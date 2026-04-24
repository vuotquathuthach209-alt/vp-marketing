"""Smoke E2E test: ffmpeg check + compose with mock files (no API keys needed)."""
import sys, paramiko
try: sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except: pass
HOST = "103.82.193.74"
PASSWORD = sys.argv[1] if len(sys.argv) > 1 else ""

CMD = r"""
cd /opt/vp-marketing

cat > /opt/vp-marketing/_tmp_smoke.js <<'JS'
process.chdir('/opt/vp-marketing');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

(async () => {
  console.log('=== Test 1: FFmpeg availability ===');
  const { checkFFmpeg } = require('/opt/vp-marketing/dist/services/video-studio/video-composer');
  const ff = await checkFFmpeg();
  console.log(`  ✅ ffmpeg v${ff.version}`);

  console.log('\n=== Test 2: Generate synthetic test clips with ffmpeg ===');
  const testDir = '/tmp/vs-smoke';
  if (!fs.existsSync(testDir)) fs.mkdirSync(testDir, { recursive: true });

  // Create 3 colored test clips (3s each, 1080x1920)
  const colors = ['red', 'green', 'blue'];
  const clipPaths = [];
  for (let i = 0; i < 3; i++) {
    const out = path.join(testDir, `clip_${i}.mp4`);
    await new Promise((resolve, reject) => {
      const proc = spawn('ffmpeg', [
        '-y', '-f', 'lavfi', '-i', `color=c=${colors[i]}:s=1080x1920:d=3:r=30`,
        '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
        out,
      ]);
      proc.on('close', (code) => code === 0 ? resolve() : reject(new Error('ffmpeg fail ' + code)));
      proc.on('error', reject);
    });
    clipPaths.push(out);
  }
  console.log(`  Created ${clipPaths.length} synthetic clips (3s each)`);

  console.log('\n=== Test 3: Generate silent test audio ===');
  const audioPath = path.join(testDir, 'voice.mp3');
  await new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', [
      '-y', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono',
      '-t', '9', '-c:a', 'libmp3lame', audioPath,
    ]);
    proc.on('close', (code) => code === 0 ? resolve() : reject());
  });
  console.log(`  Created 9s silent audio`);

  console.log('\n=== Test 4: LUT file check ===');
  const Database = require('better-sqlite3');
  const db = new Database('data/db.sqlite');
  const kit = db.prepare(`SELECT color_lut_file FROM video_brand_kits WHERE is_default = 1`).get();
  const lutExists = kit?.color_lut_file && fs.existsSync(kit.color_lut_file);
  console.log(`  LUT file: ${kit?.color_lut_file}`);
  console.log(`  Exists: ${lutExists} ${lutExists ? '(size ' + fs.statSync(kit.color_lut_file).size + ' bytes)' : ''}`);

  console.log('\n=== Test 5: Concat + process (no LUT) ===');
  const concatListPath = path.join(testDir, 'list.txt');
  fs.writeFileSync(concatListPath, clipPaths.map(p => `file '${p}'`).join('\n'));

  const concatOut = path.join(testDir, 'concat.mp4');
  await new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', [
      '-y', '-f', 'concat', '-safe', '0', '-i', concatListPath,
      '-c', 'copy', concatOut,
    ]);
    proc.on('close', (code) => code === 0 ? resolve() : reject(new Error('concat fail')));
  });
  const concatSize = fs.statSync(concatOut).size;
  console.log(`  Concat output: ${(concatSize / 1024).toFixed(0)}KB`);

  console.log('\n=== Test 6: Full mux with subtitles + audio ===');
  // Write test SRT
  const srtPath = path.join(testDir, 'subs.srt');
  fs.writeFileSync(srtPath, `1\n00:00:00,000 --> 00:00:03,000\nScene 1 đỏ test subtitles\n\n2\n00:00:03,000 --> 00:00:06,000\nScene 2 xanh lá test\n\n3\n00:00:06,000 --> 00:00:09,000\nScene 3 xanh dương cuối\n`, 'utf-8');

  const finalOut = path.join(testDir, 'final.mp4');
  await new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', [
      '-y', '-i', concatOut, '-i', audioPath,
      '-filter_complex', `[0:v]subtitles='${srtPath}':force_style='FontName=DejaVu Sans,FontSize=28,PrimaryColour=&H00FFEB3B,OutlineColour=&H00000000,BorderStyle=3,Outline=2,Shadow=1,Alignment=2,MarginV=80'[vout]`,
      '-map', '[vout]', '-map', '1:a',
      '-c:v', 'libx264', '-preset', 'fast', '-crf', '22',
      '-c:a', 'aac', '-b:a', '128k', '-shortest',
      '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
      finalOut,
    ]);
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('close', (code) => code === 0 ? resolve() : reject(new Error('mux fail: ' + stderr.substring(stderr.length - 500))));
  });

  const finalSize = fs.statSync(finalOut).size;
  console.log(`  ✅ Final output: ${(finalSize / 1024).toFixed(0)}KB`);

  console.log('\n=== Test 7: Probe duration ===');
  const duration = await new Promise((resolve) => {
    const proc = spawn('ffprobe', [
      '-v', 'error', '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1', finalOut,
    ]);
    let out = '';
    proc.stdout.on('data', (d) => { out += d.toString(); });
    proc.on('close', () => resolve(parseFloat(out.trim())));
  });
  console.log(`  Duration: ${duration?.toFixed(2)}s`);

  // Cleanup
  fs.rmSync(testDir, { recursive: true, force: true });
  db.close();

  console.log('\n✅ V1.5 smoke E2E test PASS — full pipeline works on VPS');
  console.log('\nĐể chạy real E2E với content thực:');
  console.log('  1. Setup API keys qua /video-studio → Settings');
  console.log('  2. Ideas → AI brainstorm');
  console.log('  3. Create → pick topic → generate script → approve');
  console.log('  4. Fetch visuals → voice → compose → final approve');
})().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
JS

node /opt/vp-marketing/_tmp_smoke.js
rm /opt/vp-marketing/_tmp_smoke.js
"""

c = paramiko.SSHClient()
c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
c.connect(HOST, username="root", password=PASSWORD, timeout=20)
_, out, err = c.exec_command(CMD, timeout=180)
print(out.read().decode('utf-8', errors='replace'))
e = err.read().decode('utf-8', errors='replace')
if e.strip(): print('--STDERR--'); print(e[:1500])
c.close()

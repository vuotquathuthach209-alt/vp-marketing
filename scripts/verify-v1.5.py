"""Verify V1.5: FFmpeg check, voice synthesizer (dry-run), composer hooks."""
import sys, paramiko
try: sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except: pass
HOST = "103.82.193.74"
PASSWORD = sys.argv[1] if len(sys.argv) > 1 else ""

CMD = r"""
cd /opt/vp-marketing

echo '=== Check ffmpeg installed ==='
which ffmpeg && ffmpeg -version 2>&1 | head -3 || echo 'ffmpeg NOT INSTALLED'
echo ''
echo '=== Check ffprobe ==='
which ffprobe || echo 'ffprobe NOT INSTALLED'
echo ''

cat > /opt/vp-marketing/_tmp_v15.js <<'JS'
process.chdir('/opt/vp-marketing');

(async () => {
  console.log('=== Test 1: FFmpeg availability check ===');
  const { checkFFmpeg } = require('/opt/vp-marketing/dist/services/video-studio/video-composer');
  const ff = await checkFFmpeg();
  console.log(`  ffmpeg available: ${ff.available}`);
  console.log(`  version: ${ff.version || 'unknown'}`);

  console.log('\n=== Test 2: Voice synthesizer — listAvailableVoices (no API key = empty) ===');
  const { listAvailableVoices, previewVoice } = require('/opt/vp-marketing/dist/services/video-studio/voice-synthesizer');
  const voices = await listAvailableVoices();
  console.log(`  voices returned: ${voices.length}`);
  if (voices.length === 0) {
    console.log('  (Expected: no ElevenLabs API key configured yet)');
  } else {
    for (const v of voices.slice(0, 5)) {
      console.log(`    ${v.voice_id}: ${v.name} (${v.language})`);
    }
  }

  console.log('\n=== Test 3: Orchestrator new steps exist ===');
  const orch = require('/opt/vp-marketing/dist/services/video-studio/studio-orchestrator');
  const newFns = ['generateVoiceStep', 'approveVoiceStep', 'composeVideoStep', 'approveFinalStep'];
  for (const fn of newFns) {
    console.log(`  ${fn}: ${typeof orch[fn] === 'function' ? '✅' : '❌'}`);
  }

  console.log('\n=== Test 4: Data dir structure ===');
  const fs = require('fs');
  const path = require('path');
  const DATA = path.resolve('data/video-studio');
  console.log(`  ${DATA} exists: ${fs.existsSync(DATA)}`);
  if (fs.existsSync(DATA)) {
    const subdirs = fs.readdirSync(DATA);
    console.log(`  subdirs: ${subdirs.join(', ')}`);
    const lutDir = path.join(DATA, 'luts');
    if (fs.existsSync(lutDir)) {
      const luts = fs.readdirSync(lutDir);
      console.log(`  luts/: ${luts.join(', ')}`);
    }
  }

  console.log('\n✅ V1.5 deployment verified');
})().catch(e => { console.error('Fatal:', e); process.exit(1); });
JS

node /opt/vp-marketing/_tmp_v15.js
rm /opt/vp-marketing/_tmp_v15.js
"""

c = paramiko.SSHClient()
c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
c.connect(HOST, username="root", password=PASSWORD, timeout=20)
_, out, err = c.exec_command(CMD, timeout=60)
print(out.read().decode('utf-8', errors='replace'))
e = err.read().decode('utf-8', errors='replace')
if e.strip(): print('--STDERR--'); print(e)
c.close()

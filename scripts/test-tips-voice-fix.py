"""Re-gen tips video voice (1 segment only) để verify giọng chuẩn."""
import sys, paramiko
try: sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except: pass
HOST = "103.82.193.74"
PASSWORD = sys.argv[1] if len(sys.argv) > 1 else ""

CMD = r"""
cd /opt/vp-marketing
cat > /opt/vp-marketing/_tmp_voice_test.js <<'JS'
process.chdir('/opt/vp-marketing');
const fs = require('fs');
const path = require('path');

(async () => {
  // Test 1 segment chỉ để verify voice — không gen full video
  const { synthesizeTipsVoice } = require('/opt/vp-marketing/dist/services/video-studio/tips-composer');

  const mockScript = {
    category: 'booking_tips',
    topic: 'Test voice',
    hook_pattern: 'number',
    hook_text: 'Bạn có biết 5 sai lầm khi đặt phòng nhiều người mắc?',
    hook_variants: { A: '...', B: '...' },
    tips: [
      { number: 1, title: 'Đặt sớm', text: 'Đặt phòng trước 60 ngày để có giá tốt nhất, đặc biệt vào lễ.', visual_query: '...' },
      { number: 2, title: 'Tránh peak', text: 'Tránh check-in tối thứ Sáu và sáng thứ Bảy vì đông và đắt.', visual_query: '...' },
      { number: 3, title: 'Chọn lân cận', text: 'Chọn thành phố lân cận thay vì điểm hot, giá rẻ hơn 50 phần trăm.', visual_query: '...' },
      { number: 4, title: 'Săn flash sale', text: 'Săn flash sale trên app vào trưa thứ Hai, deal tốt nhất.', visual_query: '...' },
      { number: 5, title: 'Hỏi trực tiếp', text: 'Hỏi thẳng khách sạn để có giá rẻ hơn các nền tảng đặt phòng.', visual_query: '...' },
    ],
    cta_text: 'Save bài này nếu hữu ích nhé! Comment thêm tip của bạn nha.',
    caption_text: 'Test caption',
    hashtags: ['#test'],
    total_duration_sec: 75,
  };

  console.log('Generating voice với pattern Edge-TTS → ElevenLabs STS...');
  const start = Date.now();
  const segments = await synthesizeTipsVoice(mockScript, 999);
  const elapsed = (Date.now() - start) / 1000;

  console.log(`\nResult: ${segments.length} segments, ${elapsed.toFixed(1)}s elapsed`);
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i];
    const sz = fs.existsSync(s.audio_path) ? (fs.statSync(s.audio_path).size / 1024).toFixed(1) + 'KB' : 'MISSING';
    console.log(`  ${i + 1}. ${s.duration_sec.toFixed(1)}s ${sz} → ${path.basename(s.audio_path)}`);
  }

  // Save 1 sample for verify giọng
  const samplePath = '/opt/vp-marketing/data/media/voice-sample-tips-fix.mp3';
  if (segments[0]) {
    fs.copyFileSync(segments[0].audio_path, samplePath);
    console.log(`\n✓ Sample voice (hook): /media/voice-sample-tips-fix.mp3`);
    console.log(`  Public URL: https://app.sondervn.com/media/voice-sample-tips-fix.mp3`);
  }

  // Cleanup
  for (const s of segments) try { fs.unlinkSync(s.audio_path); } catch {}
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
JS

node /opt/vp-marketing/_tmp_voice_test.js
rm /opt/vp-marketing/_tmp_voice_test.js
"""

c = paramiko.SSHClient()
c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
c.connect(HOST, username="root", password=PASSWORD, timeout=20)
_, out, err = c.exec_command(CMD, timeout=300)
print(out.read().decode('utf-8', errors='replace'))
e = err.read().decode('utf-8', errors='replace')
if e.strip(): print('--STDERR--'); print(e[:1000])
c.close()

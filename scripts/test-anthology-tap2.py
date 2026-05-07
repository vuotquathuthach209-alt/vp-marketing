"""
Test anthology pipeline — generate Tập 2 "Phở 6 Giờ Sáng" trên VPS.

Character: Linh (đang ở Sonder Airport)
Location: Sonder Airport (sảnh 5h45 sáng)
Brand values thấm: Hiểu địa phương + Ấm áp như nhà
Logo placements: tag Tuấn + khăn lau + chìa khoá
Hook: "5h45 sáng. Mình dậy sớm hơn dự định."

Test:
  python scripts/test-anthology-tap2.py 'PASSWORD'
"""
import sys
import os
import paramiko

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

HOST = "103.82.193.74"
USER = "root"
PASSWORD = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("VPS_PASSWORD", "")

# Inline Node script: import orchestrator, run pipeline, print result
NODE_SCRIPT = r'''
const { runFullAnthologyPipeline } = require('/opt/vp-marketing/dist/services/anthology/anthology-orchestrator');

(async () => {
  console.log('[test] starting pipeline for Tap 2 "Pho 6 Gio Sang"...');
  const start = Date.now();
  try {
    const r = await runFullAnthologyPipeline({
      pick: {
        primary: 'linh',
        is_crossover: false,
        arc_slug: 'linh_season_1',
        reason: 'manual test Tap 2 — Pho 6 Gio Sang',
      },
      episodeIdeaSeed: `Tap 2: "Pho 6 Gio Sang"
- Linh day som hon du dinh (5h45 sang)
- Buoc xuong sanh — Tuan van o quay
- Tuan goi y quan Pho Ba Tam duong Hoang Van Thu (mo 5h30, gia binh dan)
- Linh di mot minh, ngoi vua banh, slurp pho dau tien
- Reflection: "Hoa ra Sai Gon khong voi nhu minh tuong. Hoa ra ai do nho minh thich an gi sang."
- Closing: "Lan dau minh an pho 1 minh ma khong thay le loi."
- Brand values tham: understand_local + warm_like_home
- Logo placements: tag Tuan ao, khan lau pho banh, chia khoa phong khi quay ve`,
      generatedBy: 'manual-test-tap2',
    });
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    if (r.ok) {
      console.log('\n=== RESULT ===');
      console.log('episode_id:', r.episode_id);
      console.log('episode_no:', r.episode_no);
      console.log('title:', r.script?.title);
      console.log('hook_surface:', r.script?.hook_surface);
      console.log('hook_arc:', r.script?.hook_arc);
      console.log('arc_beat:', r.script?.arc_beat);
      console.log('brand_values:', r.script?.brand_values_used);
      console.log('logo_placements:', r.script?.logo_placements_used);
      console.log('total_duration_target_sec:', r.script?.total_duration_target_sec);
      console.log('actual duration_sec:', r.duration_sec?.toFixed(1));
      console.log('output_path:', r.output_path);
      console.log('final_video_url:', r.final_video_url);
      console.log('new_facts:', JSON.stringify(r.script?.new_facts, null, 2));
      console.log('layers count:', r.script?.layers?.length);
      console.log('elapsed:', elapsed + 's');
      console.log('=== OK ===');
    } else {
      console.error('\n=== FAILED ===');
      console.error('step:', r.step_failed);
      console.error('error:', r.error);
      console.error('episode_id (if created):', r.episode_id);
      console.error('elapsed:', elapsed + 's');
      process.exit(1);
    }
  } catch (e) {
    console.error('UNCAUGHT:', e?.message);
    console.error(e?.stack);
    process.exit(1);
  }
})();
'''

CMD = f"""
cd /opt/vp-marketing
cat > /tmp/test-tap2.js <<'JSEOF'
{NODE_SCRIPT}
JSEOF
node /tmp/test-tap2.js 2>&1
"""

if not PASSWORD:
    print("ERROR: pass password as arg #1 or set VPS_PASSWORD env", file=sys.stderr)
    sys.exit(1)

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
print(f"[test] connecting to {USER}@{HOST}...", file=sys.stderr)
client.connect(HOST, username=USER, password=PASSWORD, timeout=15, look_for_keys=False, allow_agent=False)

print(f"[test] running anthology pipeline test (10-15 min expected)...", file=sys.stderr)
stdin, stdout, stderr = client.exec_command(CMD, timeout=1200)  # 20 min timeout
out = stdout.read().decode("utf-8", errors="replace")
err = stderr.read().decode("utf-8", errors="replace")
code = stdout.channel.recv_exit_status()
print(out)
if err.strip():
    print("STDERR:\n" + err, file=sys.stderr)
print(f"[test] exit code: {code}", file=sys.stderr)
sys.exit(code)

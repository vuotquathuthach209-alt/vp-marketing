"""Manual trigger: generate + publish today's plan end-to-end."""
import sys, paramiko
try: sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except: pass
HOST = "103.82.193.74"
PASSWORD = sys.argv[1] if len(sys.argv) > 1 else ""

CMD = r"""
cd /opt/vp-marketing

cat > tmp.js <<'JS'
process.chdir('/opt/vp-marketing');
const Database = require('better-sqlite3');
const db = new Database('data/db.sqlite');

(async () => {
  const { generateTodayPlan, publishTodayPlan } = require('/opt/vp-marketing/dist/services/product-auto-post/orchestrator');

  // Regenerate plan (fresh caption)
  console.log('\n=== REGENERATE PLAN ===');
  db.prepare(`DELETE FROM auto_post_plan WHERE scheduled_date = date('now', '+7 hours')`).run();
  db.prepare(`DELETE FROM auto_post_history WHERE scheduled_date = date('now', '+7 hours') AND status = 'generated'`).run();

  const gen = await generateTodayPlan();
  console.log('Generate result:', JSON.stringify({
    ok: gen.ok, reason: gen.reason, plan_id: gen.plan_id,
    hotel: gen.hotel?.name, angle: gen.angle,
    image_source: gen.image?.source,
    caption_preview: gen.caption?.substring(0, 200),
  }, null, 2));

  if (!gen.ok) { db.close(); return; }

  // Now publish
  console.log('\n=== PUBLISH PLAN ===');
  const pub = await publishTodayPlan();
  console.log('Publish result:', JSON.stringify(pub, null, 2));

  if (pub.ok) {
    console.log('\n✅ Posted successfully!');
    console.log('  FB Post ID:', pub.fb_post_id);
    console.log('  → https://www.facebook.com/' + pub.fb_post_id);
  }

  // Check cross-post log
  setTimeout(() => {
    console.log('\n=== CROSS-POST LOG (should auto-trigger after 10-15s) ===');
    const logs = db.prepare(`SELECT platform, result, external_id, error, datetime(created_at/1000, 'unixepoch', '+7 hours') as t FROM cross_post_log WHERE fb_post_id = ? ORDER BY id DESC`).all(pub.fb_post_id);
    logs.forEach(l => console.log('  ' + l.t + ' ' + l.platform + ' → ' + l.result + ' ' + (l.external_id||'') + ' ' + (l.error||'')));
    db.close();
  }, 15000);
})();
JS

node tmp.js
rm tmp.js
"""

c = paramiko.SSHClient()
c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
c.connect(HOST, username="root", password=PASSWORD, timeout=15)
_, out, err = c.exec_command(CMD, timeout=180)
print(out.read().decode('utf-8'))
e = err.read().decode('utf-8')
if e.strip(): print('STDERR:', e[:500])
c.close()

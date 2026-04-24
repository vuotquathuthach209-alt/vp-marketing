"""Test v25 product auto post end-to-end."""
import sys, paramiko
try: sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except: pass
HOST = "103.82.193.74"
PASSWORD = sys.argv[1] if len(sys.argv) > 1 else ""

CMD = r"""
cd /opt/vp-marketing

cat > tmp_test.js <<'JS'
process.chdir('/opt/vp-marketing');
const Database = require('better-sqlite3');
const { getAllHotelsScored } = require('/opt/vp-marketing/dist/services/product-auto-post/picker');
const db = new Database('data/db.sqlite');

console.log('═══════════════════════════════════════════');
console.log('  PHASE 1: PICKER — SCORE ALL HOTELS');
console.log('═══════════════════════════════════════════');
const { eligible, rejected } = getAllHotelsScored();
console.log('Eligible:', eligible.length);
eligible.slice(0, 5).forEach(c => {
  console.log('  #' + c.hotel_id + ' "' + c.name + '" score=' + c.score + ' rating=' + (c.rating?.toFixed(1)||'?') + ' reviews=' + c.review_count + ' images=' + c.image_count);
  console.log('    breakdown:', JSON.stringify(c.score_breakdown));
});
console.log('\nRejected:', rejected.length);
rejected.forEach(c => {
  console.log('  ✗ #' + c.hotel_id + ' ' + c.name + ' → ' + c.reject_reason);
});

console.log('\n═══════════════════════════════════════════');
console.log('  PHASE 2: GENERATE TODAY PLAN');
console.log('═══════════════════════════════════════════');
(async () => {
  const { generateTodayPlan } = require('/opt/vp-marketing/dist/services/product-auto-post/orchestrator');
  const r = await generateTodayPlan();
  console.log('Result:', JSON.stringify({
    ok: r.ok, reason: r.reason, plan_id: r.plan_id, date: r.date,
    hotel: r.hotel?.name, angle: r.angle,
    image_source: r.image?.source, image_fp: r.image?.fingerprint,
  }, null, 2));
  if (r.caption) {
    console.log('\nCaption generated (' + r.caption.length + ' chars):');
    console.log('---');
    console.log(r.caption);
    console.log('---');
  }

  console.log('\n═══════════════════════════════════════════');
  console.log('  PHASE 3: SAVED PLAN IN DB');
  console.log('═══════════════════════════════════════════');
  const plans = db.prepare(`SELECT id, scheduled_date, hotel_id, angle, status, length(caption_draft) as cap_len FROM auto_post_plan ORDER BY scheduled_date DESC LIMIT 3`).all();
  plans.forEach(p => console.log('  plan #' + p.id + ' ' + p.scheduled_date + ' hotel=' + p.hotel_id + ' angle=' + p.angle + ' status=' + p.status + ' cap=' + p.cap_len + 'ch'));

  db.close();
})();
JS

node tmp_test.js
rm -f tmp_test.js
"""

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, username="root", password=PASSWORD, timeout=15)
_, stdout, stderr = client.exec_command(CMD, timeout=180)
print(stdout.read().decode('utf-8', errors='replace'))
err = stderr.read().decode('utf-8', errors='replace')
if err.strip(): print('STDERR:', err[:1000])
client.close()

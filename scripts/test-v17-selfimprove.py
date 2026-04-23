"""Test v17 self-improvement: seed templates + pick variant + weekly report."""
import sys, paramiko
try: sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except: pass
HOST = "103.82.193.74"
PASSWORD = sys.argv[1] if len(sys.argv) > 1 else ""

CMD = r"""
cd /opt/vp-marketing

echo "=== 1. Verify tables ==="
cat > tmp.js <<'JS'
const Database = require('better-sqlite3');
const db = new Database('data/db.sqlite');
['reply_templates', 'reply_experiments', 'reply_assignments', 'prompt_lessons'].forEach(t => {
  const cols = db.prepare(`PRAGMA table_info(${t})`).all();
  console.log('  ' + t + ': ' + cols.length + ' cols');
});
db.close();
JS
node tmp.js; rm -f tmp.js

echo ""
echo "=== 2. Seed reply templates ==="
cat > tmp.js <<'JS'
const { seedReplyTemplates } = require('./dist/services/reply-template-seed');
console.log(JSON.stringify(seedReplyTemplates()));
JS
node tmp.js; rm -f tmp.js

echo ""
echo "=== 3. List templates ==="
cat > tmp.js <<'JS'
const Database = require('better-sqlite3');
const db = new Database('data/db.sqlite');
const rows = db.prepare(`SELECT template_key, variant_name, substr(content, 1, 60) as preview, impressions FROM reply_templates ORDER BY template_key, variant_name`).all();
rows.forEach(r => console.log('  ' + r.template_key + '/' + r.variant_name + ' (imps=' + r.impressions + '): ' + r.preview + '...'));
db.close();
JS
node tmp.js; rm -f tmp.js

echo ""
echo "=== 4. Test pickVariant deterministic (same sender gets same variant) ==="
cat > tmp.js <<'JS'
const { pickVariant } = require('./dist/services/reply-variant-selector');
const senders = ['zalo:user001', 'zalo:user002', 'zalo:user003', 'zalo:user004', 'zalo:user005'];
for (const s of senders) {
  const v1 = pickVariant(s, 0, 'greeting_new');
  const v2 = pickVariant(s, 0, 'greeting_new');  // second call same sender
  const consistency = (v1 && v2 && v1.id === v2.id) ? '✅' : '❌';
  console.log('  ' + s + ': variant=' + (v1 ? v1.variant_name : 'NULL') + ' ' + consistency);
}
JS
node tmp.js; rm -f tmp.js

echo ""
echo "=== 5. Auto-experiment created ==="
cat > tmp.js <<'JS'
const Database = require('better-sqlite3');
const db = new Database('data/db.sqlite');
const exps = db.prepare(`SELECT * FROM reply_experiments`).all();
exps.forEach(e => console.log('  #' + e.id + ' ' + e.experiment_name + ' status=' + e.status));
const assigns = db.prepare(`SELECT COUNT(*) as n FROM reply_assignments`).get();
console.log('  total assignments:', assigns.n);
db.close();
JS
node tmp.js; rm -f tmp.js

echo ""
echo "=== 6. Weekly report preview ==="
cat > tmp.js <<'JS'
const { generateWeeklyReport, formatReportForTelegram } = require('./dist/services/weekly-performance-report');
const r = generateWeeklyReport(1);
console.log('Period:', r.period.from, '→', r.period.to);
console.log('Totals:', JSON.stringify(r.totals));
console.log('Top sources:', r.top_reply_sources.length);
r.top_reply_sources.slice(0, 3).forEach(s => console.log('  ' + s.reply_source + ': ' + s.converted + '/' + s.total + ' = ' + (s.rate*100).toFixed(0) + '%'));
console.log('Worst:', r.worst_reply_sources.length);
r.worst_reply_sources.slice(0, 3).forEach(s => console.log('  ' + s.reply_source + ': ' + s.bad_count + '/' + s.total + ' = ' + (s.bad_rate*100).toFixed(0) + '% bad'));
console.log('Audiences:', r.audience_stats.length);
r.audience_stats.slice(0, 3).forEach(a => console.log('  ' + a.audience_name + ': ' + a.member_count + ' members'));
console.log('\n--- Telegram format ---');
console.log(formatReportForTelegram(r));
JS
node tmp.js; rm -f tmp.js

echo ""
echo "=== 7. Prompt lessons extraction ==="
cat > tmp.js <<'JS'
const { extractLessonsFromLabels, getLessonsForContext } = require('./dist/services/prompt-lessons');
const r = extractLessonsFromLabels();
console.log('Extraction:', JSON.stringify(r));
const lessons = getLessonsForContext('any', 0, 5);
console.log('Lessons for any context:', lessons.length);
JS
node tmp.js; rm -f tmp.js

echo ""
echo "=== 8. Trigger bot greeting → check variant impression ==="
cat > tmp.js <<'JS'
const Database = require('better-sqlite3');
const db = new Database('data/db.sqlite');
db.prepare(`DELETE FROM bot_conversation_state WHERE sender_id = 'zalo:v17_greet'`).run();
db.prepare(`DELETE FROM conversation_memory WHERE sender_id = 'zalo:v17_greet'`).run();
db.close();
JS
node tmp.js; rm -f tmp.js

curl -s -X POST http://127.0.0.1:3000/webhook/zalo \
  -H 'Content-Type: application/json' \
  -d '{"oa_id":"328738126716568694","event_name":"user_send_text","sender":{"id":"v17_greet"},"message":{"text":"xin chào"}}' > /dev/null
sleep 5

cat > tmp.js <<'JS'
const Database = require('better-sqlite3');
const db = new Database('data/db.sqlite');
const msgs = db.prepare(`SELECT role, substr(message, 1, 200) as msg, intent FROM conversation_memory WHERE sender_id = 'zalo:v17_greet' ORDER BY id`).all();
msgs.forEach(m => console.log((m.role === 'user' ? '👤' : '🤖') + ' [' + (m.intent||'-') + '] ' + m.msg));

console.log('\nVariant impression:');
const variant = db.prepare(`
  SELECT rt.template_key, rt.variant_name, rt.impressions FROM reply_assignments ra
  JOIN reply_templates rt ON rt.id = ra.variant_id
  WHERE ra.sender_id = 'zalo:v17_greet'
`).get();
if (variant) console.log('  Assigned:', variant.template_key, variant.variant_name, '(imps=' + variant.impressions + ')');
else console.log('  (no variant assigned — greeting fallback path hoặc bot paused)');
db.close();
JS
node tmp.js; rm -f tmp.js
"""

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, username="root", password=PASSWORD, timeout=15)
_, stdout, stderr = client.exec_command(CMD, timeout=120)
print(stdout.read().decode('utf-8', errors='replace'))
err = stderr.read().decode('utf-8', errors='replace')
if err.strip(): print('STDERR:', err[:800])
client.close()

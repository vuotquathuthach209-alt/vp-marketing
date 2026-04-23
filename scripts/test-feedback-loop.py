"""Test v13 feedback loop end-to-end."""
import sys, paramiko
try: sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except: pass

HOST = "103.82.193.74"
PASSWORD = sys.argv[1] if len(sys.argv) > 1 else ""

CMD = r"""
cd /opt/vp-marketing

echo "=== 1. Verify tables created ==="
cat > tmp.js <<'JS'
const Database = require('better-sqlite3');
const db = new Database('data/db.sqlite');
const tables = ['bot_reply_outcomes', 'funnel_stage_transitions', 'funnel_daily_metrics', 'conversation_labels'];
tables.forEach(t => {
  try {
    const cols = db.prepare(`PRAGMA table_info(${t})`).all();
    console.log('  ' + t + ': ' + cols.length + ' cols');
  } catch (e) {
    console.log('  ' + t + ': MISSING');
  }
});
db.close();
JS
node tmp.js; rm -f tmp.js

echo ""
echo "=== 2. Send 4 test messages to trigger logger + classifier ==="
# Fresh sender to avoid cross-contamination
cat > tmp-clean.js <<'JS'
const Database = require('better-sqlite3');
const db = new Database('data/db.sqlite');
['fb_v13_test', 'zalo:v13_test'].forEach(s => {
  db.prepare(`DELETE FROM bot_conversation_state WHERE sender_id = ?`).run(s);
  db.prepare(`DELETE FROM conversation_memory WHERE sender_id = ?`).run(s);
  db.prepare(`DELETE FROM bot_reply_outcomes WHERE sender_id = ?`).run(s);
  db.prepare(`DELETE FROM funnel_stage_transitions WHERE sender_id = ?`).run(s);
});
db.close();
JS
node tmp-clean.js; rm -f tmp-clean.js

# Send sequence: greeting → price → misunderstand signal → phone
for MSG in "Chào shop" "Giá phòng bao nhiêu" "không hiểu em nói gì" "0909123456 Nguyễn A"; do
  echo "  User: $MSG"
  curl -s -X POST http://127.0.0.1:3000/webhook/zalo \
    -H 'Content-Type: application/json' \
    -d '{"oa_id":"328738126716568694","event_name":"user_send_text","sender":{"id":"v13_test"},"message":{"text":"'"$MSG"'"}}' \
    -o /dev/null
  sleep 5
done

echo ""
echo "=== 3. Check replies logged ==="
cat > tmp.js <<'JS'
const Database = require('better-sqlite3');
const db = new Database('data/db.sqlite');
const replies = db.prepare(`SELECT id, substr(user_message,1,40) as um, substr(bot_reply,1,80) as br, intent, stage, reply_source, outcome, latency_ms FROM bot_reply_outcomes WHERE sender_id = 'zalo:v13_test' ORDER BY id`).all();
console.log('Replies logged:', replies.length);
replies.forEach(r => console.log('  #' + r.id + ' [' + (r.outcome || 'null') + '] ' + r.reply_source + ' | Q: ' + r.um + ' | A: ' + r.br));
console.log('');
const transitions = db.prepare(`SELECT id, from_stage, to_stage, trigger_intent, trigger_msg FROM funnel_stage_transitions WHERE sender_id = 'zalo:v13_test' ORDER BY id`).all();
console.log('Stage transitions:', transitions.length);
transitions.forEach(t => console.log('  ' + (t.from_stage || 'NULL') + ' → ' + t.to_stage + ' [' + (t.trigger_intent || '-') + '] ' + t.trigger_msg));
db.close();
JS
node tmp.js; rm -f tmp.js

echo ""
echo "=== 4. Run classifier manually ==="
cat > tmp.js <<'JS'
const { classifyPendingOutcomes } = require('./dist/services/outcome-classifier');
const r = classifyPendingOutcomes();
console.log(JSON.stringify(r, null, 2));
JS
node tmp.js; rm -f tmp.js

echo ""
echo "=== 5. Re-check outcomes after classify ==="
cat > tmp.js <<'JS'
const Database = require('better-sqlite3');
const db = new Database('data/db.sqlite');
const replies = db.prepare(`SELECT id, substr(user_message,1,40) as um, outcome, outcome_evidence FROM bot_reply_outcomes WHERE sender_id = 'zalo:v13_test' ORDER BY id`).all();
replies.forEach(r => console.log('  #' + r.id + ' outcome=' + r.outcome + ' evidence=' + (r.outcome_evidence || 'null')));
db.close();
JS
node tmp.js; rm -f tmp.js

echo ""
echo "=== 6. Dashboard stats preview (directly via DB) ==="
cat > tmp.js <<'JS'
const { getOutcomeStats, getTopPerformingSources } = require('./dist/services/reply-outcome-logger');
const stats = getOutcomeStats(1, 1);
console.log('Outcome distribution (hotel 1, 1 day):', JSON.stringify(stats, null, 2));
JS
node tmp.js; rm -f tmp.js
"""

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, username="root", password=PASSWORD, timeout=15)
_, stdout, stderr = client.exec_command(CMD, timeout=120)
print(stdout.read().decode("utf-8", errors="replace"))
err = stderr.read().decode("utf-8", errors="replace")
if err.strip(): print("STDERR:\n" + err, file=sys.stderr)
client.close()

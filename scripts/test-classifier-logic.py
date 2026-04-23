"""Test outcome classifier by backdating timestamps."""
import sys, paramiko
try: sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except: pass

HOST = "103.82.193.74"
PASSWORD = sys.argv[1] if len(sys.argv) > 1 else ""

CMD = r"""
cd /opt/vp-marketing

echo "=== Backdate v13_test replies by 10 min → trigger classifier ==="
cat > tmp.js <<'JS'
const Database = require('better-sqlite3');
const db = new Database('data/db.sqlite');
const offset = 10 * 60_000;  // 10 min
db.prepare(`UPDATE bot_reply_outcomes SET created_at = created_at - ? WHERE sender_id = 'zalo:v13_test'`).run(offset);
db.prepare(`UPDATE conversation_memory SET created_at = created_at - ? WHERE sender_id = 'zalo:v13_test'`).run(offset);
console.log('Backdated all v13_test replies + msgs by 10 min');
db.close();
JS
node tmp.js; rm -f tmp.js

echo ""
echo "=== Run classifier ==="
cat > tmp.js <<'JS'
const { classifyPendingOutcomes } = require('./dist/services/outcome-classifier');
const r = classifyPendingOutcomes();
console.log(JSON.stringify(r, null, 2));
JS
node tmp.js; rm -f tmp.js

echo ""
echo "=== After classify ==="
cat > tmp.js <<'JS'
const Database = require('better-sqlite3');
const db = new Database('data/db.sqlite');
const replies = db.prepare(`SELECT id, substr(user_message,1,30) as um, substr(bot_reply,1,50) as br, reply_source, outcome, outcome_evidence FROM bot_reply_outcomes WHERE sender_id = 'zalo:v13_test' ORDER BY id`).all();
replies.forEach(r => {
  console.log('#' + r.id + ' [' + r.outcome + '] ' + r.reply_source);
  console.log('  Q: ' + r.um);
  console.log('  A: ' + r.br);
  if (r.outcome_evidence) console.log('  Evidence: ' + r.outcome_evidence);
});
db.close();
JS
node tmp.js; rm -f tmp.js

echo ""
echo "=== Dashboard stats via API (use admin password) ==="
# Login via admin mode (just password, no email)
TOKEN=$(curl -s -X POST http://127.0.0.1:3000/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"password":"cCxEvKZ0J3Ee6NJG"}' -c /tmp/ck.txt | node -pe 'try { JSON.parse(require("fs").readFileSync("/dev/stdin")).mode || "" } catch { "" }' 2>/dev/null)
echo "Login mode: $TOKEN"

echo ""
echo "=== /api/feedback-loop/health ==="
curl -s -b /tmp/ck.txt http://127.0.0.1:3000/api/feedback-loop/health | node -pe 'JSON.stringify(JSON.parse(require("fs").readFileSync("/dev/stdin")), null, 2)'

echo ""
echo "=== /api/feedback-loop/stats?days=1 ==="
curl -s -b /tmp/ck.txt 'http://127.0.0.1:3000/api/feedback-loop/stats?days=1' | node -pe 'const r = JSON.parse(require("fs").readFileSync("/dev/stdin")); console.log(JSON.stringify(r, null, 2).slice(0, 2000))' 2>/dev/null | head -80

rm -f /tmp/ck.txt
"""

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, username="root", password=PASSWORD, timeout=15)
_, stdout, stderr = client.exec_command(CMD, timeout=60)
print(stdout.read().decode("utf-8", errors="replace"))
err = stderr.read().decode("utf-8", errors="replace")
if err.strip(): print("STDERR:\n" + err, file=sys.stderr)
client.close()

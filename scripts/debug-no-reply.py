"""Debug why bot không reply."""
import sys, os, paramiko
try: sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except: pass

HOST = "103.82.193.74"
PASSWORD = sys.argv[1] if len(sys.argv) > 1 else ""

CMD = r"""
cd /opt/vp-marketing

# Start tail in background
timeout 30 pm2 logs vp-mkt --raw --lines 0 2>&1 | grep -iE 'gemini|funnel|error|exception|d1_debug' > /tmp/tail.log &
TAIL_PID=$!
sleep 1

# Clean + send test
cat > tmp.js <<'JS'
const Database = require('better-sqlite3');
const db = new Database('data/db.sqlite');
db.prepare(`DELETE FROM bot_conversation_state WHERE sender_id = 'zalo:d1_debug'`).run();
db.prepare(`DELETE FROM conversation_memory WHERE sender_id = 'zalo:d1_debug'`).run();
db.close();
JS
node tmp.js; rm -f tmp.js

echo "Sending test message..."
curl -s -X POST http://127.0.0.1:3000/webhook/zalo \
  -H 'Content-Type: application/json' \
  -d '{"oa_id":"328738126716568694","event_name":"user_send_text","sender":{"id":"d1_debug"},"message":{"text":"Giá phòng bao nhiêu"}}' -w "HTTP: %{http_code}\n"

# Wait for bot to process
sleep 20

echo ""
echo "=== CONVERSATION ==="
cat > tmp.js <<'JS'
const Database = require('better-sqlite3');
const db = new Database('data/db.sqlite');
const rows = db.prepare(`SELECT role, substr(message, 1, 500) as msg, intent, created_at FROM conversation_memory WHERE sender_id = 'zalo:d1_debug' ORDER BY id`).all();
rows.forEach(r => {
  console.log((r.role === 'user' ? '👤' : '🤖') + ' [' + (r.intent || '-') + '] ' + r.msg);
});
const s = db.prepare(`SELECT stage, slots FROM bot_conversation_state WHERE sender_id = 'zalo:d1_debug'`).get();
if (s) console.log('state:', s.stage, '| slots:', s.slots);
db.close();
JS
node tmp.js; rm -f tmp.js

# Kill tail + show output
kill $TAIL_PID 2>/dev/null
wait $TAIL_PID 2>/dev/null
echo ""
echo "=== TAILED LOGS ==="
cat /tmp/tail.log 2>&1 | tail -30
rm -f /tmp/tail.log
"""

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, username="root", password=PASSWORD, timeout=15)
_, stdout, stderr = client.exec_command(CMD, timeout=90)
print(stdout.read().decode("utf-8", errors="replace"))
err = stderr.read().decode("utf-8", errors="replace")
if err.strip(): print("STDERR:\n" + err, file=sys.stderr)
client.close()

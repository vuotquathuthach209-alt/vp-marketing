"""Check broad PM2 logs after a test call."""
import sys, os, paramiko
try: sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except: pass

HOST = "103.82.193.74"
PASSWORD = sys.argv[1] if len(sys.argv) > 1 else ""

CMD = r"""
cd /opt/vp-marketing

# Clean + send
cat > tmp.js <<'JS'
const Database = require('better-sqlite3');
const db = new Database('data/db.sqlite');
db.prepare(`DELETE FROM bot_conversation_state WHERE sender_id = 'zalo:broad_test'`).run();
db.prepare(`DELETE FROM conversation_memory WHERE sender_id = 'zalo:broad_test'`).run();
db.close();
JS
node tmp.js; rm -f tmp.js

echo "Sending..."
curl -s -X POST http://127.0.0.1:3000/webhook/zalo \
  -H 'Content-Type: application/json' \
  -d '{"oa_id":"328738126716568694","event_name":"user_send_text","sender":{"id":"broad_test"},"message":{"text":"Giá phòng bao nhiêu"}}' > /dev/null

sleep 15

echo ""
echo "=== Recent logs (last 50) ==="
pm2 logs vp-mkt --raw --lines 50 --nostream 2>&1 | tail -60

echo ""
echo "=== Conv ==="
cat > tmp.js <<'JS'
const Database = require('better-sqlite3');
const db = new Database('data/db.sqlite');
const rows = db.prepare(`SELECT role, substr(message, 1, 300) as msg, intent FROM conversation_memory WHERE sender_id = 'zalo:broad_test' ORDER BY id`).all();
rows.forEach(r => console.log((r.role === 'user' ? '👤' : '🤖') + ' [' + (r.intent || '-') + '] ' + r.msg));
db.close();
JS
node tmp.js; rm -f tmp.js
"""

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, username="root", password=PASSWORD, timeout=15)
_, stdout, stderr = client.exec_command(CMD, timeout=60)
print(stdout.read().decode("utf-8", errors="replace"))
err = stderr.read().decode("utf-8", errors="replace")
if err.strip(): print("STDERR:\n" + err, file=sys.stderr)
client.close()

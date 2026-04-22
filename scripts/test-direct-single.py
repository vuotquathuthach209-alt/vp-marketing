"""Test single direct scenario với sleep đủ + log."""
import sys, os, paramiko
try: sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except: pass

HOST = "103.82.193.74"
PASSWORD = sys.argv[1] if len(sys.argv) > 1 else ""

CMD = r"""
cd /opt/vp-marketing
# Clean
cat > tmp.js <<'JS'
const Database = require('better-sqlite3');
const db = new Database('data/db.sqlite');
db.prepare(`DELETE FROM bot_conversation_state WHERE sender_id LIKE 'zalo:d1_%'`).run();
db.prepare(`DELETE FROM conversation_memory WHERE sender_id LIKE 'zalo:d1_%'`).run();
db.close();
JS
node tmp.js; rm -f tmp.js

# Test "Giá phòng bao nhiêu" với wait đủ
echo "━━━ USER: 'Giá phòng bao nhiêu' ━━━"
curl -s -X POST http://127.0.0.1:3000/webhook/zalo \
  -H 'Content-Type: application/json' \
  -d '{"oa_id":"328738126716568694","event_name":"user_send_text","sender":{"id":"d1_price"},"message":{"text":"Giá phòng bao nhiêu"}}' > /dev/null
sleep 8

cat > tmp.js <<'JS'
const Database = require('better-sqlite3');
const db = new Database('data/db.sqlite');
const rows = db.prepare(`SELECT role, substr(message, 1, 500) as msg, intent, created_at FROM conversation_memory WHERE sender_id = 'zalo:d1_price' ORDER BY id`).all();
rows.forEach(r => {
  console.log((r.role === 'user' ? '👤' : '🤖') + ' [' + (r.intent || '-') + '] ' + r.msg);
});
const s = db.prepare(`SELECT stage FROM bot_conversation_state WHERE sender_id = 'zalo:d1_price'`).get();
if (s) console.log('state:', s.stage);
db.close();
JS
node tmp.js; rm -f tmp.js

echo ""
echo "━━━ Check VPS logs for this turn ━━━"
pm2 logs vp-mkt --raw --lines 100 --nostream 2>&1 | grep -iE 'funnel|d1_price|error' | tail -20
"""

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, username="root", password=PASSWORD, timeout=15)
_, stdout, stderr = client.exec_command(CMD, timeout=60)
print(stdout.read().decode("utf-8", errors="replace"))
err = stderr.read().decode("utf-8", errors="replace")
if err.strip(): print("STDERR:\n" + err, file=sys.stderr)
client.close()

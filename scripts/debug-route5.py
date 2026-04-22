"""Debug Route 5 contact_info với 0909123456 Nguyễn Văn A."""
import sys, paramiko
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
db.prepare(`DELETE FROM bot_conversation_state WHERE sender_id = 'zalo:r5_debug'`).run();
db.prepare(`DELETE FROM conversation_memory WHERE sender_id = 'zalo:r5_debug'`).run();
db.prepare(`DELETE FROM customer_contacts WHERE sender_id = 'zalo:r5_debug'`).run();
db.close();
JS
node tmp.js; rm -f tmp.js

# Flush PM2 logs to capture cleanly
pm2 flush vp-mkt > /dev/null 2>&1

echo "Sending phone+name..."
curl -s -X POST http://127.0.0.1:3000/webhook/zalo \
  -H 'Content-Type: application/json' \
  -d '{"oa_id":"328738126716568694","event_name":"user_send_text","sender":{"id":"r5_debug"},"message":{"text":"0909123456 Nguyễn Văn A"}}' > /dev/null

sleep 10

echo ""
echo "=== Relevant logs ==="
pm2 logs vp-mkt --raw --lines 200 --nostream 2>&1 | grep -iE 'route5|gemini-intent|funnel.*contact|contact_captured|funnel_property' | tail -30

echo ""
echo "=== Conversation ==="
cat > tmp.js <<'JS'
const Database = require('better-sqlite3');
const db = new Database('data/db.sqlite');
const rows = db.prepare(`SELECT role, substr(message, 1, 300) as msg, intent FROM conversation_memory WHERE sender_id = 'zalo:r5_debug' ORDER BY id`).all();
rows.forEach(r => console.log((r.role === 'user' ? '👤' : '🤖') + ' [' + (r.intent || '-') + '] ' + r.msg));
const c = db.prepare(`SELECT phone, name FROM customer_contacts WHERE sender_id = 'zalo:r5_debug'`).get();
if (c) console.log('SAVED:', JSON.stringify(c));
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

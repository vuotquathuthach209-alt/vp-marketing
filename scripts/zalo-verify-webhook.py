"""Verify webhook actually processes incoming messages through bot."""
import sys
import os
import time
import paramiko

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

HOST = "103.82.193.74"
USER = "root"
PASSWORD = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("VPS_PASSWORD", "")

# Send fake webhook + check logs
CMD = r"""
cd /opt/vp-marketing

# Clear recent logs first
pm2 flush vp-mkt > /dev/null 2>&1 || true
sleep 1

# Send fake webhook
echo '--- sending fake webhook ---'
curl -s -w 'HTTP %{http_code}\n' -X POST http://127.0.0.1:3000/webhook/zalo \
  -H 'Content-Type: application/json' \
  -d '{"oa_id":"328738126716568694","event_name":"user_send_text","sender":{"id":"verify_user_123"},"message":{"text":"Sonder co con phong gan san bay khong"},"timestamp":"1713700000000"}'

# Wait for async processing
echo '--- waiting 4s for async processing ---'
sleep 4

# Grep recent logs
echo '--- recent logs ---'
pm2 logs vp-mkt --raw --lines 30 --nostream 2>&1 | grep -iE 'zalo|verify_user|smart' | head -20

# Check DB for message
echo '--- conversation_memory ---'
cat > tmp-check.js <<'JS'
const Database = require('better-sqlite3');
const db = new Database('data/db.sqlite');
const rows = db.prepare(`SELECT id, sender_id, role, substr(message,1,80) as msg, intent, created_at FROM conversation_memory WHERE sender_id LIKE 'zalo:verify_user_%' ORDER BY id DESC LIMIT 5`).all();
console.log(JSON.stringify(rows, null, 2));
db.close();
JS
node tmp-check.js
rm -f tmp-check.js
"""

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, username=USER, password=PASSWORD, timeout=15, look_for_keys=False, allow_agent=False)
stdin, stdout, stderr = client.exec_command(CMD, timeout=60)
print(stdout.read().decode("utf-8", errors="replace"))
err = stderr.read().decode("utf-8", errors="replace")
if err.strip(): print("STDERR:\n" + err, file=sys.stderr)
client.close()

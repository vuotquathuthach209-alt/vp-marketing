"""Test v15 single scenario."""
import sys, paramiko, time
try: sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except: pass
HOST = "103.82.193.74"
PASSWORD = sys.argv[1] if len(sys.argv) > 1 else ""

# Use a single CMD that handles all scenarios with bash array
CMD = r"""
cd /opt/vp-marketing

SCENARIOS=(
  "Chinh sach huy phong the nao"
  "Check-in som duoc khong"
  "Co ma khuyen mai khong"
  "Cuoi tuan co dat hon khong"
  "O 14 dem co giam khong"
  "Le 30/4 gia the nao"
  "Khach VIP co uu dai gi"
)

for i in "${!SCENARIOS[@]}"; do
  MSG="${SCENARIOS[$i]}"
  SENDER="v15_$i"

  cat > /opt/vp-marketing/tmp-test.js <<JS
const Database = require('better-sqlite3');
const db = new Database('data/db.sqlite');
db.prepare(\`DELETE FROM bot_conversation_state WHERE sender_id = 'zalo:$SENDER'\`).run();
db.prepare(\`DELETE FROM conversation_memory WHERE sender_id = 'zalo:$SENDER'\`).run();
db.close();
JS
  node /opt/vp-marketing/tmp-test.js

  curl -s -X POST http://127.0.0.1:3000/webhook/zalo \
    -H 'Content-Type: application/json' \
    -d '{"oa_id":"328738126716568694","event_name":"user_send_text","sender":{"id":"'$SENDER'"},"message":{"text":"'"$MSG"'"}}' > /dev/null

  sleep 6

  echo ""
  echo "--- [$i] USER: $MSG ---"
  cat > /opt/vp-marketing/tmp-test.js <<JS
const Database = require('better-sqlite3');
const db = new Database('data/db.sqlite');
const r = db.prepare(\`SELECT role, substr(message, 1, 300) as msg, intent FROM conversation_memory WHERE sender_id = 'zalo:$SENDER' ORDER BY id\`).all();
r.forEach(x => console.log((x.role === 'user' ? '👤' : '🤖') + ' [' + (x.intent||'-') + '] ' + x.msg));
db.close();
JS
  node /opt/vp-marketing/tmp-test.js
done
rm -f /opt/vp-marketing/tmp-test.js
"""

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, username="root", password=PASSWORD, timeout=15)
_, stdout, stderr = client.exec_command(CMD, timeout=120)
print(stdout.read().decode('utf-8', errors='replace'))
err = stderr.read().decode('utf-8', errors='replace')
if err.strip(): print('STDERR:', err[:500])
client.close()

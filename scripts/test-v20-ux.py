"""Test v20 UX fixes: chọn-in-show-results, correction, clear-signals."""
import sys, paramiko, time
try: sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except: pass
HOST = "103.82.193.74"
PASSWORD = sys.argv[1] if len(sys.argv) > 1 else ""

CMD = r"""
cd /opt/vp-marketing

run_scenario() {
  local SENDER=$1
  local -n MSGS=$2

  cat > tmp.js <<JS
const Database = require('better-sqlite3');
const db = new Database('data/db.sqlite');
db.prepare(\`DELETE FROM bot_conversation_state WHERE sender_id = 'zalo:$SENDER'\`).run();
db.prepare(\`DELETE FROM conversation_memory WHERE sender_id = 'zalo:$SENDER'\`).run();
db.close();
JS
  node tmp.js; rm -f tmp.js

  for MSG in "${MSGS[@]}"; do
    echo "  👤 $MSG"
    curl -s -X POST http://127.0.0.1:3000/webhook/zalo \
      -H 'Content-Type: application/json' \
      -d "{\"oa_id\":\"328738126716568694\",\"event_name\":\"user_send_text\",\"sender\":{\"id\":\"$SENDER\"},\"message\":{\"text\":\"$MSG\"}}" > /dev/null
    sleep 5
  done

  cat > tmp.js <<JS
const Database = require('better-sqlite3');
const db = new Database('data/db.sqlite');
const msgs = db.prepare(\`SELECT role, substr(message, 1, 250) as msg, intent FROM conversation_memory WHERE sender_id = 'zalo:$SENDER' ORDER BY id\`).all();
msgs.forEach(m => {
  if (m.role === 'bot') console.log('  🤖 [' + (m.intent||'-') + '] ' + m.msg);
});
db.close();
JS
  node tmp.js; rm -f tmp.js
}

echo "=========================================="
echo "SCENARIO 1: 'chọn 1' ở SHOW_RESULTS (short-circuit)"
echo "=========================================="
MSGS1=(
  "Đặt homestay 5/5 2 khách 1 triệu Tân Bình"
  "chọn 1"
)
run_scenario "v20ux_1" MSGS1

echo ""
echo "=========================================="
echo "SCENARIO 2: Correction 'không phải, 4 khách'"
echo "=========================================="
MSGS2=(
  "Đặt homestay 5/5 2 khách"
  "không phải 2, là 4 khách"
)
run_scenario "v20ux_2" MSGS2

echo ""
echo "=========================================="
echo "SCENARIO 3: Clear budget 'bỏ budget, không giới hạn'"
echo "=========================================="
MSGS3=(
  "Đặt homestay 5/5 2 khách budget 500k"
  "bỏ budget, không giới hạn tiền"
)
run_scenario "v20ux_3" MSGS3

echo ""
echo "=========================================="
echo "SCENARIO 4: Clear area 'bất kỳ khu nào'"
echo "=========================================="
MSGS4=(
  "Đặt homestay 5/5 2 khách budget 1 triệu Tân Bình"
  "đổi lại, bất kỳ khu nào cũng được"
)
run_scenario "v20ux_4" MSGS4
"""

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, username="root", password=PASSWORD, timeout=15)
_, stdout, stderr = client.exec_command(CMD, timeout=180)
print(stdout.read().decode('utf-8', errors='replace'))
err = stderr.read().decode('utf-8', errors='replace')
if err.strip(): print('STDERR:', err[:500])
client.close()

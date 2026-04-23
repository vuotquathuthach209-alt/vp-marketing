"""Test v20 infinite loop fix: simulate khách từ chối cho SĐT nhiều lần."""
import sys, paramiko, time
try: sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except: pass
HOST = "103.82.193.74"
PASSWORD = sys.argv[1] if len(sys.argv) > 1 else ""

CMD = r"""
cd /opt/vp-marketing

# Clean test sender
cat > tmp.js <<'JS'
const Database = require('better-sqlite3');
const db = new Database('data/db.sqlite');
['zalo:v20_loop'].forEach(s => {
  db.prepare(`DELETE FROM bot_conversation_state WHERE sender_id = ?`).run(s);
  db.prepare(`DELETE FROM conversation_memory WHERE sender_id = ?`).run(s);
});
db.close();
JS
node tmp.js; rm -f tmp.js

echo "=== Simulate stuck loop: khách đặt phòng xong từ chối cho SĐT ==="
# Step 1: Provide full info → reach SHOW_RESULTS → PROPERTY_PICKED → ... → CLOSING_CONTACT
MESSAGES=(
  "Đặt homestay ngày 5/5 2 khách budget 1 triệu khu Tân Bình"
  "chọn 1"
  "chọn cái đầu"
  "ok đặt phòng"
  "không muốn cho SĐT"
  "không cần"
  "thôi em tự đặt"
  "đừng hỏi nữa"
)

for MSG in "${MESSAGES[@]}"; do
  echo ""
  echo "--- USER: $MSG ---"
  curl -s -X POST http://127.0.0.1:3000/webhook/zalo \
    -H 'Content-Type: application/json' \
    -d '{"oa_id":"328738126716568694","event_name":"user_send_text","sender":{"id":"v20_loop"},"message":{"text":"'"$MSG"'"}}' > /dev/null
  sleep 5
done

echo ""
echo "=== Final conversation + state ==="
cat > tmp.js <<'JS'
const Database = require('better-sqlite3');
const db = new Database('data/db.sqlite');
const msgs = db.prepare(`SELECT role, substr(message, 1, 200) as msg, intent FROM conversation_memory WHERE sender_id = 'zalo:v20_loop' ORDER BY id`).all();
msgs.forEach(m => console.log((m.role === 'user' ? '👤' : '🤖') + ' [' + (m.intent||'-') + '] ' + m.msg));
const st = db.prepare(`SELECT stage, same_stage_count, handed_off, turns_since_extract FROM bot_conversation_state WHERE sender_id = 'zalo:v20_loop'`).get();
console.log('\n=== Final state ===');
console.log('  stage:', st?.stage);
console.log('  same_stage_count:', st?.same_stage_count);
console.log('  handed_off:', st?.handed_off);
console.log('  turns_since_extract:', st?.turns_since_extract);
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
if err.strip(): print('STDERR:', err[:500])
client.close()

"""Test FSM flow đầy đủ: budget → results → pick → rooms → confirm → close."""
import sys, os, paramiko
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception: pass

HOST = "103.82.193.74"; USER = "root"
PASSWORD = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("VPS_PASSWORD", "")

CMD = r"""
cd /opt/vp-marketing
cat > tmp.js <<'JS'
const Database = require('better-sqlite3');
const db = new Database('data/db.sqlite');
try {
  const r1 = db.prepare(`DELETE FROM conversation_memory WHERE sender_id LIKE 'zalo:test_fsm_%'`).run();
  const r2 = db.prepare(`DELETE FROM bot_conversation_state WHERE sender_id LIKE 'zalo:test_fsm_%'`).run();
  console.log('Cleaned conv=' + r1.changes + ', state=' + r2.changes);
} catch (e) {}
db.close();
JS
node tmp.js
rm -f tmp.js

SENDER="test_fsm_full"
MESSAGES=(
  "chào"
  "homestay"
  "tân bình"
  "cuối tuần"
  "2 người"
  "dưới 1 triệu"
  "lấy số 1"
  "standard"
  "đúng rồi đặt luôn"
  "Hùng Nguyễn, 0909123456"
)

for MSG in "${MESSAGES[@]}"; do
  echo ""
  echo "--- USER: $MSG ---"
  curl -s -X POST http://127.0.0.1:3000/webhook/zalo \
    -H 'Content-Type: application/json' \
    -d "{\"oa_id\":\"328738126716568694\",\"event_name\":\"user_send_text\",\"sender\":{\"id\":\"$SENDER\"},\"message\":{\"text\":\"$MSG\"}}" > /dev/null
  sleep 2
done
sleep 3

echo
echo "=== FINAL CONVERSATION ==="
cat > tmp.js <<'JS'
const Database = require('better-sqlite3');
const db = new Database('data/db.sqlite');
const rows = db.prepare(`SELECT role, substr(message,1,800) as msg, intent FROM conversation_memory WHERE sender_id = 'zalo:test_fsm_full' ORDER BY id ASC`).all();
rows.forEach(r => {
  const icon = r.role === 'user' ? '👤' : '🤖';
  console.log(`${icon} [${r.intent || '-'}]`);
  console.log(r.msg);
  console.log('');
});

console.log('=== FINAL STATE ===');
const s = db.prepare(`SELECT stage, slots FROM bot_conversation_state WHERE sender_id = 'zalo:test_fsm_full'`).get();
if (s) {
  console.log('Stage:', s.stage);
  console.log('Slots:', JSON.stringify(JSON.parse(s.slots), null, 2));
}

console.log('\n=== BOT_BOOKING_DRAFTS ===');
try {
  const pb = db.prepare(`SELECT * FROM bot_booking_drafts WHERE sender_id = 'zalo:test_fsm_full' ORDER BY id DESC LIMIT 1`).get();
  if (pb) console.log(JSON.stringify(pb, null, 2));
  else console.log('(none yet)');
} catch(e) { console.log('err:', e.message); }

db.close();
JS
node tmp.js
rm -f tmp.js
"""

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, username=USER, password=PASSWORD, timeout=15, look_for_keys=False, allow_agent=False)
stdin, stdout, stderr = client.exec_command(CMD, timeout=180)
print(stdout.read().decode("utf-8", errors="replace"))
err = stderr.read().decode("utf-8", errors="replace")
if err.strip(): print("STDERR:\n" + err, file=sys.stderr)
client.close()

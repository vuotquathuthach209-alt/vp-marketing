"""Test 5 CTO fixes + returning customer với same scenario trong screenshot."""
import sys, os, paramiko
try: sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except: pass

HOST = "103.82.193.74"
PASSWORD = sys.argv[1] if len(sys.argv) > 1 else ""

CMD = r"""
cd /opt/vp-marketing
# Clean test state
cat > tmp.js <<'JS'
const Database = require('better-sqlite3');
const db = new Database('data/db.sqlite');
db.prepare(`DELETE FROM bot_conversation_state WHERE sender_id LIKE 'zalo:test_cto_%'`).run();
db.prepare(`DELETE FROM conversation_memory WHERE sender_id LIKE 'zalo:test_cto_%'`).run();
db.prepare(`DELETE FROM customer_memory WHERE sender_id LIKE 'zalo:test_cto_%'`).run();
db.close();
console.log('cleaned');
JS
node tmp.js
rm -f tmp.js

# Replay scenario từ screenshot
SENDER="test_cto_1"
MESSAGES=("Có khách sạn không bạn" "Có khách sạn nào ở tân bình không" "Khách sạn tân bình gần sân bay")

for MSG in "${MESSAGES[@]}"; do
  echo ""
  echo "--- USER: $MSG ---"
  curl -s -X POST http://127.0.0.1:3000/webhook/zalo \
    -H 'Content-Type: application/json' \
    -d "{\"oa_id\":\"328738126716568694\",\"event_name\":\"user_send_text\",\"sender\":{\"id\":\"$SENDER\"},\"message\":{\"text\":\"$MSG\"}}" > /dev/null
  sleep 3
done

echo ""
echo "=== FINAL CONVERSATION ==="
cat > tmp.js <<'JS'
const Database = require('better-sqlite3');
const db = new Database('data/db.sqlite');
const rows = db.prepare(`SELECT role, substr(message, 1, 800) as msg, intent FROM conversation_memory WHERE sender_id = 'zalo:test_cto_1' ORDER BY id ASC`).all();
rows.forEach(r => {
  console.log((r.role === 'user' ? '👤' : '🤖') + ' [' + (r.intent || '-') + ']');
  console.log(r.msg);
  console.log('');
});

console.log('=== STATE ===');
const s = db.prepare(`SELECT stage, same_stage_count, turns_since_extract, slots FROM bot_conversation_state WHERE sender_id = 'zalo:test_cto_1'`).get();
if (s) {
  console.log('Stage:', s.stage);
  console.log('same_stage_count:', s.same_stage_count, '| turns_since_extract:', s.turns_since_extract);
  console.log('Slots:', JSON.stringify(JSON.parse(s.slots), null, 2));
}
db.close();
JS
node tmp.js
rm -f tmp.js
"""

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, username="root", password=PASSWORD, timeout=15)
_, stdout, stderr = client.exec_command(CMD, timeout=120)
print(stdout.read().decode("utf-8", errors="replace"))
err = stderr.read().decode("utf-8", errors="replace")
if err.strip(): print("STDERR:\n" + err, file=sys.stderr)
client.close()

"""Test marketplace bot flow: greeting → property type → list."""
import sys, os, paramiko
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception: pass

HOST = "103.82.193.74"; USER = "root"
PASSWORD = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("VPS_PASSWORD", "")

CMD = r"""
cd /opt/vp-marketing
# Clean old test conversations
cat > tmp-clean.js <<'JS'
const Database = require('better-sqlite3');
const db = new Database('data/db.sqlite');
db.prepare("DELETE FROM conversation_memory WHERE sender_id LIKE 'zalo:test_bot_%'").run();
db.close();
console.log('cleaned');
JS
node tmp-clean.js
rm -f tmp-clean.js

# Simulate user messages one by one
for MSG in "Chào bạn" "Mình muốn tìm khách sạn gần sân bay" "còn phòng đêm nay không?"; do
  echo ""
  echo "--- USER: $MSG ---"
  curl -s -X POST http://127.0.0.1:3000/webhook/zalo \
    -H 'Content-Type: application/json' \
    -d "{\"oa_id\":\"328738126716568694\",\"event_name\":\"user_send_text\",\"sender\":{\"id\":\"test_bot_mp1\"},\"message\":{\"text\":\"$MSG\"},\"timestamp\":\"$(date +%s000)\"}" > /dev/null
  sleep 3
done

echo ""
echo "=== Conversation log ==="
cat > tmp-log.js <<'JS'
const Database = require('better-sqlite3');
const db = new Database('data/db.sqlite');
const rows = db.prepare(`SELECT role, substr(message,1,500) as msg, intent, created_at FROM conversation_memory WHERE sender_id = 'zalo:test_bot_mp1' ORDER BY id ASC`).all();
rows.forEach(r => {
  const icon = r.role === 'user' ? '👤' : '🤖';
  console.log(`${icon} [${r.intent || '-'}] ${r.msg}`);
  console.log('');
});
db.close();
JS
node tmp-log.js
rm -f tmp-log.js
"""

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, username=USER, password=PASSWORD, timeout=15, look_for_keys=False, allow_agent=False)
stdin, stdout, stderr = client.exec_command(CMD, timeout=60)
print(stdout.read().decode("utf-8", errors="replace"))
err = stderr.read().decode("utf-8", errors="replace")
if err.strip(): print("STDERR:\n" + err, file=sys.stderr)
client.close()

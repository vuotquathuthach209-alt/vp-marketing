"""Deploy Day 4-5 + enable USE_NEW_FUNNEL=true + live test."""
import sys, os, paramiko
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception: pass

HOST = "103.82.193.74"; USER = "root"
PASSWORD = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("VPS_PASSWORD", "")

CMD = r"""
cd /opt/vp-marketing

echo '=== 1. Pull + build ==='
git pull --ff-only 2>&1 | tail -5
npx tsc 2>&1 | tail -5

echo
echo '=== 2. Enable USE_NEW_FUNNEL=true in .env ==='
if grep -q '^USE_NEW_FUNNEL=' .env 2>/dev/null; then
  sed -i 's/^USE_NEW_FUNNEL=.*/USE_NEW_FUNNEL=true/' .env
  echo 'Updated existing line'
else
  echo 'USE_NEW_FUNNEL=true' >> .env
  echo 'Added new line'
fi
grep '^USE_NEW_FUNNEL' .env

echo
echo '=== 3. Restart PM2 with env refresh ==='
pm2 restart vp-mkt --update-env 2>&1 | tail -3
sleep 2
pm2 list | grep vp-mkt

echo
echo '=== 4. Clear existing test conversation state ==='
cat > tmp.js <<'JS'
const Database = require('better-sqlite3');
const db = new Database('data/db.sqlite');
try {
  const r = db.prepare(`DELETE FROM bot_conversation_state WHERE sender_id LIKE 'zalo:test_fsm_%'`).run();
  console.log('Cleaned', r.changes, 'state rows');
} catch (e) { console.log('err:', e.message); }
db.close();
JS
node tmp.js
rm -f tmp.js

echo
echo '=== 5. Simulate user chat — 5 messages (FSM flow) ==='
SENDER="test_fsm_u1"
for MSG in "Chào bạn" "Mình cần homestay" "Tân Bình" "Cuối tuần" "2 người"; do
  echo ""
  echo "--- USER: $MSG ---"
  curl -s -X POST http://127.0.0.1:3000/webhook/zalo \
    -H 'Content-Type: application/json' \
    -d "{\"oa_id\":\"328738126716568694\",\"event_name\":\"user_send_text\",\"sender\":{\"id\":\"$SENDER\"},\"message\":{\"text\":\"$MSG\"}}" > /dev/null
  sleep 2
done
sleep 2

echo
echo '=== 6. Show conversation log ==='
cat > tmp.js <<'JS'
const Database = require('better-sqlite3');
const db = new Database('data/db.sqlite');
const rows = db.prepare(`
  SELECT role, substr(message, 1, 500) as msg, intent, created_at
  FROM conversation_memory
  WHERE sender_id = 'zalo:test_fsm_u1'
  ORDER BY id ASC
`).all();
rows.forEach(r => {
  const icon = r.role === 'user' ? '👤' : '🤖';
  console.log(`${icon} [${r.intent || '-'}] ${r.msg}`);
  console.log('');
});

console.log('=== State ===');
const state = db.prepare(`SELECT stage, slots, turn_count, turns_since_extract FROM bot_conversation_state WHERE sender_id = 'zalo:test_fsm_u1'`).get();
console.log(JSON.stringify(state, null, 2));
db.close();
JS
node tmp.js
rm -f tmp.js
"""

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, username=USER, password=PASSWORD, timeout=15, look_for_keys=False, allow_agent=False)
stdin, stdout, stderr = client.exec_command(CMD, timeout=300)
print(stdout.read().decode("utf-8", errors="replace"))
err = stderr.read().decode("utf-8", errors="replace")
if err.strip(): print("STDERR:\n" + err, file=sys.stderr)
client.close()

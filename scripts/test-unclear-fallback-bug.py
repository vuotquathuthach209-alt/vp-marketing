"""Reproduce scenario screenshot: user gõ 'Chào bạn' khi bot đang ở UNCLEAR_FALLBACK."""
import sys, os, paramiko
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
db.prepare(`DELETE FROM bot_conversation_state WHERE sender_id = 'zalo:bug_test'`).run();
db.prepare(`DELETE FROM conversation_memory WHERE sender_id = 'zalo:bug_test'`).run();
db.close();
console.log('cleaned');
JS
node tmp.js
rm -f tmp.js

SENDER="bug_test"

# Turn 1: Force bot into UNCLEAR_FALLBACK bằng cách hỏi "khách sạn" 2-3 lần
echo ""
echo "━━━ Turn 1: 'có khách sạn không' ━━━"
curl -s -X POST http://127.0.0.1:3000/webhook/zalo \
  -H 'Content-Type: application/json' \
  -d "{\"oa_id\":\"328738126716568694\",\"event_name\":\"user_send_text\",\"sender\":{\"id\":\"$SENDER\"},\"message\":{\"text\":\"có khách sạn không\"}}" > /dev/null
sleep 2

echo ""
echo "━━━ Turn 2: 'khách sạn 4 sao' (lần 2 → UNCLEAR_FALLBACK) ━━━"
curl -s -X POST http://127.0.0.1:3000/webhook/zalo \
  -H 'Content-Type: application/json' \
  -d "{\"oa_id\":\"328738126716568694\",\"event_name\":\"user_send_text\",\"sender\":{\"id\":\"$SENDER\"},\"message\":{\"text\":\"khách sạn 4 sao gần sân bay\"}}" > /dev/null
sleep 2

# Check state
cat > tmp.js <<'JS'
const Database = require('better-sqlite3');
const db = new Database('data/db.sqlite');
const s = db.prepare(`SELECT stage, same_stage_count FROM bot_conversation_state WHERE sender_id = 'zalo:bug_test'`).get();
console.log(`  State after turn 2: stage=${s.stage}, same_stage_count=${s.same_stage_count}`);
db.close();
JS
node tmp.js
rm -f tmp.js

# Turn 3: User gõ "Chào bạn" (fresh greeting) — EXPECT: bot reset + greet fresh
echo ""
echo "━━━ Turn 3: 'Chào bạn' (EXPECT reset + fresh greeting) ━━━"
curl -s -X POST http://127.0.0.1:3000/webhook/zalo \
  -H 'Content-Type: application/json' \
  -d "{\"oa_id\":\"328738126716568694\",\"event_name\":\"user_send_text\",\"sender\":{\"id\":\"$SENDER\"},\"message\":{\"text\":\"Chào bạn\"}}" > /dev/null
sleep 2

# Turn 4: User cung cấp slot → escape UNCLEAR
echo ""
echo "━━━ Turn 4: 'homestay tân bình' (EXPECT continue flow) ━━━"
curl -s -X POST http://127.0.0.1:3000/webhook/zalo \
  -H 'Content-Type: application/json' \
  -d "{\"oa_id\":\"328738126716568694\",\"event_name\":\"user_send_text\",\"sender\":{\"id\":\"$SENDER\"},\"message\":{\"text\":\"homestay tân bình\"}}" > /dev/null
sleep 2

# Show all replies
echo ""
echo "=== CONVERSATION TRACE ==="
cat > tmp.js <<'JS'
const Database = require('better-sqlite3');
const db = new Database('data/db.sqlite');
const rows = db.prepare(`SELECT role, substr(message, 1, 500) as msg, intent FROM conversation_memory WHERE sender_id = 'zalo:bug_test' ORDER BY id ASC`).all();
rows.forEach(r => {
  const icon = r.role === 'user' ? '👤' : '🤖';
  console.log(`${icon} [${r.intent || '-'}]`);
  console.log(`   ${r.msg.replace(/\n/g, ' ')}`);
  console.log('');
});
const finalState = db.prepare(`SELECT stage, slots, same_stage_count FROM bot_conversation_state WHERE sender_id = 'zalo:bug_test'`).get();
if (finalState) {
  console.log(`FINAL STATE: stage=${finalState.stage}, same_stage_count=${finalState.same_stage_count}`);
  console.log(`slots=`, finalState.slots);
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

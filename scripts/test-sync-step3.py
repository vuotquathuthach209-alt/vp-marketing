"""Test sync hub step 3: bot integration — 24h cutoff + availability filter + hết phòng."""
import sys, paramiko
try: sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except: pass

HOST = "103.82.193.74"
PASSWORD = sys.argv[1] if len(sys.argv) > 1 else ""

CMD = r"""
cd /opt/vp-marketing

echo "=== Scenario A: 24h cutoff — khách hỏi book tối nay ==="
cat > tmp.js <<'JS'
const Database = require('better-sqlite3');
const db = new Database('data/db.sqlite');
['zalo:cutoff_test'].forEach(s => {
  db.prepare(`DELETE FROM bot_conversation_state WHERE sender_id = ?`).run(s);
  db.prepare(`DELETE FROM conversation_memory WHERE sender_id = ?`).run(s);
});
db.close();
JS
node tmp.js; rm -f tmp.js

# Today's date = tonight check-in < 24h
TODAY=$(date -d 'today 14:00' +%Y-%m-%d)
echo "Check-in today: $TODAY"
curl -s -X POST http://127.0.0.1:3000/webhook/zalo \
  -H 'Content-Type: application/json' \
  -d "{\"oa_id\":\"328738126716568694\",\"event_name\":\"user_send_text\",\"sender\":{\"id\":\"cutoff_test\"},\"message\":{\"text\":\"đặt phòng homestay 2 người tối nay\"}}" > /dev/null
sleep 4

cat > tmp.js <<'JS'
const Database = require('better-sqlite3');
const db = new Database('data/db.sqlite');
const msgs = db.prepare(`SELECT role, substr(message, 1, 200) as msg, intent FROM conversation_memory WHERE sender_id = 'zalo:cutoff_test' ORDER BY id`).all();
msgs.forEach(m => console.log((m.role === 'user' ? '👤' : '🤖') + ' [' + (m.intent||'-') + '] ' + m.msg));
db.close();
JS
node tmp.js; rm -f tmp.js

echo ""
echo "=== Scenario B: 30/4 peak date — nhiều hotels hết phòng ==="
cat > tmp.js <<'JS'
const Database = require('better-sqlite3');
const db = new Database('data/db.sqlite');
['zalo:peak_test'].forEach(s => {
  db.prepare(`DELETE FROM bot_conversation_state WHERE sender_id = ?`).run(s);
  db.prepare(`DELETE FROM conversation_memory WHERE sender_id = ?`).run(s);
});
// FORCE 30/4/2026 availability = 0 for all hotels
const r = db.prepare(`UPDATE sync_availability SET available_rooms = 0 WHERE date_str = '2026-04-30'`).run();
console.log('Set 30/4 to 0:', r.changes, 'rows');
db.close();
JS
node tmp.js; rm -f tmp.js

curl -s -X POST http://127.0.0.1:3000/webhook/zalo \
  -H 'Content-Type: application/json' \
  -d '{"oa_id":"328738126716568694","event_name":"user_send_text","sender":{"id":"peak_test"},"message":{"text":"đặt homestay ngày 30/4 2 người"}}' > /dev/null
sleep 5

cat > tmp.js <<'JS'
const Database = require('better-sqlite3');
const db = new Database('data/db.sqlite');
const msgs = db.prepare(`SELECT role, substr(message, 1, 400) as msg, intent FROM conversation_memory WHERE sender_id = 'zalo:peak_test' ORDER BY id`).all();
msgs.forEach(m => console.log((m.role === 'user' ? '👤' : '🤖') + ' [' + (m.intent||'-') + '] ' + m.msg));
db.close();
JS
node tmp.js; rm -f tmp.js

echo ""
echo "=== Scenario C: Ngày bình thường còn phòng (8/5) ==="
cat > tmp.js <<'JS'
const Database = require('better-sqlite3');
const db = new Database('data/db.sqlite');
['zalo:normal_test'].forEach(s => {
  db.prepare(`DELETE FROM bot_conversation_state WHERE sender_id = ?`).run(s);
  db.prepare(`DELETE FROM conversation_memory WHERE sender_id = ?`).run(s);
});
// Ensure 8/5 has availability
const cnt = db.prepare(`SELECT COUNT(*) as n FROM sync_availability WHERE date_str = '2026-05-08' AND available_rooms > 0`).get();
console.log('8/5 rows with availability > 0:', cnt.n);
db.close();
JS
node tmp.js; rm -f tmp.js

curl -s -X POST http://127.0.0.1:3000/webhook/zalo \
  -H 'Content-Type: application/json' \
  -d '{"oa_id":"328738126716568694","event_name":"user_send_text","sender":{"id":"normal_test"},"message":{"text":"đặt homestay 8/5 2 người"}}' > /dev/null
sleep 5

cat > tmp.js <<'JS'
const Database = require('better-sqlite3');
const db = new Database('data/db.sqlite');
const msgs = db.prepare(`SELECT role, substr(message, 1, 300) as msg, intent FROM conversation_memory WHERE sender_id = 'zalo:normal_test' ORDER BY id`).all();
msgs.forEach(m => console.log((m.role === 'user' ? '👤' : '🤖') + ' [' + (m.intent||'-') + '] ' + m.msg));
db.close();
JS
node tmp.js; rm -f tmp.js
"""

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, username="root", password=PASSWORD, timeout=15)
_, stdout, stderr = client.exec_command(CMD, timeout=90)
print(stdout.read().decode("utf-8", errors="replace"))
err = stderr.read().decode("utf-8", errors="replace")
if err.strip(): print("STDERR:\n" + err, file=sys.stderr)
client.close()

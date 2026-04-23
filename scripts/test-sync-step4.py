"""Test step 4: re-seed 30 days + test with FULL slots (reach SHOW_RESULTS)."""
import sys, paramiko
try: sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except: pass

HOST = "103.82.193.74"
PASSWORD = sys.argv[1] if len(sys.argv) > 1 else ""

CMD = r"""
cd /opt/vp-marketing

echo "=== Re-seed with 30 days ==="
cat > tmp.js <<'JS'
const { clearSeedData, seedAvailability } = require('./dist/services/sync-hub-seed');
clearSeedData();
const r = seedAvailability({ days: 30 });
console.log(JSON.stringify(r));
JS
node tmp.js; rm -f tmp.js

echo ""
echo "=== Scenario A: đặt hôm nay + đầy đủ info → trigger 24h cutoff ==="
cat > tmp.js <<'JS'
const Database = require('better-sqlite3');
const db = new Database('data/db.sqlite');
['zalo:cut24_test'].forEach(s => {
  db.prepare(`DELETE FROM bot_conversation_state WHERE sender_id = ?`).run(s);
  db.prepare(`DELETE FROM conversation_memory WHERE sender_id = ?`).run(s);
});
db.close();
JS
node tmp.js; rm -f tmp.js

curl -s -X POST http://127.0.0.1:3000/webhook/zalo \
  -H 'Content-Type: application/json' \
  -d '{"oa_id":"328738126716568694","event_name":"user_send_text","sender":{"id":"cut24_test"},"message":{"text":"book homestay tối nay 2 người budget 1 triệu khu Tân Bình"}}' > /dev/null
sleep 6

cat > tmp.js <<'JS'
const Database = require('better-sqlite3');
const db = new Database('data/db.sqlite');
const msgs = db.prepare(`SELECT role, substr(message, 1, 500) as msg, intent FROM conversation_memory WHERE sender_id = 'zalo:cut24_test' ORDER BY id`).all();
msgs.forEach(m => console.log((m.role === 'user' ? '👤' : '🤖') + ' [' + (m.intent||'-') + '] ' + m.msg));
db.close();
JS
node tmp.js; rm -f tmp.js

echo ""
echo "=== Scenario B: đặt 30/4 peak (force all 0) + đầy đủ info ==="
cat > tmp.js <<'JS'
const Database = require('better-sqlite3');
const db = new Database('data/db.sqlite');
['zalo:peak_test2'].forEach(s => {
  db.prepare(`DELETE FROM bot_conversation_state WHERE sender_id = ?`).run(s);
  db.prepare(`DELETE FROM conversation_memory WHERE sender_id = ?`).run(s);
});
// Force 30/4 all 0
const r = db.prepare(`UPDATE sync_availability SET available_rooms = 0 WHERE date_str = '2026-04-30'`).run();
console.log('Set 30/4 to 0:', r.changes, 'rows');
// Ensure có alternatives: 29/4, 1/5, 2/5 có phòng
db.prepare(`UPDATE sync_availability SET available_rooms = 3 WHERE date_str = '2026-04-29'`).run();
db.prepare(`UPDATE sync_availability SET available_rooms = 0 WHERE date_str = '2026-05-01'`).run();
db.prepare(`UPDATE sync_availability SET available_rooms = 5 WHERE date_str = '2026-05-02'`).run();
db.close();
JS
node tmp.js; rm -f tmp.js

curl -s -X POST http://127.0.0.1:3000/webhook/zalo \
  -H 'Content-Type: application/json' \
  -d '{"oa_id":"328738126716568694","event_name":"user_send_text","sender":{"id":"peak_test2"},"message":{"text":"homestay 30/4 2 khách budget 1 triệu Tân Bình"}}' > /dev/null
sleep 6

cat > tmp.js <<'JS'
const Database = require('better-sqlite3');
const db = new Database('data/db.sqlite');
const msgs = db.prepare(`SELECT role, substr(message, 1, 500) as msg, intent FROM conversation_memory WHERE sender_id = 'zalo:peak_test2' ORDER BY id`).all();
msgs.forEach(m => console.log((m.role === 'user' ? '👤' : '🤖') + ' [' + (m.intent||'-') + '] ' + m.msg));
db.close();
JS
node tmp.js; rm -f tmp.js

echo ""
echo "=== Scenario C: 5/5 (5 ngày sau, còn phòng) + full slots ==="
cat > tmp.js <<'JS'
const Database = require('better-sqlite3');
const db = new Database('data/db.sqlite');
['zalo:normal_test2'].forEach(s => {
  db.prepare(`DELETE FROM bot_conversation_state WHERE sender_id = ?`).run(s);
  db.prepare(`DELETE FROM conversation_memory WHERE sender_id = ?`).run(s);
});
// Ensure 5/5 có phòng
db.prepare(`UPDATE sync_availability SET available_rooms = 5 WHERE date_str = '2026-05-05' AND available_rooms = 0`).run();
const cnt = db.prepare(`SELECT COUNT(*) as n FROM sync_availability WHERE date_str = '2026-05-05' AND available_rooms > 0`).get();
console.log('5/5 rows with availability > 0:', cnt.n);
db.close();
JS
node tmp.js; rm -f tmp.js

curl -s -X POST http://127.0.0.1:3000/webhook/zalo \
  -H 'Content-Type: application/json' \
  -d '{"oa_id":"328738126716568694","event_name":"user_send_text","sender":{"id":"normal_test2"},"message":{"text":"homestay 5/5 2 khách budget 1 triệu Tân Bình"}}' > /dev/null
sleep 6

cat > tmp.js <<'JS'
const Database = require('better-sqlite3');
const db = new Database('data/db.sqlite');
const msgs = db.prepare(`SELECT role, substr(message, 1, 500) as msg, intent FROM conversation_memory WHERE sender_id = 'zalo:normal_test2' ORDER BY id`).all();
msgs.forEach(m => console.log((m.role === 'user' ? '👤' : '🤖') + ' [' + (m.intent||'-') + '] ' + m.msg));
db.close();
JS
node tmp.js; rm -f tmp.js
"""

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, username="root", password=PASSWORD, timeout=15)
_, stdout, stderr = client.exec_command(CMD, timeout=120)
print(stdout.read().decode("utf-8", errors="replace"))
err = stderr.read().decode("utf-8", errors="replace")
if err.strip(): print("STDERR:\n" + err, file=sys.stderr)
client.close()

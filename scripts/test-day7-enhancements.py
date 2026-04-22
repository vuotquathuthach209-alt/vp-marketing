"""Test Day 7: urgency, returning customer, rich notify."""
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
db.prepare(`DELETE FROM bot_conversation_state WHERE sender_id LIKE 'zalo:test_day7_%'`).run();
db.prepare(`DELETE FROM conversation_memory WHERE sender_id LIKE 'zalo:test_day7_%'`).run();
// Seed: returning customer — insert past booking with same phone
db.exec(`CREATE TABLE IF NOT EXISTS bot_booking_drafts (
  id INTEGER PRIMARY KEY AUTOINCREMENT, sender_id TEXT, hotel_id INTEGER, room_id INTEGER,
  property_type TEXT, rental_mode TEXT, checkin_date TEXT, checkout_date TEXT, nights INTEGER,
  months INTEGER, guests_adults INTEGER, guests_children INTEGER, budget_min INTEGER,
  budget_max INTEGER, area TEXT, phone TEXT, name TEXT, email TEXT, slots_json TEXT,
  status TEXT DEFAULT 'new', created_at INTEGER);`);
db.prepare(`DELETE FROM bot_booking_drafts WHERE phone = '0912999888'`).run();
db.prepare(`INSERT INTO bot_booking_drafts (sender_id, hotel_id, name, phone, status, created_at)
  VALUES ('zalo:past_returning', 7, 'Nguyễn Văn An', '0912999888', 'confirmed', ?)`).run(Date.now() - 30 * 24 * 3600000);
console.log('Seeded returning customer');

// Seed urgency: 3 recent bookings for hotel 7 trong 24h qua
for (let i = 0; i < 3; i++) {
  db.prepare(`INSERT INTO bot_booking_drafts (sender_id, hotel_id, name, phone, status, created_at)
    VALUES (?, 7, ?, ?, 'new', ?)`).run('zalo:u' + i, 'Khach ' + i, '09' + String(i).padStart(9, '0'), Date.now() - i * 60000);
}
console.log('Seeded 3 recent leads');
db.close();
JS
node tmp.js
rm -f tmp.js

# Test 1: Multi-slot + returning customer (phone 0912999888 in past)
echo ""
echo "=== TEST 1: Returning customer với multi-slot ==="
MSG="Chào bạn, mình tên Nguyễn Văn An SĐT 0912999888, cần homestay gần sân bay 2 người tuần sau dưới 800k"
echo "USER: $MSG"
curl -s -X POST http://127.0.0.1:3000/webhook/zalo \
  -H 'Content-Type: application/json' \
  -d "{\"oa_id\":\"328738126716568694\",\"event_name\":\"user_send_text\",\"sender\":{\"id\":\"test_day7_returning\"},\"message\":{\"text\":\"$MSG\"}}" > /dev/null

sleep 5

cat > tmp.js <<'JS'
const Database = require('better-sqlite3');
const db = new Database('data/db.sqlite');
const r = db.prepare(`SELECT role, substr(message, 1, 800) as msg, intent FROM conversation_memory WHERE sender_id = 'zalo:test_day7_returning' ORDER BY id ASC`).all();
r.forEach(row => {
  console.log((row.role === 'user' ? '👤' : '🤖') + ' [' + (row.intent || '-') + ']');
  console.log(row.msg);
  console.log('');
});
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

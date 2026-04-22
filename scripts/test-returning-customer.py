"""Test returning customer: seed past bookings + verify personalized greeting."""
import sys, os, paramiko
try: sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except: pass

HOST = "103.82.193.74"
PASSWORD = sys.argv[1] if len(sys.argv) > 1 else ""

CMD = r"""
cd /opt/vp-marketing
# Seed: customer đã book 3 lần confirmed (regular tier)
cat > tmp.js <<'JS'
const Database = require('better-sqlite3');
const db = new Database('data/db.sqlite');
const sender = 'zalo:test_returning_vip';

// Ensure customer_memory table exists by requiring the service
require('./dist/services/customer-memory');

// Clean
db.prepare(`DELETE FROM bot_conversation_state WHERE sender_id = ?`).run(sender);
db.prepare(`DELETE FROM conversation_memory WHERE sender_id = ?`).run(sender);
db.prepare(`DELETE FROM customer_memory WHERE sender_id = ?`).run(sender);
db.prepare(`DELETE FROM bot_booking_drafts WHERE sender_id = ?`).run(sender);

// Seed 3 past confirmed bookings
const now = Date.now();
for (let i = 0; i < 3; i++) {
  db.prepare(`INSERT INTO bot_booking_drafts
    (sender_id, hotel_id, property_type, area, guests_adults, nights, phone, name, status, created_at, budget_max)
    VALUES (?, 7, 'homestay', 'Tân Bình', 2, 2, '0912345678', 'Nguyễn Văn An', 'confirmed', ?, 800000)`)
    .run(sender, now - (i + 1) * 30 * 86400000);
}
console.log('Seeded 3 past bookings for returning customer');

// Rebuild customer profile
const { rebuildCustomerProfile } = require('./dist/services/customer-memory');
rebuildCustomerProfile(sender);

// Show profile
const p = db.prepare(`SELECT * FROM customer_memory WHERE sender_id = ?`).get(sender);
console.log('Profile:', JSON.stringify(p, null, 2));
db.close();
JS
node tmp.js
rm -f tmp.js

echo ""
echo "=== Chat thử lần đầu của returning customer ==="
curl -s -X POST http://127.0.0.1:3000/webhook/zalo \
  -H 'Content-Type: application/json' \
  -d '{"oa_id":"328738126716568694","event_name":"user_send_text","sender":{"id":"test_returning_vip"},"message":{"text":"Chào bạn"}}' > /dev/null

sleep 3

cat > tmp.js <<'JS'
const Database = require('better-sqlite3');
const db = new Database('data/db.sqlite');
const rows = db.prepare(`SELECT role, substr(message, 1, 800) as msg, intent FROM conversation_memory WHERE sender_id = 'zalo:test_returning_vip' ORDER BY id ASC`).all();
rows.forEach(r => {
  console.log((r.role === 'user' ? '👤' : '🤖') + ' [' + (r.intent || '-') + ']');
  console.log(r.msg);
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

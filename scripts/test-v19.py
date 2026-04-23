"""Test v19 attribution + dashboard."""
import sys, paramiko
try: sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except: pass
HOST = "103.82.193.74"
PASSWORD = sys.argv[1] if len(sys.argv) > 1 else ""

CMD = r"""
cd /opt/vp-marketing

echo "=== 1. Verify tables ==="
cat > tmp.js <<'JS'
const Database = require('better-sqlite3');
const db = new Database('data/db.sqlite');
['revenue_events', 'attribution_links', 'customer_ltv'].forEach(t => {
  const cols = db.prepare(`PRAGMA table_info(${t})`).all();
  console.log('  ' + t + ': ' + cols.length + ' cols');
});
db.close();
JS
node tmp.js; rm -f tmp.js

echo ""
echo "=== 2. Seed a fake confirmed booking + trigger attribution ==="
cat > tmp.js <<'JS'
const Database = require('better-sqlite3');
const db = new Database('data/db.sqlite');
const now = Date.now();

// Create fake sync_booking confirmed
const r = db.prepare(`
  INSERT INTO sync_bookings (hotel_id, source, source_ref, room_type_code, checkin_date, checkout_date,
    nights, guests, total_price, deposit_amount, deposit_paid, customer_name, customer_phone,
    sender_id, status, created_at, updated_at)
  VALUES (1, 'bot', 'TEST19', 'DELUXE', '2026-05-10', '2026-05-12', 2, 2, 2400000, 500000, 1,
          'Nguyen Test', '0909999888', 'zalo:v19_test_' + now, 'confirmed', ?, ?)
`).run(now, now);
const bookingId = r.lastInsertRowid;
console.log('Created booking #' + bookingId);

// Seed some fake touches for this sender
const senderId = 'zalo:v19_test_' + now;

// Fake reply outcome
db.prepare(`INSERT INTO bot_reply_outcomes (hotel_id, sender_id, user_message, bot_reply, reply_source, outcome, created_at) VALUES (1, ?, 'test', 'test reply', 'generic_price', 'converted_to_lead', ?)`)
  .run(senderId, now - 2 * 24 * 3600_000);

// Fake assignment
const varRow = db.prepare(`SELECT id FROM reply_templates WHERE template_key = 'greeting_new' LIMIT 1`).get();
if (varRow) {
  db.prepare(`INSERT INTO reply_experiments (hotel_id, experiment_name, template_key, status, started_at) VALUES (0, 'test_exp', 'greeting_new', 'running', ?)`).run(now);
  const expId = db.prepare(`SELECT id FROM reply_experiments WHERE experiment_name = 'test_exp'`).get().id;
  db.prepare(`INSERT OR IGNORE INTO reply_assignments (sender_id, experiment_id, variant_id, assigned_at) VALUES (?, ?, ?, ?)`).run(senderId, expId, varRow.id, now - 3600_000);
}

// Fake outreach
db.prepare(`INSERT INTO scheduled_outreach (hotel_id, trigger_type, sender_id, channel, template_key, message_content, status, scheduled_at, sent_at, created_at) VALUES (1, 'pre_checkin_1d', ?, 'zalo_message', 'test', 'test msg', 'sent', ?, ?, ?)`)
  .run(senderId, now - 86400_000, now - 86400_000, now - 86400_000);

// Fake promo usage
db.prepare(`INSERT INTO promotion_usage (promotion_id, promotion_code, sender_id, booking_id, discount_applied_vnd, created_at) VALUES (1, 'SONDER2026', ?, ?, 150000, ?)`)
  .run(senderId, bookingId, now);

db.close();

// Now trigger attribution
const { recordBookingAttribution } = require('./dist/services/attribution-tracker');
const result = recordBookingAttribution(bookingId);
console.log('Attribution result:', JSON.stringify(result));
JS
node tmp.js; rm -f tmp.js

echo ""
echo "=== 3. View attribution_links ==="
cat > tmp.js <<'JS'
const Database = require('better-sqlite3');
const db = new Database('data/db.sqlite');
const rows = db.prepare(`SELECT touch_type, touch_value, weight FROM attribution_links ORDER BY id DESC LIMIT 10`).all();
rows.forEach(r => console.log('  ' + r.touch_type + ': ' + r.touch_value + ' (weight=' + r.weight + ')'));

const rev = db.prepare(`SELECT COUNT(*) as n, SUM(amount_vnd) as total FROM revenue_events`).get();
console.log('\nRevenue events:', rev.n, 'total: ' + (rev.total || 0) + 'đ');

const ltv = db.prepare(`SELECT sender_id, customer_name, customer_tier, total_revenue_vnd, predicted_ltv_vnd FROM customer_ltv ORDER BY total_revenue_vnd DESC LIMIT 5`).all();
console.log('\nCustomer LTV:');
ltv.forEach(l => console.log('  ' + (l.customer_name || l.sender_id) + ' [' + l.customer_tier + ']: ' + l.total_revenue_vnd + 'đ (predicted ' + l.predicted_ltv_vnd + 'đ)'));
db.close();
JS
node tmp.js; rm -f tmp.js

echo ""
echo "=== 4. API test (no auth for HTML, attribution needs cookie) ==="
curl -s -o /dev/null -w "Dashboard HTML: HTTP %{http_code} size=%{size_download}\n" http://127.0.0.1:3000/admin-dashboard.html

echo ""
echo "=== 5. Attribution by type via direct query ==="
cat > tmp.js <<'JS'
const { attributionByType, getRevenueTotals, topCustomersByLTV } = require('./dist/services/attribution-tracker');

console.log('Revenue totals 30d:');
const t = getRevenueTotals(30);
console.log('  Bookings:', t.bookings, '| Revenue:', t.total_revenue_vnd, 'đ | AOV:', t.avg_order_value_vnd + 'đ');

console.log('\nAttribution by reply_source:');
const bySource = attributionByType('reply_source', { days: 30 });
bySource.slice(0, 5).forEach(a => console.log('  ' + a.touch_value + ': ' + a.attributed_revenue_vnd + 'đ (' + a.bookings_attributed + ' bookings)'));

console.log('\nAttribution by outreach:');
const byOutreach = attributionByType('outreach', { days: 30 });
byOutreach.slice(0, 5).forEach(a => console.log('  ' + a.touch_value + ': ' + a.attributed_revenue_vnd + 'đ'));

console.log('\nAttribution by variant:');
const byVariant = attributionByType('variant', { days: 30 });
byVariant.slice(0, 5).forEach(a => console.log('  ' + a.touch_value + ': ' + a.attributed_revenue_vnd + 'đ'));

console.log('\nTop customers:');
const top = topCustomersByLTV(5);
top.forEach(c => console.log('  ' + (c.customer_name || c.sender_id) + ' [' + c.customer_tier + ']: ' + c.total_revenue_vnd + 'đ (LTV ' + c.predicted_ltv_vnd + 'đ)'));
JS
node tmp.js; rm -f tmp.js
"""

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, username="root", password=PASSWORD, timeout=15)
_, stdout, stderr = client.exec_command(CMD, timeout=90)
print(stdout.read().decode('utf-8', errors='replace'))
err = stderr.read().decode('utf-8', errors='replace')
if err.strip(): print('STDERR:', err[:500])
client.close()

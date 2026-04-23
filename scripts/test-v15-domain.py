"""Seed + test v15 domain data (policies + pricing + promotions)."""
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
['hotel_policy_rules', 'pricing_rules', 'promotions', 'promotion_usage'].forEach(t => {
  const cols = db.prepare(`PRAGMA table_info(${t})`).all();
  console.log('  ' + t + ': ' + cols.length + ' cols');
});
db.close();
JS
node tmp.js; rm -f tmp.js

echo ""
echo "=== 2. Seed domain data ==="
cat > tmp.js <<'JS'
const { seedSonderDomainData } = require('./dist/services/domain-seed');
const r = seedSonderDomainData();
console.log(JSON.stringify(r));
JS
node tmp.js; rm -f tmp.js

echo ""
echo "=== 3. Verify seeded ==="
cat > tmp.js <<'JS'
const Database = require('better-sqlite3');
const db = new Database('data/db.sqlite');
const p = db.prepare(`SELECT policy_type, rule_name, description FROM hotel_policy_rules ORDER BY policy_type, priority DESC`).all();
console.log('Policies:', p.length);
const pp = {};
p.forEach(r => { pp[r.policy_type] = (pp[r.policy_type] || 0) + 1; });
console.log('  by type:', JSON.stringify(pp));

const pr = db.prepare(`SELECT rule_type, rule_name, modifier_type, modifier_value FROM pricing_rules ORDER BY rule_type`).all();
console.log('Pricing rules:', pr.length);
pr.forEach(r => console.log('  ' + r.rule_name + ': ' + r.modifier_type + ' ' + r.modifier_value));

const pm = db.prepare(`SELECT code, name, discount_type, discount_value FROM promotions`).all();
console.log('Promotions:', pm.length);
pm.forEach(p => console.log('  ' + p.code + ': ' + p.name));
db.close();
JS
node tmp.js; rm -f tmp.js

echo ""
echo "=== 4. Pricing calculator test ==="
cat > tmp.js <<'JS'
const { calculatePrice } = require('./dist/services/pricing-calculator');

// Scenario 1: Weekend nightly
console.log('\n[Scenario 1] Weekend (T6-T7) 2 đêm Deluxe, not VIP, no promo:');
const r1 = calculatePrice({
  hotel_id: 6, room_type_code: 'DELUXE',
  checkin_date: '2026-04-24', nights: 2,  // Fri 24/4
});
console.log(r1.breakdown_text);

// Scenario 2: Long stay 14 nights + VIP
console.log('\n[Scenario 2] 14 đêm + VIP tier:');
const r2 = calculatePrice({
  hotel_id: 6, room_type_code: 'DELUXE',
  checkin_date: '2026-05-10', nights: 14, customer_tier: 'vip',
});
console.log(r2.breakdown_text);

// Scenario 3: Peak date 30/4 + promo
console.log('\n[Scenario 3] 30/4 peak + promo SONDER2026:');
const r3 = calculatePrice({
  hotel_id: 6, room_type_code: 'DELUXE',
  checkin_date: '2026-04-30', nights: 2,
  customer_tier: 'new', promo_code: 'SONDER2026',
});
console.log(r3.breakdown_text);

// Scenario 4: Early bird (30 days ahead)
console.log('\n[Scenario 4] Book 40 ngày trước check-in:');
const r4 = calculatePrice({
  hotel_id: 6, room_type_code: 'DELUXE',
  checkin_date: '2026-06-01', nights: 3,
  booking_date: '2026-04-23',
});
console.log(r4.breakdown_text);
JS
node tmp.js; rm -f tmp.js

echo ""
echo "=== 5. Bot scenarios (via Zalo webhook) ==="
for MSG in "Chính sách hủy phòng thế nào" "Có mã khuyến mãi không" "Cuối tuần có đắt hơn không" "Mang chó được không" "Ở 7 đêm có giảm không"; do
  SENDER="zalo:v15_test_$(echo $MSG | md5sum | cut -c1-6)"
  echo ""
  echo "--- USER: $MSG ---"
  cat > tmp.js <<JS
const Database = require('better-sqlite3');
const db = new Database('data/db.sqlite');
db.prepare(\`DELETE FROM bot_conversation_state WHERE sender_id = '$SENDER'\`).run();
db.prepare(\`DELETE FROM conversation_memory WHERE sender_id = '$SENDER'\`).run();
db.close();
JS
  node tmp.js; rm -f tmp.js
  curl -s -X POST http://127.0.0.1:3000/webhook/zalo \
    -H 'Content-Type: application/json' \
    -d "{\"oa_id\":\"328738126716568694\",\"event_name\":\"user_send_text\",\"sender\":{\"id\":\"${SENDER#zalo:}\"},\"message\":{\"text\":\"$MSG\"}}" > /dev/null
  sleep 4
  cat > tmp.js <<JS
const Database = require('better-sqlite3');
const db = new Database('data/db.sqlite');
const r = db.prepare(\`SELECT role, substr(message, 1, 500) as msg, intent FROM conversation_memory WHERE sender_id = '$SENDER' ORDER BY id\`).all();
r.forEach(x => console.log((x.role === 'user' ? '👤' : '🤖') + ' [' + (x.intent||'-') + '] ' + x.msg));
db.close();
JS
  node tmp.js; rm -f tmp.js
done
"""

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, username="root", password=PASSWORD, timeout=15)
_, stdout, stderr = client.exec_command(CMD, timeout=180)
print(stdout.read().decode("utf-8", errors="replace"))
err = stderr.read().decode("utf-8", errors="replace")
if err.strip(): print("STDERR:\n" + err, file=sys.stderr)
client.close()

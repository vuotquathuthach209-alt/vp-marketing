"""Full E2E test — verify toàn bộ hệ thống sau nhiều ngày dev."""
import sys, os, paramiko
try: sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except: pass

HOST = "103.82.193.74"
PASSWORD = sys.argv[1] if len(sys.argv) > 1 else ""

CMD = r"""
cd /opt/vp-marketing

# =============================================
# Test 1: Bot Sales Funnel — full flow
# =============================================
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║ TEST 1: Bot Funnel — Honest capability + Multi-slot + RAG    ║"
echo "╚══════════════════════════════════════════════════════════════╝"

# Clean test state
cat > tmp.js <<'JS'
const Database = require('better-sqlite3');
const db = new Database('data/db.sqlite');
db.prepare(`DELETE FROM bot_conversation_state WHERE sender_id LIKE 'zalo:e2e_%'`).run();
db.prepare(`DELETE FROM conversation_memory WHERE sender_id LIKE 'zalo:e2e_%'`).run();
db.prepare(`DELETE FROM customer_memory WHERE sender_id LIKE 'zalo:e2e_%'`).run();
db.close();
console.log('Clean done');
JS
node tmp.js
rm -f tmp.js

# Test 1a: User hỏi khách sạn (không có trong network) → bot phải honest redirect
SENDER_A="e2e_test_a"
echo ""
echo "--- Scenario A: 'có khách sạn gần sân bay không' (capability check) ---"
MSG="có khách sạn gần sân bay không"
curl -s -X POST http://127.0.0.1:3000/webhook/zalo \
  -H 'Content-Type: application/json' \
  -d "{\"oa_id\":\"328738126716568694\",\"event_name\":\"user_send_text\",\"sender\":{\"id\":\"$SENDER_A\"},\"message\":{\"text\":\"$MSG\"}}" > /dev/null
sleep 3

# Test 1b: Multi-slot extract + honest fallback
SENDER_B="e2e_test_b"
echo ""
echo "--- Scenario B: 'cần homestay tân bình 2 người tuần sau dưới 800k' (multi-slot) ---"
MSG_B="cần homestay tân bình 2 người tuần sau dưới 800k"
curl -s -X POST http://127.0.0.1:3000/webhook/zalo \
  -H 'Content-Type: application/json' \
  -d "{\"oa_id\":\"328738126716568694\",\"event_name\":\"user_send_text\",\"sender\":{\"id\":\"$SENDER_B\"},\"message\":{\"text\":\"$MSG_B\"}}" > /dev/null
sleep 4

# Test 1c: Semantic RAG — dining question
SENDER_C="e2e_test_c"
echo ""
echo "--- Scenario C: 'gần có bánh mì ngon không' (semantic) ---"
MSG_C="gần có bánh mì ngon không"
curl -s -X POST http://127.0.0.1:3000/webhook/zalo \
  -H 'Content-Type: application/json' \
  -d "{\"oa_id\":\"328738126716568694\",\"event_name\":\"user_send_text\",\"sender\":{\"id\":\"$SENDER_C\"},\"message\":{\"text\":\"$MSG_C\"}}" > /dev/null
sleep 4

# Test 1d: Returning customer
cat > tmp.js <<'JS'
const Database = require('better-sqlite3');
const db = new Database('data/db.sqlite');
const sender = 'zalo:e2e_returning';
db.prepare(`DELETE FROM bot_conversation_state WHERE sender_id = ?`).run(sender);
db.prepare(`DELETE FROM conversation_memory WHERE sender_id = ?`).run(sender);
db.prepare(`DELETE FROM customer_memory WHERE sender_id = ?`).run(sender);
db.prepare(`DELETE FROM bot_booking_drafts WHERE sender_id = ?`).run(sender);
// Seed past bookings
const now = Date.now();
for (let i = 0; i < 3; i++) {
  db.prepare(`INSERT INTO bot_booking_drafts
    (sender_id, hotel_id, property_type, area, guests_adults, nights, phone, name, status, created_at, budget_max)
    VALUES (?, 7, 'homestay', 'Tân Bình', 2, 2, '0912345678', 'Nguyễn Văn An', 'confirmed', ?, 800000)`)
    .run(sender, now - (i + 1) * 30 * 86400000);
}
require('./dist/services/customer-memory').rebuildCustomerProfile(sender);
console.log('Seeded returning customer');
db.close();
JS
node tmp.js
rm -f tmp.js

SENDER_D="e2e_returning"
echo ""
echo "--- Scenario D: Returning customer 'Chào bạn' ---"
curl -s -X POST http://127.0.0.1:3000/webhook/zalo \
  -H 'Content-Type: application/json' \
  -d "{\"oa_id\":\"328738126716568694\",\"event_name\":\"user_send_text\",\"sender\":{\"id\":\"$SENDER_D\"},\"message\":{\"text\":\"Chào bạn\"}}" > /dev/null
sleep 3

# Show all conversations
echo ""
echo "=== BOT REPLIES ==="
cat > tmp.js <<'JS'
const Database = require('better-sqlite3');
const db = new Database('data/db.sqlite');
const testSenders = ['zalo:e2e_test_a', 'zalo:e2e_test_b', 'zalo:e2e_test_c', 'zalo:e2e_returning'];
for (const sid of testSenders) {
  const rows = db.prepare(`SELECT role, substr(message, 1, 500) as msg, intent FROM conversation_memory WHERE sender_id = ? ORDER BY id ASC`).all(sid);
  console.log('\n━━━ ' + sid + ' ━━━');
  rows.forEach(r => {
    const icon = r.role === 'user' ? '👤' : '🤖';
    console.log(`${icon} [${r.intent || '-'}]`);
    console.log(`   ${r.msg.replace(/\n/g, ' ')}`);
  });
}
db.close();
JS
node tmp.js
rm -f tmp.js


# =============================================
# Test 2: Admin Analytics APIs
# =============================================
echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║ TEST 2: Admin APIs (stats)                                   ║"
echo "╚══════════════════════════════════════════════════════════════╝"

# Get auth token via admin login
TOKEN=$(curl -s -X POST http://127.0.0.1:3000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"password":"fpwecCB6qVdI3Wpax3PNLY0P"}' | grep -o '"token":"[^"]*' | cut -d'"' -f4)
echo "Admin token: ${TOKEN:0:30}..."

echo ""
echo "--- /api/funnel/stats ---"
curl -s http://127.0.0.1:3000/api/funnel/stats -H "Cookie: token=$TOKEN" | python3 -m json.tool 2>/dev/null || echo "(no token route uses cookie)"

echo ""
echo "--- /api/knowledge/stats ---"
curl -s http://127.0.0.1:3000/api/knowledge/stats -H "Cookie: token=$TOKEN" | head -c 1000
echo ""

echo ""
echo "--- /api/retention/stats ---"
curl -s http://127.0.0.1:3000/api/retention/stats -H "Cookie: token=$TOKEN" | head -c 1000
echo ""

# =============================================
# Test 3: Semantic search variety
# =============================================
echo ""
echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║ TEST 3: Semantic RAG variety                                 ║"
echo "╚══════════════════════════════════════════════════════════════╝"

cat > tmp.js <<'JS'
(async () => {
  const { semanticSearch, unifiedQuery } = require('./dist/services/knowledge-sync');
  const scenarios = [
    { q: 'nơi nào phù hợp công tác business', label: 'business' },
    { q: 'có wheelchair không', label: 'accessibility' },
    { q: 'cho chó mèo được không', label: 'pet' },
    { q: 'ưu đãi deal hiện tại', label: 'promotion' },
    { q: 'khách review thế nào', label: 'review' },
    { q: 'không ồn ban đêm', label: 'house_rule' },
    { q: 'free breakfast', label: 'family' },
  ];
  for (const s of scenarios) {
    const hits = await semanticSearch(s.q, { topK: 2, minScore: 0.3 });
    console.log(`\n"${s.q}" [expected: ${s.label}]`);
    if (hits.length === 0) {
      console.log(`  (no matches)`);
    } else {
      hits.forEach((h, i) => {
        const match = h.chunk_type === s.label ? '✅' : '⚠️';
        console.log(`  ${i+1}. ${match} [${h.chunk_type}] ${(h.score*100).toFixed(0)}% — ${h.chunk_text.slice(0, 90)}`);
      });
    }
  }
})();
JS
node tmp.js
rm -f tmp.js

# =============================================
# Test 4: Current DB snapshot
# =============================================
echo ""
echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║ TEST 4: DB Snapshot                                          ║"
echo "╚══════════════════════════════════════════════════════════════╝"

cat > tmp.js <<'JS'
const Database = require('better-sqlite3');
const db = new Database('data/db.sqlite');

console.log('Tables and row counts:');
const tables = [
  'hotel_profile', 'mkt_hotels', 'hotel_room_catalog',
  'hotel_knowledge_embeddings', 'knowledge_wiki',
  'bot_conversation_state', 'bot_booking_drafts', 'customer_memory',
  'conversation_memory', 'zalo_oa', 'ota_raw_hotels',
];
tables.forEach(t => {
  try {
    const r = db.prepare(`SELECT COUNT(*) as n FROM ${t}`).get();
    console.log(`  ${t}: ${r.n}`);
  } catch (e) { console.log(`  ${t}: (error)`); }
});

console.log('\nActive hotels:');
const ahs = db.prepare(`SELECT mh.id as mkt_id, mh.name, mh.ota_hotel_id, hp.star_rating, hp.property_type
  FROM mkt_hotels mh LEFT JOIN hotel_profile hp ON hp.hotel_id = mh.ota_hotel_id
  WHERE mh.status = 'active' ORDER BY mh.id`).all();
ahs.forEach(h => console.log(`  #${h.mkt_id} ${h.name} | ota=${h.ota_hotel_id} | ${h.property_type || '?'} ${h.star_rating || '?'}⭐`));

console.log('\nPM2 uptime + memory:');
db.close();
JS
node tmp.js
rm -f tmp.js

echo ""
pm2 info vp-mkt | grep -E "status|uptime|memory|restart" | head -5
"""

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, username="root", password=PASSWORD, timeout=15)
_, stdout, stderr = client.exec_command(CMD, timeout=300)
print(stdout.read().decode("utf-8", errors="replace"))
err = stderr.read().decode("utf-8", errors="replace")
if err.strip(): print("STDERR:\n" + err, file=sys.stderr)
client.close()

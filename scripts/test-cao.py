"""Test CAO: new customer / returning (resume_context) / returning (greet_new)."""
import sys, paramiko
try: sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except: pass
HOST = "103.82.193.74"
PASSWORD = sys.argv[1] if len(sys.argv) > 1 else ""

CMD = r"""
cd /opt/vp-marketing
cat > /opt/vp-marketing/_tmp_cao.js <<'JS'
process.chdir('/opt/vp-marketing');
const Database = require('better-sqlite3');
const db = new Database('data/db.sqlite');

// Enable agentic flow for tests
const { setSetting } = require('/opt/vp-marketing/dist/db');
setSetting('agentic_flow_enabled', 'true');

(async () => {
  // Clean previous test data
  db.prepare(`DELETE FROM conversation_memory WHERE sender_id LIKE 'fb:cao_test_%'`).run();
  db.prepare(`DELETE FROM bot_conversation_state WHERE sender_id LIKE 'fb:cao_test_%'`).run();
  db.prepare(`DELETE FROM customer_memory WHERE sender_id LIKE 'fb:cao_test_%'`).run();
  db.prepare(`DELETE FROM agentic_opening_cache WHERE sender_id LIKE 'fb:cao_test_%'`).run();

  const { processMessageAgentic } = require('/opt/vp-marketing/dist/services/agentic/orchestrator');
  const { runCAO, shouldUseCAO, callOpeningLLM } = require('/opt/vp-marketing/dist/services/agentic/context-aware-opener');

  // ═══════════════════════════════════════════
  console.log('=== Test 1: Khách mới — NO LLM call, template fast-path ===');
  // ═══════════════════════════════════════════
  const sender1 = 'fb:cao_test_new_' + Date.now();
  const r1 = await processMessageAgentic(sender1, 1, 'chào bạn', {});
  console.log(`  Tier: ${r1?.tier_used}`);
  console.log(`  Template: ${r1?.meta?.template_id}`);
  console.log(`  CAO action: ${r1?.meta?.cao_action || 'null (không gọi CAO)'}`);
  console.log(`  Cost: ${r1?.cost_estimate}`);
  console.log(`  Reply preview: ${r1?.reply?.substring(0, 100)}`);

  // ═══════════════════════════════════════════
  console.log('\n=== Test 2: Khách cũ có mạch dở (resume_context expected) ===');
  // ═══════════════════════════════════════════
  const sender2 = 'fb:cao_test_returning_' + Date.now();

  // Insert customer profile
  db.prepare(`
    INSERT INTO customer_memory (sender_id, name, phone, customer_tier, total_conversations, total_bookings, last_area, last_property_type, last_seen_at, first_seen_at, updated_at)
    VALUES (?, 'Anh Minh', '0912345678', 'returning', 3, 1, 'Tân Bình (sân bay)', 'khách sạn', ?, ?, ?)
  `).run(sender2, Date.now() - 7 * 24 * 3600 * 1000, Date.now() - 14 * 24 * 3600 * 1000, Date.now());

  // Insert prior conversation — 8 days ago, khách đang hỏi phòng gần sân bay
  const oldTs = Date.now() - 8 * 24 * 3600 * 1000;
  const msgs = [
    ['user', 'cho em hỏi phòng gần sân bay Tân Sơn Nhất ngày 25/5'],
    ['bot', 'Dạ em tư vấn đặt phòng ngắn ngày ạ! Anh/chị cho em xin: ngày check-in + số đêm, số khách, budget dự kiến, khu vực muốn ở'],
    ['user', '2 người 2 đêm budget 800k'],
    ['bot', 'Dạ em note nhé. Anh/chị muốn phòng có bồn tắm, view, hay gym không ạ?'],
    ['user', 'cho em view đẹp'],
    ['bot', 'Dạ em check phòng trống gần sân bay có view đẹp cho anh nhé'],
  ];
  for (let i = 0; i < msgs.length; i++) {
    db.prepare(`INSERT INTO conversation_memory (sender_id, page_id, role, message, created_at) VALUES (?, 0, ?, ?, ?)`)
      .run(sender2, msgs[i][0], msgs[i][1], oldTs + i * 60000);
  }

  // Khách inbox lại sau 8 ngày
  const r2 = await processMessageAgentic(sender2, 1, 'alo bạn', {});
  console.log(`  Tier: ${r2?.tier_used}`);
  console.log(`  Template: ${r2?.meta?.template_id}`);
  console.log(`  CAO action: ${r2?.meta?.cao_action}`);
  console.log(`  CAO provider: ${r2?.meta?.cao_provider}`);
  console.log(`  CAO summary: ${r2?.meta?.cao_summary}`);
  console.log(`  Cost: ${r2?.cost_estimate}`);
  console.log(`  Reply: ${r2?.reply}`);

  // ═══════════════════════════════════════════
  console.log('\n=== Test 3: Khách cũ — quá lâu >30 days (greet_new expected) ===');
  // ═══════════════════════════════════════════
  const sender3 = 'fb:cao_test_old_' + Date.now();
  db.prepare(`
    INSERT INTO customer_memory (sender_id, name, customer_tier, total_conversations, total_bookings, last_area, last_seen_at, first_seen_at, updated_at)
    VALUES (?, 'Chị Lan', 'regular', 5, 3, 'Q1', ?, ?, ?)
  `).run(sender3, Date.now() - 60 * 24 * 3600 * 1000, Date.now() - 120 * 24 * 3600 * 1000, Date.now());

  // Old conversation 60 days ago
  const veryOldTs = Date.now() - 60 * 24 * 3600 * 1000;
  db.prepare(`INSERT INTO conversation_memory (sender_id, page_id, role, message, created_at) VALUES (?, 0, 'user', 'đặt phòng Q1', ?)`).run(sender3, veryOldTs);
  db.prepare(`INSERT INTO conversation_memory (sender_id, page_id, role, message, created_at) VALUES (?, 0, 'bot', 'xác nhận đặt phòng Q1', ?)`).run(sender3, veryOldTs + 60000);

  const r3 = await processMessageAgentic(sender3, 1, 'hi em', {});
  console.log(`  Tier: ${r3?.tier_used}`);
  console.log(`  Template: ${r3?.meta?.template_id}`);
  console.log(`  CAO action: ${r3?.meta?.cao_action || 'N/A'}`);
  console.log(`  Reply: ${r3?.reply}`);

  // ═══════════════════════════════════════════
  console.log('\n=== Test 4: Direct CAO test - dry run LLM call ===');
  // ═══════════════════════════════════════════
  const testCtx = {
    senderId: 'test_dry',
    hotelId: 1,
    currentMessage: 'alo cho mình hỏi tiếp phòng bữa trước',
    customerProfile: {
      name: 'Anh Hưng',
      tier: 'regular',
      total_bookings: 2,
      days_since_last_visit: 5,
      last_area: 'Bình Thạnh',
      last_property_type: 'homestay',
    },
    history: [
      { role: 'user', message: 'em hỏi phòng Bình Thạnh giá 500k cuối tuần', ts: Date.now() - 5 * 24 * 3600 * 1000 },
      { role: 'bot', message: 'Dạ em note. Anh cho em ngày cụ thể nhé', ts: Date.now() - 5 * 24 * 3600 * 1000 + 60000 },
      { role: 'user', message: 'thứ 7 chủ nhật tuần sau', ts: Date.now() - 5 * 24 * 3600 * 1000 + 120000 },
      { role: 'bot', message: 'Dạ em check phòng trống', ts: Date.now() - 5 * 24 * 3600 * 1000 + 180000 },
    ],
  };

  const check = shouldUseCAO(testCtx);
  console.log(`  shouldUseCAO: ${JSON.stringify(check)}`);

  if (check.use) {
    const decision = await callOpeningLLM(testCtx);
    if (decision) {
      console.log(`  action: ${decision.action}`);
      console.log(`  relevance: ${decision.context_relevance}`);
      console.log(`  confidence: ${decision.confidence}`);
      console.log(`  provider: ${decision.llm_provider}`);
      console.log(`  summary: ${decision.summary_previous}`);
      if (decision.suggested_opening) {
        console.log(`  🎯 CUSTOM OPENING: "${decision.suggested_opening}"`);
      }
      console.log(`  personalization: ${JSON.stringify(decision.personalization)}`);
    } else {
      console.log(`  ❌ LLM returned null`);
    }
  }

  // ═══════════════════════════════════════════
  console.log('\n=== Stats ===');
  // ═══════════════════════════════════════════
  const { getCAOStats } = require('/opt/vp-marketing/dist/services/agentic/context-aware-opener');
  const stats = getCAOStats(7);
  console.log(`  Stats: ${JSON.stringify(stats, null, 2)}`);

  // Cleanup test data
  db.prepare(`DELETE FROM conversation_memory WHERE sender_id LIKE 'fb:cao_test_%'`).run();
  db.prepare(`DELETE FROM bot_conversation_state WHERE sender_id LIKE 'fb:cao_test_%'`).run();
  db.prepare(`DELETE FROM customer_memory WHERE sender_id LIKE 'fb:cao_test_%'`).run();
  db.prepare(`DELETE FROM agentic_opening_cache WHERE sender_id LIKE 'fb:cao_test_%' OR sender_id = 'test_dry'`).run();
  db.prepare(`DELETE FROM agentic_template_tracking WHERE sender_id LIKE 'fb:cao_test_%'`).run();
  db.prepare(`DELETE FROM agentic_template_selections WHERE sender_id LIKE 'fb:cao_test_%'`).run();
  db.close();

  console.log('\n✅ CAO E2E test complete');
})().catch(e => { console.error('Fatal:', e); process.exit(1); });
JS

node /opt/vp-marketing/_tmp_cao.js
rm /opt/vp-marketing/_tmp_cao.js
"""

c = paramiko.SSHClient()
c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
c.connect(HOST, username="root", password=PASSWORD, timeout=20)
_, out, err = c.exec_command(CMD, timeout=180)
print(out.read().decode('utf-8', errors='replace'))
e = err.read().decode('utf-8', errors='replace')
if e.strip(): print('--STDERR--'); print(e)
c.close()

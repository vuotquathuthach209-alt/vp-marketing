"""Enable agentic v27 flow + test end-to-end với sample conversation."""
import sys, paramiko
try: sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except: pass
HOST = "103.82.193.74"
PASSWORD = sys.argv[1] if len(sys.argv) > 1 else ""

CMD = r"""
cd /opt/vp-marketing

cat > tmp.js <<'JS'
process.chdir('/opt/vp-marketing');
const Database = require('better-sqlite3');
const { setSetting, getSetting } = require('/opt/vp-marketing/dist/db');
const db = new Database('data/db.sqlite');

// Enable agentic
setSetting('agentic_flow_enabled', 'true');
console.log('✅ Agentic flow ENABLED in settings');

// Clean test sender history
const testSender = 'fb:test_agentic_' + Date.now();
console.log('Test sender:', testSender);

(async () => {
  const { processMessageAgentic } = require('/opt/vp-marketing/dist/services/agentic/orchestrator');
  const { renderTemplate } = require('/opt/vp-marketing/dist/services/agentic/template-library');

  // Test 1: Turn 1 (empty history) → expect greeting_opening template
  console.log('\n=== Test 1: Turn 1 — greeting ===');
  let result = await processMessageAgentic(testSender, 1, 'chào bạn', {});
  if (result) {
    console.log('Tier:', result.tier_used);
    console.log('Confidence:', result.confidence_score);
    console.log('Cost:', result.cost_estimate);
    console.log('Reply preview:', result.reply.substring(0, 200));
    console.log('Quick replies:', result.quick_replies?.map(q => q.title).join(' | '));
  } else {
    console.log('NULL - delegated to FSM');
  }

  // Save user msg + bot reply vào memory để tăng turn_number
  const saveMsg = (role, msg) => {
    db.prepare(`INSERT INTO conversation_memory (sender_id, page_id, role, message, created_at) VALUES (?, 0, ?, ?, ?)`)
      .run(testSender, role, msg, Date.now());
  };
  saveMsg('user', 'chào bạn');
  if (result) saveMsg('bot', result.reply);

  // Test 2: Turn 2 booking intent → expect discover_short_stay template
  console.log('\n=== Test 2: Turn 2 — booking intent ===');
  result = await processMessageAgentic(testSender, 1, 'tôi muốn đặt phòng', {});
  if (result) {
    console.log('Tier:', result.tier_used);
    console.log('Confidence:', result.confidence_score);
    console.log('Reply preview:', result.reply.substring(0, 200));
  } else {
    console.log('NULL - delegated to FSM');
  }
  saveMsg('user', 'tôi muốn đặt phòng');
  if (result) saveMsg('bot', result.reply);

  // Test 3: Turn 3 full slots batch
  console.log('\n=== Test 3: Turn 3 — batch slots ===');
  result = await processMessageAgentic(testSender, 1, '25/5 2 đêm 2 người 800k gần sân bay', {});
  if (result) {
    console.log('Tier:', result.tier_used, 'Confidence:', result.confidence_score);
    console.log('Reply preview:', result.reply.substring(0, 200));
  } else {
    console.log('NULL - delegated to FSM (sẽ dùng full FSM cho slot filling real)');
  }
  saveMsg('user', '25/5 2 đêm 2 người 800k gần sân bay');
  if (result) saveMsg('bot', result.reply);

  // Test 4: Handoff request
  console.log('\n=== Test 4: Handoff request ===');
  result = await processMessageAgentic(testSender, 1, 'cho em gặp nhân viên', {});
  if (result) {
    console.log('Tier:', result.tier_used);
    console.log('Handoff triggered:', result.handoff_triggered);
    console.log('Reply:', result.reply.substring(0, 300));
  }

  // Test 5: Unknown info → safety mode
  console.log('\n=== Test 5: Unknown info → safety ===');
  const testSender2 = 'fb:test_safety_' + Date.now();
  saveMsg2 = (role, msg) => db.prepare(`INSERT INTO conversation_memory (sender_id, page_id, role, message, created_at) VALUES (?, 0, ?, ?, ?)`).run(testSender2, role, msg, Date.now());
  saveMsg2('user', 'dummy greeting');
  saveMsg2('bot', 'greeting reply');
  saveMsg2('user', 'dummy turn 2');
  saveMsg2('bot', 'some reply');

  result = await processMessageAgentic(testSender2, 1, 'có cho chó cưng vào phòng không? giá bao nhiêu con chó to 40kg?', {});
  if (result) {
    console.log('Tier:', result.tier_used, 'Confidence:', result.confidence_score);
    console.log('Reply:', result.reply.substring(0, 200));
    console.log('Reasons:', JSON.stringify(result.meta?.reasons));
  } else {
    console.log('NULL - delegated to RAG/FSM');
  }

  // Cleanup test senders
  db.prepare(`DELETE FROM conversation_memory WHERE sender_id LIKE 'fb:test_%'`).run();
  db.prepare(`DELETE FROM handoff_log WHERE sender_id LIKE 'fb:test_%'`).run();
  db.close();
  console.log('\n✅ Tests complete, cleaned up');
})();
JS

node tmp.js
rm tmp.js
"""

c = paramiko.SSHClient()
c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
c.connect(HOST, username="root", password=PASSWORD, timeout=15)
_, out, _ = c.exec_command(CMD, timeout=120)
print(out.read().decode('utf-8'))
c.close()

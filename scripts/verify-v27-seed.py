"""Verify 25 templates seeded + test render + test smart selection."""
import sys, paramiko
try: sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except: pass
HOST = "103.82.193.74"
PASSWORD = sys.argv[1] if len(sys.argv) > 1 else ""

CMD = r"""
cd /opt/vp-marketing

cat > /opt/vp-marketing/_tmp_verify.js <<'JS'
process.chdir('/opt/vp-marketing');
const Database = require('better-sqlite3');
const db = new Database('data/db.sqlite');

console.log('=== Template count by category ===');
const byCat = db.prepare(`SELECT category, COUNT(*) as n FROM agentic_templates WHERE active=1 GROUP BY category ORDER BY category`).all();
byCat.forEach(r => console.log(`  ${r.category.padEnd(12)} : ${r.n}`));
const total = db.prepare(`SELECT COUNT(*) as n FROM agentic_templates WHERE active=1`).get();
console.log(`  TOTAL        : ${total.n}`);

console.log('\n=== All IDs ===');
const ids = db.prepare(`SELECT id, category FROM agentic_templates WHERE active=1 ORDER BY category, id`).all();
ids.forEach(r => console.log(`  [${r.category}] ${r.id}`));

console.log('\n=== Test render engine ===');
const { renderString, renderTemplateById, selectTemplate } = require('/opt/vp-marketing/dist/services/agentic/template-engine');

// Test 1: simple render
const t1 = renderTemplateById('first_contact_warm', { hotline: '0348 644 833' });
console.log('T1 first_contact_warm preview:', t1 ? t1.content.substring(0, 100) + '...' : 'NULL');

// Test 2: render với customerName + isVip section
const t2 = renderTemplateById('returning_customer_greet', { customerName: 'Anh Minh', isVip: true });
console.log('T2 returning_customer_greet (VIP) preview:', t2 ? t2.content.substring(0, 120) + '...' : 'NULL');

// Test 3: render với isVip=false → inverted section
const t3 = renderTemplateById('returning_customer_greet', { customerName: 'Chị Lan', isVip: false });
console.log('T3 returning_customer_greet (REG) preview:', t3 ? t3.content.substring(0, 120) + '...' : 'NULL');

// Test 4: smart selection cho urgency keyword
console.log('\n=== Test smart selection ===');
const s1 = selectTemplate({ turn_number: 1, message: 'tôi cần phòng gấp đêm nay' });
console.log('S1 turn=1 + "gấp" → expect first_with_urgency:', s1?.id || 'NULL');

const s2 = selectTemplate({ turn_number: 1, message: 'chào' });
console.log('S2 turn=1 + "chào" (short) → expect first_vague:', s2?.id || 'NULL');

const s3 = selectTemplate({ intent: 'booking', rental_mode: 'short_term', slot_completeness: 0.1, message: 'tôi muốn đặt phòng', turn_number: 2 });
console.log('S3 booking short low-slot → expect discover_short_stay_batch:', s3?.id || 'NULL');

const s4 = selectTemplate({ intent: 'info_question', sub_category: 'price', message: 'giá phòng bao nhiêu' });
console.log('S4 info price → expect price_overview:', s4?.id || 'NULL');

const s5 = selectTemplate({ keywords_any: ['mắc'], message: 'phòng mắc quá' });
console.log('S5 "mắc" → expect price_objection:', s5?.id || 'NULL');

const s6 = selectTemplate({ stuck_turns: 3 });
console.log('S6 stuck_turns=3 → expect force_handoff_apology:', s6?.id || 'NULL');

console.log('\n=== Simulate orchestrator turn-1 ===');
(async () => {
  // Enable feature flag for test
  const { setSetting, getSetting } = require('/opt/vp-marketing/dist/db');
  setSetting('agentic_flow_enabled', 'true');

  const { processMessageAgentic } = require('/opt/vp-marketing/dist/services/agentic/orchestrator');

  // Clean
  db.prepare(`DELETE FROM conversation_memory WHERE sender_id LIKE 'fb:verify_%'`).run();
  db.prepare(`DELETE FROM bot_conversation_state WHERE sender_id LIKE 'fb:verify_%'`).run();

  const sid = 'fb:verify_' + Date.now();

  console.log('\n-- Turn 1: "chào bạn" (short → first_vague) --');
  let r = await processMessageAgentic(sid, 1, 'chào bạn', {});
  console.log('  tier:', r?.tier_used, '| template_id:', r?.meta?.template_id, '| conf:', r?.confidence_score);

  db.prepare(`INSERT INTO conversation_memory (sender_id, page_id, role, message, created_at) VALUES (?, 0, 'user', 'chào bạn', ?)`).run(sid, Date.now());
  db.prepare(`INSERT INTO conversation_memory (sender_id, page_id, role, message, created_at) VALUES (?, 0, 'bot', ?, ?)`).run(sid, r?.reply || 'ok', Date.now());

  console.log('\n-- Turn 2: urgency test --');
  const sid2 = 'fb:verify_urgent_' + Date.now();
  r = await processMessageAgentic(sid2, 1, 'phòng gấp đêm nay 2 người', {});
  console.log('  tier:', r?.tier_used, '| template_id:', r?.meta?.template_id, '| conf:', r?.confidence_score);

  // Cleanup
  db.prepare(`DELETE FROM conversation_memory WHERE sender_id LIKE 'fb:verify_%'`).run();
  db.prepare(`DELETE FROM bot_conversation_state WHERE sender_id LIKE 'fb:verify_%'`).run();
  db.prepare(`DELETE FROM handoff_log WHERE sender_id LIKE 'fb:verify_%'`).run();
  db.close();

  console.log('\n✅ Verification complete');
})();
JS

node /opt/vp-marketing/_tmp_verify.js
rm /opt/vp-marketing/_tmp_verify.js
"""

c = paramiko.SSHClient()
c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
c.connect(HOST, username="root", password=PASSWORD, timeout=20)
_, out, err = c.exec_command(CMD, timeout=120)
print(out.read().decode('utf-8', errors='replace'))
e = err.read().decode('utf-8', errors='replace')
if e.strip(): print('--STDERR--'); print(e)
c.close()

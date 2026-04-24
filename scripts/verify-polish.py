"""Verify Phase 4 polish: conversion tracking, selection logs, accent matching."""
import sys, paramiko
try: sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except: pass
HOST = "103.82.193.74"
PASSWORD = sys.argv[1] if len(sys.argv) > 1 else ""

CMD = r"""
cd /opt/vp-marketing

cat > /opt/vp-marketing/_tmp_polish.js <<'JS'
process.chdir('/opt/vp-marketing');
const Database = require('better-sqlite3');
const db = new Database('data/db.sqlite');

console.log('=== Test 1: Accent-insensitive match ===');
const { normalizeForMatch, selectTemplate } = require('/opt/vp-marketing/dist/services/agentic/template-engine');

const pairs = [
  ['thú cưng', 'thu cung'],
  ['hoàn tiền', 'hoan tien'],
  ['đặt phòng', 'dat phong'],
  ['THÚ CƯNG', 'thu cung'],
];
for (const [a, b] of pairs) {
  const na = normalizeForMatch(a);
  const nb = normalizeForMatch(b);
  console.log(`  "${a}" → "${na}" | "${b}" → "${nb}" | match: ${na === nb}`);
}

// Add test template với keyword "thú cưng"
db.prepare(`
  INSERT OR REPLACE INTO agentic_templates
    (id, category, description, trigger_conditions, content, confidence, active, hotel_id, version, created_at, updated_at)
  VALUES ('test_pet_match', 'info', 'test accent', ?, 'dạ test', 0.9, 1, 0, 1, ?, ?)
`).run(JSON.stringify({ keywords_any: ['thú cưng', 'chó mèo'] }), Date.now(), Date.now());

const { invalidateCache } = require('/opt/vp-marketing/dist/services/agentic/template-engine');
invalidateCache();

const tests = [
  { msg: 'cho thú cưng vào không', expect: true },
  { msg: 'cho thu cung vao khong', expect: true },   // no accents
  { msg: 'THÚ CƯNG được không', expect: true },       // mixed case
  { msg: 'có con cho meo không', expect: true },      // 'chó mèo' without accents
  { msg: 'đặt phòng', expect: false },
];

for (const t of tests) {
  const r = selectTemplate({ message: t.msg });
  const matched = r?.id === 'test_pet_match';
  const status = matched === t.expect ? '✅' : '❌';
  console.log(`  ${status} "${t.msg}" → ${r?.id || 'no match'} (expect match=${t.expect})`);
}

// Cleanup test template
db.prepare(`DELETE FROM agentic_templates WHERE id = 'test_pet_match'`).run();

console.log('\n=== Test 2: Conversion tracking ===');
const { trackTemplateUse, detectAndMarkConversion } = require('/opt/vp-marketing/dist/services/agentic/template-engine');

// Simulate: bot sent confirm_booking_summary, user replies with phone
const testSender = 'fb:polish_test_' + Date.now();
trackTemplateUse(testSender, 'confirm_booking_summary', 'decision');

const before = db.prepare(`SELECT conversions FROM agentic_templates WHERE id = ?`).get('confirm_booking_summary');
console.log(`  Before: conversions = ${before?.conversions || 0}`);

// User replies with phone → should trigger conversion
const conv1 = detectAndMarkConversion(testSender, 'ok 0912345678');
console.log(`  detect 1 "ok 0912345678": converted=${conv1.converted} template=${conv1.template_id}`);

const after1 = db.prepare(`SELECT conversions FROM agentic_templates WHERE id = ?`).get('confirm_booking_summary');
console.log(`  After detect 1: conversions = ${after1?.conversions}`);

// Second call should NOT double-count (conversion_marked=1)
const conv2 = detectAndMarkConversion(testSender, 'ok đặt luôn');
console.log(`  detect 2 "ok đặt luôn": converted=${conv2.converted} (expect false, dedup)`);

// Test negative: smalltalk template should NOT count as conversion
const testSender2 = 'fb:polish_test2_' + Date.now();
trackTemplateUse(testSender2, 'smalltalk_polite', 'misc');
const conv3 = detectAndMarkConversion(testSender2, 'ok cảm ơn');
console.log(`  detect 3 (smalltalk category): converted=${conv3.converted} (expect false, wrong category)`);

// Cleanup
db.prepare(`DELETE FROM agentic_template_tracking WHERE sender_id LIKE 'fb:polish_test%'`).run();
// Rollback conversions count
if (conv1.converted) {
  db.prepare(`UPDATE agentic_templates SET conversions = conversions - 1 WHERE id = 'confirm_booking_summary'`).run();
}

console.log('\n=== Test 3: Selection logging ===');
const { logSelection, selectTemplateWithCandidates } = require('/opt/vp-marketing/dist/services/agentic/template-engine');

const testCtx = { turn_number: 1, message: 'chào bạn', customer_is_new: true };
const selResult = selectTemplateWithCandidates(testCtx);
console.log(`  Best: ${selResult.best?.id} | Candidates: ${selResult.candidates.length}`);
for (const c of selResult.candidates) console.log(`    - ${c.id}: ${c.score}`);

const logSender = 'fb:polish_log_' + Date.now();
logSelection(logSender, 1, selResult.best.id, testCtx, selResult.candidates, 1.0);

const logs = db.prepare(`SELECT template_id, candidates_json FROM agentic_template_selections WHERE sender_id = ?`).all(logSender);
console.log(`  Saved ${logs.length} log row(s)`);
if (logs.length > 0) console.log(`    candidates stored: ${logs[0].candidates_json}`);

// Cleanup
db.prepare(`DELETE FROM agentic_template_selections WHERE sender_id LIKE 'fb:polish_log_%'`).run();

console.log('\n=== Test 4: Export/Import flow ===');
// Export
const exported = db.prepare(`SELECT id, category FROM agentic_templates WHERE active = 1`).all();
console.log(`  Current active templates: ${exported.length}`);

// Simulate import new template
const importData = {
  templates: [
    { id: 'test_import_via_api', category: 'misc', description: 'imported via test',
      content: 'Dạ test import {{customerName|anh/chị}} 🙌', trigger_conditions: null,
      quick_replies: null, confidence: 0.8, active: true, hotel_id: 0 },
  ],
};
const { renderTemplateById } = require('/opt/vp-marketing/dist/services/agentic/template-engine');

// Direct insert (mimicking import endpoint)
const now = Date.now();
db.prepare(`
  INSERT OR REPLACE INTO agentic_templates
    (id, category, description, trigger_conditions, content, quick_replies, confidence, active, hotel_id, version, created_at, updated_at)
  VALUES (?, 'misc', 'imported via test', NULL, ?, NULL, 0.8, 1, 0, 1, ?, ?)
`).run('test_import_via_api', 'Dạ test import {{customerName|anh/chị}} 🙌', now, now);

invalidateCache();
const rendered = renderTemplateById('test_import_via_api', { customerName: 'Anh Minh' });
console.log(`  Rendered imported: "${rendered?.content}"`);

// Cleanup
db.prepare(`DELETE FROM agentic_templates WHERE id = 'test_import_via_api'`).run();

db.close();
console.log('\n✅ Polish verification complete');
JS

node /opt/vp-marketing/_tmp_polish.js
rm /opt/vp-marketing/_tmp_polish.js
"""

c = paramiko.SSHClient()
c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
c.connect(HOST, username="root", password=PASSWORD, timeout=20)
_, out, err = c.exec_command(CMD, timeout=180)
print(out.read().decode('utf-8', errors='replace'))
e = err.read().decode('utf-8', errors='replace')
if e.strip(): print('--STDERR--'); print(e)
c.close()

"""Test Phase 5: A/B variants, click tracking, health score, winner."""
import sys, paramiko
try: sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except: pass
HOST = "103.82.193.74"
PASSWORD = sys.argv[1] if len(sys.argv) > 1 else ""

CMD = r"""
cd /opt/vp-marketing
cat > /opt/vp-marketing/_tmp_p5.js <<'JS'
process.chdir('/opt/vp-marketing');
const Database = require('better-sqlite3');
const db = new Database('data/db.sqlite');

console.log('=== Test 1: A/B variant pick + impression tracking ===');
const {
  invalidateCache, renderTemplateById, trackTemplateUse,
  detectAndMarkConversion, detectAndTrackClick, computeHealthScore
} = require('/opt/vp-marketing/dist/services/agentic/template-engine');
const {
  getVariants, pickVariant, analyzeWinner, promoteWinner
} = require('/opt/vp-marketing/dist/services/agentic/template-variants');

// Clean old test data
db.prepare(`DELETE FROM agentic_template_variants WHERE template_id = 'first_contact_warm'`).run();

// Create B variant
const now = Date.now();
db.prepare(`
  INSERT INTO agentic_template_variants (template_id, variant_key, content, quick_replies, weight, active, impressions, clicks, conversions, created_at, updated_at)
  VALUES ('first_contact_warm', 'B', 'Dạ em xin chào 💚 Em là trợ lý Sonder. Em giúp gì anh/chị ạ?', '[{"title":"🏨 Đặt phòng","payload":"intent_booking"},{"title":"👤 Nhân viên","payload":"intent_handoff"}]', 0.5, 1, 0, 0, 0, ?, ?)
`).run(now, now);

// Also insert variant A (weight 0.5) for balance
db.prepare(`
  INSERT INTO agentic_template_variants (template_id, variant_key, content, quick_replies, weight, active, impressions, clicks, conversions, created_at, updated_at)
  VALUES ('first_contact_warm', 'A', 'Dạ em chào anh/chị 👋 Em là trợ lý AI Sonder. Em có thể giúp gì ạ?', '[{"title":"🏨 Đặt phòng","payload":"intent_booking"}]', 0.5, 1, 0, 0, 0, ?, ?)
`).run(now, now);

console.log('Inserted variants A + B for first_contact_warm');

// Simulate 100 renders — should split ~50/50
let countA = 0, countB = 0;
for (let i = 0; i < 100; i++) {
  const r = renderTemplateById('first_contact_warm', {});
  if (r?.variant_key === 'A') countA++;
  else if (r?.variant_key === 'B') countB++;
}
console.log(`  100 renders: A=${countA}, B=${countB} (expect roughly 50/50)`);

// Check stored impressions
const stored = db.prepare(`SELECT variant_key, impressions FROM agentic_template_variants WHERE template_id = 'first_contact_warm' ORDER BY variant_key`).all();
console.log(`  Stored: ${stored.map(r => r.variant_key + '=' + r.impressions).join(', ')}`);

console.log('\n=== Test 2: Conversion attribution to variant ===');
// Simulate: sender receives variant B, responds with phone
const sender = 'fb:p5_conv_' + Date.now();
trackTemplateUse(sender, 'first_contact_warm', 'discovery', 'B');

// But discovery is not in CONVERSION_CATS, so let me track a decision-category template
const sender2 = 'fb:p5_conv2_' + Date.now();
trackTemplateUse(sender2, 'confirm_booking_summary', 'decision', 'B');
db.prepare(`INSERT OR REPLACE INTO agentic_template_variants (template_id, variant_key, content, weight, active, impressions, clicks, conversions, created_at, updated_at) VALUES ('confirm_booking_summary', 'B', 'variant B content', 0.5, 1, 10, 3, 0, ?, ?)`).run(now, now);

const convBefore = db.prepare(`SELECT conversions FROM agentic_template_variants WHERE template_id = 'confirm_booking_summary' AND variant_key = 'B'`).get();
console.log(`  B conv before: ${convBefore?.conversions || 0}`);

const conv = detectAndMarkConversion(sender2, 'ok 0912345678');
console.log(`  detect: ${JSON.stringify(conv)}`);

const convAfter = db.prepare(`SELECT conversions FROM agentic_template_variants WHERE template_id = 'confirm_booking_summary' AND variant_key = 'B'`).get();
console.log(`  B conv after: ${convAfter?.conversions || 0}`);

console.log('\n=== Test 3: QR click tracking ===');
const clickSender = 'fb:p5_click_' + Date.now();
trackTemplateUse(clickSender, 'first_contact_warm', 'discovery', 'B');

// B has QR [{"title":"🏨 Đặt phòng"},{"title":"👤 Nhân viên"}]
const clicksBefore = db.prepare(`SELECT clicks FROM agentic_template_variants WHERE template_id = 'first_contact_warm' AND variant_key = 'B'`).get();
console.log(`  B clicks before: ${clicksBefore?.clicks || 0}`);

const click1 = detectAndTrackClick(clickSender, '🏨 Đặt phòng');
console.log(`  click "🏨 Đặt phòng": ${JSON.stringify(click1)}`);

const clicksAfter = db.prepare(`SELECT clicks FROM agentic_template_variants WHERE template_id = 'first_contact_warm' AND variant_key = 'B'`).get();
console.log(`  B clicks after: ${clicksAfter?.clicks || 0}`);

// Test normalized match: user types "dat phong" without accents
const clickSender2 = 'fb:p5_click2_' + Date.now();
trackTemplateUse(clickSender2, 'first_contact_warm', 'discovery', 'A');
const click2 = detectAndTrackClick(clickSender2, 'dat phong');
console.log(`  click "dat phong" (no accent): ${JSON.stringify(click2)}`);

console.log('\n=== Test 4: Winner analysis ===');
// Seed B as winner: B has 30 conversions / 50 impressions; A has 5/50
db.prepare(`UPDATE agentic_template_variants SET impressions = 50, conversions = 30 WHERE template_id = 'first_contact_warm' AND variant_key = 'B'`).run();
db.prepare(`UPDATE agentic_template_variants SET impressions = 50, conversions = 5 WHERE template_id = 'first_contact_warm' AND variant_key = 'A'`).run();

const analysis = analyzeWinner('first_contact_warm');
console.log(`  analysis:`);
console.log(`    has_variants: ${analysis.has_variants}`);
console.log(`    enough_data: ${analysis.enough_data}`);
console.log(`    winner: ${analysis.winner} (${((analysis.winner_conv_rate || 0) * 100).toFixed(1)}%)`);
console.log(`    runner_up: ${analysis.runner_up} (${((analysis.runner_up_conv_rate || 0) * 100).toFixed(1)}%)`);
console.log(`    confidence: ${analysis.confidence}`);

console.log('\n=== Test 5: Health score ===');
// first_contact_warm has hits=100 + some conversions + recent use
db.prepare(`UPDATE agentic_templates SET hits = 100, clicks = 30, conversions = 15, last_used_at = ? WHERE id = 'first_contact_warm'`).run(Date.now());
const h1 = computeHealthScore('first_contact_warm');
console.log(`  first_contact_warm: score=${h1.score} tier=${h1.tier}`);
console.log(`    metrics: ${JSON.stringify(h1.metrics)}`);
console.log(`    reasons: ${h1.reasons.join(' | ')}`);

// Simulate bad template: many hits, 0 conversions
db.prepare(`UPDATE agentic_templates SET hits = 30, clicks = 0, conversions = 0, last_used_at = ? WHERE id = 'first_vague'`).run(Date.now() - 5 * 24 * 3600 * 1000);
const h2 = computeHealthScore('first_vague');
console.log(`  first_vague: score=${h2.score} tier=${h2.tier}`);
console.log(`    reasons: ${h2.reasons.join(' | ')}`);

console.log('\n=== Test 6: Promote winner ===');
const promoteR = promoteWinner('first_contact_warm', 'B', 'test@admin');
console.log(`  promote: ${JSON.stringify(promoteR)}`);

// Check parent content updated
const parentAfter = db.prepare(`SELECT content FROM agentic_templates WHERE id = 'first_contact_warm'`).get();
console.log(`  parent content (first 80 chars): ${parentAfter.content.substring(0, 80)}...`);

// Check variants deactivated
const variantsAfter = db.prepare(`SELECT variant_key, active FROM agentic_template_variants WHERE template_id = 'first_contact_warm'`).all();
console.log(`  variants after promote: ${variantsAfter.map(v => v.variant_key + '=active:' + v.active).join(', ')}`);

// Cleanup
db.prepare(`DELETE FROM agentic_template_variants WHERE template_id IN ('first_contact_warm', 'confirm_booking_summary')`).run();
db.prepare(`DELETE FROM agentic_template_tracking WHERE sender_id LIKE 'fb:p5_%'`).run();
// Reset stats
db.prepare(`UPDATE agentic_templates SET hits = 0, clicks = 0, conversions = 0, last_used_at = NULL WHERE id IN ('first_contact_warm', 'first_vague', 'confirm_booking_summary')`).run();
// Restore original first_contact_warm content via force re-seed
const { seedTemplates } = require('/opt/vp-marketing/dist/services/agentic/template-seeder');
seedTemplates(true);
console.log('  cleanup + re-seed done');

db.close();
console.log('\n✅ Phase 5 verification complete');
JS

node /opt/vp-marketing/_tmp_p5.js
rm /opt/vp-marketing/_tmp_p5.js
"""

c = paramiko.SSHClient()
c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
c.connect(HOST, username="root", password=PASSWORD, timeout=20)
_, out, err = c.exec_command(CMD, timeout=120)
print(out.read().decode('utf-8', errors='replace'))
e = err.read().decode('utf-8', errors='replace')
if e.strip(): print('--STDERR--'); print(e)
c.close()

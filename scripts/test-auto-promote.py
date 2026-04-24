"""Test auto-promote: simulate 7-day high-confidence streak + verify promote."""
import sys, paramiko
try: sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except: pass
HOST = "103.82.193.74"
PASSWORD = sys.argv[1] if len(sys.argv) > 1 else ""

CMD = r"""
cd /opt/vp-marketing
cat > /opt/vp-marketing/_tmp_ap.js <<'JS'
process.chdir('/opt/vp-marketing');
const Database = require('better-sqlite3');
const db = new Database('data/db.sqlite');

const { setSetting, getSetting } = require('/opt/vp-marketing/dist/db');

(async () => {
  console.log('=== Test 1: Setup — variants với stats cao ===');

  // Clean previous test data
  db.prepare(`DELETE FROM agentic_template_variants WHERE template_id = 'test_autopromote'`).run();
  db.prepare(`DELETE FROM agentic_variant_winner_log WHERE template_id = 'test_autopromote'`).run();
  db.prepare(`DELETE FROM agentic_templates WHERE id = 'test_autopromote'`).run();

  // Create parent template
  const now = Date.now();
  db.prepare(`
    INSERT INTO agentic_templates (id, category, description, content, confidence, active, hotel_id, version, created_at, updated_at)
    VALUES ('test_autopromote', 'misc', 'Test auto-promote', 'parent content', 0.9, 1, 0, 1, ?, ?)
  `).run(now, now);

  // Create 2 variants — B is clear winner (5× conv rate)
  db.prepare(`
    INSERT INTO agentic_template_variants (template_id, variant_key, content, weight, active, impressions, clicks, conversions, created_at, updated_at)
    VALUES ('test_autopromote', 'A', 'variant A content', 0.5, 1, 100, 10, 5, ?, ?)
  `).run(now, now);

  db.prepare(`
    INSERT INTO agentic_template_variants (template_id, variant_key, content, weight, active, impressions, clicks, conversions, created_at, updated_at)
    VALUES ('test_autopromote', 'B', 'variant B content — winner version', 0.5, 1, 100, 30, 25, ?, ?)
  `).run(now, now);

  console.log('  Created test_autopromote with A (5% conv) + B (25% conv)');

  console.log('\n=== Test 2: Simulate 7-day streak (insert logs cho 7 ngày qua) ===');
  const { logDailyWinnerAnalysis, checkStreak, runDailyAutoPromote, previewAutoPromote } =
    require('/opt/vp-marketing/dist/services/agentic/template-variants');

  // Manually insert 7 daily logs (high confidence, same winner 'B')
  for (let daysAgo = 7; daysAgo >= 1; daysAgo--) {
    const logTs = now - daysAgo * 24 * 3600 * 1000;
    db.prepare(`
      INSERT INTO agentic_variant_winner_log (template_id, winner_key, winner_conv_rate, runner_up_key, runner_up_conv_rate, confidence, total_impressions, logged_at, auto_promoted)
      VALUES ('test_autopromote', 'B', 0.25, 'A', 0.05, 'high', 200, ?, 0)
    `).run(logTs);
  }
  console.log('  Inserted 7 days of logs (all high confidence, winner=B)');

  console.log('\n=== Test 3: checkStreak() ===');
  const streak = checkStreak('test_autopromote');
  console.log(`  templateId: ${streak.templateId}`);
  console.log(`  streak: ${streak.streak}`);
  console.log(`  consistentWinner: ${streak.consistentWinner}`);
  console.log(`  reason: ${streak.reason}`);
  console.log(`  eligible: ${streak.eligible}`);

  console.log('\n=== Test 4: previewAutoPromote() ===');
  const preview = await previewAutoPromote();
  console.log(`  enabled: ${preview.enabled}`);
  console.log(`  checked: ${preview.checked}`);
  console.log(`  eligible: ${preview.eligible.length}`);
  const testEligible = preview.eligible.find(e => e.templateId === 'test_autopromote');
  if (testEligible) {
    console.log(`  ✓ test_autopromote eligible: winner=${testEligible.consistentWinner} streak=${testEligible.streak}`);
  }

  console.log('\n=== Test 5: Run với auto_promote DISABLED (log only) ===');
  setSetting('auto_promote_variants', 'false');
  const r1 = await runDailyAutoPromote();
  console.log(`  enabled: ${r1.enabled}`);
  console.log(`  checked: ${r1.checked} logged: ${r1.logged}`);
  console.log(`  eligible: ${r1.eligible.length}`);
  console.log(`  promoted: ${r1.eligible.filter(e => e.promoted).length} (expect 0 — disabled)`);

  // Parent content should STILL be 'parent content'
  const parentBefore = db.prepare(`SELECT content FROM agentic_templates WHERE id = 'test_autopromote'`).get();
  console.log(`  parent content unchanged: "${parentBefore?.content}"`);

  console.log('\n=== Test 6: Run với auto_promote ENABLED (should promote B) ===');
  setSetting('auto_promote_variants', 'true');

  // Need to re-insert the 7 logs (last run added today's log, streak still there)
  // But the previous run already logged, so streak check now needs these 7 older logs + today's new log = 8 days
  // The check needs the MOST RECENT 7 days — which should all be high (we inserted 7 old + 1 new from r1)
  // The new log from r1 should also be high (variants unchanged), so we should still be eligible

  const r2 = await runDailyAutoPromote();
  console.log(`  enabled: ${r2.enabled}`);
  console.log(`  eligible: ${r2.eligible.length}`);
  const promoted = r2.eligible.filter(e => e.promoted);
  console.log(`  promoted: ${promoted.length}`);
  for (const p of promoted) {
    console.log(`    🏆 ${p.templateId} → ${p.consistentWinner}`);
  }

  // Parent should now be variant B's content
  const parentAfter = db.prepare(`SELECT content, version FROM agentic_templates WHERE id = 'test_autopromote'`).get();
  console.log(`  parent content AFTER: "${parentAfter?.content}" (version ${parentAfter?.version})`);

  // Variants should be archived
  const variantsAfter = db.prepare(`SELECT variant_key, active FROM agentic_template_variants WHERE template_id = 'test_autopromote'`).all();
  console.log(`  variants after promote: ${variantsAfter.map(v => v.variant_key + '=active:' + v.active).join(', ')}`);

  // Check auto_promoted flag in today's log
  const todayLog = db.prepare(`SELECT auto_promoted FROM agentic_variant_winner_log WHERE template_id = 'test_autopromote' ORDER BY logged_at DESC LIMIT 1`).get();
  console.log(`  today's log auto_promoted: ${todayLog?.auto_promoted}`);

  console.log('\n=== Test 7: Re-run — should NOT promote again (1/week limit) ===');
  const r3 = await runDailyAutoPromote();
  const promoted3 = r3.eligible.filter(e => e.promoted);
  console.log(`  eligible: ${r3.eligible.length} promoted: ${promoted3.length} (expect 0 — already promoted this week)`);

  // Cleanup
  db.prepare(`DELETE FROM agentic_template_variants WHERE template_id = 'test_autopromote'`).run();
  db.prepare(`DELETE FROM agentic_variant_winner_log WHERE template_id = 'test_autopromote'`).run();
  db.prepare(`DELETE FROM agentic_templates WHERE id = 'test_autopromote'`).run();
  db.prepare(`DELETE FROM agentic_templates_history WHERE template_id = 'test_autopromote'`).run();
  setSetting('auto_promote_variants', 'false');  // Reset to OFF

  db.close();
  console.log('\n✅ Auto-promote E2E test complete');
})().catch(e => { console.error('Fatal:', e); process.exit(1); });
JS

node /opt/vp-marketing/_tmp_ap.js
rm /opt/vp-marketing/_tmp_ap.js
"""

c = paramiko.SSHClient()
c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
c.connect(HOST, username="root", password=PASSWORD, timeout=20)
_, out, err = c.exec_command(CMD, timeout=120)
print(out.read().decode('utf-8', errors='replace'))
e = err.read().decode('utf-8', errors='replace')
if e.strip(): print('--STDERR--'); print(e)
c.close()

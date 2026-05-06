/**
 * V5 Day 7 — End-to-end test render.
 *
 * Run: node dist/scripts/v5-test-render.js [theme]
 *
 * Generates 1 script + renders 3 variants → reports metrics.
 */

import { generateV5Script } from '../services/v5/script-writer';
import { renderV5Script } from '../services/v5/composer';
import { getBudgetStatus } from '../services/v5/fal-generator';

async function main() {
  const theme = (process.argv[2] === 'saigon_insider' || process.argv[2] === 'sonder_bts')
    ? process.argv[2] as any
    : undefined;

  console.log('═══════════════════════════════════════');
  console.log('  V5 GATE 1 — END-TO-END TEST');
  console.log('═══════════════════════════════════════');
  console.log();

  const budget = getBudgetStatus();
  console.log(`📊 Budget: $${budget.spent.toFixed(2)} / $${budget.budget} (${budget.pct.toFixed(0)}% used, $${budget.remaining.toFixed(2)} remaining)`);
  console.log();

  // 1. Generate script
  console.log('🎬 Step 1: Generating V5 script...');
  const t0 = Date.now();
  const script = await generateV5Script({ theme, generated_by: 'gate1-test' });
  if (!script) {
    console.error('❌ Script generation FAILED');
    process.exit(1);
  }
  console.log(`✅ Script generated in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log(`   ID: ${script.id}`);
  console.log(`   Theme: ${script.theme}`);
  console.log(`   Title: ${script.title}`);
  console.log(`   Duration target: ${script.total_duration_target_sec}s`);
  console.log(`   Hook A (${script.hook_a.pattern}): ${script.hook_a.vo_text || '(silent)'}`);
  console.log(`   Hook B (${script.hook_b.pattern}): ${script.hook_b.vo_text || '(silent)'}`);
  console.log(`   Hook C (${script.hook_c.pattern}): ${script.hook_c.vo_text || '(silent)'}`);
  console.log(`   Visual shots: ${script.visual_plan.shots.length}`);
  console.log();

  // 2. Render
  console.log('🎥 Step 2: Rendering 3 variants (this takes 2-5 min)...');
  const t1 = Date.now();
  const result = await renderV5Script(script.id);
  const renderTime = ((Date.now() - t1) / 1000).toFixed(1);

  if (!result.ok) {
    console.error(`❌ Render FAILED in ${renderTime}s: ${result.error}`);
    process.exit(1);
  }

  console.log(`✅ Render complete in ${renderTime}s`);
  console.log(`   Variants: ${result.variants.length}`);
  console.log(`   Total cost: $${result.total_cost_usd.toFixed(3)}`);
  console.log();

  // 3. Verify
  console.log('🔍 Step 3: Verifying output...');
  for (const v of result.variants) {
    const dur = v.duration_sec.toFixed(1);
    const size = v.size_mb.toFixed(1);
    const cost = v.cost_usd.toFixed(3);
    const passDur = v.duration_sec >= 15 && v.duration_sec <= 35;
    const passSize = v.size_mb < 50;
    const passCost = v.cost_usd < 1;
    const status = passDur && passSize && passCost ? '✅' : '⚠️';
    console.log(`   ${status} Variant ${v.variant.toUpperCase()} (${v.hook_pattern}): ${dur}s, ${size}MB, $${cost}`);
    console.log(`     → ${v.output_path}`);
  }
  console.log();

  // 4. Summary
  const totalDur = result.variants.reduce((s, v) => s + v.duration_sec, 0) / result.variants.length;
  const totalSize = result.variants.reduce((s, v) => s + v.size_mb, 0) / result.variants.length;
  const passGate1 =
    result.variants.length === 3 &&
    totalDur >= 15 && totalDur <= 35 &&
    result.total_cost_usd < 3;

  console.log('═══════════════════════════════════════');
  console.log(`  GATE 1 ${passGate1 ? '✅ PASSED' : '❌ FAILED'}`);
  console.log('═══════════════════════════════════════');
  console.log(`  Variants rendered: ${result.variants.length}/3`);
  console.log(`  Avg duration: ${totalDur.toFixed(1)}s (target 15-35s)`);
  console.log(`  Avg size: ${totalSize.toFixed(1)}MB (target <50MB)`);
  console.log(`  Total cost: $${result.total_cost_usd.toFixed(3)} (target <$3)`);
  console.log();
  console.log('Output paths:');
  for (const v of result.variants) {
    console.log(`  https://app.sondervn.com/v5-out/${require('path').basename(v.output_path)}`);
  }
  console.log();

  if (!passGate1) {
    console.log('⚠️  Gate 1 conditions not met. Review variants + adjust before Phase 2.');
    process.exit(1);
  }

  console.log('🎯 Anh review 3 variants + duyệt → Gate 1 official pass.');
  process.exit(0);
}

main().catch(e => {
  console.error('FATAL:', e);
  process.exit(1);
});

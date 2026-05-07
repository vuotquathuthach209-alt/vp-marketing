/**
 * V5T Gate 1 — End-to-end test render.
 *
 * Run: node dist/scripts/v5t-test-render.js [type]
 *   type: carousel | single_image | poll | question
 */

import { runV5TGeneratePhase } from '../services/v5t/orchestrator';

async function main() {
  const type = (process.argv[2] || 'carousel') as any;

  console.log('═══════════════════════════════════════');
  console.log('  V5T GATE 1 — END-TO-END TEST');
  console.log(`  Type: ${type}`);
  console.log('═══════════════════════════════════════\n');

  const t0 = Date.now();
  const r = await runV5TGeneratePhase({ type, generated_by: 'gate1-test' });
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

  if (!r.ok) {
    console.error(`❌ FAILED in ${elapsed}s: step=${r.step_failed} error=${r.error}`);
    process.exit(1);
  }

  console.log(`✅ Generated post #${r.post_id} in ${elapsed}s`);
  console.log(`   Images: ${r.images_count}`);
  console.log(`   Cost: $${(r.total_cost_usd || 0).toFixed(3)}`);
  console.log();
  console.log('Public URLs:');
  const { db } = await import('../db');
  const images = db.prepare(
    `SELECT composed_path FROM v5t_post_images WHERE post_id = ? ORDER BY position`,
  ).all(r.post_id) as any[];
  for (const img of images) {
    const filename = require('path').basename(img.composed_path);
    console.log(`  https://app.sondervn.com/v5t-out/${filename}`);
  }
  console.log();
  console.log('🎯 Anh review images → click Approve trên dashboard /admin/v5t/dashboard');
  process.exit(0);
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });

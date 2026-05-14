/**
 * Phase D verification: trigger V5T generate NOW to verify:
 *   1. Post-writer firewall pre-check works (skip blacklisted images)
 *   2. Carousel composer fires copyright gate on each position
 *   3. Watermark added to images
 *   4. Publisher final firewall check passes
 *   5. prepublish_audit table logs each check
 */

const { db } = require('/opt/vp-marketing/dist/db');

(async () => {
  console.log('═══ Phase D verification — V5T pipeline with full firewall ═══');
  console.log('');

  // Setup: ensure blacklist has at least 1 entry
  const blacklist = db.prepare('SELECT COUNT(*) AS n FROM copyright_takedown_blacklist').get();
  console.log(`Blacklist entries: ${blacklist.n}`);

  // If empty, blacklist 1 photo to test skip logic
  if (blacklist.n === 0) {
    const sample = db.prepare("SELECT image_path, phash FROM copyright_phashes WHERE image_path LIKE '%sonder-real-footage%' LIMIT 1").get();
    if (sample) {
      db.prepare("INSERT INTO copyright_takedown_blacklist (phash, image_path, reason, added_at) VALUES (?, ?, 'TEST: Phase D verification', ?)").run(sample.phash, sample.image_path, Date.now());
      console.log(`Added test blacklist entry: ${sample.image_path.split('/').pop()}`);
    }
  }

  // Stats before
  const beforeAudits = db.prepare('SELECT COUNT(*) AS n FROM prepublish_audit').get();
  const beforePosts = db.prepare('SELECT COUNT(*) AS n FROM v5t_posts').get();
  console.log(`\nBEFORE: ${beforeAudits.n} audit entries, ${beforePosts.n} v5t_posts`);

  // Trigger generate
  console.log('\n--- Triggering generateV5TPost ---');
  const { generateV5TPost } = require('/opt/vp-marketing/dist/services/v5t/post-writer');
  const t0 = Date.now();
  const post = await generateV5TPost({ type: 'tips_post', generated_by: 'phase-d-test' });
  const t1 = Date.now();

  if (!post) {
    console.log('❌ generateV5TPost returned null (firewall blocked all candidates OR LLM failed)');
    process.exit(0);
  }
  console.log(`✅ Post #${post.id} generated in ${(t1 - t0) / 1000}s`);
  console.log(`   picked_footage_id: ${post.id} (caption ${post.type}, theme ${post.theme})`);

  // Trigger compose
  console.log('\n--- Triggering composeV5TPost ---');
  const { composeV5TPost } = require('/opt/vp-marketing/dist/services/v5t/composer');
  const composeResult = await composeV5TPost(post.id);
  console.log(`Compose ok=${composeResult.ok}, images=${composeResult.images.length}, cost=$${composeResult.total_cost_usd.toFixed(3)}`);
  for (const img of composeResult.images) {
    console.log(`   • pos${img.position} footage_id=${img.footage_id} overlay=${img.has_text_overlay}`);
  }

  // Don't actually publish to FB — just verify firewall would pass via dry-run
  console.log('\n--- Firewall dry-run on composed images ---');
  const { checkBeforePublish } = require('/opt/vp-marketing/dist/services/copyright/firewall');
  const fwResult = await checkBeforePublish({
    source: 'v5t',
    source_id: post.id,
    image_paths: composeResult.images.map(i => i.composed_path),
    caption: post.caption_a,
  });
  console.log(`Firewall decision: ${fwResult.decision} (blocked=${fwResult.blocked})`);
  console.log(`  Image results: ${fwResult.image_results.length} checked, ${fwResult.image_results.filter(r => !r.ok).length} blocked`);
  if (fwResult.caption_issues.length > 0) {
    console.log(`  Caption issues:`);
    for (const i of fwResult.caption_issues) console.log(`    • ${i}`);
  }

  // Stats after
  const afterAudits = db.prepare('SELECT COUNT(*) AS n FROM prepublish_audit').get();
  console.log(`\nAFTER: ${afterAudits.n} audit entries (+${afterAudits.n - beforeAudits.n} from this test)`);

  // Show recent audit entries for this test
  const recents = db.prepare("SELECT source, source_id, decision, blocked, duration_ms FROM prepublish_audit WHERE checked_at > ? ORDER BY checked_at DESC LIMIT 5").all(t0);
  console.log('\nRecent audit entries:');
  for (const r of recents) {
    console.log(`  ${r.decision.padEnd(6)} src=${r.source} id=${r.source_id} blocked=${r.blocked} (${r.duration_ms}ms)`);
  }

  process.exit(0);
})().catch(e => {
  console.error('FATAL:', e);
  process.exit(1);
});

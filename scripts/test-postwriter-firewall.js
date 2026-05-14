/**
 * Test Phase C: V5T post-writer firewall pre-check.
 *
 * Setup: 1 image is in takedown_blacklist (added earlier).
 * Expected: post-writer pickPhotoForPost() should SKIP that image + log "🛡️ skip photo".
 */

const { db } = require('/opt/vp-marketing/dist/db');

(async () => {
  console.log('=== Setup: verify blacklist has at least 1 entry ===');
  const blacklist = db.prepare('SELECT phash, image_path, reason FROM copyright_takedown_blacklist').all();
  console.log('Blacklist entries:', blacklist.length);
  if (blacklist.length === 0) {
    console.log('No blacklist entries — skip test (need to add via /admin/copyright/dashboard first)');
    process.exit(0);
  }
  for (const b of blacklist) {
    console.log(`  - ${b.image_path?.split('/').pop()} (${b.reason})`);
  }

  console.log('');
  console.log('=== Test: call generateV5TPost() — should NOT pick blacklisted image ===');
  const { generateV5TPost } = require('/opt/vp-marketing/dist/services/v5t/post-writer');
  const result = await generateV5TPost({ type: 'tips_post', generated_by: 'firewall-test-c' });

  if (result) {
    console.log(`Generated post #${result.id}`);
    console.log(`  picked_footage_id = ${result.id}`);
    const photo = db.prepare('SELECT path FROM v5_footage WHERE id = (SELECT picked_footage_id FROM v5t_posts WHERE id = ?)').get(result.id);
    if (photo) {
      console.log(`  photo path: ${photo.path}`);
      const isBlacklisted = blacklist.some(b => b.image_path === photo.path);
      if (isBlacklisted) {
        console.log('❌ FAIL: blacklisted image was picked!');
      } else {
        console.log('✅ PASS: picked a non-blacklisted image');
      }
    }
  } else {
    console.log('⚠️ No post generated (all photos firewall-blocked OR inventory empty)');
  }

  process.exit(0);
})().catch(e => {
  console.error('FATAL:', e);
  process.exit(1);
});

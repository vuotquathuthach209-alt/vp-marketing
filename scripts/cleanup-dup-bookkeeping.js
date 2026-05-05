/**
 * One-shot cleanup: fix duplicate facts/counters from ep#14 double-bookkeeping.
 *
 * Background: ep#14 was bookkept twice (first publish + republish after BGM fix).
 * This created:
 *   - 3 dup facts in story_continuity
 *   - linh.appearance_count = 3 (should be 2)
 *   - 2 brand_values over-counted by 1
 *   - linh_season_1.episodes_published = 3 (should be 2)
 *
 * Fix: dedupe + decrement + mark ep#14 as bookkept.
 */

const Database = require('better-sqlite3');
const db = new Database('/opt/vp-marketing/data/db.sqlite');

console.log('═'.repeat(70));
console.log('Cleanup duplicate bookkeeping for ep#14');
console.log('═'.repeat(70));

db.exec('BEGIN');
try {
  // 1. Dedupe story_continuity — keep oldest (lowest id) for each (fact_key, episode_id)
  console.log('\n[1/4] Deduping story_continuity for ep#14...');
  const dups = db.prepare(`
    SELECT fact_key, established_episode_id, MIN(id) as keep_id, COUNT(*) as n
    FROM story_continuity
    WHERE established_episode_id = 14 AND superseded_at IS NULL
    GROUP BY fact_key, established_episode_id
    HAVING COUNT(*) > 1
  `).all();
  for (const d of dups) {
    const r = db.prepare(`
      DELETE FROM story_continuity
      WHERE fact_key = ? AND established_episode_id = ? AND id != ?
    `).run(d.fact_key, d.established_episode_id, d.keep_id);
    console.log(`  ${d.fact_key}: deleted ${r.changes} dup rows (kept id=${d.keep_id})`);
  }

  // 2. Decrement linh.appearance_count by 1
  console.log('\n[2/4] Fix character counts...');
  const linhBefore = db.prepare(`SELECT appearance_count FROM story_characters WHERE slug = ?`).get('linh').appearance_count;
  db.prepare(`UPDATE story_characters SET appearance_count = appearance_count - 1 WHERE slug = ?`).run('linh');
  console.log(`  linh: ${linhBefore} → ${linhBefore - 1}`);

  // 3. Decrement brand values that were used in ep#14 (read brand_values_json)
  console.log('\n[3/4] Fix brand_values counts...');
  const ep14 = db.prepare(`SELECT brand_values_json FROM story_episodes WHERE id = 14`).get();
  const bvUsed = JSON.parse(ep14.brand_values_json || '[]');
  console.log(`  ep#14 used: ${JSON.stringify(bvUsed)}`);
  for (const v of bvUsed) {
    const before = db.prepare(`SELECT appearance_count FROM story_brand_values WHERE value_key = ?`).get(v)?.appearance_count;
    db.prepare(`UPDATE story_brand_values SET appearance_count = appearance_count - 1 WHERE value_key = ?`).run(v);
    const after = db.prepare(`SELECT appearance_count FROM story_brand_values WHERE value_key = ?`).get(v)?.appearance_count;
    console.log(`  ${v}: ${before} → ${after}`);
  }

  // 4. Decrement linh_season_1 arc episodes_published
  console.log('\n[4/4] Fix arc progress...');
  const arcBefore = db.prepare(`SELECT episodes_published FROM story_arcs WHERE arc_slug = ?`).get('linh_season_1')?.episodes_published;
  db.prepare(`UPDATE story_arcs SET episodes_published = episodes_published - 1 WHERE arc_slug = ?`).run('linh_season_1');
  const arcAfter = db.prepare(`SELECT episodes_published FROM story_arcs WHERE arc_slug = ?`).get('linh_season_1')?.episodes_published;
  console.log(`  linh_season_1: ${arcBefore} → ${arcAfter}`);

  // 5. Mark ep#14 as bookkept (so future re-publish skips bookkeeping)
  db.prepare(`UPDATE story_episodes SET bookkept_at = ?, updated_at = ? WHERE id IN (13, 14)`)
    .run(Date.now(), Date.now());
  console.log('\nMarked ep#13 + ep#14 as bookkept_at = now (idempotency anchor)');

  db.exec('COMMIT');
  console.log('\n✅ COMMITTED');
} catch (e) {
  db.exec('ROLLBACK');
  console.error('❌ ROLLBACK:', e.message);
  process.exit(1);
}

// Verify
console.log('\n=== POST-CLEANUP STATE ===');
console.log('\nDuplicate facts (should be empty):');
const remaining = db.prepare(`
  SELECT fact_key, established_episode_id, COUNT(*) as n
  FROM story_continuity
  WHERE superseded_at IS NULL
  GROUP BY fact_key, established_episode_id
  HAVING COUNT(*) > 1
`).all();
console.log(remaining.length === 0 ? '  (none)' : remaining);

console.log('\nLinh count:', db.prepare(`SELECT appearance_count FROM story_characters WHERE slug = ?`).get('linh').appearance_count);

console.log('\nBrand values:');
const bvs = db.prepare(`SELECT value_key, appearance_count FROM story_brand_values`).all();
for (const b of bvs) console.log(`  ${b.value_key}: ${b.appearance_count}`);

console.log('\nArc:');
const arcs = db.prepare(`SELECT arc_slug, episodes_published, episodes_planned FROM story_arcs WHERE status = ?`).all('active');
for (const a of arcs) console.log(`  ${a.arc_slug}: ${a.episodes_published}/${a.episodes_planned}`);

db.close();

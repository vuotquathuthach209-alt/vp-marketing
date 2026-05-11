/**
 * Run Google Vision Web Detection on Drive library to find images
 * that already exist on other websites (booking.com, agoda, partner FB, etc.).
 *
 * Cost: ~$0.0015/image. For ~130 images: ~$0.20 total.
 * Throttled 800ms between calls.
 */

const { db } = require('/opt/vp-marketing/dist/db');
const { assessImage } = require('/opt/vp-marketing/dist/services/copyright/verifier');

(async () => {
  // Pick Drive images that haven't been web-scanned yet (web_matches_count = 0 OR no assessment)
  const rows = db.prepare(`
    SELECT vf.id, vf.path, vf.filename
    FROM v5_footage vf
    LEFT JOIN copyright_assessments ca ON ca.image_path = vf.path
    WHERE (vf.media_type = 'image' OR vf.media_type IS NULL)
      AND vf.path LIKE '%sonder-real-footage%'
      AND (vf.path LIKE '%.jpg' OR vf.path LIKE '%.JPG' OR vf.path LIKE '%.jpeg' OR vf.path LIKE '%.png')
      AND vf.path NOT LIKE '%.HEIC'
      AND vf.path NOT LIKE '%.heic'
    ORDER BY vf.id DESC
  `).all();

  console.log(`Found ${rows.length} Drive images to web-scan`);
  console.log(`Estimated cost: $${(rows.length * 0.0015).toFixed(3)}`);

  let scanned = 0;
  let foundOnWeb = 0;
  let critical = 0;
  let totalCost = 0;
  const flagged = [];

  for (const row of rows) {
    try {
      // Skip if already web-scanned (web_matches_count > 0 in existing assessment)
      const existing = db.prepare('SELECT web_matches_count, checked_at FROM copyright_assessments WHERE image_path = ?').get(row.path);
      if (existing && existing.web_matches_count > 0 && (Date.now() - existing.checked_at) < 7 * 86400_000) {
        console.log(`[skip] ${row.filename} — already web-scanned recently`);
        continue;
      }

      console.log(`[scan ${scanned + 1}/${rows.length}] ${row.filename}...`);
      const a = await assessImage(row.path, { skip_web_search: false });
      scanned++;
      totalCost += 0.0015;

      if (a.web_matches_count > 0) {
        foundOnWeb++;
        console.log(`  ⚠️ Found on ${a.web_matches_count} other website(s):`);
        a.web_matches.slice(0, 3).forEach(url => console.log(`    - ${url.slice(0, 100)}`));
        flagged.push({
          id: row.id,
          filename: row.filename,
          path: row.path,
          web_matches_count: a.web_matches_count,
          web_matches: a.web_matches.slice(0, 5),
          risk_score: a.risk_score,
          risk_level: a.risk_level,
          status: a.status,
        });
      }
      if (a.risk_level === 'critical' || a.risk_level === 'high') {
        critical++;
      }

      // Throttle 800ms to respect API rate limits
      await new Promise(r => setTimeout(r, 800));
    } catch (e) {
      console.error(`[error] ${row.filename}:`, e.message);
    }
  }

  console.log('');
  console.log('═══════════════════════════════════════');
  console.log(`✅ SCAN COMPLETE`);
  console.log(`  Scanned: ${scanned} images`);
  console.log(`  Found on web: ${foundOnWeb} (${Math.round(foundOnWeb / scanned * 100)}%)`);
  console.log(`  Critical/High risk: ${critical}`);
  console.log(`  Cost: $${totalCost.toFixed(3)}`);
  console.log('═══════════════════════════════════════');

  if (flagged.length > 0) {
    console.log('');
    console.log('🚨 FLAGGED IMAGES (found on other websites):');
    for (const f of flagged) {
      console.log(`  [#${f.id}] ${f.filename}  score=${f.risk_score} level=${f.risk_level}`);
      for (const url of f.web_matches.slice(0, 2)) {
        console.log(`    → ${url.slice(0, 90)}`);
      }
    }
  }

  process.exit(0);
})().catch(e => {
  console.error('FATAL:', e);
  process.exit(1);
});

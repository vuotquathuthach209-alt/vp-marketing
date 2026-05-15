"""Verify CSE working + run baseline rank check cho tat ca 42 keywords."""
import paramiko, sys, io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")
HOST = "103.82.193.74"; USER = "root"; PASS = "cCxEvKZ0J3Ee6NJG"

SCRIPT = r"""
cat > /tmp/baseline.js <<'EOF'
(async () => {
  const { db } = require('/opt/vp-marketing/dist/db');
  const { checkKeywordRank, checkAllKeywords, recordKeywordRank } = require('/opt/vp-marketing/dist/services/seo/keyword-tracker');

  console.log('═══════════════════════════════════════════');
  console.log('  STEP 1: SMOKE TEST CSE');
  console.log('═══════════════════════════════════════════');

  console.log('\n▶ Test 1: branded "sondervn" (retry up to 5x với delay 30s nếu API mới enable)');
  let r1;
  for (let attempt = 1; attempt <= 5; attempt++) {
    r1 = await checkKeywordRank('sondervn', 'https://sondervn.com');
    if (!r1.error) break;
    if (r1.error.includes('not been used') || r1.error.includes('disabled')) {
      console.log('  attempt ' + attempt + '/5: API chưa propagate, đợi 30s...');
      await new Promise(r => setTimeout(r, 30000));
    } else { break; }
  }
  if (r1.error) { console.log('❌ ' + r1.error); process.exit(1); }
  console.log('  rank=' + (r1.rank ? '#' + r1.rank : 'not in top 50') + ' total_results=' + (r1.total_results||'n/a'));

  console.log('\n▶ Test 2: head term "khách sạn đà lạt"');
  const r2 = await checkKeywordRank('khách sạn đà lạt', 'https://sondervn.com');
  if (r2.error) { console.log('❌ ' + r2.error); process.exit(1); }
  console.log('  rank=' + (r2.rank ? '#' + r2.rank : 'not in top 50') + ' total_results=' + (r2.total_results||'n/a'));

  if (!r2.total_results || r2.total_results < 1000) {
    console.log('\n⚠️  total_results = ' + r2.total_results + ' < 1000 cho head term phổ biến');
    console.log('    → "Search the entire web" CHƯA bật trong CSE settings');
    console.log('    → Tạm tiếp tục baseline nhưng kết quả sẽ thiếu chính xác');
  } else {
    console.log('\n✅ Total results = ' + r2.total_results.toLocaleString() + ' → CSE đang search ENTIRE WEB');
  }

  console.log('\n═══════════════════════════════════════════');
  console.log('  STEP 2: BASELINE CHECK 42 KEYWORDS');
  console.log('═══════════════════════════════════════════');
  console.log('\nĐang check (~1 phút, tốn ~10-50 quota CSE)...\n');
  const t0 = Date.now();
  const result = await checkAllKeywords({ onlyStale: false });
  const dt = ((Date.now()-t0)/1000).toFixed(1);

  console.log('Checked: ' + result.checked);
  console.log('Errors:  ' + result.errors);
  console.log('Skipped: ' + result.skipped);
  console.log('Cost:    $' + (result.cost_usd||0).toFixed(4));
  console.log('Duration: ' + dt + 's');

  console.log('\n═══════════════════════════════════════════');
  console.log('  STEP 3: BASELINE BY TIER');
  console.log('═══════════════════════════════════════════');

  const tiers = ['branded', 'long_tail', 'medium_tail', 'head_term'];
  for (const tier of tiers) {
    console.log('\n▼ ' + tier.toUpperCase());
    const rows = db.prepare(`
      SELECT keyword, current_rank, target_url
      FROM seo_keywords WHERE category = ?
      ORDER BY (current_rank IS NULL), current_rank ASC
    `).all(tier);
    let inTop10 = 0, inTop30 = 0, inTop100 = 0, notRanked = 0;
    for (const k of rows) {
      const rank = k.current_rank;
      let badge = '   —';
      if (rank && rank <= 10) { badge = '🥇#' + String(rank).padStart(2); inTop10++; inTop30++; inTop100++; }
      else if (rank && rank <= 30) { badge = '🥈#' + String(rank).padStart(2); inTop30++; inTop100++; }
      else if (rank && rank <= 100) { badge = '🥉#' + String(rank).padStart(2); inTop100++; }
      else { notRanked++; }
      console.log('  ' + badge + '  ' + k.keyword.slice(0,60));
    }
    console.log('  ──────────────');
    console.log('  Top 10: ' + inTop10 + ' | Top 30: ' + inTop30 + ' | Top 100: ' + inTop100 + ' | NOT ranked: ' + notRanked + ' (of ' + rows.length + ')');
  }

  console.log('\n═══════════════════════════════════════════');
  console.log('  OVERALL BASELINE SUMMARY');
  console.log('═══════════════════════════════════════════');
  const summary = db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN current_rank BETWEEN 1 AND 10 THEN 1 ELSE 0 END) AS top10,
      SUM(CASE WHEN current_rank BETWEEN 1 AND 30 THEN 1 ELSE 0 END) AS top30,
      SUM(CASE WHEN current_rank BETWEEN 1 AND 100 THEN 1 ELSE 0 END) AS top100,
      SUM(CASE WHEN current_rank IS NULL THEN 1 ELSE 0 END) AS not_ranked
    FROM seo_keywords
  `).get();
  console.log('Total tracked: ' + summary.total);
  console.log('  🥇 Top 10:    ' + summary.top10 + ' (' + (summary.top10/summary.total*100).toFixed(0) + '%)');
  console.log('  🥈 Top 30:    ' + summary.top30 + ' (' + (summary.top30/summary.total*100).toFixed(0) + '%)');
  console.log('  🥉 Top 100:   ' + summary.top100 + ' (' + (summary.top100/summary.total*100).toFixed(0) + '%)');
  console.log('  ❌ Not ranked: ' + summary.not_ranked + ' (' + (summary.not_ranked/summary.total*100).toFixed(0) + '%)');
  console.log('');
  console.log('Baseline đã lưu vào seo_keyword_history → từ mai tool sẽ tự check + so sánh.');

  process.exit(0);
})().catch(e => { console.error('FATAL:', e?.message || e); console.error(e?.stack); process.exit(1); });
EOF
cd /opt/vp-marketing && node /tmp/baseline.js
"""

cl = paramiko.SSHClient()
cl.set_missing_host_key_policy(paramiko.AutoAddPolicy())
cl.connect(HOST, 22, USER, PASS, timeout=30, banner_timeout=60)
_, o, e = cl.exec_command(SCRIPT, timeout=300)
print(o.read().decode("utf-8", errors="replace").rstrip())
err = e.read().decode("utf-8", errors="replace")
if err: print("STDERR:", err, file=sys.stderr)
cl.close()

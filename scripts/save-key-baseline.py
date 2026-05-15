"""Save new CSE API key + smoke test + baseline check 42 keywords."""
import paramiko, sys, io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")
HOST = "103.82.193.74"; USER = "root"; PASS = "cCxEvKZ0J3Ee6NJG"

NEW_KEY = "AIzaSyBVoBxEoP3-UYoCBGJanOCYqeud15Waiu0"

SCRIPT = rf"""
cat > /tmp/baseline2.js <<'EOF'
(async () => {{
  const {{ db, setSetting, getSetting }} = require('/opt/vp-marketing/dist/db');
  const {{ checkKeywordRank, checkAllKeywords }} = require('/opt/vp-marketing/dist/services/seo/keyword-tracker');

  console.log('═══════════════════════════════════════════');
  console.log('  STEP 0: Save new CSE API key');
  console.log('═══════════════════════════════════════════');
  setSetting('google_cse_api_key', '{NEW_KEY}');
  console.log('Saved google_cse_api_key = ' + getSetting('google_cse_api_key').slice(0, 12) + '...');
  console.log('CSE ID:                  ' + getSetting('google_cse_id'));

  console.log('\n═══════════════════════════════════════════');
  console.log('  STEP 1: SMOKE TEST');
  console.log('═══════════════════════════════════════════');

  // Retry up to 8x với delay 45s — Google propagate API enable có thể chậm 5-10 phút
  console.log('\n▶ Test 1: "sondervn" (branded)');
  let r1;
  for (let attempt = 1; attempt <= 8; attempt++) {{
    r1 = await checkKeywordRank('sondervn', 'https://sondervn.com');
    if (!r1.error) break;
    // Match any 403/permission/propagation error
    const isTransient = r1.error.includes('not been used') || r1.error.includes('disabled')
      || r1.error.includes('blocked') || r1.error.includes('does not have the access')
      || r1.error.includes('PERMISSION_DENIED') || r1.error.includes('forbidden');
    if (isTransient) {{
      console.log('  attempt ' + attempt + '/8: ' + r1.error.slice(0, 100) + '... đợi 45s');
      await new Promise(r => setTimeout(r, 45000));
    }} else {{ break; }}
  }}
  if (r1.error) {{
    console.log('❌ FATAL after 8 attempts: ' + r1.error);
    console.log('');
    console.log('Possible causes:');
    console.log('  1. API key có "API restrictions" block Custom Search API');
    console.log('     → Check at: https://console.cloud.google.com/apis/credentials');
    console.log('     → Click key "TÌM KIẾM" → API restrictions → đảm bảo có "Custom Search API"');
    console.log('  2. Project chưa enable billing (Custom Search free 100/day không cần billing,');
    console.log('     nhưng đôi khi Google bắt buộc cho new projects)');
    console.log('  3. Cần đợi thêm 5-10 phút để propagate');
    process.exit(1);
  }}
  console.log('  rank=' + (r1.rank ? '#' + r1.rank : 'not in top 50') + ' total_results=' + (r1.total_results||'n/a').toLocaleString());

  console.log('\n▶ Test 2: "khách sạn đà lạt" (head term — verify entire-web mode)');
  const r2 = await checkKeywordRank('khách sạn đà lạt', 'https://sondervn.com');
  if (r2.error) {{ console.log('❌ ' + r2.error); }}
  else {{
    console.log('  rank=' + (r2.rank ? '#' + r2.rank : 'not in top 50') + ' total_results=' + (r2.total_results||'n/a').toLocaleString());
    if (!r2.total_results || r2.total_results < 1000) {{
      console.log('\n  ⚠️ total_results thấp → CSE chưa bật "Search the entire web"');
      console.log('     → Anh phải vào https://programmablesearchengine.google.com/ → Edit CSE engine → Setup → bật "Search the entire web"');
      console.log('     → Em vẫn tiếp tục baseline check (kết quả sẽ thiếu chính xác cho head terms)');
    }} else {{
      console.log('  ✅ CSE search ENTIRE WEB (' + r2.total_results.toLocaleString() + ' results)');
    }}
  }}

  console.log('\n═══════════════════════════════════════════');
  console.log('  STEP 2: BASELINE 42 KEYWORDS');
  console.log('═══════════════════════════════════════════');
  console.log('\nĐang check toàn bộ (~3-5 phút, tốn ~30-50 CSE quota)...\n');
  const t0 = Date.now();
  const result = await checkAllKeywords({{ onlyStale: false }});
  console.log('Done: ' + result.checked + ' checked, ' + result.errors + ' errors, ' + result.skipped + ' skipped');
  console.log('Cost: $' + (result.cost_usd||0).toFixed(4) + ' | Duration: ' + ((Date.now()-t0)/1000).toFixed(1) + 's');

  console.log('\n═══════════════════════════════════════════');
  console.log('  STEP 3: RESULTS BY TIER');
  console.log('═══════════════════════════════════════════');

  for (const tier of ['branded', 'long_tail', 'medium_tail', 'head_term']) {{
    console.log('\n▼ ' + tier.toUpperCase());
    const rows = db.prepare(`
      SELECT keyword, current_rank
      FROM seo_keywords WHERE category = ?
      ORDER BY (current_rank IS NULL), current_rank ASC
    `).all(tier);
    let t10 = 0, t30 = 0, t100 = 0, nr = 0;
    for (const k of rows) {{
      let badge = '   —';
      if (k.current_rank && k.current_rank <= 10) {{ badge = '🥇#' + String(k.current_rank).padStart(2); t10++; t30++; t100++; }}
      else if (k.current_rank && k.current_rank <= 30) {{ badge = '🥈#' + String(k.current_rank).padStart(2); t30++; t100++; }}
      else if (k.current_rank && k.current_rank <= 100) {{ badge = '🥉#' + String(k.current_rank).padStart(2); t100++; }}
      else nr++;
      console.log('  ' + badge + '  ' + k.keyword.slice(0,55));
    }}
    console.log('  ────────  T10=' + t10 + ' T30=' + t30 + ' T100=' + t100 + ' NR=' + nr + ' (of ' + rows.length + ')');
  }}

  console.log('\n═══════════════════════════════════════════');
  console.log('  OVERALL BASELINE');
  console.log('═══════════════════════════════════════════');
  const s = db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN current_rank BETWEEN 1 AND 10 THEN 1 ELSE 0 END) AS t10,
      SUM(CASE WHEN current_rank BETWEEN 1 AND 30 THEN 1 ELSE 0 END) AS t30,
      SUM(CASE WHEN current_rank BETWEEN 1 AND 100 THEN 1 ELSE 0 END) AS t100,
      SUM(CASE WHEN current_rank IS NULL THEN 1 ELSE 0 END) AS nr
    FROM seo_keywords
  `).get();
  console.log('Total tracked: ' + s.total);
  console.log('  🥇 Top 10:     ' + s.t10 + ' (' + (s.t10/s.total*100).toFixed(0) + '%)');
  console.log('  🥈 Top 30:     ' + s.t30 + ' (' + (s.t30/s.total*100).toFixed(0) + '%)');
  console.log('  🥉 Top 100:    ' + s.t100 + ' (' + (s.t100/s.total*100).toFixed(0) + '%)');
  console.log('  ❌ Not ranked: ' + s.nr + ' (' + (s.nr/s.total*100).toFixed(0) + '%)');
  console.log('\n✅ Baseline saved. Daily cron 3:30 AM VN sẽ tự check + so sánh từ mai.');

  process.exit(0);
}})().catch(e => {{ console.error('FATAL:', e?.message || e); process.exit(1); }});
EOF
cd /opt/vp-marketing && node /tmp/baseline2.js
"""

cl = paramiko.SSHClient()
cl.set_missing_host_key_policy(paramiko.AutoAddPolicy())
cl.connect(HOST, 22, USER, PASS, timeout=30, banner_timeout=60)
_, o, e = cl.exec_command(SCRIPT, timeout=600)
print(o.read().decode("utf-8", errors="replace").rstrip())
err = e.read().decode("utf-8", errors="replace")
if err: print("STDERR:", err, file=sys.stderr)
cl.close()

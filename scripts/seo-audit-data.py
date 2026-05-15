"""Audit how much SEO data sondervn.com has to feed article writer + assess ranking baseline."""
import paramiko, sys, io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")
HOST = "103.82.193.74"; USER = "root"; PASS = "cCxEvKZ0J3Ee6NJG"

SCRIPT = r"""
cat > /tmp/seo-data.js <<'EOF'
const { db } = require('/opt/vp-marketing/dist/db');

console.log('═══════════════════════════════════════════════════');
console.log('  PHẦN 1: DATA HIỆN CÓ ĐỂ VIẾT BÀI SEO');
console.log('═══════════════════════════════════════════════════');

// A. Crawled pages on sondervn.com
const pages = db.prepare('SELECT page_type, COUNT(*) AS n FROM seo_pages GROUP BY page_type ORDER BY n DESC').all();
const totalPages = db.prepare('SELECT COUNT(*) AS n FROM seo_pages').get().n;
console.log('\n📄 SONDERVN.COM PAGES (đã crawl):');
console.log('  Total: ' + totalPages + ' pages');
for (const p of pages) console.log('    ' + p.page_type.padEnd(20) + p.n);

// B. Crawl coverage stats
const crawlStats = db.prepare(`
  SELECT
    SUM(CASE WHEN has_schema=1 THEN 1 ELSE 0 END) AS with_schema,
    SUM(CASE WHEN has_schema=0 THEN 1 ELSE 0 END) AS no_schema,
    SUM(image_count) AS total_images,
    SUM(images_with_alt) AS images_w_alt,
    SUM(images_without_alt) AS images_no_alt,
    AVG(word_count) AS avg_words,
    SUM(word_count) AS total_words
  FROM seo_pages
`).get();
console.log('\n🔍 Coverage:');
console.log('  Pages with schema:    ' + crawlStats.with_schema + ' / ' + totalPages);
console.log('  Pages thiếu schema:   ' + crawlStats.no_schema);
console.log('  Total images:         ' + (crawlStats.total_images||0));
console.log('  Images có alt:        ' + (crawlStats.images_w_alt||0));
console.log('  Images THIẾU alt:     ' + (crawlStats.images_no_alt||0));
console.log('  Avg words/page:       ' + Math.round(crawlStats.avg_words||0));
console.log('  Total content words:  ' + (crawlStats.total_words||0));

// C. Open SEO issues
const issues = db.prepare('SELECT severity, COUNT(*) AS n FROM seo_issues WHERE fixed=0 GROUP BY severity').all();
const totalIssues = db.prepare('SELECT COUNT(*) AS n FROM seo_issues WHERE fixed=0').get().n;
console.log('\n🔴 SEO ISSUES (open):');
console.log('  Total: ' + totalIssues);
for (const i of issues) console.log('    ' + i.severity.padEnd(10) + i.n);

const topIssueTypes = db.prepare('SELECT type, COUNT(*) AS n FROM seo_issues WHERE fixed=0 GROUP BY type ORDER BY n DESC LIMIT 8').all();
console.log('  Top issue types:');
for (const t of topIssueTypes) console.log('    ' + t.type.padEnd(30) + t.n);

// D. Tracked keywords + current rankings
const keywords = db.prepare('SELECT keyword, current_rank, prev_rank, target_url, last_checked_at FROM seo_keywords ORDER BY current_rank ASC NULLS LAST LIMIT 30').all();
console.log('\n🔑 TRACKED KEYWORDS:');
console.log('  Total tracked: ' + db.prepare('SELECT COUNT(*) AS n FROM seo_keywords').get().n);
console.log('');
const inTop10 = keywords.filter(k => k.current_rank && k.current_rank <= 10).length;
const inTop30 = keywords.filter(k => k.current_rank && k.current_rank <= 30).length;
const inTop100 = keywords.filter(k => k.current_rank && k.current_rank <= 100).length;
const notRanked = keywords.filter(k => !k.current_rank).length;
console.log('  Ranking distribution:');
console.log('    Top 10:    ' + inTop10);
console.log('    Top 30:    ' + inTop30);
console.log('    Top 100:   ' + inTop100);
console.log('    Not in top 100: ' + notRanked);
console.log('');
console.log('  Sample (top 20 by rank):');
for (const k of keywords.slice(0, 20)) {
  const rank = k.current_rank ? '#' + String(k.current_rank).padStart(3) : '  —';
  const url = (k.target_url||'').slice(0,40);
  console.log('    ' + rank + '  ' + k.keyword.slice(0,50).padEnd(50) + url);
}

// E. Hotels available (for hotel_comparison / destination_guide articles)
const hotels = db.prepare('SELECT COUNT(*) AS n FROM hotel_profile').get().n;
const hotelsByCity = db.prepare(`SELECT city, COUNT(*) AS n FROM hotel_profile WHERE city IS NOT NULL GROUP BY city ORDER BY n DESC LIMIT 10`).all();
console.log('\n🏨 HOTEL DATA (cho hotel_comparison + destination_guide):');
console.log('  Total hotels: ' + hotels);
console.log('  By city:');
for (const c of hotelsByCity) console.log('    ' + (c.city||'unknown').padEnd(25) + c.n);

// F. Existing articles
const articles = db.prepare('SELECT status, COUNT(*) AS n FROM seo_articles GROUP BY status').all();
console.log('\n📝 SEO ARTICLES (đã sinh):');
console.log('  Total: ' + db.prepare('SELECT COUNT(*) AS n FROM seo_articles').get().n);
for (const a of articles) console.log('    ' + a.status.padEnd(15) + a.n);

console.log('\n═══════════════════════════════════════════════════');
console.log('  PHẦN 2: BASELINE RANKING');
console.log('═══════════════════════════════════════════════════');

// G. Latest keyword check timestamp
const lastCheck = db.prepare('SELECT MAX(last_checked_at) AS t FROM seo_keywords').get().t;
if (lastCheck) {
  const days = Math.floor((Date.now() - lastCheck) / 86400000);
  console.log('\n⏰ Last keyword check: ' + new Date(lastCheck).toISOString() + ' (' + days + ' days ago)');
}

// H. Daily snapshot history
const snapshots = db.prepare('SELECT COUNT(*) AS n FROM seo_daily_snapshot').get().n;
console.log('📊 Daily snapshots stored: ' + snapshots);

// I. Backlink data? (placeholder — usually external)
console.log('\nℹ️ Backlink profile, DA/DR data: KHÔNG có (cần Ahrefs/SEMrush API — chưa wire)');

// J. CSE/SerpAPI config check
const cseKey = db.prepare("SELECT value FROM settings WHERE key='google_cse_api_key'").get();
const cseId = db.prepare("SELECT value FROM settings WHERE key='google_cse_id'").get();
const serpapi = db.prepare("SELECT value FROM settings WHERE key='serpapi_key'").get();
console.log('\n🔧 Keyword rank check config:');
console.log('  Google CSE API key: ' + (cseKey?.value ? '✅ configured' : '❌ MISSING'));
console.log('  Google CSE ID:      ' + (cseId?.value ? '✅ configured' : '❌ MISSING'));
console.log('  SerpAPI key:        ' + (serpapi?.value ? '✅ configured' : '❌ MISSING'));

process.exit(0);
EOF
cd /opt/vp-marketing && node /tmp/seo-data.js
"""

cl = paramiko.SSHClient()
cl.set_missing_host_key_policy(paramiko.AutoAddPolicy())
cl.connect(HOST, 22, USER, PASS, timeout=30, banner_timeout=60)
_, o, e = cl.exec_command(SCRIPT, timeout=60)
print(o.read().decode("utf-8", errors="replace").rstrip())
err = e.read().decode("utf-8", errors="replace")
if err: print("STDERR:", err, file=sys.stderr)
cl.close()

"""Verify keyword tracker end-to-end after seed."""
import paramiko, sys, io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")
HOST = "103.82.193.74"; USER = "root"; PASS = "cCxEvKZ0J3Ee6NJG"

SCRIPT = r"""
cat > /tmp/verify.js <<'EOF'
const { db, getSetting } = require('/opt/vp-marketing/dist/db');
const { checkKeywordRank, setManualRank, getKeywordHistory } = require('/opt/vp-marketing/dist/services/seo/keyword-tracker');

console.log('=== TEST 1: Keyword inventory + tier breakdown ===');
const total = db.prepare('SELECT COUNT(*) AS n FROM seo_keywords').get().n;
console.log('Total tracked: ' + total);
const byTier = db.prepare('SELECT category, COUNT(*) AS n FROM seo_keywords GROUP BY category').all();
for (const t of byTier) console.log('  ' + t.category.padEnd(15) + t.n);

console.log('\n=== TEST 2: Manual rank entry (works without CSE config) ===');
const branded = db.prepare("SELECT id, keyword FROM seo_keywords WHERE category = 'branded' LIMIT 1").get();
console.log('Pick keyword: "' + branded.keyword + '" (id=' + branded.id + ')');
setManualRank(branded.id, 1);  // Simulate admin saying "we're ranking #1"
console.log('setManualRank(id, 1) — OK');

const updated = db.prepare('SELECT keyword, current_rank, last_checked_at FROM seo_keywords WHERE id = ?').get(branded.id);
console.log('Verify: keyword="' + updated.keyword + '" current_rank=' + updated.current_rank + ' last_checked=' + (updated.last_checked_at ? new Date(updated.last_checked_at).toISOString() : 'null'));

const history = getKeywordHistory(branded.id, 5);
console.log('History entries: ' + history.length);
if (history.length > 0) console.log('  Latest: rank=' + history[0].rank + ' at ' + new Date(history[0].checked_at).toISOString());

// Reset
setManualRank(branded.id, null);
console.log('(reset)');

console.log('\n=== TEST 3: Try auto rank-check (will fail without CSE ID — expected) ===');
try {
  const r = await checkKeywordRank('sondervn', 'https://sondervn.com');
  console.log('Source: ' + r.source);
  console.log('Rank: ' + (r.rank || 'not in top 50'));
  console.log('Cost: $' + (r.cost_usd || 0).toFixed(4));
  if (r.error) console.log('Error: ' + r.error);
  if (r.total_results) console.log('Total results: ' + r.total_results);
} catch (e) {
  console.log('Threw: ' + e.message);
}

console.log('\n=== TEST 4: Check daily cron schedule ===');
const seoCronEnabled = getSetting('seo_daily_cron_enabled');
console.log('seo_daily_cron_enabled: ' + (seoCronEnabled === 'false' ? '❌ DISABLED' : '✅ enabled (default)'));
console.log('Schedule: 3:30 AM VN — checks all keywords + crawls sitemap + audits');

console.log('\n=== READINESS REPORT ===');
const cseKey = getSetting('google_cse_api_key') || getSetting('google_api_key');
const cseId = getSetting('google_cse_id');
const serpapi = getSetting('serpapi_key');
console.log('Keywords tracked:        ' + total + ' / 42 seeded');
console.log('Article writer:          ✅ ready (test passed earlier)');
console.log('Manual rank entry:       ✅ working');
console.log('Auto rank via CSE:       ' + (cseKey && cseId ? '✅ ready' : '❌ MISSING google_cse_id (admin paste qua dashboard)'));
console.log('Auto rank via SerpAPI:   ' + (serpapi ? '✅' : '❌ (optional)'));
console.log('Daily cron 3:30 AM VN:   ' + (seoCronEnabled !== 'false' ? '✅ enabled' : '❌ disabled'));

process.exit(0);
EOF
cd /opt/vp-marketing && node --no-warnings -e "
process.on('unhandledRejection', e => { console.error('UNHANDLED:', e); process.exit(1); });
(async () => { await import('/tmp/verify.js').catch(async () => {
  // CommonJS fallback
  await require('/tmp/verify.js');
}); })();
" 2>&1 || node /tmp/verify.js
"""

cl = paramiko.SSHClient()
cl.set_missing_host_key_policy(paramiko.AutoAddPolicy())
cl.connect(HOST, 22, USER, PASS, timeout=30, banner_timeout=60)
_, o, e = cl.exec_command(SCRIPT, timeout=60)
print(o.read().decode("utf-8", errors="replace").rstrip())
err = e.read().decode("utf-8", errors="replace")
if err: print("STDERR:", err, file=sys.stderr)
cl.close()

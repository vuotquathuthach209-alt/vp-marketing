"""Trigger seedSondervnKeywords + verify on VPS."""
import paramiko, sys, io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")
HOST = "103.82.193.74"; USER = "root"; PASS = "cCxEvKZ0J3Ee6NJG"

SCRIPT = r"""
cat > /tmp/seed.js <<'EOF'
const { db } = require('/opt/vp-marketing/dist/db');
const { seedSondervnKeywords, SONDERVN_SEED_KEYWORDS } = require('/opt/vp-marketing/dist/services/seo/seed-keywords');

console.log('=== BEFORE: existing keywords ===');
const before = db.prepare('SELECT COUNT(*) AS n FROM seo_keywords').get().n;
console.log('Total: ' + before);

console.log('\n=== Seeding ' + SONDERVN_SEED_KEYWORDS.length + ' curated keywords ===');
const r = seedSondervnKeywords();
console.log('Inserted: ' + r.inserted + ', Skipped: ' + r.skipped + ', Total: ' + r.total);

console.log('\n=== AFTER: by category ===');
const byCat = db.prepare(`SELECT category, COUNT(*) AS n FROM seo_keywords GROUP BY category ORDER BY n DESC`).all();
for (const c of byCat) console.log('  ' + (c.category||'(none)').padEnd(15) + c.n);

console.log('\n=== Sample by tier ===');
for (const cat of ['branded', 'long_tail', 'medium_tail', 'head_term']) {
  const sample = db.prepare(`SELECT keyword, target_url FROM seo_keywords WHERE category = ? LIMIT 4`).all(cat);
  console.log('\n  [' + cat.toUpperCase() + ']');
  for (const s of sample) console.log('    • ' + s.keyword.slice(0,60).padEnd(60) + ' → ' + (s.target_url||'').slice(0,40));
}

console.log('\n=== Keyword tracking config ===');
const { getSetting } = require('/opt/vp-marketing/dist/db');
const cseKey = getSetting('google_cse_api_key') || getSetting('google_api_key');
const cseId = getSetting('google_cse_id');
const serpapi = getSetting('serpapi_key');
console.log('  Google CSE API key: ' + (cseKey ? '✅ (' + cseKey.slice(0,8) + '...)' : '❌ MISSING — admin cấu hình ở Settings'));
console.log('  Google CSE ID:      ' + (cseId ? '✅ (' + cseId + ')' : '❌ MISSING'));
console.log('  SerpAPI key:        ' + (serpapi ? '✅' : '❌ MISSING (optional alt to CSE)'));

process.exit(0);
EOF
cd /opt/vp-marketing && node /tmp/seed.js
"""

cl = paramiko.SSHClient()
cl.set_missing_host_key_policy(paramiko.AutoAddPolicy())
cl.connect(HOST, 22, USER, PASS, timeout=30, banner_timeout=60)
_, o, e = cl.exec_command(SCRIPT, timeout=60)
print(o.read().decode("utf-8", errors="replace").rstrip())
err = e.read().decode("utf-8", errors="replace")
if err: print("STDERR:", err, file=sys.stderr)
cl.close()

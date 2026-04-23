"""Test CI v2 — social sources + AI image."""
import sys, paramiko
try: sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except: pass

HOST = "103.82.193.74"
PASSWORD = sys.argv[1] if len(sys.argv) > 1 else ""

CMD = r"""
cd /opt/vp-marketing

echo "=== 1. Pre-ingest social sources (blog RSS) ==="
cat > tmp.js <<'JS'
(async () => {
  try {
    const { ingestTravelBlogs } = require('./dist/services/social-inspiration-fetcher');
    const t0 = Date.now();
    const r = await ingestTravelBlogs(1);
    console.log('Elapsed:', Date.now() - t0, 'ms');
    console.log('Result:', JSON.stringify(r));
  } catch (e) {
    console.log('ERR:', e.message);
  }
})();
JS
node tmp.js; rm -f tmp.js

echo ""
echo "=== 2. Check inspiration_posts just ingested ==="
cat > tmp.js <<'JS'
const Database = require('better-sqlite3');
const db = new Database('data/db.sqlite');
const recent = db.prepare(`SELECT id, source_name, source_type, pattern_hook, status, substr(original_text, 1, 120) as preview FROM inspiration_posts WHERE created_at > ? ORDER BY id DESC LIMIT 5`).all(Date.now() - 300_000);
console.log('Recent (last 5 min):', recent.length);
recent.forEach(r => console.log('  #' + r.id + ' [' + r.status + '] ' + r.source_name + ': ' + r.preview));
db.close();
JS
node tmp.js; rm -f tmp.js

echo ""
echo "=== 3. Reset weekly counter + run auto-weekly ==="
cat > tmp-run.js <<'JS'
(async () => {
  try {
    const Database = require('better-sqlite3');
    const db = new Database('data/db.sqlite');
    const { startOfCurrentWeekVN } = require('./dist/services/ci-auto-weekly');
    const weekStart = startOfCurrentWeekVN();
    console.log('Week start VN (ts):', weekStart, new Date(weekStart).toISOString());
    db.prepare(`UPDATE remix_drafts SET published_at = published_at - 864000000 WHERE hotel_id = 1 AND published_at >= ?`).run(weekStart);
    db.close();

    const { runWeeklyAutoPost, ciPublishedThisWeek } = require('./dist/services/ci-auto-weekly');
    console.log('Count this week (after reset):', ciPublishedThisWeek(1));

    const t0 = Date.now();
    const r = await runWeeklyAutoPost(1);
    console.log('Elapsed:', Date.now() - t0, 'ms');
    console.log('Result:', JSON.stringify(r, null, 2));
  } catch (e) {
    console.log('ERR:', e.message);
    console.log(e.stack);
  }
})();
JS
node tmp-run.js
rm -f tmp-run.js

echo ""
echo "=== 4. Latest remix_drafts ==="
cat > tmp.js <<'JS'
const Database = require('better-sqlite3');
const db = new Database('data/db.sqlite');
const rows = db.prepare(`SELECT id, hotel_id, status, fb_post_id, substr(remix_text, 1, 300) as preview, published_at FROM remix_drafts ORDER BY id DESC LIMIT 3`).all();
rows.forEach(r => {
  console.log('---');
  console.log('#' + r.id, 'status=' + r.status, 'fb=' + (r.fb_post_id || '(none)'));
  if (r.published_at) console.log('published_at:', new Date(r.published_at).toISOString());
  console.log('Preview:', r.preview);
});
db.close();
JS
node tmp.js; rm -f tmp.js
"""

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, username="root", password=PASSWORD, timeout=15)
_, stdout, stderr = client.exec_command(CMD, timeout=240)
print(stdout.read().decode("utf-8", errors="replace"))
err = stderr.read().decode("utf-8", errors="replace")
if err.strip(): print("STDERR:\n" + err, file=sys.stderr)
client.close()

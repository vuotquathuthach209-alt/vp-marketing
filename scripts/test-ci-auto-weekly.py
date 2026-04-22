"""Test Content Intelligence auto-weekly-post directly (bypass auth)."""
import sys, paramiko
try: sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except: pass

HOST = "103.82.193.74"
PASSWORD = sys.argv[1] if len(sys.argv) > 1 else ""

CMD = r"""
cd /opt/vp-marketing

# 1. Check news_articles available
cat > tmp.js <<'JS'
const Database = require('better-sqlite3');
const db = new Database('data/db.sqlite');
const oneWeekAgo = Date.now() - 7 * 24 * 3600_000;
const total = db.prepare(`SELECT COUNT(*) as n FROM news_articles WHERE published_at > ?`).get(oneWeekAgo);
console.log('news_articles last 7d:', total.n);
const relevant = db.prepare(`SELECT COUNT(*) as n FROM news_articles WHERE published_at > ? AND is_travel_relevant = 1`).get(oneWeekAgo);
console.log('  travel relevant:', relevant.n);
db.close();
JS
node tmp.js; rm -f tmp.js

# 2. Run runWeeklyAutoPost directly
echo ""
echo "=== Running runWeeklyAutoPost(1) with force ==="
cat > tmp-run.js <<'JS'
(async () => {
  try {
    const Database = require('better-sqlite3');
    const db = new Database('data/db.sqlite');
    // Reset weekly count: backdate any published this week
    db.prepare(`UPDATE remix_drafts SET published_at = published_at - 864000000 WHERE hotel_id = 1 AND published_at > ?`).run(Date.now() - 7*24*3600_000);
    db.close();

    const { runWeeklyAutoPost, ciPublishedThisWeek } = require('./dist/services/ci-auto-weekly');
    console.log('Published this week (after reset):', ciPublishedThisWeek(1));
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

# 3. Show latest remix drafts
echo ""
echo "=== Latest remix_drafts ==="
cat > tmp.js <<'JS'
const Database = require('better-sqlite3');
const db = new Database('data/db.sqlite');
const rows = db.prepare(`SELECT id, hotel_id, status, fb_post_id, substr(remix_text, 1, 250) as preview, created_at, published_at FROM remix_drafts ORDER BY id DESC LIMIT 3`).all();
rows.forEach(r => {
  console.log('---');
  console.log('ID:', r.id, 'Status:', r.status, 'FB:', r.fb_post_id || '(none)');
  console.log('Preview:', r.preview);
});
db.close();
JS
node tmp.js; rm -f tmp.js
"""

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, username="root", password=PASSWORD, timeout=15)
_, stdout, stderr = client.exec_command(CMD, timeout=180)
print(stdout.read().decode("utf-8", errors="replace"))
err = stderr.read().decode("utf-8", errors="replace")
if err.strip(): print("STDERR:\n" + err, file=sys.stderr)
client.close()

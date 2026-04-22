"""Check post scheduler + news publisher status on VPS."""
import sys, paramiko
try: sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except: pass

HOST = "103.82.193.74"
PASSWORD = sys.argv[1] if len(sys.argv) > 1 else ""

CMD = r"""
cd /opt/vp-marketing
cat > tmp.js <<'JS'
const Database = require('better-sqlite3');
const db = new Database('data/db.sqlite');

console.log('=== 1. Pages (facebook) ===');
const pages = db.prepare(`SELECT id, fb_page_id, name, hotel_id, LENGTH(access_token) as token_len FROM pages`).all();
pages.forEach(p => console.log(JSON.stringify(p)));

console.log('\n=== 2. Recent posts (last 20) ===');
const posts = db.prepare(`SELECT id, page_id, status, scheduled_at, published_at, error_message, substr(caption, 1, 60) as cap FROM posts ORDER BY id DESC LIMIT 20`).all();
posts.forEach(p => console.log(JSON.stringify(p)));

console.log('\n=== 3. News drafts recent ===');
const drafts = db.prepare(`SELECT id, hotel_id, status, scheduled_at, published_at, fb_post_id FROM news_post_drafts ORDER BY id DESC LIMIT 10`).all();
drafts.forEach(d => console.log(JSON.stringify(d)));

console.log('\n=== 4. Published this week (for each hotel) ===');
const weekAgo = Date.now() - 7 * 24 * 3600_000;
const hotels = db.prepare(`SELECT DISTINCT hotel_id FROM news_post_drafts`).all();
hotels.forEach(h => {
  const cnt = db.prepare(`SELECT COUNT(*) as n FROM news_post_drafts WHERE hotel_id = ? AND status = 'published' AND published_at > ?`).get(h.hotel_id, weekAgo);
  console.log(`  hotel #${h.hotel_id}: ${cnt.n}/3 this week`);
});

console.log('\n=== 5. Content Intelligence tables ===');
const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%inspiration%' OR name LIKE '%remix%' OR name LIKE '%content_intel%'`).all();
tables.forEach(t => console.log(t.name));

console.log('\n=== 6. Scheduler running? (pm2 log grep) ===');
db.close();
JS
node tmp.js; rm -f tmp.js

echo ""
pm2 logs vp-mkt --raw --lines 200 --nostream 2>&1 | grep -iE 'scheduler|news-publish|publishScheduled|publish-now' | tail -20
"""

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, username="root", password=PASSWORD, timeout=15)
_, stdout, stderr = client.exec_command(CMD, timeout=30)
print(stdout.read().decode("utf-8", errors="replace"))
err = stderr.read().decode("utf-8", errors="replace")
if err.strip(): print("STDERR:\n" + err, file=sys.stderr)
client.close()

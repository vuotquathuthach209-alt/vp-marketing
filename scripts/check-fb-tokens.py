"""Check Facebook page tokens + failed posts."""
import sys, os, paramiko
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception: pass

HOST = "103.82.193.74"; USER = "root"
PASSWORD = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("VPS_PASSWORD", "")

CMD = r"""
cd /opt/vp-marketing
cat > tmp.js <<'JS'
const Database = require('better-sqlite3');
const db = new Database('data/db.sqlite');

console.log('=== posts schema ===');
const postCols = db.prepare("PRAGMA table_info(posts)").all();
console.log('cols:', postCols.map(c => c.name).join(', '));

console.log('\n=== Failed posts (last 5) ===');
// Use only columns that exist
const colNames = postCols.map(c => c.name);
const errorCol = ['error_message','error','fail_reason','last_error'].find(c => colNames.includes(c)) || 'NULL';
const failed = db.prepare(`
  SELECT id, page_id, status, ${errorCol} as err, created_at, scheduled_at, published_at
  FROM posts
  WHERE status IN ('failed', 'error')
  ORDER BY id DESC LIMIT 5
`).all();
failed.forEach(p => {
  console.log(`#${p.id} page=${p.page_id} status=${p.status}`);
  console.log(`  error: ${(p.err || '').slice(0, 300)}`);
  console.log(`  scheduled: ${p.scheduled_at ? new Date(p.scheduled_at).toLocaleString('vi-VN') : '-'}`);
});

console.log('\n=== Pages in DB ===');
const cols = db.prepare("PRAGMA table_info(pages)").all();
console.log('Columns:', cols.map(c => c.name).join(', '));
const pages = db.prepare(`SELECT * FROM pages`).all();
pages.forEach(p => {
  const tokenPreview = p.access_token ? p.access_token.slice(0, 30) + '...' : '(null)';
  const tokenExpiry = p.token_expires_at
    ? new Date(p.token_expires_at).toLocaleString('vi-VN')
    : '(no expiry set)';
  const hotelCol = p.hotel_id !== undefined ? `hotel_id=${p.hotel_id}` : '';
  console.log(`#${p.id} ${p.name || '(no name)'} fb_page_id=${p.fb_page_id || p.page_id} ${hotelCol}`);
  console.log(`  token: ${tokenPreview}`);
  console.log(`  expires_at: ${tokenExpiry}`);
  console.log(`  status: ${p.status || '(no status)'}`);
});

console.log('\n=== Recent post attempts by page ===');
const recentPosts = db.prepare(`
  SELECT page_id, status, COUNT(*) as n
  FROM posts
  WHERE created_at > ?
  GROUP BY page_id, status
  ORDER BY page_id, status
`).all(Date.now() - 7 * 86400000);
recentPosts.forEach(r => console.log(`  page=${r.page_id} ${r.status}: ${r.n}`));

db.close();
JS
node tmp.js
rm -f tmp.js
"""

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, username=USER, password=PASSWORD, timeout=15, look_for_keys=False, allow_agent=False)
stdin, stdout, stderr = client.exec_command(CMD, timeout=30)
print(stdout.read().decode("utf-8", errors="replace"))
err = stderr.read().decode("utf-8", errors="replace")
if err.strip(): print("STDERR:\n" + err, file=sys.stderr)
client.close()

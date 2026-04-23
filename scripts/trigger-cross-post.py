"""Trigger cross-post for recent FB posts via internal service call."""
import sys, paramiko
try: sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except: pass
HOST = "103.82.193.74"
PASSWORD = sys.argv[1] if len(sys.argv) > 1 else ""
# Optional: which post IDs to trigger (default: latest 3 published)
TARGET_IDS = sys.argv[2].split(',') if len(sys.argv) > 2 else []

CMD = r"""
cd /opt/vp-marketing

cat > tmp_xpost.js <<'JS'
process.chdir('/opt/vp-marketing');
const Database = require('better-sqlite3');
const db = new Database('data/db.sqlite');

// Target posts: latest 3 published (hoặc user-specified)
const ids = '""" + ','.join(TARGET_IDS) + r"""';
let posts;
if (ids && ids.length > 0) {
  const arr = ids.split(',').map(x => parseInt(x));
  posts = db.prepare(`SELECT id, fb_post_id, hotel_id, caption, media_id, media_type FROM posts WHERE id IN (${arr.map(()=>'?').join(',')}) AND status='published'`).all(...arr);
} else {
  posts = db.prepare(`SELECT id, fb_post_id, hotel_id, caption, media_id, media_type FROM posts WHERE status='published' AND fb_post_id IS NOT NULL ORDER BY published_at DESC LIMIT 3`).all();
}
db.close();

console.log('Target posts:', posts.length);
posts.forEach(p => console.log('  #' + p.id + ' fb=' + p.fb_post_id + ' media=' + p.media_type + ' cap="' + (p.caption||'').substring(0, 60) + '"'));
console.log('');

(async () => {
  const { crossPostFromPostId } = require('/opt/vp-marketing/dist/services/cross-post-sync');

  for (const p of posts) {
    console.log('\\n=== Cross-posting #' + p.id + ' ===');
    try {
      const result = await crossPostFromPostId(p.id, 'manual');
      if (!result) { console.log('  SKIPPED (null result)'); continue; }
      console.log('  IG:', result.ig.success + '/' + result.ig.attempted, 'errors:', JSON.stringify(result.ig.errors));
      console.log('  Zalo:', result.zalo.success + '/' + result.zalo.attempted, 'errors:', JSON.stringify(result.zalo.errors));
    } catch (e) {
      console.log('  EXCEPTION:', e.message);
    }
  }

  console.log('\\n=== Cross-post log (recent) ===');
  const db2 = new Database('data/db.sqlite');
  const logs = db2.prepare(`SELECT platform, fb_post_id, result, external_id, error, datetime(created_at/1000, 'unixepoch', '+7 hours') as t FROM cross_post_log ORDER BY id DESC LIMIT 10`).all();
  logs.forEach(l => console.log('  [' + l.t + '] ' + l.platform + ' fb=' + l.fb_post_id + ' → ' + l.result + ' ' + (l.external_id||'') + ' ' + (l.error||'')));
  db2.close();
})();
JS

node tmp_xpost.js
rm -f tmp_xpost.js
"""

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, username="root", password=PASSWORD, timeout=15)
_, stdout, stderr = client.exec_command(CMD, timeout=180)
print(stdout.read().decode('utf-8', errors='replace'))
err = stderr.read().decode('utf-8', errors='replace')
if err.strip(): print('STDERR:', err[:1000])
client.close()

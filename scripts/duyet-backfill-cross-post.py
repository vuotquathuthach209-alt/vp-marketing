"""Duyệt — cross-post all remaining published FB posts to IG + Zalo."""
import sys, paramiko
try: sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except: pass
HOST = "103.82.193.74"
PASSWORD = sys.argv[1] if len(sys.argv) > 1 else ""

CMD = r"""
cd /opt/vp-marketing

cat > tmp_backfill.js <<'JS'
process.chdir('/opt/vp-marketing');
const Database = require('better-sqlite3');
const { crossPostFromPostId } = require('/opt/vp-marketing/dist/services/cross-post-sync');
const db = new Database('data/db.sqlite');

// All published FB posts (order by newest first)
const posts = db.prepare(`SELECT id, fb_post_id, substr(caption, 1, 60) as cap FROM posts WHERE status='published' AND fb_post_id IS NOT NULL ORDER BY id DESC`).all();
console.log('Total FB posts:', posts.length);

// Filter — only cross-post ones not yet successful on BOTH platforms
const pending = posts.filter(p => {
  const ig = db.prepare(`SELECT 1 FROM cross_post_log WHERE fb_post_id = ? AND platform = 'instagram' AND result = 'success'`).get(p.fb_post_id);
  const zl = db.prepare(`SELECT 1 FROM cross_post_log WHERE fb_post_id = ? AND platform = 'zalo_oa' AND result = 'success'`).get(p.fb_post_id);
  return !ig || !zl;
});

console.log('Posts needing cross-post:', pending.length);
pending.forEach(p => console.log('  #' + p.id + ' fb=' + p.fb_post_id.substring(0, 40) + '... cap="' + p.cap + '"'));
console.log('');

(async () => {
  let igOk = 0, igFail = 0, zlOk = 0, zlFail = 0;

  for (const p of pending) {
    console.log('\n=== Cross-posting #' + p.id + ' ===');
    try {
      // Delay between posts (avoid Zalo rate limit)
      await new Promise(r => setTimeout(r, 5000));

      const result = await crossPostFromPostId(p.id, 'duyet_backfill');
      if (!result) { console.log('  SKIPPED'); continue; }

      igOk += result.ig.success;
      igFail += (result.ig.attempted - result.ig.success);
      zlOk += result.zalo.success;
      zlFail += (result.zalo.attempted - result.zalo.success);

      console.log('  IG:', result.ig.success + '/' + result.ig.attempted,
        result.ig.errors.length ? 'errors=' + JSON.stringify(result.ig.errors) : '');
      console.log('  Zalo:', result.zalo.success + '/' + result.zalo.attempted,
        result.zalo.errors.length ? 'errors=' + JSON.stringify(result.zalo.errors) : '');
    } catch (e) {
      console.log('  EXCEPTION:', e.message);
    }
  }

  console.log('\n=== Backfill tổng kết ===');
  console.log('IG: ' + igOk + ' OK, ' + igFail + ' fail');
  console.log('Zalo: ' + zlOk + ' OK, ' + zlFail + ' fail');

  // Final stats
  console.log('\n=== Cross-post log summary ===');
  const stats = db.prepare(`
    SELECT platform, result, COUNT(*) as n
    FROM cross_post_log
    WHERE created_at > ?
    GROUP BY platform, result
    ORDER BY platform, result
  `).all(Date.now() - 24 * 3600000);
  stats.forEach(s => console.log('  ' + s.platform + '/' + s.result + ': ' + s.n));

  db.close();
})();
JS

node tmp_backfill.js
rm -f tmp_backfill.js
"""

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, username="root", password=PASSWORD, timeout=15)
_, stdout, stderr = client.exec_command(CMD, timeout=300)
print(stdout.read().decode('utf-8', errors='replace'))
err = stderr.read().decode('utf-8', errors='replace')
if err.strip(): print('STDERR:', err[:500])
client.close()

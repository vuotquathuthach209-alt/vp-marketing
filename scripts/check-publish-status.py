"""Check IG + Zalo publishing status."""
import sys, paramiko
try: sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except: pass
HOST = "103.82.193.74"
PASSWORD = sys.argv[1] if len(sys.argv) > 1 else ""

CMD = r"""
cd /opt/vp-marketing

cat > tmp_check.js <<'JS'
process.chdir('/opt/vp-marketing');
const Database = require('better-sqlite3');
const db = new Database('data/db.sqlite');

console.log('═══════════════════════════════════════════');
console.log('  INSTAGRAM STATUS');
console.log('═══════════════════════════════════════════');

// Check instagram_accounts (correct table name)
try {
  const igs = db.prepare(`SELECT * FROM instagram_accounts`).all();
  console.log('IG accounts configured:', igs.length);
  igs.forEach(ig => {
    console.log('  id=' + ig.id + ' @' + (ig.ig_username||'?') + ' biz_id=' + ig.ig_business_id + ' linked_page=' + (ig.linked_fb_page_id||'-') + ' active=' + ig.active);
  });
  if (igs.length === 0) {
    console.log('');
    console.log('  ⚠️  CHƯA connect IG account nào.');
    console.log('  Để setup, cần:');
    console.log('    1. IG account là Business/Creator (không phải Personal)');
    console.log('    2. Đã link với FB Page');
    console.log('    3. Chạy: curl -b cookie.txt https://mkt.sondervn.com/api/mp/ig/discover');
    console.log('    4. Chạy: curl -b cookie.txt -X POST /api/mp/ig/connect -d ...');
  }
} catch (e) { console.log('instagram_accounts:', e.message); }

// IG publish attempts (from posts table or ops_post_tasks)
try {
  const attempts = db.prepare(`SELECT platform, status, COUNT(*) as n FROM ops_post_tasks WHERE platform = 'instagram' GROUP BY platform, status`).all();
  console.log('\nIG publish attempts (ops_post_tasks):');
  if (attempts.length === 0) console.log('  (none)');
  attempts.forEach(a => console.log('  ' + a.platform + '/' + a.status + ': ' + a.n));
} catch (e) { /* table might not exist */ }

console.log('');
console.log('═══════════════════════════════════════════');
console.log('  ZALO STATUS');
console.log('═══════════════════════════════════════════');

// Zalo OA (introspect columns)
try {
  const cols = db.prepare(`PRAGMA table_info(zalo_oa)`).all();
  console.log('zalo_oa columns:', cols.map(c => c.name).join(', '));
  const expCol = cols.find(c => c.name === 'expires_at' || c.name === 'token_expires_at');
  const expSql = expCol ? expCol.name : null;

  const oas = db.prepare(`SELECT oa_id, oa_name, hotel_id, LENGTH(access_token) as tok_len${expSql ? ', ' + expSql + ' as exp' : ''} FROM zalo_oa`).all();
  console.log('Zalo OAs:', oas.length);
  oas.forEach(oa => {
    let expStr = 'unknown';
    if (expSql && oa.exp) {
      const hrs = ((oa.exp - Date.now()) / 3600000).toFixed(1);
      expStr = new Date(oa.exp).toISOString() + ' (in ' + hrs + 'h)';
    }
    console.log('  oa=' + oa.oa_id + ' name=' + oa.oa_name + ' tok_len=' + oa.tok_len + ' expires=' + expStr);
  });
} catch (e) { console.log('zalo_oa:', e.message); }

// Zalo article log (try different names)
for (const tbl of ['zalo_articles_log', 'zalo_articles', 'zalo_article_logs', 'zalo_posts']) {
  try {
    const n = db.prepare(`SELECT COUNT(*) as n FROM ${tbl}`).get();
    console.log(`\n${tbl} rows:`, n.n);
    if (n.n > 0) {
      const recent = db.prepare(`SELECT * FROM ${tbl} ORDER BY id DESC LIMIT 3`).all();
      recent.forEach(r => console.log('  ' + JSON.stringify(r).substring(0, 150)));
    }
    break;
  } catch (e) {}
}

// Zalo chat convos
try {
  const convs = db.prepare(`SELECT COUNT(*) as n FROM conversation_memory WHERE sender_id LIKE 'zalo:%'`).get();
  const last24 = db.prepare(`SELECT COUNT(*) as n FROM conversation_memory WHERE sender_id LIKE 'zalo:%' AND created_at > ?`).get(Date.now() - 86400000);
  const distinct = db.prepare(`SELECT COUNT(DISTINCT sender_id) as n FROM conversation_memory WHERE sender_id LIKE 'zalo:%'`).get();
  console.log('\nZalo CHAT messages total:', convs.n, '(last 24h:', last24.n, ') distinct senders:', distinct.n);
} catch (e) { }

console.log('');
console.log('═══════════════════════════════════════════');
console.log('  FB POSTS');
console.log('═══════════════════════════════════════════');
try {
  const posts = db.prepare(`SELECT COUNT(*) as total, SUM(CASE WHEN status='published' THEN 1 ELSE 0 END) as published FROM posts`).get();
  console.log('FB posts total:', posts.total, 'published:', posts.published);
  const recent = db.prepare(`SELECT id, status, fb_post_id, substr(caption, 1, 60) as cap, datetime(COALESCE(published_at, scheduled_at)/1000, 'unixepoch', '+7 hours') as time_vn FROM posts ORDER BY id DESC LIMIT 3`).all();
  recent.forEach(p => console.log('  #' + p.id + ' ' + p.time_vn + ' status=' + p.status + ' fb_id=' + (p.fb_post_id||'-').substring(0,40) + ' cap="' + p.cap + '"'));
} catch (e) { console.log('posts:', e.message); }

console.log('');
console.log('═══════════════════════════════════════════');
console.log('  CI WEEKLY NEXT RUN');
console.log('═══════════════════════════════════════════');
const now = new Date();
const vnNow = new Date(now.getTime() + 7 * 3600000);
console.log('VN now:', vnNow.toISOString().substring(0, 19));
const nextMon = new Date(vnNow);
const day = nextMon.getUTCDay();
const daysToMon = day === 1 ? (nextMon.getUTCHours() < 9 ? 0 : 7) : (day === 0 ? 1 : 8 - day);
nextMon.setUTCDate(nextMon.getUTCDate() + daysToMon);
nextMon.setUTCHours(9, 0, 0, 0);
console.log('Next auto-post T2 9h VN:', nextMon.toISOString().substring(0, 19));

db.close();
JS

node tmp_check.js
rm -f tmp_check.js
"""

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, username="root", password=PASSWORD, timeout=15)
_, stdout, stderr = client.exec_command(CMD, timeout=60)
print(stdout.read().decode('utf-8', errors='replace'))
err = stderr.read().decode('utf-8', errors='replace')
if err.strip(): print('STDERR:', err[:500])
client.close()

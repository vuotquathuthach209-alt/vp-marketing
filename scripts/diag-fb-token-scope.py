"""Check current FB Page token scopes to see what's missing for IG publish."""
import sys, paramiko
try: sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except: pass
HOST = "103.82.193.74"
PASSWORD = sys.argv[1] if len(sys.argv) > 1 else ""

CMD = r"""
cd /opt/vp-marketing

cat > tmp_diag.js <<'JS'
process.chdir('/opt/vp-marketing');
const Database = require('better-sqlite3');
const axios = require('axios').default;
const db = new Database('data/db.sqlite');

const page = db.prepare(`SELECT id, fb_page_id, name, access_token FROM pages LIMIT 1`).get();
if (!page) { console.log('NO PAGE'); process.exit(1); }
console.log('Page:', page.name, 'fb_id=' + page.fb_page_id);

(async () => {
  try {
    // 1. Check token scopes via /debug_token (works cho page tokens)
    console.log('\n=== Token scopes (from /debug_token) ===');
    const appId = process.env.FB_APP_ID || db.prepare(`SELECT value FROM settings WHERE key='fb_app_id'`).get()?.value;
    const appSecret = process.env.FB_APP_SECRET || db.prepare(`SELECT value FROM settings WHERE key='fb_app_secret'`).get()?.value;
    let granted = [];
    if (appId && appSecret) {
      const appToken = appId + '|' + appSecret;
      const r1 = await axios.get('https://graph.facebook.com/v18.0/debug_token', {
        params: { input_token: page.access_token, access_token: appToken }, timeout: 10_000,
      });
      granted = r1.data?.data?.scopes || [];
      console.log('Token type:', r1.data?.data?.type);
      console.log('App id:', r1.data?.data?.app_id);
      console.log('User/Page:', r1.data?.data?.profile_id);
      console.log('Scopes:', granted.join(', '));
    } else {
      console.log('⚠️ FB_APP_ID/SECRET not available — cannot use debug_token');
      // Fallback: try /me to infer
      try {
        const rm = await axios.get('https://graph.facebook.com/v18.0/me', { params: { access_token: page.access_token }, timeout: 10_000 });
        console.log('/me:', rm.data);
      } catch (e) { console.log('/me fail:', e.response?.data?.error?.message); }
    }

    const needed = [
      'instagram_basic',
      'instagram_content_publish',
      'pages_read_engagement',
      'pages_show_list',
      'pages_manage_posts',
    ];
    console.log('\nRequired for cross-post:');
    needed.forEach(p => {
      const has = granted.includes(p);
      console.log('  ' + (has ? '✅' : '❌') + ' ' + p);
    });

    // 2. Check IG linked
    console.log('\n=== Instagram link check ===');
    const r2 = await axios.get(`https://graph.facebook.com/v18.0/${page.fb_page_id}`, {
      params: { fields: 'instagram_business_account{id,username,account_type}', access_token: page.access_token },
      timeout: 10_000,
    });
    if (r2.data.instagram_business_account) {
      console.log('✅ IG linked:', r2.data.instagram_business_account);
    } else {
      console.log('❌ No instagram_business_account on this page');
    }

    // 3. Try get full_picture of a post (test pages_read_engagement)
    console.log('\n=== Test pages_read_engagement (read FB post image) ===');
    const post = db.prepare(`SELECT fb_post_id FROM posts WHERE status='published' AND fb_post_id IS NOT NULL ORDER BY id DESC LIMIT 1`).get();
    if (post) {
      try {
        const r3 = await axios.get(`https://graph.facebook.com/v18.0/${post.fb_post_id}`, {
          params: { fields: 'full_picture', access_token: page.access_token }, timeout: 10_000,
        });
        console.log('✅ Can read post:', r3.data.full_picture ? 'full_picture available' : 'no image');
      } catch (e) {
        console.log('❌', e.response?.data?.error?.message || e.message);
      }
    }
  } catch (e) {
    console.log('ERROR:', e.response?.data?.error?.message || e.message);
  }
  db.close();
})();
JS

node tmp_diag.js
rm -f tmp_diag.js
"""

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, username="root", password=PASSWORD, timeout=15)
_, stdout, stderr = client.exec_command(CMD, timeout=60)
print(stdout.read().decode('utf-8', errors='replace'))
err = stderr.read().decode('utf-8', errors='replace')
if err.strip(): print('STDERR:', err[:500])
client.close()

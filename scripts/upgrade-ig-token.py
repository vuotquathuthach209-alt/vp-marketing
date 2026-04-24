"""Upgrade FB Page token với scope instagram_content_publish.

Usage:
  python scripts/upgrade-ig-token.py <vps_password> <user_access_token>

Flow:
  1. Short-lived user token → long-lived user token (60 days)
  2. GET /me/accounts → lấy Page tokens
  3. Match page "Sonder Apartment Hotel" → save token vào DB
  4. Verify new scope includes instagram_content_publish
  5. Trigger cross-post #9 → confirm IG works
"""
import sys, paramiko
try: sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except: pass

HOST = "103.82.193.74"
if len(sys.argv) < 3:
    print("Usage: python upgrade-ig-token.py <vps_password> <user_access_token>", file=sys.stderr)
    print("Get user token from https://developers.facebook.com/tools/explorer", file=sys.stderr)
    sys.exit(1)

PASSWORD = sys.argv[1]
USER_TOKEN = sys.argv[2]

CMD = f"""
cd /opt/vp-marketing

cat > tmp_upgrade.js <<'JS'
process.chdir('/opt/vp-marketing');
const Database = require('better-sqlite3');
const axios = require('axios').default;
const db = new Database('data/db.sqlite');

const USER_TOKEN = {USER_TOKEN!r};
const PAGE_NAME = 'Sonder Apartment Hotel';
const REQUIRED = [
  'instagram_basic',
  'instagram_content_publish',
  'pages_read_engagement',
  'pages_manage_posts',
];

(async () => {{
  // Get app credentials
  const appId = db.prepare(`SELECT value FROM settings WHERE key='fb_app_id'`).get()?.value || process.env.FB_APP_ID;
  const appSecret = db.prepare(`SELECT value FROM settings WHERE key='fb_app_secret'`).get()?.value || process.env.FB_APP_SECRET;
  if (!appId || !appSecret) {{
    console.log('❌ FB_APP_ID/SECRET not configured');
    process.exit(1);
  }}
  console.log('App id:', appId);

  // Step 1: Exchange short-lived → long-lived user token (60 days)
  console.log('\\n=== 1. Exchange short-lived → long-lived ===');
  let longUserToken;
  try {{
    const r = await axios.get('https://graph.facebook.com/v18.0/oauth/access_token', {{
      params: {{
        grant_type: 'fb_exchange_token',
        client_id: appId,
        client_secret: appSecret,
        fb_exchange_token: USER_TOKEN,
      }},
      timeout: 15_000,
    }});
    longUserToken = r.data.access_token;
    console.log('✅ long-lived user token ready, expires_in:', r.data.expires_in || 'never', 's');
  }} catch (e) {{
    console.log('❌ exchange fail:', e.response?.data?.error?.message || e.message);
    process.exit(1);
  }}

  // Step 2: Debug long-lived token scope
  console.log('\\n=== 2. Verify scopes trên long-lived token ===');
  const appToken = appId + '|' + appSecret;
  try {{
    const r = await axios.get('https://graph.facebook.com/v18.0/debug_token', {{
      params: {{ input_token: longUserToken, access_token: appToken }}, timeout: 10_000,
    }});
    const scopes = r.data?.data?.scopes || [];
    console.log('Scopes:', scopes.join(', '));
    const missing = REQUIRED.filter(p => !scopes.includes(p));
    if (missing.length > 0) {{
      console.log('❌ Thiếu scope: ' + missing.join(', '));
      console.log('   → Quay lại Graph Explorer, tick đủ permissions khi generate token');
      process.exit(1);
    }}
    console.log('✅ đủ scope cần thiết');
  }} catch (e) {{
    console.log('❌ debug_token fail:', e.response?.data?.error?.message || e.message);
    process.exit(1);
  }}

  // Step 3: Get Page tokens
  console.log('\\n=== 3. Get Page access_tokens ===');
  let pages;
  try {{
    const r = await axios.get('https://graph.facebook.com/v18.0/me/accounts', {{
      params: {{ access_token: longUserToken, fields: 'id,name,access_token' }}, timeout: 15_000,
    }});
    pages = r.data?.data || [];
    console.log('Pages available:', pages.length);
    pages.forEach(p => console.log('  -', p.name, 'fb_id=' + p.id));
  }} catch (e) {{
    console.log('❌ get pages fail:', e.response?.data?.error?.message || e.message);
    process.exit(1);
  }}

  // Step 4: Find target page + update DB
  console.log('\\n=== 4. Update DB ===');
  const target = pages.find(p => p.name.toLowerCase().includes('sonder apartment') || p.name === PAGE_NAME);
  if (!target) {{
    console.log('❌ Không tìm thấy page "' + PAGE_NAME + '"');
    console.log('   Available:', pages.map(p => p.name).join(', '));
    process.exit(1);
  }}
  console.log('Target page:', target.name, 'fb_id=' + target.id);

  const updateRes = db.prepare(`UPDATE pages SET access_token = ? WHERE fb_page_id = ?`)
    .run(target.access_token, target.id);
  console.log('DB rows updated:', updateRes.changes);

  // Step 5: Verify page token scope
  console.log('\\n=== 5. Verify Page token scope ===');
  try {{
    const r = await axios.get('https://graph.facebook.com/v18.0/debug_token', {{
      params: {{ input_token: target.access_token, access_token: appToken }}, timeout: 10_000,
    }});
    const pageScopes = r.data?.data?.scopes || [];
    console.log('Page token scopes:', pageScopes.join(', '));
    const stillMissing = REQUIRED.filter(p => !pageScopes.includes(p));
    if (stillMissing.length > 0) {{
      console.log('⚠️ Page token thiếu:', stillMissing.join(', '));
      console.log('   (đôi khi page token ít scope hơn user token — vẫn có thể hoạt động nếu app có quyền)');
    }} else {{
      console.log('✅ Page token đủ scope');
    }}
  }} catch (e) {{
    console.log('⚠️ debug page token fail:', e.response?.data?.error?.message);
  }}

  // Step 6: Trigger cross-post cho post #9
  console.log('\\n=== 6. Test cross-post #9 ===');
  try {{
    const {{ crossPostFromPostId }} = require('/opt/vp-marketing/dist/services/cross-post-sync');
    const result = await crossPostFromPostId(9, 'manual_upgrade_test');
    if (!result) {{ console.log('SKIPPED (post #9 not found)'); }}
    else {{
      console.log('IG:', result.ig.success + '/' + result.ig.attempted);
      if (result.ig.errors.length) console.log('  IG errors:', JSON.stringify(result.ig.errors));
      console.log('Zalo:', result.zalo.success + '/' + result.zalo.attempted);
      if (result.zalo.errors.length) console.log('  Zalo errors:', JSON.stringify(result.zalo.errors));

      if (result.ig.success > 0) {{
        console.log('\\n🎉 IG PUBLISH SUCCESS! Kiểm tra @sonder_haven feed ngay.');
      }}
    }}
  }} catch (e) {{
    console.log('❌ cross-post fail:', e.message);
  }}

  db.close();
}})();
JS

node tmp_upgrade.js
rm -f tmp_upgrade.js
"""

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, username="root", password=PASSWORD, timeout=15)
_, stdout, stderr = client.exec_command(CMD, timeout=180)
print(stdout.read().decode('utf-8', errors='replace'))
err = stderr.read().decode('utf-8', errors='replace')
if err.strip(): print('STDERR:', err[:1000])
client.close()

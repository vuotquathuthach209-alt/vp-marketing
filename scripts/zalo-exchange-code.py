"""Manually exchange Zalo authorization code → access_token.

Dùng nếu callback endpoint không available (VD: Zalo dev console chỉ cho
redirect về URL khác với mkt.sondervn.com).

Usage:
  python scripts/zalo-exchange-code.py <vps_password> <authorization_code>

Get code from:
  Mở URL này trong browser (đã đăng nhập Zalo admin):

  https://oauth.zaloapp.com/v4/oa/permission?app_id=1125683119493780855&redirect_uri=https://oauth.zaloapp.com/v4/oa/test-callback&state=test

  Click "Cho phép" → URL sẽ là:
    https://oauth.zaloapp.com/v4/oa/test-callback?code=XXX&oa_id=328738126716568694&state=test

  Copy phần `code=XXX` ra → paste vào lệnh.
"""
import sys, paramiko
try: sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except: pass

HOST = "103.82.193.74"
if len(sys.argv) < 3:
    print("Usage: python scripts/zalo-exchange-code.py <vps_password> <authorization_code>", file=sys.stderr)
    sys.exit(1)

PASSWORD = sys.argv[1]
CODE = sys.argv[2]
OA_ID = sys.argv[3] if len(sys.argv) > 3 else '328738126716568694'

CMD = f"""
cd /opt/vp-marketing

cat > tmp_exchange.js <<'JS'
process.chdir('/opt/vp-marketing');
const Database = require('better-sqlite3');
const axios = require('axios').default;
const db = new Database('data/db.sqlite');

const CODE = {CODE!r};
const OA_ID = {OA_ID!r};

(async () => {{
  const appId = db.prepare(`SELECT value FROM settings WHERE key='zalo_app_id'`).get()?.value;
  const appSecret = db.prepare(`SELECT value FROM settings WHERE key='zalo_app_secret'`).get()?.value;
  if (!appId || !appSecret) {{ console.log('❌ Missing zalo_app_id/secret'); process.exit(1); }}
  console.log('App ID:', appId);

  try {{
    console.log('\\n=== Exchange code → token ===');
    const r = await axios.post(
      'https://oauth.zaloapp.com/v4/oa/access_token',
      new URLSearchParams({{
        code: CODE,
        app_id: appId,
        grant_type: 'authorization_code',
      }}),
      {{
        headers: {{
          'Content-Type': 'application/x-www-form-urlencoded',
          'secret_key': appSecret,
        }},
        timeout: 15000,
      }}
    );

    console.log('Response:', JSON.stringify(r.data, null, 2));
    if (!r.data.access_token) {{
      console.log('❌ No access_token in response');
      process.exit(1);
    }}

    console.log('\\n=== Save to DB ===');
    const expiresAt = Date.now() + (parseInt(String(r.data.expires_in || 90000), 10) * 1000);
    db.prepare(`UPDATE zalo_oa SET access_token = ?, refresh_token = ?, token_expires_at = ? WHERE oa_id = ?`)
      .run(r.data.access_token, r.data.refresh_token || '', expiresAt, OA_ID);
    console.log('✅ Token saved. Expires:', new Date(expiresAt).toISOString());

    console.log('\\n=== Verify new token ===');
    const testR = await axios.get('https://openapi.zalo.me/v2.0/oa/getoa', {{
      headers: {{ access_token: r.data.access_token }}, timeout: 10000,
    }});
    console.log('/getoa:', JSON.stringify(testR.data).slice(0, 300));

    if (testR.data.error === 0) {{
      console.log('✅ Token WORKS — OA:', testR.data.data?.name, 'followers:', testR.data.data?.num_follower);
    }}

    console.log('\\n=== Test upload endpoint ===');
    const FormData = require('form-data');
    const tinyPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    const form = new FormData();
    form.append('file', tinyPng, {{ filename: 'verify.png', contentType: 'image/png' }});

    const upR = await axios.post(
      'https://openapi.zalo.me/v2.0/oa/upload/image',
      form,
      {{ headers: {{ ...form.getHeaders(), access_token: r.data.access_token }}, timeout: 30000 }}
    );
    console.log('Upload test:', JSON.stringify(upR.data).slice(0, 300));
    if (upR.data.error === 0) {{
      console.log('✅ Upload scope AVAILABLE — can cross-post Zalo!');
    }} else {{
      console.log('⚠️ Upload error ' + upR.data.error + ': ' + upR.data.message);
    }}
  }} catch (e) {{
    console.log('❌ Error:', e.response?.data || e.message);
  }}

  db.close();
}})();
JS

node tmp_exchange.js
rm -f tmp_exchange.js
"""

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, username="root", password=PASSWORD, timeout=15)
_, stdout, stderr = client.exec_command(CMD, timeout=60)
print(stdout.read().decode('utf-8', errors='replace'))
err = stderr.read().decode('utf-8', errors='replace')
if err.strip(): print('STDERR:', err[:500])
client.close()

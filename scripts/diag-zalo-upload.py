"""Diagnose Zalo upload -216 error.

Kiểm tra:
1. Token current expires_at + còn valid không
2. Test call /me endpoint để verify token recognized
3. Test call /v2.0/oa/upload/image direct để reproduce lỗi
4. Try refresh token + re-test
5. Check app permissions from Zalo dev console format
"""
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

(async () => {
  const oa = db.prepare(`SELECT * FROM zalo_oa WHERE enabled = 1 LIMIT 1`).get();
  console.log('OA:', oa.oa_name, 'oa_id=' + oa.oa_id);
  console.log('Token length:', oa.access_token?.length);
  console.log('Token expires_at:', new Date(oa.token_expires_at).toISOString(), '(in', ((oa.token_expires_at - Date.now())/3600000).toFixed(1) + 'h)');
  console.log('Token preview:', oa.access_token.slice(0, 40) + '...' + oa.access_token.slice(-20));

  // Test 1: /getoa — should ALWAYS work for valid token
  console.log('\n=== Test 1: GET /oa/getoa (basic auth check) ===');
  try {
    const r = await axios.get('https://openapi.zalo.me/v2.0/oa/getoa', {
      headers: { access_token: oa.access_token }, timeout: 10000,
    });
    console.log('Response:', JSON.stringify(r.data).slice(0, 300));
    if (r.data?.error === 0) console.log('✅ Token VALID for read operations');
    else console.log('❌ Error:', r.data.error, r.data.message);
  } catch (e) {
    console.log('❌ /getoa exception:', e.response?.data || e.message);
  }

  // Test 2: Small image upload to reproduce -216
  console.log('\n=== Test 2: POST /v2.0/oa/upload/image (test upload endpoint) ===');
  try {
    const FormData = require('form-data');
    // Use a tiny 1x1 red pixel PNG
    const tinyPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    const form = new FormData();
    form.append('file', tinyPng, { filename: 'test.png', contentType: 'image/png' });

    const r = await axios.post(
      'https://openapi.zalo.me/v2.0/oa/upload/image',
      form,
      {
        headers: { ...form.getHeaders(), access_token: oa.access_token },
        timeout: 30000,
      }
    );
    console.log('Upload response:', JSON.stringify(r.data).slice(0, 300));
    if (r.data?.error === 0) console.log('✅ Upload WORKS!');
    else console.log('❌ Upload error:', r.data.error, '-', r.data.message);
  } catch (e) {
    console.log('❌ Upload exception:', e.response?.data || e.message);
  }

  // Test 3: Refresh token + retry
  console.log('\n=== Test 3: Force refresh token + re-test ===');
  const { refreshZaloToken } = require('/opt/vp-marketing/dist/services/zalo');
  const refreshed = await refreshZaloToken(oa);
  console.log('Refresh result:', refreshed);

  if (refreshed) {
    const oa2 = db.prepare(`SELECT * FROM zalo_oa WHERE oa_id = ?`).get(oa.oa_id);
    console.log('New token expires:', new Date(oa2.token_expires_at).toISOString());
    console.log('New token preview:', oa2.access_token.slice(0, 40) + '...' + oa2.access_token.slice(-20));
    console.log('Same as old?', oa2.access_token === oa.access_token);

    // Re-test upload with fresh token
    try {
      const FormData = require('form-data');
      const tinyPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
      const form = new FormData();
      form.append('file', tinyPng, { filename: 'test2.png', contentType: 'image/png' });

      const r = await axios.post(
        'https://openapi.zalo.me/v2.0/oa/upload/image',
        form,
        { headers: { ...form.getHeaders(), access_token: oa2.access_token }, timeout: 30000 }
      );
      console.log('Upload after refresh:', JSON.stringify(r.data).slice(0, 300));
      if (r.data?.error === 0) console.log('✅ Upload WORKS after refresh!');
      else console.log('❌ Still error:', r.data.error, '-', r.data.message);
    } catch (e) {
      console.log('❌ Upload exception:', e.response?.data || e.message);
    }
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
_, stdout, stderr = client.exec_command(CMD, timeout=120)
print(stdout.read().decode('utf-8', errors='replace'))
err = stderr.read().decode('utf-8', errors='replace')
if err.strip(): print('STDERR:', err[:500])
client.close()

"""Diagnose Zalo upload — uses getZaloByOaId (proper decryption)."""
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
const { getZaloByOaId, refreshZaloToken } = require('/opt/vp-marketing/dist/services/zalo');
const db = new Database('data/db.sqlite');

(async () => {
  // Get FIRST OA oa_id
  const oaRow = db.prepare(`SELECT oa_id FROM zalo_oa WHERE enabled = 1 LIMIT 1`).get();
  if (!oaRow) { console.log('NO OA'); process.exit(1); }

  const oa = getZaloByOaId(oaRow.oa_id);
  console.log('OA:', oa.oa_name, 'oa_id=' + oa.oa_id);
  console.log('Decrypted token length:', oa.access_token?.length);
  console.log('Token preview:', oa.access_token.slice(0, 30) + '...' + oa.access_token.slice(-15));
  console.log('Expires:', new Date(oa.token_expires_at).toISOString(), '(in', ((oa.token_expires_at - Date.now())/3600000).toFixed(1) + 'h)');

  console.log('\n=== Test 1: GET /v2.0/oa/getoa ===');
  try {
    const r = await axios.get('https://openapi.zalo.me/v2.0/oa/getoa', {
      headers: { access_token: oa.access_token }, timeout: 10000,
    });
    console.log('Response:', JSON.stringify(r.data).slice(0, 400));
    if (r.data?.error === 0) {
      console.log('✅ Token VALID. OA name:', r.data.data?.name, 'followers:', r.data.data?.num_follower);
    } else {
      console.log('❌ Error:', r.data.error, '-', r.data.message);
    }
  } catch (e) {
    console.log('❌ Exception:', e.response?.data || e.message);
  }

  console.log('\n=== Test 2: POST /v2.0/oa/upload/image ===');
  try {
    const FormData = require('form-data');
    const tinyPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    const form = new FormData();
    form.append('file', tinyPng, { filename: 'verify.png', contentType: 'image/png' });
    const r = await axios.post(
      'https://openapi.zalo.me/v2.0/oa/upload/image',
      form,
      { headers: { ...form.getHeaders(), access_token: oa.access_token }, timeout: 30000 }
    );
    console.log('Response:', JSON.stringify(r.data).slice(0, 400));
    if (r.data?.error === 0) {
      console.log('✅ Upload WORKS! attachment_id:', r.data.data?.attachment_id);
    } else {
      console.log('❌ Error:', r.data.error, '-', r.data.message);
    }
  } catch (e) {
    console.log('❌ Exception:', e.response?.data || e.message);
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

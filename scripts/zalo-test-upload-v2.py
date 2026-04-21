"""Try different Zalo upload endpoints."""
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
require('dotenv').config();
const Database = require('better-sqlite3');
const crypto = require('crypto');
const axios = require('axios');
const FormData = require('form-data');

const PREFIX = 'enc:v1:';
const raw = process.env.SECRET_KEY || process.env.JWT_SECRET || '';
const key = crypto.createHash('sha256').update(raw || 'vp-mkt-default-insecure').digest();
function decrypt(p) {
  if (!p || !p.startsWith(PREFIX)) return p;
  const buf = Buffer.from(p.slice(PREFIX.length), 'base64');
  const iv = buf.subarray(0,12), tag = buf.subarray(12,28), ct = buf.subarray(28);
  const d = crypto.createDecipheriv('aes-256-gcm', key, iv); d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
}

(async () => {
  const db = new Database('data/db.sqlite');
  const row = db.prepare("SELECT access_token FROM zalo_oa WHERE oa_id = '328738126716568694'").get();
  const token = decrypt(row.access_token);
  db.close();

  const img = await axios.get('https://picsum.photos/800/450', { responseType: 'arraybuffer', timeout: 15000 });
  const imgBuf = Buffer.from(img.data);

  const endpoints = [
    'https://openapi.zalo.me/v2.0/oa/upload/image',
    'https://openapi.zalo.me/v3.0/oa/upload/image',
    'https://openapi.zalo.me/v2.0/upload/image',
    'https://openapi.zalo.me/v2.0/article/media/upload',
    'https://openapi.zalo.me/v2.0/oa/article/media/upload',
  ];

  for (const url of endpoints) {
    const form = new FormData();
    form.append('file', imgBuf, { filename: 'cover.jpg', contentType: 'image/jpeg' });
    try {
      const r = await axios.post(url, form, {
        headers: { ...form.getHeaders(), access_token: token },
        timeout: 30000, validateStatus: () => true,
      });
      const status = r.data?.error === 0 ? '✅ WORKS' : `❌ ${r.data?.error || r.status}`;
      console.log(`${status} ${url}`);
      console.log(`   ${JSON.stringify(r.data).slice(0, 250)}`);
    } catch (e) { console.log(`❌ ERR ${url}: ${e.message.slice(0, 100)}`); }
  }

  // Also test article/verify which some docs mention
  console.log('\n--- Try article create với cover as media url từ OA của chính mình ---');
  // Sonder's OA probably has existing images we can reuse.
  // Thử với empty/omit cover first
  const r2 = await axios.post('https://openapi.zalo.me/v2.0/article/create', {
    type: 'normal',
    title: 'Test no cover',
    desc: 'description',
    body: [{ type: 'text', content: '<p>Test</p>' }],
    status: 'hide',  // hide so it doesn't spam
  }, { headers: { access_token: token, 'Content-Type': 'application/json' }, timeout: 15000, validateStatus: () => true });
  console.log('No-cover:', JSON.stringify(r2.data).slice(0, 300));
})();
JS
node tmp.js
rm -f tmp.js
"""

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, username=USER, password=PASSWORD, timeout=15, look_for_keys=False, allow_agent=False)
stdin, stdout, stderr = client.exec_command(CMD, timeout=120)
print(stdout.read().decode("utf-8", errors="replace"))
err = stderr.read().decode("utf-8", errors="replace")
if err.strip(): print("STDERR:\n" + err, file=sys.stderr)
client.close()

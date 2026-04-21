"""Test Zalo image upload endpoint to get upload_id."""
import sys
import os
import paramiko

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

HOST = "103.82.193.74"
USER = "root"
PASSWORD = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("VPS_PASSWORD", "")

CMD = r"""
cd /opt/vp-marketing
cat > tmp-test-upload.js <<'JS'
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

  // Step 1: Download an image từ web thành Buffer
  console.log('--- Downloading test image from picsum ---');
  const imgResp = await axios.get('https://picsum.photos/800/450', {
    responseType: 'arraybuffer', timeout: 15000
  });
  const imgBuf = Buffer.from(imgResp.data);
  console.log(`Image size: ${imgBuf.length} bytes`);

  // Step 2: Upload to Zalo via multipart form
  console.log('\n--- Uploading to Zalo article/upload_image ---');
  const form = new FormData();
  form.append('file', imgBuf, { filename: 'cover.jpg', contentType: 'image/jpeg' });
  try {
    const r = await axios.post(
      'https://openapi.zalo.me/v2.0/article/upload_image',
      form,
      {
        headers: { ...form.getHeaders(), access_token: token },
        timeout: 30000, validateStatus: () => true,
      }
    );
    console.log('Status:', r.status);
    console.log('Response:', JSON.stringify(r.data, null, 2));
    if (r.data?.error === 0 && r.data?.data?.url) {
      console.log('\n✓ Uploaded! URL:', r.data.data.url);
      console.log('\n--- Now trying article/create with Zalo URL ---');

      const articleR = await axios.post('https://openapi.zalo.me/v2.0/article/create', {
        type: 'normal',
        title: 'Sonder Airport — Test bài đăng tự động',
        desc: 'Bài test từ bot VP Marketing',
        cover: r.data.data.url,
        body: [
          { type: 'text', content: '<p>🏨 <b>Sonder Airport</b> — chuỗi khách sạn 3★ gần sân bay.</p>' },
          { type: 'text', content: '<p>✨ Tiện nghi đầy đủ, lễ tân 24/7.</p>' },
          { type: 'text', content: '<p>📞 Hotline: 0348 644 833</p>' },
        ],
        status: 'show',
        comment: 'enable',
      }, {
        headers: { access_token: token, 'Content-Type': 'application/json' },
        timeout: 30000, validateStatus: () => true
      });
      console.log('Article status:', articleR.status);
      console.log('Article response:', JSON.stringify(articleR.data, null, 2));
    }
  } catch (e) {
    console.log('ERR:', e.response?.data || e.message);
  }
})();
JS
node tmp-test-upload.js
rm -f tmp-test-upload.js
"""

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, username=USER, password=PASSWORD, timeout=15, look_for_keys=False, allow_agent=False)
stdin, stdout, stderr = client.exec_command(CMD, timeout=120)
print(stdout.read().decode("utf-8", errors="replace"))
err = stderr.read().decode("utf-8", errors="replace")
if err.strip(): print("STDERR:\n" + err, file=sys.stderr)
client.close()

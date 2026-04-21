"""Use attachment_id from upload as article cover."""
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

  // 1. Upload
  console.log('--- Upload image ---');
  const img = await axios.get('https://picsum.photos/1200/675', { responseType: 'arraybuffer', timeout: 15000 });
  const form = new FormData();
  form.append('file', Buffer.from(img.data), { filename: 'cover.jpg', contentType: 'image/jpeg' });
  const up = await axios.post('https://openapi.zalo.me/v2.0/oa/upload/image', form, {
    headers: { ...form.getHeaders(), access_token: token }, timeout: 30000, validateStatus: () => true
  });
  console.log(JSON.stringify(up.data).slice(0, 300));
  const attachmentId = up.data?.data?.attachment_id;
  const imgUrl = up.data?.data?.url;  // might not exist
  if (!attachmentId) { console.log('Upload fail'); return; }
  console.log(`\nattachment_id: ${attachmentId}`);
  console.log(`url field: ${imgUrl || '(none)'}`);

  // 2. Try article create với attachment_id as cover
  const variants = [
    { label: 'cover=attachment_id', cover: attachmentId },
    { label: 'cover=upload_id prefix', cover: `upload_id:${attachmentId}` },
  ];

  for (const v of variants) {
    console.log(`\n--- article create: ${v.label} ---`);
    const r = await axios.post('https://openapi.zalo.me/v2.0/article/create', {
      type: 'normal',
      title: 'Sonder test article',
      desc: 'test',
      cover: v.cover,
      body: [{ type: 'text', content: '<p>Hello</p>' }],
      status: 'hide',
      comment: 'disable',
    }, { headers: { access_token: token, 'Content-Type': 'application/json' }, timeout: 15000, validateStatus: () => true });
    console.log(`HTTP ${r.status} → ${JSON.stringify(r.data).slice(0, 300)}`);
  }

  // 3. Maybe we need to upload via different endpoint that returns URL
  console.log('\n--- Trying asset upload endpoints ---');
  const form2 = new FormData();
  form2.append('file', Buffer.from(img.data), { filename: 'cover.jpg', contentType: 'image/jpeg' });
  const extraEndpoints = [
    'https://openapi.zalo.me/v2.0/oa/article/upload',
    'https://openapi.zalo.me/v2.0/article/upload',
    'https://openapi.zalo.me/v3.0/oa/article/upload',
  ];
  for (const url of extraEndpoints) {
    try {
      const form3 = new FormData();
      form3.append('file', Buffer.from(img.data), { filename: 'cover.jpg', contentType: 'image/jpeg' });
      const r = await axios.post(url, form3, {
        headers: { ...form3.getHeaders(), access_token: token }, timeout: 20000, validateStatus: () => true
      });
      console.log(`${r.data?.error === 0 ? '✅' : '❌'} ${url}: ${JSON.stringify(r.data).slice(0, 200)}`);
    } catch (e) { console.log(`❌ ${url}: ${e.message.slice(0, 100)}`); }
  }
})();
JS
node tmp.js
rm -f tmp.js
"""

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, username=USER, password=PASSWORD, timeout=15, look_for_keys=False, allow_agent=False)
stdin, stdout, stderr = client.exec_command(CMD, timeout=150)
print(stdout.read().decode("utf-8", errors="replace"))
err = stderr.read().decode("utf-8", errors="replace")
if err.strip(): print("STDERR:\n" + err, file=sys.stderr)
client.close()

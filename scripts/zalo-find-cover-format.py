"""Find correct cover format for article/create by various experiments."""
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

  // 1. Check if there's a /article/list to see existing article format
  console.log('--- List existing articles ---');
  try {
    const r = await axios.get('https://openapi.zalo.me/v2.0/article/get_list?data=' + encodeURIComponent('{"offset":0,"count":3,"type":"normal"}'), {
      headers: { access_token: token }, timeout: 15000, validateStatus: () => true
    });
    console.log(JSON.stringify(r.data, null, 2).slice(0, 1000));
  } catch (e) { console.log('err:', e.message); }

  // 2. Try other variations of the endpoint name
  console.log('\n--- Alt endpoints ---');
  const listEndpoints = [
    'https://openapi.zalo.me/v2.0/article/getlist',
    'https://openapi.zalo.me/v2.0/article/list',
    'https://openapi.zalo.me/v2.0/oa/article/list',
    'https://openapi.zalo.me/v2.0/oa/article/get',
    'https://openapi.zalo.me/v2.0/article/get_all',
  ];
  for (const url of listEndpoints) {
    try {
      const r = await axios.get(url + '?data=' + encodeURIComponent('{"offset":0,"count":1}'), {
        headers: { access_token: token }, timeout: 10000, validateStatus: () => true
      });
      console.log(`${r.data?.error === 0 ? '✅' : '❌'} ${url}: ${JSON.stringify(r.data).slice(0,200)}`);
    } catch (e) { console.log(`❌ ${url}: ${e.message.slice(0,80)}`); }
  }

  // 3. Try sending as cover multipart upload (separate upload endpoint)
  console.log('\n--- Trying /v2.0/article/verify_article ---');
  const r3 = await axios.post('https://openapi.zalo.me/v2.0/article/verify_article', {
    url: 'https://sondervn.com'
  }, { headers: { access_token: token, 'Content-Type': 'application/json' }, timeout: 15000, validateStatus: () => true });
  console.log(JSON.stringify(r3.data).slice(0, 300));

  // 4. Check what /oa/post/info endpoint does (might be different feature)
  console.log('\n--- /v2.0/oa/info ---');
  const r4 = await axios.get('https://openapi.zalo.me/v2.0/oa/info', {
    headers: { access_token: token }, timeout: 10000, validateStatus: () => true
  });
  console.log(JSON.stringify(r4.data).slice(0, 300));
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

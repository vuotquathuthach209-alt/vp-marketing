"""Probe all Zalo OA publishing endpoints to see which work with current tier."""
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
cat > tmp-probe.js <<'JS'
require('dotenv').config();
const Database = require('better-sqlite3');
const crypto = require('crypto');
const axios = require('axios');

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

  const endpoints = [
    // Article/post creation
    ['POST /v2.0/article/create', 'https://openapi.zalo.me/v2.0/article/create',
      { type: 'normal', title: 'Test', desc: 'Probe', cover: '', body: [{type:'text', content:'hello'}], status: 'show', comment: 'disable' }],
    ['POST /v3.0/article/create', 'https://openapi.zalo.me/v3.0/article/create',
      { type: 'normal', title: 'Test', body: [{type:'text', content:'hello'}] }],
    // Broadcast to all followers
    ['POST /v3.0/oa/message/broadcast', 'https://openapi.zalo.me/v3.0/oa/message/broadcast',
      { message: { text: 'Broadcast probe' } }],
    // Message to followers list (has to provide recipient)
    ['POST /v3.0/oa/message/promotion (broadcast-style)', 'https://openapi.zalo.me/v3.0/oa/message/promotion',
      { recipient: { target: { user_id: [] } }, message: { text: 'probe promo' } }],
    // Article attachment in message
    ['POST /v3.0/oa/message/cs (article-link)', 'https://openapi.zalo.me/v3.0/oa/message/cs',
      { recipient: { user_id: '5742053080582146621' },
        message: { attachment: { type: 'template', payload: {
          template_type: 'list',
          elements: [
            { title: 'Sonder Airport', subtitle: '3★ gần sân bay', image_url: 'https://sondervn.com/logo.png',
              default_action: { type: 'oa.open.url', url: 'https://sondervn.com' }},
          ]}}}}],
  ];

  for (const [label, url, body] of endpoints) {
    try {
      const r = await axios.post(url, body, {
        headers: { access_token: token, 'Content-Type': 'application/json' },
        timeout: 15000,
        validateStatus: () => true,
      });
      const err = r.data?.error;
      const msg = r.data?.message || '';
      const verdict = err === 0 ? '✅ WORKS' : err === -224 ? '❌ tier block' : err === -209 ? '❌ not approved' : err === 404 ? '⚠️ URL 404' : `⚠️ err=${err}`;
      console.log(`${verdict} ${label}`);
      console.log(`   ${JSON.stringify(r.data).slice(0, 220)}`);
    } catch (e) {
      console.log(`❌ ERR ${label}: ${e.message}`);
    }
  }

  // Also check follower count via getoa
  console.log('\n--- getoa (for context) ---');
  try {
    const r = await axios.get('https://openapi.zalo.me/v2.0/oa/getoa', {
      headers: { access_token: token }, timeout: 10000
    });
    console.log(JSON.stringify(r.data?.data || r.data, null, 2).slice(0, 500));
  } catch (e) { console.log('err:', e.message); }
})();
JS
node tmp-probe.js
rm -f tmp-probe.js
"""

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, username=USER, password=PASSWORD, timeout=15, look_for_keys=False, allow_agent=False)
stdin, stdout, stderr = client.exec_command(CMD, timeout=120)
print(stdout.read().decode("utf-8", errors="replace"))
err = stderr.read().decode("utf-8", errors="replace")
if err.strip(): print("STDERR:\n" + err, file=sys.stderr)
client.close()

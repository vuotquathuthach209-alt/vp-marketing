"""Test live: đăng 1 bài thật lên Sonder OA feed."""
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
cat > tmp-test-article.js <<'JS'
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

  // Test 1: Create article với cover URL public
  const payload = {
    type: 'normal',
    title: 'Sonder Airport — Chào mừng đến với chúng tôi!',
    desc: 'Khách sạn 3★ gần sân bay Tân Sơn Nhất, dịch vụ chuẩn quốc tế',
    cover: 'https://picsum.photos/800/450',
    body: [
      { type: 'text', content: '<p>🏨 <b>Sonder Airport</b> — chuỗi khách sạn thân thiện, phục vụ khách công tác + du lịch chỉ cách sân bay Tân Sơn Nhất 5 phút taxi.</p>' },
      { type: 'text', content: '<p>✨ Tiện nghi đầy đủ: điều hoà, wifi tốc độ cao, bãi đậu xe, lễ tân 24/7.</p>' },
      { type: 'text', content: '<p>📞 Hotline: 0348 644 833 — đặt phòng ngay hôm nay!</p>' },
    ],
    author: 'Sonder Team',
    status: 'show',
    comment: 'enable',
  };

  console.log('--- Testing article create API ---');
  try {
    const r = await axios.post('https://openapi.zalo.me/v2.0/article/create', payload, {
      headers: { access_token: token, 'Content-Type': 'application/json' },
      timeout: 30000, validateStatus: () => true
    });
    console.log('Status:', r.status);
    console.log('Response:', JSON.stringify(r.data, null, 2));
    if (r.data?.error === 0) {
      console.log('\n🎉 SUCCESS! Article URL:', r.data?.data?.url || '(no url in response)');
    }
  } catch (e) {
    console.log('ERR:', e.response?.data || e.message);
  }
})();
JS
node tmp-test-article.js
rm -f tmp-test-article.js
"""

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, username=USER, password=PASSWORD, timeout=15, look_for_keys=False, allow_agent=False)
stdin, stdout, stderr = client.exec_command(CMD, timeout=90)
print(stdout.read().decode("utf-8", errors="replace"))
err = stderr.read().decode("utf-8", errors="replace")
if err.strip(): print("STDERR:\n" + err, file=sys.stderr)
client.close()

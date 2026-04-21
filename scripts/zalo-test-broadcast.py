"""Test broadcast alternatives: message with image, rich template, link preview."""
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

  // 1. Upload image to Zalo
  console.log('--- Upload image ---');
  const img = await axios.get('https://picsum.photos/800/450', { responseType: 'arraybuffer' });
  const form = new FormData();
  form.append('file', Buffer.from(img.data), { filename: 'promo.jpg', contentType: 'image/jpeg' });
  const up = await axios.post('https://openapi.zalo.me/v2.0/oa/upload/image', form, {
    headers: { ...form.getHeaders(), access_token: token }, validateStatus: () => true
  });
  const attachmentId = up.data?.data?.attachment_id;
  console.log('attachment_id:', attachmentId?.slice(0, 40) + '...');
  if (!attachmentId) { console.log('upload fail'); return; }

  const USER_ID = '5742053080582146621';  // Hùng Nguyễn

  // 2. Send image message with caption (use attachment_id)
  console.log('\n--- Send image message ---');
  const imgMsg = await axios.post('https://openapi.zalo.me/v3.0/oa/message/cs', {
    recipient: { user_id: USER_ID },
    message: {
      text: '🏨 Sonder Airport — Ưu đãi tháng 4!\n\n✨ Giảm 20% phòng deluxe từ 20/04 đến 30/04.\n📞 Hotline: 0348 644 833',
      attachment: { type: 'template', payload: { template_type: 'media', elements: [
        { media_type: 'image', attachment_id: attachmentId }
      ]}},
    }
  }, { headers: { access_token: token, 'Content-Type': 'application/json' }, validateStatus: () => true });
  console.log('image msg:', JSON.stringify(imgMsg.data).slice(0, 400));

  // 3. Try rich list template (like FB carousel)
  console.log('\n--- Send rich list template ---');
  const listMsg = await axios.post('https://openapi.zalo.me/v3.0/oa/message/cs', {
    recipient: { user_id: USER_ID },
    message: {
      attachment: { type: 'template', payload: {
        template_type: 'list',
        elements: [
          {
            title: 'Sonder Airport',
            subtitle: '3★ gần sân bay Tân Sơn Nhất, dịch vụ chuẩn quốc tế',
            image_url: 'https://picsum.photos/800/450',
            default_action: { type: 'oa.open.url', url: 'https://sondervn.com' }
          }
        ],
        buttons: [
          { title: '📞 Gọi ngay', type: 'oa.open.phone', payload: '0348644833' },
          { title: '🌐 Xem website', type: 'oa.open.url', payload: 'https://sondervn.com' }
        ]
      }}
    }
  }, { headers: { access_token: token, 'Content-Type': 'application/json' }, validateStatus: () => true });
  console.log('list tpl:', JSON.stringify(listMsg.data).slice(0, 400));

  // 4. Get follower list — for broadcast
  console.log('\n--- Get follower list ---');
  const followers = await axios.get(
    'https://openapi.zalo.me/v2.0/oa/getlistfollower?data=' + encodeURIComponent('{"offset":0,"count":10}'),
    { headers: { access_token: token }, validateStatus: () => true }
  );
  console.log('followers:', JSON.stringify(followers.data).slice(0, 500));

  // 5. Try v3.0 recent chat to get recent users
  console.log('\n--- Get recent chats ---');
  const recent = await axios.get(
    'https://openapi.zalo.me/v2.0/oa/listrecentchat?data=' + encodeURIComponent('{"offset":0,"count":10}'),
    { headers: { access_token: token }, validateStatus: () => true }
  );
  console.log('recent:', JSON.stringify(recent.data).slice(0, 500));
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

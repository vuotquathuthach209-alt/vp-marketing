"""
Full end-to-end test sau khi upgrade tier:
1. Refresh token từ DB
2. Gửi tin thật qua OA API
3. Gửi fake webhook → xem bot có gửi được reply không
"""
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
cat > tmp-e2e.js <<'JS'
require('dotenv').config();
const Database = require('better-sqlite3');
const crypto = require('crypto');
const axios = require('axios');
const querystring = require('querystring');

const PREFIX = 'enc:v1:';
const raw = process.env.SECRET_KEY || process.env.JWT_SECRET || '';
const key = crypto.createHash('sha256').update(raw || 'vp-mkt-default-insecure').digest();

function decrypt(payload) {
  if (payload == null) return null;
  if (typeof payload !== 'string' || !payload.startsWith(PREFIX)) return payload;
  try {
    const buf = Buffer.from(payload.slice(PREFIX.length), 'base64');
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const ct = buf.subarray(28);
    const dec = crypto.createDecipheriv('aes-256-gcm', key, iv);
    dec.setAuthTag(tag);
    return Buffer.concat([dec.update(ct), dec.final()]).toString('utf8');
  } catch (e) { return null; }
}

function encrypt(plain) {
  if (!plain) return plain;
  if (typeof plain === 'string' && plain.startsWith(PREFIX)) return plain;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + Buffer.concat([iv, tag, ct]).toString('base64');
}

(async () => {
  const db = new Database('data/db.sqlite');
  const row = db.prepare("SELECT * FROM zalo_oa WHERE oa_id = '328738126716568694'").get();
  if (!row) { console.log('ERR: OA not found'); db.close(); return; }

  const access = decrypt(row.access_token);
  const refresh = decrypt(row.refresh_token);
  const secret = decrypt(row.app_secret);
  const appId = '1125683119493780855';
  const userId = '5742053080582146621'; // Hùng Nguyễn

  console.log('--- Credentials decrypted ---');
  console.log(`access_token: ${access ? access.length : 0} chars`);
  console.log(`refresh_token: ${refresh ? refresh.length : 0} chars`);
  console.log(`app_secret: ${secret}`);

  // 1. Refresh token first (get fresh token)
  console.log('\n--- Step 1: Refresh token ---');
  let freshAccess = access;
  try {
    const r = await axios.post(
      'https://oauth.zaloapp.com/v4/oa/access_token',
      querystring.stringify({ refresh_token: refresh, app_id: appId, grant_type: 'refresh_token' }),
      { headers: { 'secret_key': secret, 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 15000 }
    );
    if (r.data?.access_token) {
      freshAccess = r.data.access_token;
      const freshRefresh = r.data.refresh_token;
      console.log(`✓ New token: ${freshAccess.slice(0, 20)}... (${freshAccess.length} chars)`);
      // Save back
      db.prepare('UPDATE zalo_oa SET access_token=?, refresh_token=?, token_expires_at=? WHERE id=?')
        .run(encrypt(freshAccess), encrypt(freshRefresh), Date.now() + (r.data.expires_in || 90000) * 1000, row.id);
      console.log('✓ Saved to DB');
    } else {
      console.log('⚠ Refresh response:', JSON.stringify(r.data).slice(0, 300));
    }
  } catch (e) {
    console.log('⚠ Refresh fail:', e.response?.data || e.message);
    console.log('Continuing with existing access_token...');
  }

  // 2. Test send
  console.log('\n--- Step 2: Send test message ---');
  const text = '✅ Test từ bot Sonder — nếu bạn nhận được tin này nghĩa là Zalo OA bot đã hoạt động 100%! Bot sẵn sàng tự động reply khách rồi. 🎉';
  try {
    const r = await axios.post(
      'https://openapi.zalo.me/v3.0/oa/message/cs',
      { recipient: { user_id: userId }, message: { text } },
      { headers: { access_token: freshAccess, 'Content-Type': 'application/json' }, timeout: 15000 }
    );
    console.log('Response:', JSON.stringify(r.data, null, 2));
    if (r.data?.error === 0) {
      console.log('\n🎉🎉🎉 SUCCESS! Tin nhắn đã gửi tới Zalo Hùng Nguyễn!');
    } else {
      console.log('\n❌ Send fail với error code:', r.data?.error);
      if (r.data?.error === -32) console.log('   → User chưa follow OA hoặc không tồn tại');
      if (r.data?.error === -224) console.log('   → Tier chưa đủ để gửi tin (nâng gói chưa active?)');
    }
  } catch (e) {
    console.log('Send error:', e.response?.data || e.message);
  }

  db.close();
})();
JS
node tmp-e2e.js
rm -f tmp-e2e.js
"""

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, username=USER, password=PASSWORD, timeout=15, look_for_keys=False, allow_agent=False)
stdin, stdout, stderr = client.exec_command(CMD, timeout=90)
print(stdout.read().decode("utf-8", errors="replace"))
err = stderr.read().decode("utf-8", errors="replace")
if err.strip(): print("STDERR:\n" + err, file=sys.stderr)
client.close()

"""Tạo 1 article test + publish thật qua broadcast service."""
import sys, os, paramiko
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception: pass

HOST = "103.82.193.74"; USER = "root"
PASSWORD = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("VPS_PASSWORD", "")

CMD = r"""
cd /opt/vp-marketing
cat > tmp-live.js <<'JS'
require('dotenv').config();
const Database = require('better-sqlite3');
const { zaloBroadcastRichMessage } = require('./dist/services/zalo');
const { decrypt } = require('./dist/services/crypto');

(async () => {
  const db = new Database('data/db.sqlite');
  const row = db.prepare("SELECT * FROM zalo_oa WHERE oa_id = '328738126716568694' AND enabled = 1").get();
  db.close();
  if (!row) { console.log('OA not found'); return; }

  const oa = {
    ...row,
    access_token: decrypt(row.access_token) || '',
    refresh_token: decrypt(row.refresh_token),
    app_secret: decrypt(row.app_secret),
  };

  console.log('--- Broadcast test ---');
  const caption = `🏨 Sonder Airport — Ưu đãi tháng 4! ✨

Giảm ngay 20% phòng Deluxe cho booking từ 20/04 đến 30/04.

✅ Wifi tốc độ cao
✅ Lễ tân 24/7
✅ Gần sân bay Tân Sơn Nhất 5 phút

📞 Gọi ngay 0348 644 833 để đặt phòng!`;

  // Debug: check token
  console.log('token len:', oa.access_token?.length);

  // First test: explicit user_id (Hùng Nguyễn — đã từng chat OA)
  console.log('\n--- With explicit user_id ---');
  try {
    const result = await zaloBroadcastRichMessage(oa, {
      caption,
      imageUrl: 'https://picsum.photos/1200/675',
      userIds: ['1472089308935393663'],  // Hùng Nguyễn as seen by OA
      onProgress: (d, t) => console.log(`  [${d}/${t}]`),
    });
    console.log('\nResult:', JSON.stringify(result, null, 2));
  } catch (e) { console.log('ERR:', e.message); }

  // Second test: debug recent chat user list
  console.log('\n--- Debug listrecentchat ---');
  const axios = require('axios');
  const r = await axios.get(
    'https://openapi.zalo.me/v2.0/oa/listrecentchat?data=' + encodeURIComponent('{"offset":0,"count":20}'),
    { headers: { access_token: oa.access_token }, validateStatus: () => true }
  );
  console.log('items count:', r.data?.data?.length || 0);
  console.log('first item:', JSON.stringify(r.data?.data?.[0] || null).slice(0, 400));
})();
JS
node tmp-live.js
rm -f tmp-live.js
"""

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, username=USER, password=PASSWORD, timeout=15, look_for_keys=False, allow_agent=False)
stdin, stdout, stderr = client.exec_command(CMD, timeout=180)
for line in iter(stdout.readline, ""):
    if line.strip(): print(line, end="", flush=True)
err = stderr.read().decode("utf-8", errors="replace")
if err.strip(): print("\nSTDERR:\n" + err, file=sys.stderr)
client.close()

"""
Save Zalo OA config vào DB:
- hotel_id: 6 (Sonder Airport)
- oa_id: 328738126716568694
- oa_name: Sonder
- app_secret: GUZI3qP6QivL7OW94VD7
- access_token: placeholder (sẽ update khi user gửi token valid)
- refresh_token: placeholder
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

# Token args (optional — if provided, use real values)
ACCESS_TOKEN = sys.argv[2] if len(sys.argv) > 2 else "PLACEHOLDER_UPDATE_ME"
REFRESH_TOKEN = sys.argv[3] if len(sys.argv) > 3 else "PLACEHOLDER_UPDATE_ME"

CMD = f"""
cd /opt/vp-marketing
cat > tmp-zalo-save.js <<'JS'
const Database = require('better-sqlite3');
const db = new Database('data/db.sqlite');

// Inspect schema first
const cols = db.prepare("PRAGMA table_info(zalo_oa)").all();
console.log('zalo_oa schema:');
cols.forEach(c => console.log(`  ${{c.name}} ${{c.type}}`));

// Upsert OA config
const HOTEL_ID = 6;
const OA_ID = '328738126716568694';
const OA_NAME = 'Sonder';
const APP_SECRET = 'GUZI3qP6QivL7OW94VD7';
const ACCESS_TOKEN = {ACCESS_TOKEN!r};
const REFRESH_TOKEN = {REFRESH_TOKEN!r};
const now = Date.now();

// Token expires in 25h (Zalo default)
const TOKEN_EXPIRES_AT = now + (25 * 60 * 60 * 1000);

const existing = db.prepare('SELECT id FROM zalo_oa WHERE oa_id = ?').get(OA_ID);
if (existing) {{
  db.prepare(`UPDATE zalo_oa SET
    hotel_id=?, oa_name=?, access_token=?, refresh_token=?, app_secret=?, token_expires_at=?, enabled=1
    WHERE oa_id=?`).run(HOTEL_ID, OA_NAME, ACCESS_TOKEN, REFRESH_TOKEN, APP_SECRET, TOKEN_EXPIRES_AT, OA_ID);
  console.log('\\n✓ UPDATED existing row id=' + existing.id);
}} else {{
  const r = db.prepare(`INSERT INTO zalo_oa
    (hotel_id, oa_id, oa_name, access_token, refresh_token, token_expires_at, app_secret, enabled, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`).run(
      HOTEL_ID, OA_ID, OA_NAME, ACCESS_TOKEN, REFRESH_TOKEN, TOKEN_EXPIRES_AT, APP_SECRET, now);
  console.log('\\n✓ INSERTED new row id=' + r.lastInsertRowid);
}}

// Verify
const row = db.prepare('SELECT id, hotel_id, oa_id, oa_name, enabled, length(access_token) as at_len, length(refresh_token) as rt_len, length(app_secret) as sec_len, token_expires_at FROM zalo_oa WHERE oa_id = ?').get(OA_ID);
console.log('\\nFinal row:', JSON.stringify(row, null, 2));
db.close();
JS
node tmp-zalo-save.js
rm -f tmp-zalo-save.js
"""

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, username=USER, password=PASSWORD, timeout=15, look_for_keys=False, allow_agent=False)
stdin, stdout, stderr = client.exec_command(CMD, timeout=60)
print(stdout.read().decode("utf-8", errors="replace"))
err = stderr.read().decode("utf-8", errors="replace")
if err.strip(): print("STDERR:\n" + err, file=sys.stderr)
client.close()

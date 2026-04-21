"""Re-encrypt plaintext Zalo tokens in DB using the encrypt() function."""
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
cat > tmp-reencrypt.js <<'JS'
// Load .env so SECRET_KEY is available
require('dotenv').config();
const Database = require('better-sqlite3');
const crypto = require('crypto');

const PREFIX = 'enc:v1:';
const raw = process.env.SECRET_KEY || process.env.JWT_SECRET || '';
const key = crypto.createHash('sha256').update(raw || 'vp-mkt-default-insecure').digest();

function encrypt(plain) {
  if (plain == null || plain === '') return plain;
  if (typeof plain === 'string' && plain.startsWith(PREFIX)) return plain;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + Buffer.concat([iv, tag, ct]).toString('base64');
}

const db = new Database('data/db.sqlite');
const rows = db.prepare('SELECT * FROM zalo_oa').all();
let n = 0;
for (const r of rows) {
  const at = encrypt(r.access_token);
  const rt = encrypt(r.refresh_token);
  const sk = encrypt(r.app_secret);
  db.prepare('UPDATE zalo_oa SET access_token=?, refresh_token=?, app_secret=? WHERE id=?')
    .run(at, rt, sk, r.id);
  n++;
  console.log(`Row ${r.id}: at_len=${r.access_token ? r.access_token.length : 0}→${at ? at.length : 0}, already_encrypted=${r.access_token && r.access_token.startsWith(PREFIX)}`);
}
console.log(`\n✓ Re-encrypted ${n} rows`);
db.close();
JS
node tmp-reencrypt.js
rm -f tmp-reencrypt.js
"""

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, username=USER, password=PASSWORD, timeout=15, look_for_keys=False, allow_agent=False)
stdin, stdout, stderr = client.exec_command(CMD, timeout=60)
print(stdout.read().decode("utf-8", errors="replace"))
err = stderr.read().decode("utf-8", errors="replace")
if err.strip(): print("STDERR:\n" + err, file=sys.stderr)
client.close()

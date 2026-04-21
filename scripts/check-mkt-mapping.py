"""Check mkt_hotels.ota_hotel_id mapping for hotel_id=6."""
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
cat > tmp-check.js <<'JS'
const Database = require('better-sqlite3');
const db = new Database('data/db.sqlite');

// mkt_hotels schema + data
console.log('=== mkt_hotels schema ===');
const cols = db.prepare("PRAGMA table_info(mkt_hotels)").all();
cols.forEach(c => console.log(`  ${c.name} ${c.type}`));

console.log('\n=== mkt_hotels rows ===');
const m = db.prepare("SELECT * FROM mkt_hotels ORDER BY id").all();
m.forEach(r => console.log(JSON.stringify(r)));

db.close();
JS
node tmp-check.js
rm -f tmp-check.js
"""

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, username=USER, password=PASSWORD, timeout=15, look_for_keys=False, allow_agent=False)
stdin, stdout, stderr = client.exec_command(CMD, timeout=30)
print(stdout.read().decode("utf-8", errors="replace"))
err = stderr.read().decode("utf-8", errors="replace")
if err.strip(): print("STDERR:\n" + err, file=sys.stderr)
client.close()

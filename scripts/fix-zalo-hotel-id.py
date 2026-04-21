"""Fix zalo_oa.hotel_id from 6 (OTA Push Test) to 1 (Sonder Vietnam)."""
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
cat > tmp-fix.js <<'JS'
const Database = require('better-sqlite3');
const db = new Database('data/db.sqlite');

// Verify Sonder mkt_hotel
const sonder = db.prepare("SELECT id, ota_hotel_id, name FROM mkt_hotels WHERE id = 1").get();
console.log('Sonder mkt_hotel:', JSON.stringify(sonder));

// Update zalo_oa
const r = db.prepare("UPDATE zalo_oa SET hotel_id = 1 WHERE oa_id = '328738126716568694'").run();
console.log(`\nUpdated ${r.changes} row`);

// Verify
const final = db.prepare("SELECT id, hotel_id, oa_id, oa_name, enabled FROM zalo_oa").all();
console.log('\nFinal zalo_oa:');
final.forEach(r => console.log(JSON.stringify(r)));

// Clean up old test conversations
const cleanup = db.prepare("DELETE FROM conversation_memory WHERE sender_id LIKE 'zalo:verify_user_%' OR sender_id LIKE 'zalo:test_user_%'").run();
console.log(`\nCleaned up ${cleanup.changes} test conversations`);

db.close();
JS
node tmp-fix.js
rm -f tmp-fix.js
"""

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, username=USER, password=PASSWORD, timeout=15, look_for_keys=False, allow_agent=False)
stdin, stdout, stderr = client.exec_command(CMD, timeout=30)
print(stdout.read().decode("utf-8", errors="replace"))
err = stderr.read().decode("utf-8", errors="replace")
if err.strip(): print("STDERR:\n" + err, file=sys.stderr)
client.close()

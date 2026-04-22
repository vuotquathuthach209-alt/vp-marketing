"""Xoa test hotel khoi hotel_profile + mkt_hotels de khong anh huong bot."""
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
const Database = require('better-sqlite3');
const db = new Database('data/db.sqlite');

console.log('Before:');
const before = db.prepare(`SELECT hotel_id, name_canonical, data_source FROM hotel_profile WHERE name_canonical LIKE '%self-test%' OR name_canonical LIKE '%Sample Test%'`).all();
before.forEach(r => console.log(`  #${r.hotel_id} ${r.name_canonical} (${r.data_source})`));

// Delete from hotel_profile
const r1 = db.prepare(`DELETE FROM hotel_profile WHERE name_canonical LIKE '%self-test%' OR name_canonical LIKE '%Sample Test%'`).run();
console.log(`\nDeleted ${r1.changes} from hotel_profile`);

// Delete from mkt_hotels
const r2 = db.prepare(`DELETE FROM mkt_hotels WHERE name LIKE '%self-test%' OR name LIKE '%Sample Test%'`).run();
console.log(`Deleted ${r2.changes} from mkt_hotels`);

// Mark raw record as reviewed (keep for audit)
const r3 = db.prepare(`UPDATE ota_raw_hotels SET status = 'test_cleaned' WHERE ota_id = 'test-self-001'`).run();
console.log(`Cleaned ${r3.changes} ota_raw_hotels rows`);

db.close();
console.log('\nDone.');
JS
node tmp.js
rm -f tmp.js
"""

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, username=USER, password=PASSWORD, timeout=15, look_for_keys=False, allow_agent=False)
stdin, stdout, stderr = client.exec_command(CMD, timeout=30)
print(stdout.read().decode("utf-8", errors="replace"))
err = stderr.read().decode("utf-8", errors="replace")
if err.strip(): print("STDERR:\n" + err, file=sys.stderr)
client.close()

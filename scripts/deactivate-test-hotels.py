"""Deactivate test hotels để bot không list chúng."""
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

console.log('=== Before ===');
let rows = db.prepare(`SELECT id, name, status FROM mkt_hotels ORDER BY id`).all();
rows.forEach(r => console.log(`  #${r.id} ${r.name} status=${r.status}`));

// Deactivate test + OTA Push hotels
const r = db.prepare(`UPDATE mkt_hotels SET status='inactive', updated_at=? WHERE name LIKE '%Test%' OR name LIKE '%OTA Push%'`).run(Date.now());
console.log(`\nDeactivated ${r.changes} test hotels`);

console.log('\n=== After ===');
rows = db.prepare(`SELECT id, name, status FROM mkt_hotels ORDER BY id`).all();
rows.forEach(r => console.log(`  #${r.id} ${r.name} status=${r.status}`));

db.close();
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

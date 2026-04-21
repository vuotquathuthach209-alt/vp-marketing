"""
Save Zalo OA config vào DB via Node (không cần sqlite3 CLI).
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
cat > /tmp/zalo-save.js <<'JS'
const Database = require('better-sqlite3');
const db = new Database('data/db.sqlite');
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
console.log('Tables:');
tables.forEach(t => console.log('  ' + t.name));

// Find hotel-related table
console.log('\nHotel-related rows:');
['hotels', 'hotel_profiles', 'hotel_profile', 'users'].forEach(name => {
  try {
    const rows = db.prepare(`SELECT * FROM ${name} LIMIT 3`).all();
    if (rows.length) {
      console.log(`-- ${name} (${rows.length} rows, schema:`, Object.keys(rows[0]).join(','), '):');
      rows.forEach(r => console.log(JSON.stringify(r).slice(0, 200)));
    }
  } catch {}
});

// Zalo accounts
console.log('\nzalo_accounts:');
try {
  const cols = db.prepare("PRAGMA table_info(zalo_accounts)").all();
  cols.forEach(c => console.log(`  col: ${c.name} ${c.type}`));
  const oas = db.prepare('SELECT id, hotel_id, oa_id, oa_name, status FROM zalo_accounts').all();
  console.log(`  rows: ${oas.length}`);
  oas.forEach(o => console.log('  ' + JSON.stringify(o)));
} catch (e) { console.log('  error:', e.message); }
db.close();
JS
cp /tmp/zalo-save.js /opt/vp-marketing/tmp-zalo-save.js
cd /opt/vp-marketing && node tmp-zalo-save.js
rm -f /opt/vp-marketing/tmp-zalo-save.js
"""

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, username=USER, password=PASSWORD, timeout=15, look_for_keys=False, allow_agent=False)
stdin, stdout, stderr = client.exec_command(CMD, timeout=60)
print(stdout.read().decode("utf-8", errors="replace"))
err = stderr.read().decode("utf-8", errors="replace")
if err.strip(): print("STDERR:\n" + err, file=sys.stderr)
client.close()

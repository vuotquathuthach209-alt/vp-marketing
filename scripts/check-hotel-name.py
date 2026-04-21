"""Check why bot returns 'OTA Push Test Hotel' for hotel_id=6."""
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

// Check hotel_profile for hotel_id=6
console.log('=== hotel_profile #6 ===');
const h = db.prepare('SELECT hotel_id, name_canonical, name_en, city, district FROM hotel_profile WHERE hotel_id = 6').get();
console.log(JSON.stringify(h, null, 2));

// Check v_hotel_bot_context view if exists
console.log('\n=== v_hotel_bot_context #6 ===');
try {
  const c = db.prepare('SELECT * FROM v_hotel_bot_context WHERE hotel_id = 6 LIMIT 1').get();
  console.log(JSON.stringify(c, null, 2).slice(0, 500));
} catch (e) { console.log('(no view)', e.message); }

// Check rooms for hotel 6
console.log('\n=== rooms for hotel 6 (from catalog) ===');
try {
  const rooms = db.prepare("SELECT id, room_name, price, product_group FROM hotel_room_catalog WHERE hotel_id = 6 LIMIT 5").all();
  console.log(JSON.stringify(rooms, null, 2));
} catch (e) { console.log('err:', e.message); }

// Find "OTA Push Test Hotel" hotel
console.log('\n=== "OTA Push Test Hotel" in DB ===');
const found = db.prepare("SELECT hotel_id, name_canonical FROM hotel_profile WHERE name_canonical LIKE '%OTA Push%' OR name_canonical LIKE '%Push%'").all();
console.log(JSON.stringify(found, null, 2));

// Check mkt_hotels
console.log('\n=== mkt_hotels rows (first 10) ===');
try {
  const m = db.prepare("SELECT id, hotel_name FROM mkt_hotels LIMIT 10").all();
  console.log(JSON.stringify(m, null, 2));
} catch (e) { console.log('err:', e.message); }

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

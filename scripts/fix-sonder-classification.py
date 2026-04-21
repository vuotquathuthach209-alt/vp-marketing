"""Fix Sonder Airport classification: monthly_apartment → nightly_stay."""
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

console.log('=== hotel_profile Sonder Airport (hotel_id=6) ===');
const p = db.prepare('SELECT hotel_id, name_canonical, property_type, rental_type, product_group, monthly_price_from FROM hotel_profile WHERE hotel_id = 6').get();
console.log(JSON.stringify(p, null, 2));

console.log('\n=== hotel_room_catalog for hotel_id=6 ===');
const rooms = db.prepare('SELECT * FROM hotel_room_catalog WHERE hotel_id = 6').all();
rooms.forEach(r => {
  console.log(`  id=${r.id} display_name=${r.display_name_vi} price_weekday=${r.price_weekday} price_monthly=${r.price_monthly} max_guests=${r.max_guests} product_group=${r.product_group || '-'}`);
});

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

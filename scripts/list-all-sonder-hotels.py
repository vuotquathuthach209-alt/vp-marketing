"""List all Sonder hotels + classification."""
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

console.log('=== hotel_profile — ALL ===');
const rows = db.prepare('SELECT hotel_id, name_canonical, property_type, rental_type, product_group, monthly_price_from, city, district FROM hotel_profile ORDER BY hotel_id').all();
rows.forEach(r => {
  console.log(`#${r.hotel_id} ${r.name_canonical}`);
  console.log(`  type=${r.property_type} rental=${r.rental_type} group=${r.product_group}`);
  console.log(`  location=${r.district}, ${r.city} | monthly_from=${r.monthly_price_from || '-'}`);
});

console.log('\n=== mkt_hotels — ALL (tenant config) ===');
const mkt = db.prepare('SELECT id, ota_hotel_id, name, slug, status FROM mkt_hotels ORDER BY id').all();
mkt.forEach(m => console.log(`#${m.id} ${m.name} slug=${m.slug} ota_id=${m.ota_hotel_id} status=${m.status}`));

console.log('\n=== hotel_room_catalog — Group by hotel ===');
const rooms = db.prepare('SELECT hotel_id, COUNT(*) as n, GROUP_CONCAT(DISTINCT product_group) as groups, MIN(price_weekday) as min_p, MAX(price_weekday) as max_p FROM hotel_room_catalog GROUP BY hotel_id').all();
rooms.forEach(r => console.log(`  hotel=${r.hotel_id} rooms=${r.n} groups=[${r.groups}] price_range=${r.min_p}-${r.max_p}`));

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

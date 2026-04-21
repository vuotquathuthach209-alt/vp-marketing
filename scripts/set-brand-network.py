"""Set brand_network in mkt_hotels.config để bot biết Sonder Airport + Seehome là cùng hệ thống."""
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

function setBrand(mktHotelId, brand) {
  const row = db.prepare('SELECT id, config FROM mkt_hotels WHERE id = ?').get(mktHotelId);
  if (!row) { console.log(`  skip: mkt_hotel ${mktHotelId} not found`); return; }
  let cfg = {};
  try { cfg = row.config ? JSON.parse(row.config) : {}; } catch {}
  cfg.brand_network = brand;
  db.prepare('UPDATE mkt_hotels SET config=?, updated_at=? WHERE id=?').run(JSON.stringify(cfg), Date.now(), mktHotelId);
  console.log(`  ✓ mkt_hotel #${mktHotelId} brand_network=${brand}`);
}

console.log('Setting brand_network = "sonder" for Sonder network hotels...');
setBrand(1, 'sonder');  // Sonder Vietnam (Sonder Airport apartment)
setBrand(3, 'sonder');  // Seehome Airport (sibling — nightly hotel)

console.log('\n=== Verify ===');
const all = db.prepare(`SELECT id, name, ota_hotel_id, config FROM mkt_hotels ORDER BY id`).all();
all.forEach(m => {
  let brand = null;
  try { brand = (JSON.parse(m.config || '{}')).brand_network; } catch {}
  console.log(`  #${m.id} ${m.name} ota=${m.ota_hotel_id} brand=${brand || '-'}`);
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

"""Check current state of availability + OTA sync pipeline."""
import sys, paramiko
try: sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except: pass

HOST = "103.82.193.74"
PASSWORD = sys.argv[1] if len(sys.argv) > 1 else ""

CMD = r"""
cd /opt/vp-marketing
cat > tmp.js <<'JS'
const Database = require('better-sqlite3');
const db = new Database('data/db.sqlite');

console.log('=== 1. mkt_availability_cache ===');
try {
  const cols = db.prepare(`PRAGMA table_info(mkt_availability_cache)`).all();
  console.log('Columns:', cols.map(c => c.name).join(', '));
  const cnt = db.prepare(`SELECT COUNT(*) as n FROM mkt_availability_cache`).get();
  console.log('Rows:', cnt.n);
  if (cnt.n > 0) {
    const sample = db.prepare(`SELECT * FROM mkt_availability_cache LIMIT 3`).all();
    sample.forEach(s => console.log('  sample:', JSON.stringify(s).slice(0, 300)));
    const latest = db.prepare(`SELECT MAX(last_updated_at) as latest FROM mkt_availability_cache`).get();
    if (latest?.latest) console.log('Latest sync:', new Date(latest.latest).toISOString(), '(' + Math.round((Date.now()-latest.latest)/3600_000) + 'h ago)');
  }
} catch (e) { console.log('ERR:', e.message); }

console.log('\n=== 2. ota_raw_availability ===');
try {
  const cnt = db.prepare(`SELECT COUNT(*) as n FROM ota_raw_availability`).get();
  console.log('Rows:', cnt.n);
  const cols = db.prepare(`PRAGMA table_info(ota_raw_availability)`).all();
  console.log('Columns:', cols.map(c => c.name).join(', '));
  if (cnt.n > 0) {
    const sample = db.prepare(`SELECT * FROM ota_raw_availability LIMIT 2`).all();
    sample.forEach(s => console.log('  sample:', JSON.stringify(s).slice(0, 400)));
  }
} catch (e) { console.log('ERR:', e.message); }

console.log('\n=== 3. ota_raw_hotels + ota_raw_rooms ===');
try {
  const hCount = db.prepare(`SELECT COUNT(*) as n FROM ota_raw_hotels`).get();
  const rCount = db.prepare(`SELECT COUNT(*) as n FROM ota_raw_rooms`).get();
  console.log('ota_raw_hotels:', hCount.n, '| ota_raw_rooms:', rCount.n);
} catch (e) { console.log('ERR:', e.message); }

console.log('\n=== 4. etl_sync_log (gần nhất) ===');
try {
  const logs = db.prepare(`SELECT * FROM etl_sync_log ORDER BY id DESC LIMIT 5`).all();
  logs.forEach(l => console.log('  ', JSON.stringify(l).slice(0, 200)));
} catch (e) { console.log('ERR:', e.message); }

console.log('\n=== 5. etl_hotel_failures (có ai fail không) ===');
try {
  const cnt = db.prepare(`SELECT COUNT(*) as n FROM etl_hotel_failures`).get();
  console.log('Rows:', cnt.n);
  const recent = db.prepare(`SELECT * FROM etl_hotel_failures ORDER BY id DESC LIMIT 3`).all();
  recent.forEach(l => console.log('  ', JSON.stringify(l).slice(0, 200)));
} catch (e) { console.log('ERR:', e.message); }

console.log('\n=== 6. hotel_room_catalog columns (master data) ===');
try {
  const cols = db.prepare(`PRAGMA table_info(hotel_room_catalog)`).all();
  console.log('Columns:', cols.map(c => c.name).join(', '));
  const cnt = db.prepare(`SELECT COUNT(*) as n FROM hotel_room_catalog`).get();
  console.log('Rows:', cnt.n);
  const sample = db.prepare(`SELECT hotel_id, display_name_vi, max_guests, price_weekday, price_weekend FROM hotel_room_catalog LIMIT 3`).all();
  sample.forEach(s => console.log('  ', JSON.stringify(s)));
} catch (e) { console.log('ERR:', e.message); }

console.log('\n=== 7. mkt_bookings_cache ===');
try {
  const cnt = db.prepare(`SELECT COUNT(*) as n FROM mkt_bookings_cache`).get();
  console.log('Rows:', cnt.n);
  const cols = db.prepare(`PRAGMA table_info(mkt_bookings_cache)`).all();
  console.log('Columns:', cols.map(c => c.name).join(', '));
} catch (e) { console.log('ERR:', e.message); }

console.log('\n=== 8. pending_bookings ===');
try {
  const cnt = db.prepare(`SELECT COUNT(*) as n FROM pending_bookings`).get();
  console.log('Rows:', cnt.n);
  const cols = db.prepare(`PRAGMA table_info(pending_bookings)`).all();
  console.log('Columns:', cols.map(c => c.name).join(', '));
} catch (e) { console.log('ERR:', e.message); }

db.close();
JS
node tmp.js; rm -f tmp.js

echo ""
echo "=== 9. OTA sync cron logs (24h gần nhất) ==="
pm2 logs vp-mkt --raw --lines 500 --nostream 2>&1 | grep -iE 'ota-sync|runBookingSync|runFullSync|availability|etl' | tail -15

echo ""
echo "=== 10. ota-sync.ts service ==="
grep -E 'export async function|runBookingSync|runFullSync|availability' dist/services/ota-sync.js 2>/dev/null | head -20
"""

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, username="root", password=PASSWORD, timeout=15)
_, stdout, stderr = client.exec_command(CMD, timeout=45)
print(stdout.read().decode("utf-8", errors="replace"))
err = stderr.read().decode("utf-8", errors="replace")
if err.strip(): print("STDERR:\n" + err, file=sys.stderr)
client.close()

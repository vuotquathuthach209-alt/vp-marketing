"""Debug: star_rating đã bị thay đổi — tìm nguyên nhân."""
import sys, os, paramiko
try: sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except: pass

HOST = "103.82.193.74"
PASSWORD = sys.argv[1] if len(sys.argv) > 1 else ""

CMD = r"""
cd /opt/vp-marketing

echo '=== 1. Current star_rating + source ==='
cat > tmp.js <<'JS'
const Database = require('better-sqlite3');
const db = new Database('data/db.sqlite');
console.log('hotel_profile:');
const hp = db.prepare(`
  SELECT hotel_id, name_canonical, star_rating, data_source, scraped_at, synthesized_at,
         manual_override, version, datetime(updated_at/1000, 'unixepoch', '+7 hours') as updated
  FROM hotel_profile WHERE star_rating IS NOT NULL OR name_canonical LIKE '%Sonder%' OR name_canonical LIKE '%Seehome%'
  ORDER BY hotel_id
`).all();
hp.forEach(r => console.log(JSON.stringify(r)));

console.log('\nmkt_hotels_cache:');
const mh = db.prepare(`SELECT ota_hotel_id, name, star_rating, updated_at FROM mkt_hotels_cache`).all();
mh.forEach(r => console.log(JSON.stringify(r)));

console.log('\nmkt_rooms_cache (star_rating không có — chỉ kiểm):');
const mr = db.prepare(`SELECT ota_hotel_id, name, base_price FROM mkt_rooms_cache`).all();
mr.forEach(r => console.log(JSON.stringify(r)));

// OTA raw hotel data — check lần cuối đẩy về có star_rating bao nhiêu
console.log('\nOTA raw hotels (recent):');
try {
  const raw = db.prepare(`
    SELECT ota_id, substr(payload, 1, 500) as preview, status, received_at,
           datetime(received_at/1000, 'unixepoch', '+7 hours') as recv_at
    FROM ota_raw_hotels ORDER BY received_at DESC LIMIT 5
  `).all();
  raw.forEach(r => console.log(JSON.stringify(r)));
} catch (e) { console.log('(no ota_raw_hotels):', e.message); }

db.close();
JS
node tmp.js
rm -f tmp.js

echo
echo '=== 2. PM2 logs 24h qua — tìm update star_rating ==='
pm2 logs vp-mkt --raw --lines 500 --nostream 2>&1 | grep -iE "star|synthesized|classified|Sonder|Seehome" | tail -30

echo
echo '=== 3. Recent ingest logs (news-ingest hoặc scraper) ==='
pm2 logs vp-mkt --raw --lines 500 --nostream 2>&1 | grep -iE "scraper|synth|ingest" | tail -10
"""

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, username="root", password=PASSWORD, timeout=15)
_, stdout, stderr = client.exec_command(CMD, timeout=60)
print(stdout.read().decode("utf-8", errors="replace"))
err = stderr.read().decode("utf-8", errors="replace")
if err.strip(): print("STDERR:\n" + err, file=sys.stderr)
client.close()

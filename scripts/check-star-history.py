"""Check scraped_data + version history for star_rating."""
import sys, os, paramiko
try: sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except: pass

HOST = "103.82.193.74"
PASSWORD = sys.argv[1] if len(sys.argv) > 1 else ""

CMD = r"""
cd /opt/vp-marketing
cat > tmp.js <<'JS'
const Database = require('better-sqlite3');
const db = new Database('data/db.sqlite');

console.log('=== ALL hotel_profile (full) ===');
const all = db.prepare(`SELECT hotel_id, name_canonical, star_rating, data_source,
  datetime(scraped_at/1000, 'unixepoch', '+7 hours') as scraped_at,
  datetime(synthesized_at/1000, 'unixepoch', '+7 hours') as synth_at,
  version, manual_override
  FROM hotel_profile ORDER BY hotel_id`).all();
all.forEach(r => console.log(JSON.stringify(r)));

console.log('\n=== scraped_data raw cho Sonder Airport (#6) ===');
const row6 = db.prepare(`SELECT scraped_data FROM hotel_profile WHERE hotel_id = 6`).get();
if (row6?.scraped_data) {
  try {
    const parsed = JSON.parse(row6.scraped_data);
    console.log(JSON.stringify(parsed, null, 2).slice(0, 2000));
  } catch (e) { console.log('parse fail:', e.message); console.log(row6.scraped_data.slice(0, 500)); }
}

console.log('\n=== scraped_data raw cho Seehome Airport (#7) ===');
const row7 = db.prepare(`SELECT scraped_data FROM hotel_profile WHERE hotel_id = 7`).get();
if (row7?.scraped_data) {
  try {
    const parsed = JSON.parse(row7.scraped_data);
    console.log(JSON.stringify(parsed, null, 2).slice(0, 2000));
  } catch {}
}

console.log('\n=== OTA raw hotel recent (nếu có ghi đè qua ota-raw) ===');
try {
  const raw = db.prepare(`SELECT id, ota_id, substr(payload, 1, 800) as payload_preview, status,
    datetime(received_at/1000, 'unixepoch', '+7 hours') as recv_at
    FROM ota_raw_hotels ORDER BY received_at DESC LIMIT 10`).all();
  raw.forEach(r => console.log(JSON.stringify(r)));
} catch (e) { console.log('err:', e.message); }

console.log('\n=== Schema synth status: kiểm scheduler có đang ghi đè ===');
const schedInfo = db.prepare(`SELECT hotel_id, name_canonical, star_rating, version FROM hotel_profile WHERE name_canonical LIKE '%Sonder%' OR name_canonical LIKE '%Seehome%'`).all();
schedInfo.forEach(r => console.log(JSON.stringify(r)));

db.close();
JS
node tmp.js
rm -f tmp.js

echo
echo '=== Test live URL sondervn.com ==='
curl -s "https://sondervn.com/api/hotels" 2>&1 | head -c 2000 || echo "(fail)"
"""

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, username="root", password=PASSWORD, timeout=15)
_, stdout, stderr = client.exec_command(CMD, timeout=60)
print(stdout.read().decode("utf-8", errors="replace"))
err = stderr.read().decode("utf-8", errors="replace")
if err.strip(): print("STDERR:\n" + err, file=sys.stderr)
client.close()

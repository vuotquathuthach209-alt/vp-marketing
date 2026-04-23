"""End-to-end test Sync Hub: provision keys + seed + HMAC call + bot integration."""
import sys, hmac, hashlib, json, time, paramiko
try: sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except: pass

HOST = "103.82.193.74"
PASSWORD = sys.argv[1] if len(sys.argv) > 1 else ""

CMD = r"""
cd /opt/vp-marketing

echo "=== 1. Verify tables ==="
cat > tmp.js <<'JS'
const Database = require('better-sqlite3');
const db = new Database('data/db.sqlite');
['sync_api_keys', 'sync_availability', 'sync_bookings', 'sync_events_log'].forEach(t => {
  try {
    const cols = db.prepare(`PRAGMA table_info(${t})`).all();
    console.log('  ' + t + ': ' + cols.length + ' cols');
  } catch (e) { console.log('  ' + t + ': MISSING'); }
});
db.close();
JS
node tmp.js; rm -f tmp.js

echo ""
echo "=== 2. Provision API key for OTA team ==="
cat > tmp.js <<'JS'
const { provisionApiKey } = require('./dist/services/sync-hub');
const r = provisionApiKey('ota-web-prod', 'OTA Web Team', ['write_availability', 'read_bookings', 'write_bookings']);
console.log('key_id:', r.key_id);
console.log('secret:', r.secret);
// Save secret to file for test
require('fs').writeFileSync('/tmp/ota-secret.txt', r.secret);
console.log('Saved to /tmp/ota-secret.txt');

// Also provision bot-internal key
const bot = require('./dist/services/sync-hub').provisionApiKey('bot-internal', 'VP MKT Bot', ['*']);
require('fs').writeFileSync('/tmp/bot-secret.txt', bot.secret);
console.log('bot_secret saved');
JS
node tmp.js; rm -f tmp.js

echo ""
echo "=== 3. Seed test data (14 days, all hotels) ==="
cat > tmp.js <<'JS'
const { seedAvailability } = require('./dist/services/sync-hub-seed');
const r = seedAvailability({ days: 14 });
console.log('Seeded:', JSON.stringify(r));
JS
node tmp.js; rm -f tmp.js

echo ""
echo "=== 4. Verify seed data ==="
cat > tmp.js <<'JS'
const Database = require('better-sqlite3');
const db = new Database('data/db.sqlite');
const total = db.prepare(`SELECT COUNT(*) as n FROM sync_availability`).get();
console.log('Total availability rows:', total.n);
const byHotel = db.prepare(`SELECT hotel_id, COUNT(*) as n, MIN(date_str) as from_date, MAX(date_str) as to_date FROM sync_availability GROUP BY hotel_id`).all();
byHotel.forEach(h => console.log('  hotel #' + h.hotel_id + ': ' + h.n + ' rows (' + h.from_date + ' → ' + h.to_date + ')'));
const peak = db.prepare(`SELECT date_str, SUM(available_rooms) as avail, SUM(total_rooms) as total FROM sync_availability WHERE date_str IN ('2026-04-30', '2026-05-01', '2026-05-02') GROUP BY date_str`).all();
console.log('Peak dates:');
peak.forEach(p => console.log('  ' + p.date_str + ': ' + p.avail + '/' + p.total + ' available'));
db.close();
JS
node tmp.js; rm -f tmp.js

echo ""
echo "=== 5. HMAC test: OTA push availability (from localhost) ==="
SECRET=$(cat /tmp/ota-secret.txt)
TS=$(date +%s)
BODY='{"hotel_id":6,"room_type_code":"TEST_ROOM","date_str":"2026-04-25","total_rooms":5,"available_rooms":3,"base_price":900000}'
SIG=$(echo -n "$BODY" | openssl dgst -sha256 -hmac "$SECRET" | awk '{print "sha256="$2}')
echo "Signature: $SIG"
curl -s -X POST http://127.0.0.1:3000/api/sync/availability \
  -H "Content-Type: application/json" \
  -H "X-Key-Id: ota-web-prod" \
  -H "X-Signature: $SIG" \
  -H "X-Timestamp: $TS" \
  -d "$BODY"
echo ""

echo ""
echo "=== 6. Query availability (should find TEST_ROOM) ==="
BODY2=''
SIG2=$(echo -n "$BODY2" | openssl dgst -sha256 -hmac "$SECRET" | awk '{print "sha256="$2}')
curl -s "http://127.0.0.1:3000/api/sync/availability?hotel_id=6&date_str=2026-04-25" \
  -H "X-Key-Id: ota-web-prod" \
  -H "X-Signature: $SIG2" \
  -H "X-Timestamp: $TS"
echo ""

echo ""
echo "=== 7. Test bad HMAC should fail ==="
curl -s -X POST http://127.0.0.1:3000/api/sync/availability \
  -H "Content-Type: application/json" \
  -H "X-Key-Id: ota-web-prod" \
  -H "X-Signature: sha256=badbad" \
  -H "X-Timestamp: $TS" \
  -d "$BODY" -w "\nHTTP: %{http_code}\n"

echo ""
echo "=== 8. Docs page ==="
curl -s -o /dev/null -w "HTTP: %{http_code}, size: %{size_download} bytes\n" http://127.0.0.1:3000/sync-hub/docs

echo ""
echo "=== 9. Events log (audit) ==="
cat > tmp.js <<'JS'
const Database = require('better-sqlite3');
const db = new Database('data/db.sqlite');
const events = db.prepare(`SELECT event_type, actor, http_status, error, hmac_verified, duration_ms FROM sync_events_log ORDER BY id DESC LIMIT 10`).all();
events.forEach(e => console.log('  ' + e.event_type + ' | actor=' + (e.actor||'-') + ' | http=' + e.http_status + ' | hmac=' + e.hmac_verified + (e.error ? ' | ERR: ' + e.error : '') + ' | ' + e.duration_ms + 'ms'));
db.close();
JS
node tmp.js; rm -f tmp.js
"""

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, username="root", password=PASSWORD, timeout=15)
_, stdout, stderr = client.exec_command(CMD, timeout=240)
print(stdout.read().decode("utf-8", errors="replace"))
err = stderr.read().decode("utf-8", errors="replace")
if err.strip(): print("STDERR:\n" + err, file=sys.stderr)
client.close()

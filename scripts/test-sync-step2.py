"""Test sync hub step 2: HMAC push + bot availability filter."""
import sys, paramiko
try: sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except: pass

HOST = "103.82.193.74"
PASSWORD = sys.argv[1] if len(sys.argv) > 1 else ""

CMD = r"""
cd /opt/vp-marketing

echo "=== HMAC test: OTA push availability ==="
SECRET=$(cat /tmp/ota-secret.txt)
TS=$(date +%s)
BODY='{"hotel_id":6,"room_type_code":"TEST_PUSH","date_str":"2026-04-25","total_rooms":5,"available_rooms":3,"base_price":900000}'
SIG="sha256=$(echo -n "$BODY" | openssl dgst -sha256 -hmac "$SECRET" -hex | awk '{print $NF}')"
echo "Signature: $SIG"
echo ""
curl -s -X POST http://127.0.0.1:3000/api/sync/availability \
  -H "Content-Type: application/json" \
  -H "X-Key-Id: ota-web-prod" \
  -H "X-Signature: $SIG" \
  -H "X-Timestamp: $TS" \
  -d "$BODY" -w "\nHTTP: %{http_code}\n"

echo ""
echo "=== Test bad HMAC (should 401) ==="
curl -s -X POST http://127.0.0.1:3000/api/sync/availability \
  -H "Content-Type: application/json" \
  -H "X-Key-Id: ota-web-prod" \
  -H "X-Signature: sha256=badbadbad" \
  -H "X-Timestamp: $TS" \
  -d "$BODY" -w "\nHTTP: %{http_code}\n"

echo ""
echo "=== Docs page ==="
curl -s -o /dev/null -w "HTTP: %{http_code}, size: %{size_download} bytes\n" http://127.0.0.1:3000/sync-hub/docs

echo ""
echo "=== Check inserted push row ==="
cat > tmp.js <<'JS'
const Database = require('better-sqlite3');
const db = new Database('data/db.sqlite');
const pushed = db.prepare(`SELECT * FROM sync_availability WHERE room_type_code = 'TEST_PUSH'`).all();
pushed.forEach(p => console.log(JSON.stringify(p)));
const events = db.prepare(`SELECT event_type, actor, http_status, hmac_verified, duration_ms, error FROM sync_events_log ORDER BY id DESC LIMIT 5`).all();
console.log('\nEvents:');
events.forEach(e => console.log('  ' + e.event_type + ' | ' + (e.actor||'-') + ' | http=' + e.http_status + ' hmac=' + e.hmac_verified + (e.error ? ' ERR: ' + e.error : '') + ' | ' + (e.duration_ms||0) + 'ms'));
db.close();
JS
node tmp.js; rm -f tmp.js
"""

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, username="root", password=PASSWORD, timeout=15)
_, stdout, stderr = client.exec_command(CMD, timeout=60)
print(stdout.read().decode("utf-8", errors="replace"))
err = stderr.read().decode("utf-8", errors="replace")
if err.strip(): print("STDERR:\n" + err, file=sys.stderr)
client.close()

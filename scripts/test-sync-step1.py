"""Test sync hub step 1: tables + provision keys + seed."""
import sys, paramiko
try: sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except: pass

HOST = "103.82.193.74"
PASSWORD = sys.argv[1] if len(sys.argv) > 1 else ""

CMD = r"""
cd /opt/vp-marketing

echo "=== Verify tables ==="
cat > tmp.js <<'JS'
const Database = require('better-sqlite3');
const db = new Database('data/db.sqlite');
['sync_api_keys', 'sync_availability', 'sync_bookings', 'sync_events_log'].forEach(t => {
  const cols = db.prepare(`PRAGMA table_info(${t})`).all();
  console.log('  ' + t + ': ' + cols.length + ' cols');
});
db.close();
JS
node tmp.js; rm -f tmp.js

echo ""
echo "=== Provision keys ==="
cat > tmp.js <<'JS'
const { provisionApiKey } = require('./dist/services/sync-hub');
const r = provisionApiKey('ota-web-prod', 'OTA Web Team', ['write_availability', 'read_bookings', 'write_bookings']);
require('fs').writeFileSync('/tmp/ota-secret.txt', r.secret);
console.log('ota-web-prod:', r.secret.slice(0, 16) + '...');

const bot = provisionApiKey('bot-internal', 'VP MKT Bot', ['*']);
require('fs').writeFileSync('/tmp/bot-secret.txt', bot.secret);
console.log('bot-internal:', bot.secret.slice(0, 16) + '...');
JS
node tmp.js; rm -f tmp.js

echo ""
echo "=== Seed test data ==="
cat > tmp.js <<'JS'
const t0 = Date.now();
const { seedAvailability } = require('./dist/services/sync-hub-seed');
const r = seedAvailability({ days: 14 });
console.log('Elapsed:', Date.now() - t0, 'ms');
console.log(JSON.stringify(r));
JS
node tmp.js; rm -f tmp.js

echo ""
echo "=== Verify seed ==="
cat > tmp.js <<'JS'
const Database = require('better-sqlite3');
const db = new Database('data/db.sqlite');
const total = db.prepare(`SELECT COUNT(*) as n FROM sync_availability`).get();
console.log('Total rows:', total.n);
const byHotel = db.prepare(`SELECT hotel_id, COUNT(*) as n FROM sync_availability GROUP BY hotel_id`).all();
byHotel.forEach(h => console.log('  hotel #' + h.hotel_id + ': ' + h.n + ' rows'));
db.close();
JS
node tmp.js; rm -f tmp.js
"""

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, username="root", password=PASSWORD, timeout=15)
_, stdout, stderr = client.exec_command(CMD, timeout=120)
print(stdout.read().decode("utf-8", errors="replace"))
err = stderr.read().decode("utf-8", errors="replace")
if err.strip(): print("STDERR:\n" + err, file=sys.stderr)
client.close()

"""Test v18 proactive outreach: scan + queue + dry-run send."""
import sys, paramiko
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
['scheduled_outreach', 'outreach_rate_log'].forEach(t => {
  const cols = db.prepare(`PRAGMA table_info(${t})`).all();
  console.log('  ' + t + ': ' + cols.length + ' cols');
});
db.close();
JS
node tmp.js; rm -f tmp.js

echo ""
echo "=== 2. Scan opportunities (all 6 triggers) ==="
cat > tmp.js <<'JS'
const { scanAndQueueOutreach } = require('./dist/services/proactive-outreach');
const results = scanAndQueueOutreach(1);
results.forEach(r => {
  console.log('  ' + r.trigger_type + ': candidates=' + r.candidates + ' queued=' + r.queued + ' dup=' + r.skipped_duplicate);
});
const total = results.reduce((s, r) => s + r.queued, 0);
console.log('Total queued: ' + total);
JS
node tmp.js; rm -f tmp.js

echo ""
echo "=== 3. Queue status ==="
cat > tmp.js <<'JS'
const Database = require('better-sqlite3');
const db = new Database('data/db.sqlite');
const rows = db.prepare(`SELECT trigger_type, status, sender_id, customer_phone, substr(message_content, 1, 80) as preview, scheduled_at FROM scheduled_outreach ORDER BY id DESC LIMIT 10`).all();
rows.forEach(r => {
  const time = new Date(r.scheduled_at).toISOString().slice(0, 16);
  console.log('  [' + r.status + '] ' + r.trigger_type + ' → ' + (r.sender_id || r.customer_phone) + ' @ ' + time);
  console.log('    "' + r.preview + '..."');
});

const stats = db.prepare(`SELECT trigger_type, status, COUNT(*) as n FROM scheduled_outreach GROUP BY trigger_type, status`).all();
console.log('\nStats:');
stats.forEach(s => console.log('  ' + s.trigger_type + '/' + s.status + ': ' + s.n));
db.close();
JS
node tmp.js; rm -f tmp.js

echo ""
echo "=== 4. Dry-run send (don't actually send) ==="
cat > tmp.js <<'JS'
const { sendQueuedOutreach } = require('./dist/services/proactive-outreach');
sendQueuedOutreach({ dryRun: true, limit: 5 }).then(r => {
  console.log(JSON.stringify(r));
}).catch(e => console.log('ERR:', e.message));
JS
node tmp.js; rm -f tmp.js

echo ""
echo "=== 5. Admin route /api/outreach/triggers via curl (login first) ==="
TOKEN=$(curl -s -X POST http://127.0.0.1:3000/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"password":"change-me-now"}' \
  -c /tmp/cookie.txt 2>/dev/null)
echo "Login result snippet: $(echo $TOKEN | head -c 80)"

curl -s -b /tmp/cookie.txt http://127.0.0.1:3000/api/outreach/triggers | node -e 'process.stdin.on("data", d => { try { const j = JSON.parse(d); (j.items || []).forEach(t => console.log("  " + t.type + " — " + t.description)); } catch(e) { console.log("Response:", d.toString().slice(0, 200)); } })'
rm -f /tmp/cookie.txt
"""

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, username="root", password=PASSWORD, timeout=15)
_, stdout, stderr = client.exec_command(CMD, timeout=90)
print(stdout.read().decode('utf-8', errors='replace'))
err = stderr.read().decode('utf-8', errors='replace')
if err.strip(): print('STDERR:', err[:600])
client.close()

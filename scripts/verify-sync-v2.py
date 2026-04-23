"""Verify Sync Coordinator v2 deploy: tables + outbox + webhook endpoints."""
import sys, paramiko
try: sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except: pass
HOST = "103.82.193.74"
PASSWORD = sys.argv[1] if len(sys.argv) > 1 else ""

CMD = r"""
cd /opt/vp-marketing

echo "=== 1. Files compiled ==="
ls -la dist/services/sync-outbox.js dist/services/sync-webhook.js dist/services/sync-conflict-resolver.js dist/services/sync-canonical-mapper.js 2>&1 | head -10

echo ""
echo "=== 2. New tables created ==="
cat > tmp.js <<'JS'
const Database = require('better-sqlite3');
const db = new Database('data/db.sqlite');
['sync_outbox', 'sync_webhook_inbound', 'sync_conflicts'].forEach(t => {
  try {
    const cols = db.prepare(`PRAGMA table_info(${t})`).all();
    console.log(t + ': ' + cols.length + ' columns');
  } catch (e) { console.log(t + ' ERROR: ' + e.message); }
});
db.close();
JS
node tmp.js; rm -f tmp.js

echo ""
echo "=== 3. Scheduler lines referencing outbox ==="
grep -c 'outbox' dist/services/scheduler.js

echo ""
echo "=== 4. Route endpoints ==="
grep -c -E "webhook/:event|/outbox|/dlq|/conflicts|/status" dist/routes/sync-hub.js

echo ""
echo "=== 5. Canonical mapper location hierarchy ==="
grep -c -E "location_keywords|landmarks_nearby|district_norm" dist/services/sync-canonical-mapper.js

echo ""
echo "=== 6. Outbox worker first tick ==="
pm2 logs vp-mkt --lines 100 --nostream 2>&1 | grep -iE 'outbox|sync' | tail -5

echo ""
echo "=== 7. Test /api/sync/status needs auth (expect 401) ==="
curl -s -o /dev/null -w "%{http_code}" https://mkt.sondervn.com/api/sync/status
echo ""
"""

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, username="root", password=PASSWORD, timeout=15)
_, stdout, stderr = client.exec_command(CMD, timeout=60)
print(stdout.read().decode('utf-8', errors='replace'))
err = stderr.read().decode('utf-8', errors='replace')
if err.strip(): print('STDERR:', err[:500])
client.close()

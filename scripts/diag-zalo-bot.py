"""Diagnose Zalo bot not responding."""
import sys, paramiko
try: sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except: pass
HOST = "103.82.193.74"
PASSWORD = sys.argv[1] if len(sys.argv) > 1 else ""

CMD = r"""
cd /opt/vp-marketing

echo "=== 1. PM2 status (service running?) ==="
pm2 list 2>&1 | head -20
echo ""
pm2 describe vp-mkt 2>&1 | grep -E 'status|uptime|restart|memory' | head -10

echo ""
echo "=== 2. Zalo OA config ==="
cat > tmp.js <<'JS'
const Database = require('better-sqlite3');
const db = new Database('data/db.sqlite');
try {
  const oas = db.prepare(`SELECT oa_id, oa_name, hotel_id, LENGTH(access_token) as token_len, LENGTH(refresh_token) as refresh_len, expires_at, updated_at FROM zalo_oa`).all();
  console.log('Zalo OAs:', oas.length);
  oas.forEach(o => {
    const exp = o.expires_at ? new Date(o.expires_at).toISOString() : '?';
    const age_h = o.expires_at ? ((o.expires_at - Date.now()) / 3600000).toFixed(1) : '?';
    console.log('  oa=' + o.oa_id + ' name=' + o.oa_name + ' hotel=' + o.hotel_id + ' token_len=' + o.token_len + ' refresh_len=' + o.refresh_len);
    console.log('    expires_at=' + exp + ' (in ' + age_h + 'h)');
  });
} catch (e) { console.log('ERR:', e.message); }
db.close();
JS
node tmp.js; rm -f tmp.js

echo ""
echo "=== 3. Hotel bot_paused_until ==="
cat > tmp.js <<'JS'
const Database = require('better-sqlite3');
const db = new Database('data/db.sqlite');
const hotels = db.prepare(`SELECT id, name, bot_paused_until, bot_pause_reason FROM mkt_hotels WHERE bot_paused_until IS NOT NULL`).all();
if (hotels.length === 0) console.log('  No hotels paused ✅');
else hotels.forEach(h => console.log('  hotel #' + h.id + ' ' + h.name + ' paused until ' + new Date(h.bot_paused_until).toISOString() + ' reason=' + h.bot_pause_reason));
db.close();
JS
node tmp.js; rm -f tmp.js

echo ""
echo "=== 4. Recent Zalo webhook events (last hour) ==="
pm2 logs vp-mkt --raw --lines 500 --nostream 2>&1 | grep -iE 'zalo.*event|zalo.*webhook|zalo.*fail|zalo.*error' | tail -20

echo ""
echo "=== 5. Zalo send text attempts (recent) ==="
pm2 logs vp-mkt --raw --lines 500 --nostream 2>&1 | grep -iE 'zaloSend|zalo.*send|Error.*zalo' | tail -15

echo ""
echo "=== 6. Recent conversations với Zalo sender ==="
cat > tmp.js <<'JS'
const Database = require('better-sqlite3');
const db = new Database('data/db.sqlite');
const last1h = Date.now() - 3600000;
const convs = db.prepare(`SELECT sender_id, role, substr(message, 1, 100) as msg, intent, datetime(created_at/1000, 'unixepoch', '+7 hours') as when_vn FROM conversation_memory WHERE sender_id LIKE 'zalo:%' AND created_at > ? ORDER BY id DESC LIMIT 20`).all(last1h);
console.log('Zalo conversations last 1h:', convs.length);
convs.forEach(c => console.log('  ' + c.when_vn + ' ' + c.sender_id + ' [' + c.role + '/' + (c.intent||'-') + ']: ' + c.msg));
db.close();
JS
node tmp.js; rm -f tmp.js

echo ""
echo "=== 7. Test Zalo OA token fresh? ==="
cat > tmp.js <<'JS'
(async () => {
  const axios = require('axios');
  const Database = require('better-sqlite3');
  const db = new Database('data/db.sqlite');
  const oas = db.prepare(`SELECT oa_id, access_token FROM zalo_oa LIMIT 5`).all();
  for (const oa of oas) {
    try {
      // Call /getoa API để test token
      const r = await axios.get('https://openapi.zalo.me/v2.0/oa/getoa', {
        headers: { access_token: oa.access_token },
        timeout: 10000,
      });
      console.log('  oa=' + oa.oa_id + ' token: ' + (r.data?.error === 0 ? '✅ VALID' : ('❌ ' + JSON.stringify(r.data))));
    } catch (e) {
      console.log('  oa=' + oa.oa_id + ' token test FAIL: ' + (e.response?.data?.message || e.message));
    }
  }
  db.close();
})();
JS
node tmp.js; rm -f tmp.js

echo ""
echo "=== 8. Webhook last received (from logs) ==="
pm2 logs vp-mkt --raw --lines 1000 --nostream 2>&1 | grep -E 'zalo.*event=|webhook.*zalo' | tail -10

echo ""
echo "=== 9. Node crashes? ==="
pm2 logs vp-mkt --raw --lines 300 --nostream --err 2>&1 | tail -20
"""

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, username="root", password=PASSWORD, timeout=15)
_, stdout, stderr = client.exec_command(CMD, timeout=60)
print(stdout.read().decode('utf-8', errors='replace'))
err = stderr.read().decode('utf-8', errors='replace')
if err.strip(): print('STDERR:', err[:500])
client.close()

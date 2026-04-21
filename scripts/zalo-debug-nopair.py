"""Debug why bot không reply khi user chat OA Zalo."""
import sys, os, paramiko
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception: pass

HOST = "103.82.193.74"; USER = "root"
PASSWORD = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("VPS_PASSWORD", "")

CMD = r"""
cd /opt/vp-marketing

echo '=== Webhook events 10 phút gần nhất ==='
pm2 logs vp-mkt --raw --lines 300 --nostream 2>&1 | grep -iE 'zalo|webhook' | tail -30

echo ''
echo '=== DB check ==='
cat > tmp-debug.js <<'JS'
const Database = require('better-sqlite3');
const db = new Database('data/db.sqlite');

console.log('--- Last 15 Zalo messages ---');
const msgs = db.prepare(`
  SELECT id, sender_id, role, substr(message, 1, 100) as msg, intent, created_at
  FROM conversation_memory
  WHERE sender_id LIKE 'zalo:%' AND sender_id NOT LIKE 'zalo:zalo_sim_%'
  ORDER BY id DESC LIMIT 15
`).all();
if (!msgs.length) console.log('  (no real Zalo messages yet)');
else msgs.forEach(m => {
  const dt = new Date(m.created_at).toLocaleString('vi-VN');
  console.log('#' + m.id + ' [' + dt + '] ' + m.sender_id + ' ' + m.role + ': ' + (m.msg || '(empty)') + ' intent=' + (m.intent || '-'));
});

console.log('');
console.log('--- Paused Zalo senders ---');
try {
  const paused = db.prepare("SELECT sender_id, hotel_id, bot_paused, updated_at FROM guest_profiles WHERE sender_id LIKE 'zalo:%' AND bot_paused = 1").all();
  console.log(JSON.stringify(paused, null, 2));
} catch (e) { console.log('(no bot_paused column):', e.message); }

console.log('');
console.log('--- zalo_oa ---');
const oa = db.prepare('SELECT id, hotel_id, oa_id, oa_name, enabled, token_expires_at FROM zalo_oa').all();
oa.forEach(r => console.log(JSON.stringify(r)));
const now = Date.now();
if (oa[0] && oa[0].token_expires_at) {
  const hoursLeft = ((oa[0].token_expires_at - now) / 3600000).toFixed(1);
  console.log('Token expires in ' + hoursLeft + 'h');
}

db.close();
JS
node tmp-debug.js
rm -f tmp-debug.js
"""

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, username=USER, password=PASSWORD, timeout=15, look_for_keys=False, allow_agent=False)
stdin, stdout, stderr = client.exec_command(CMD, timeout=60)
print(stdout.read().decode("utf-8", errors="replace"))
err = stderr.read().decode("utf-8", errors="replace")
if err.strip(): print("STDERR:\n" + err, file=sys.stderr)
client.close()

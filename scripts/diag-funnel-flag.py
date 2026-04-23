"""Check FSM flag status on VPS."""
import sys, paramiko
try: sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except: pass
HOST = "103.82.193.74"
PASSWORD = sys.argv[1] if len(sys.argv) > 1 else ""

CMD = r"""
cd /opt/vp-marketing
echo "=== 1. .env has USE_NEW_FUNNEL? ==="
grep -E "USE_NEW_FUNNEL" .env 2>/dev/null || echo "NOT SET"

echo ""
echo "=== 2. funnel_enabled_override in DB? ==="
cat > tmp_chk.js <<'JS'
process.chdir('/opt/vp-marketing');
const Database = require('better-sqlite3');
const db = new Database('data/db.sqlite');
const r = db.prepare(`SELECT value FROM settings WHERE key = 'funnel_enabled_override'`).get();
console.log('funnel_enabled_override:', r ? r.value : 'NOT SET');

// Also check pending_bookings stuck
const stuck = db.prepare(`SELECT id, fb_sender_id, status, datetime(created_at/1000, 'unixepoch', '+7 hours') as created_vn FROM pending_bookings WHERE status IN ('awaiting_transfer', 'awaiting_confirm') ORDER BY id DESC LIMIT 10`).all();
console.log('\nStuck pending_bookings:', stuck.length);
stuck.forEach(b => console.log('  #' + b.id + ' sender=' + b.fb_sender_id + ' status=' + b.status + ' created=' + b.created_vn));

// Check bot_conversation_state stuck too
const states = db.prepare(`SELECT sender_id, stage, datetime(updated_at/1000, 'unixepoch', '+7 hours') as updated_vn, (strftime('%s','now')*1000 - updated_at)/60000 as age_min FROM bot_conversation_state ORDER BY updated_at DESC LIMIT 5`).all();
console.log('\nRecent FSM states:');
states.forEach(s => console.log('  ' + s.sender_id + ' stage=' + s.stage + ' updated=' + s.updated_vn + ' age=' + s.age_min + 'min'));

db.close();
JS
node tmp_chk.js; rm -f tmp_chk.js

echo ""
echo "=== 3. Recent auto_reply_log (chào bạn responses) ==="
cat > tmp_chk2.js <<'JS'
process.chdir('/opt/vp-marketing');
const Database = require('better-sqlite3');
const db = new Database('data/db.sqlite');
const rows = db.prepare(`SELECT datetime(created_at/1000, 'unixepoch', '+7 hours') as time_vn, substr(original_text, 1, 30) as orig, substr(reply_text, 1, 80) as reply FROM auto_reply_log ORDER BY id DESC LIMIT 10`).all();
rows.forEach(r => console.log('  ' + r.time_vn + ' q="' + r.orig + '" a="' + r.reply + '"'));
db.close();
JS
node tmp_chk2.js; rm -f tmp_chk2.js
"""

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, username="root", password=PASSWORD, timeout=15)
_, stdout, stderr = client.exec_command(CMD, timeout=60)
print(stdout.read().decode('utf-8', errors='replace'))
err = stderr.read().decode('utf-8', errors='replace')
if err.strip(): print('STDERR:', err[:500])
client.close()

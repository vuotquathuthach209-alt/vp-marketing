"""Unpause bot + verify."""
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

console.log('Before:');
const before = db.prepare(`SELECT id, name, bot_paused_until, bot_pause_reason, datetime(bot_paused_until/1000, 'unixepoch', '+7 hours') as until_at FROM mkt_hotels WHERE bot_paused_until IS NOT NULL`).all();
before.forEach(r => console.log(`  #${r.id} ${r.name} paused_until=${r.until_at} reason=${r.bot_pause_reason}`));

// Unpause ALL
const r = db.prepare(`UPDATE mkt_hotels SET bot_paused_until = NULL, bot_pause_reason = NULL`).run();
console.log(`Unpaused ${r.changes} hotels`);

console.log('\nAfter:');
const after = db.prepare(`SELECT id, name, bot_paused_until FROM mkt_hotels WHERE bot_paused_until IS NOT NULL`).all();
if (after.length === 0) console.log('  All hotels unpaused ✅');
else after.forEach(r => console.log(`  #${r.id} still paused`));

db.close();
JS
node tmp.js
rm -f tmp.js
"""

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, username="root", password=PASSWORD, timeout=15)
_, stdout, stderr = client.exec_command(CMD, timeout=30)
print(stdout.read().decode("utf-8", errors="replace"))
err = stderr.read().decode("utf-8", errors="replace")
if err.strip(): print("STDERR:\n" + err, file=sys.stderr)
client.close()

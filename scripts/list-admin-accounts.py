"""List admin accounts to know who can login."""
import sys, paramiko
try: sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except: pass
HOST = "103.82.193.74"
PASSWORD = sys.argv[1] if len(sys.argv) > 1 else ""

CMD = r"""
cd /opt/vp-marketing
cat > /opt/vp-marketing/_tmp_list.js <<'JS'
process.chdir('/opt/vp-marketing');
const Database = require('better-sqlite3');
const db = new Database('data/db.sqlite');

console.log('=== User tables in DB ===');
const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND (name LIKE '%user%' OR name = 'auth' OR name = 'admin')`).all();
for (const t of tables) console.log('  ' + t.name);

console.log('\n=== Schema of mkt_users ===');
try {
  const cols = db.prepare(`PRAGMA table_info(mkt_users)`).all();
  for (const c of cols) console.log(`  ${c.name}: ${c.type}`);
} catch (e) { console.log('  no table'); }

console.log('\n=== Existing admin accounts ===');
try {
  const users = db.prepare(`SELECT id, email, role, hotel_id, status, created_at FROM mkt_users ORDER BY id`).all();
  console.log('Total: ' + users.length);
  for (const u of users) {
    const created = u.created_at ? new Date(u.created_at).toLocaleString('vi-VN') : '—';
    console.log(`  #${u.id} | ${u.email} | role=${u.role} | hotel=${u.hotel_id} | ${u.status} | ${created}`);
  }
} catch (e) { console.log('  err: ' + e.message); }

console.log('\n=== Check auth cookies/sessions table if any ===');
const otherTables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all();
for (const t of otherTables) {
  if (t.name.match(/session|auth|login/i)) console.log('  ' + t.name);
}

db.close();
JS

node /opt/vp-marketing/_tmp_list.js
rm /opt/vp-marketing/_tmp_list.js
"""

c = paramiko.SSHClient()
c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
c.connect(HOST, username="root", password=PASSWORD, timeout=20)
_, out, err = c.exec_command(CMD, timeout=30)
print(out.read().decode('utf-8', errors='replace'))
e = err.read().decode('utf-8', errors='replace')
if e.strip(): print('--STDERR--'); print(e[:500])
c.close()

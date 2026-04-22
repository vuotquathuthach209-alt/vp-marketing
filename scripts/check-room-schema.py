"""Check hotel_room_catalog schema."""
import sys, os, paramiko
try: sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except: pass
HOST = "103.82.193.74"
PASSWORD = sys.argv[1] if len(sys.argv) > 1 else ""
c = paramiko.SSHClient()
c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
c.connect(HOST, username="root", password=PASSWORD, timeout=15)
CMD = r"""
cd /opt/vp-marketing
cat > tmp.js <<'JS'
const Database = require('better-sqlite3');
const db = new Database('data/db.sqlite');
console.log('hotel_room_catalog columns:');
const cols = db.prepare("PRAGMA table_info(hotel_room_catalog)").all();
cols.forEach(c => console.log('  ' + c.name + ' ' + c.type));
db.close();
JS
node tmp.js
rm -f tmp.js
"""
_, stdout, _ = c.exec_command(CMD, timeout=30)
print(stdout.read().decode("utf-8", errors="replace"))
c.close()

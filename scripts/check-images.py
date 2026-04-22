"""Check room_images on VPS."""
import sys, paramiko
try: sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except: pass

HOST = "103.82.193.74"
PASSWORD = sys.argv[1] if len(sys.argv) > 1 else ""

CMD = r"""
cd /opt/vp-marketing
cat > tmp.js <<'JS'
const Database = require('better-sqlite3');
const db = new Database('data/db.sqlite');
// Check if table exists
const t = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='room_images'`).get();
console.log('room_images exists:', !!t);
if (t) {
  const cols = db.prepare(`PRAGMA table_info(room_images)`).all();
  console.log('cols:', cols.map(c => c.name).join(', '));
  const cnt = db.prepare(`SELECT COUNT(*) as n FROM room_images`).get();
  console.log('total rows:', cnt.n);
  const active = db.prepare(`SELECT COUNT(*) as n FROM room_images WHERE active = 1`).get();
  console.log('active rows:', active.n);
  const sample = db.prepare(`SELECT image_url, room_type_name, hotel_id FROM room_images LIMIT 3`).all();
  sample.forEach(s => console.log('sample:', JSON.stringify(s)));
}
db.close();
JS
node tmp.js; rm -f tmp.js
"""

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, username="root", password=PASSWORD, timeout=15)
_, stdout, stderr = client.exec_command(CMD, timeout=30)
print(stdout.read().decode("utf-8", errors="replace"))
err = stderr.read().decode("utf-8", errors="replace")
if err.strip(): print("STDERR:\n" + err, file=sys.stderr)
client.close()

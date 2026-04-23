"""Phase 0 cleanup: delete test data hotel_id=99."""
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
const r = db.prepare(`DELETE FROM hotel_room_catalog WHERE hotel_id = 99`).run();
console.log('Deleted test rooms hotel_id=99:', r.changes);
// Clean up orphan test senders
const s = db.prepare(`DELETE FROM bot_conversation_state WHERE sender_id LIKE 'zalo:%test%' OR sender_id LIKE 'zalo:d1_%' OR sender_id LIKE 'zalo:r5_%'`).run();
console.log('Cleaned test senders:', s.changes);
db.close();
JS
node tmp.js; rm -f tmp.js
"""
client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, username="root", password=PASSWORD, timeout=15)
_, stdout, stderr = client.exec_command(CMD, timeout=30)
print(stdout.read().decode("utf-8", errors="replace"))
client.close()

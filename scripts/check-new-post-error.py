"""Check recent failed posts + error msgs on VPS."""
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
console.log('=== Failed posts ===');
const failed = db.prepare(`SELECT id, page_id, status, error_message, substr(caption, 1, 80) as cap, scheduled_at, created_at FROM posts WHERE status IN ('failed', 'publishing', 'draft') ORDER BY id DESC LIMIT 20`).all();
failed.forEach(f => console.log(JSON.stringify(f)));
console.log('\n=== All latest posts with errors ===');
const all = db.prepare(`SELECT id, status, error_message FROM posts WHERE error_message IS NOT NULL ORDER BY id DESC LIMIT 10`).all();
all.forEach(a => console.log(JSON.stringify(a)));
db.close();
JS
node tmp.js; rm -f tmp.js

echo ""
echo "=== PM2 logs: recent publish errors ==="
pm2 logs vp-mkt --raw --lines 500 --nostream 2>&1 | grep -iE 'publish-now|FB.*error|failed|403|400' | tail -30
"""

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, username="root", password=PASSWORD, timeout=15)
_, stdout, stderr = client.exec_command(CMD, timeout=30)
print(stdout.read().decode("utf-8", errors="replace"))
err = stderr.read().decode("utf-8", errors="replace")
if err.strip(): print("STDERR:\n" + err, file=sys.stderr)
client.close()

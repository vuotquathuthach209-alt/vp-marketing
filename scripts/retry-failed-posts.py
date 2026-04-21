"""Reset failed posts back to 'scheduled' để scheduler publish lại ngay."""
import sys, os, paramiko
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception: pass

HOST = "103.82.193.74"; USER = "root"
PASSWORD = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("VPS_PASSWORD", "")

CMD = r"""
cd /opt/vp-marketing
cat > tmp.js <<'JS'
const Database = require('better-sqlite3');
const db = new Database('data/db.sqlite');

const now = Date.now();
// Reset failed posts: scheduled_at = now (để scheduler pick up ngay)
const r = db.prepare(`UPDATE posts SET status='scheduled', scheduled_at=?, error_message=NULL WHERE status='failed'`).run(now);
console.log(`✓ Reset ${r.changes} failed posts to 'scheduled'`);

// Show what we reset
const failed = db.prepare(`SELECT id, page_id, status, scheduled_at FROM posts WHERE status='scheduled' AND scheduled_at = ?`).all(now);
failed.forEach(p => console.log(`  #${p.id} page=${p.page_id} → sẽ publish trong < 1 phút`));

db.close();
JS
node tmp.js
rm -f tmp.js

echo
echo '=== Tailing logs 90s to watch scheduler pick up retries ==='
timeout 90 pm2 logs vp-mkt --raw --lines 0 2>&1 | grep -iE 'scheduler|post #|publishImage|fb_post_id' | head -20
"""

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, username=USER, password=PASSWORD, timeout=15, look_for_keys=False, allow_agent=False)
stdin, stdout, stderr = client.exec_command(CMD, timeout=120)
for line in iter(stdout.readline, ""):
    if line.strip(): print(line, end="", flush=True)
err = stderr.read().decode("utf-8", errors="replace")
if err.strip(): print("\nSTDERR:\n" + err, file=sys.stderr)
client.close()

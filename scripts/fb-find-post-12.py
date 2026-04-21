"""Find Post #12 and #13 references in logs + find root cause."""
import sys, os, paramiko
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception: pass

HOST = "103.82.193.74"; USER = "root"
PASSWORD = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("VPS_PASSWORD", "")

CMD = r"""
cd /opt/vp-marketing
echo '=== Search "Post #12" and "#13" in pm2 logs ==='
pm2 logs vp-mkt --raw --lines 500 --nostream 2>&1 | grep -iE 'post.*#1[23]|session has expired|Error validating' | tail -30

echo
echo '=== Any "Post #" pattern in recent logs ==='
pm2 logs vp-mkt --raw --lines 500 --nostream 2>&1 | grep -E 'Post #[0-9]+' | tail -15

echo
echo '=== Search in /root/.pm2/logs directly ==='
tail -500 /root/.pm2/logs/vp-mkt-*.log 2>&1 | grep -iE 'post.*#1[23]|session has expired|validating' | tail -30

echo
echo '=== news_post_drafts #12 and #13 details ==='
cat > tmp.js <<'JS'
const Database = require('better-sqlite3');
const db = new Database('data/db.sqlite');
const r = db.prepare(`SELECT id, status, fb_post_id, substr(draft_post,1,80) as preview, scheduled_at, published_at FROM news_post_drafts WHERE id IN (12, 13)`).all();
r.forEach(x => {
  const sch = x.scheduled_at ? new Date(x.scheduled_at).toLocaleString('vi-VN') : '-';
  const pub = x.published_at ? new Date(x.published_at).toLocaleString('vi-VN') : '-';
  console.log(`#${x.id} status=${x.status} fb=${x.fb_post_id || '-'}`);
  console.log(`  scheduled=${sch} published=${pub}`);
  console.log(`  preview: ${x.preview || '(empty)'}`);
});
db.close();
JS
node tmp.js
rm -f tmp.js
"""

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, username=USER, password=PASSWORD, timeout=15, look_for_keys=False, allow_agent=False)
stdin, stdout, stderr = client.exec_command(CMD, timeout=60)
print(stdout.read().decode("utf-8", errors="replace"))
err = stderr.read().decode("utf-8", errors="replace")
if err.strip(): print("STDERR:\n" + err, file=sys.stderr)
client.close()

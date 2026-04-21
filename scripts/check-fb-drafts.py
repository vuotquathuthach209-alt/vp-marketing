"""Check news_post_drafts schema + fail posts that should be retried now."""
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

console.log('=== news_post_drafts schema ===');
const cols = db.prepare("PRAGMA table_info(news_post_drafts)").all();
console.log(cols.map(c => `${c.name}:${c.type}`).join(', '));

console.log('\n=== Last 20 news_post_drafts ===');
const rows = db.prepare(`SELECT * FROM news_post_drafts ORDER BY id DESC LIMIT 20`).all();
rows.forEach(r => {
  console.log(`#${r.id} status=${r.status} fb_post_id=${r.fb_post_id || '-'} title="${(r.title || '').slice(0,60)}"`);
  // Show all error-like fields
  Object.keys(r).forEach(k => {
    if ((/err|fail|reason/i).test(k) && r[k]) {
      console.log(`  ${k}: ${String(r[k]).slice(0, 200)}`);
    }
  });
});

console.log('\n=== Scheduled status counts (news_post_drafts) ===');
const counts = db.prepare(`SELECT status, COUNT(*) as n FROM news_post_drafts GROUP BY status`).all();
counts.forEach(c => console.log(`  ${c.status}: ${c.n}`));

db.close();
JS
node tmp.js
rm -f tmp.js
"""

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, username=USER, password=PASSWORD, timeout=15, look_for_keys=False, allow_agent=False)
stdin, stdout, stderr = client.exec_command(CMD, timeout=30)
print(stdout.read().decode("utf-8", errors="replace"))
err = stderr.read().decode("utf-8", errors="replace")
if err.strip(): print("STDERR:\n" + err, file=sys.stderr)
client.close()

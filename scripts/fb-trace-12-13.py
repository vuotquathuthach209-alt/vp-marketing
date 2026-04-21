"""Trace exactly where Post #12 and #13 came from."""
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

console.log('=== sqlite_sequence for posts ===');
const seq = db.prepare("SELECT * FROM sqlite_sequence WHERE name IN ('posts','news_post_drafts','campaigns','post_metrics')").all();
console.log(JSON.stringify(seq, null, 2));

console.log('\n=== ALL posts (any status, limit 30) ===');
const all = db.prepare(`SELECT id, page_id, status, scheduled_at, published_at, substr(error_message,1,200) as err, created_at FROM posts ORDER BY id`).all();
all.forEach(p => {
  const sch = p.scheduled_at ? new Date(p.scheduled_at).toLocaleString('vi-VN') : '-';
  console.log(`#${p.id} page=${p.page_id} status=${p.status} sched=${sch}`);
  if (p.err) console.log(`  ERR: ${p.err.slice(0, 200)}`);
});

// Any other table with "Post #N" semantic?
console.log('\n=== campaigns (detail) ===');
const campCols = db.prepare("PRAGMA table_info(campaigns)").all();
console.log('cols:', campCols.map(c => c.name).join(', '));
const camp = db.prepare("SELECT * FROM campaigns ORDER BY id DESC LIMIT 15").all();
camp.forEach(c => {
  const keys = Object.keys(c).filter(k => c[k] !== null).slice(0, 8);
  console.log(`#${c.id} ${keys.map(k => `${k}=${String(c[k]).slice(0,40)}`).join(' ')}`);
});

// Check etl_sync_log or any notifier log
console.log('\n=== events table (last 20) ===');
try {
  const ev = db.prepare("SELECT * FROM events ORDER BY id DESC LIMIT 20").all();
  ev.forEach(e => {
    const keys = Object.keys(e).filter(k => e[k] !== null).slice(0, 6);
    console.log(`#${e.id} ${keys.map(k => `${k}=${String(e[k]).slice(0,60)}`).join(' ')}`);
  });
} catch (e) { console.log('err:', e.message); }

db.close();
JS
node tmp.js
rm -f tmp.js

echo
echo '=== All log files with "Session has expired" ==='
grep -l "Session has expired\|Post #1[23]" /root/.pm2/logs/*.log 2>/dev/null | head -5
echo
echo '=== Recent "Post #" entries in any log ==='
grep -E "Post #[0-9]+" /root/.pm2/logs/vp-mkt-*.log 2>/dev/null | tail -10
"""

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, username=USER, password=PASSWORD, timeout=15, look_for_keys=False, allow_agent=False)
stdin, stdout, stderr = client.exec_command(CMD, timeout=30)
print(stdout.read().decode("utf-8", errors="replace"))
err = stderr.read().decode("utf-8", errors="replace")
if err.strip(): print("STDERR:\n" + err, file=sys.stderr)
client.close()

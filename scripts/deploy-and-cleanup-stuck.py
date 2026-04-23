"""Deploy v24 hotfix + cleanup stuck pending_bookings on VPS."""
import sys, os, paramiko
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception: pass

HOST = "103.82.193.74"
USER = "root"
PASSWORD = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("VPS_PASSWORD", "")

CMD = """
set -e
cd /opt/vp-marketing

echo '=== 1. Git pull + build ==='
git pull --ff-only 2>&1 | tail -5
npm run build 2>&1 | tail -5

echo ''
echo '=== 2. Cleanup stuck pending_bookings (before restart) ==='
cat > tmp_cleanup.js <<'JS'
process.chdir('/opt/vp-marketing');
const Database = require('better-sqlite3');
const db = new Database('data/db.sqlite');
const now = Date.now();

// Identify stuck bookings
const stale = db.prepare(`
  SELECT id, fb_sender_id, status, updated_at,
    (? - updated_at) / 60000 as age_min
  FROM pending_bookings
  WHERE status IN ('collecting', 'quoting', 'awaiting_transfer', 'awaiting_confirm')
    AND (
      (status = 'collecting' AND updated_at < ? - 3600000) OR
      (status = 'quoting' AND updated_at < ? - 1800000) OR
      (status = 'awaiting_transfer' AND updated_at < ? - 21600000) OR
      (status = 'awaiting_confirm' AND updated_at < ? - 86400000)
    )
`).all(now, now, now, now, now);

console.log('Stuck bookings to clean:', stale.length);
stale.forEach(b => console.log('  #' + b.id + ' ' + b.fb_sender_id + ' status=' + b.status + ' age=' + Math.round(b.age_min) + 'min'));

if (stale.length > 0) {
  const result = db.prepare(`
    UPDATE pending_bookings
    SET status = 'cancelled', updated_at = ?
    WHERE id IN (` + stale.map(() => '?').join(',') + `)
  `).run(now, ...stale.map(b => b.id));
  console.log('Cancelled:', result.changes, 'booking(s)');
}

// Also reset FSM stale states
const fsmStale = db.prepare(`
  SELECT sender_id, stage, updated_at,
    (? - updated_at) / 60000 as age_min
  FROM bot_conversation_state
  WHERE updated_at < ? - 1800000
    AND stage NOT IN ('INIT')
`).all(now, now);
console.log('\\nStale FSM states:', fsmStale.length);
fsmStale.forEach(s => console.log('  ' + s.sender_id + ' stage=' + s.stage + ' age=' + Math.round(s.age_min) + 'min'));

if (fsmStale.length > 0) {
  const r2 = db.prepare(`
    UPDATE bot_conversation_state
    SET stage = 'INIT', slots = '{}', turns_since_extract = 0,
        turn_count = 0, same_stage_count = 0, handed_off = 0,
        last_bot_stage = stage, history_summary = 'cleaned by v24 hotfix',
        updated_at = ?
    WHERE sender_id IN (` + fsmStale.map(() => '?').join(',') + `)
  `).run(now, ...fsmStale.map(s => s.sender_id));
  console.log('Reset FSM states:', r2.changes);
}

db.close();
JS
node tmp_cleanup.js
rm -f tmp_cleanup.js

echo ''
echo '=== 3. PM2 restart ==='
pm2 restart vp-mkt 2>&1 | tail -3

sleep 3

echo ''
echo '=== 4. PM2 status ==='
pm2 list | grep vp-mkt

echo ''
echo '=== 5. Verify hotfix loaded (grep new strings in dist) ==='
grep -c 'isPureGreeting\\|PURE_GREETING_PATTERN\\|STALE_THRESHOLDS_MS\\|STALE_MS' dist/services/bookingflow.js
"""

if not PASSWORD:
    print("ERROR: password required", file=sys.stderr); sys.exit(1)

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
print(f"[deploy] {USER}@{HOST}", file=sys.stderr)
client.connect(HOST, username=USER, password=PASSWORD, timeout=15, look_for_keys=False, allow_agent=False)
stdin, stdout, stderr = client.exec_command(CMD, timeout=240)
print(stdout.read().decode("utf-8", errors="replace"))
err = stderr.read().decode("utf-8", errors="replace")
if err.strip(): print("STDERR:", err[:1500], file=sys.stderr)
print(f"[deploy] exit {stdout.channel.recv_exit_status()}", file=sys.stderr)
client.close()

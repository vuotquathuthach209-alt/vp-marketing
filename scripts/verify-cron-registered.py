"""Verify ci-weekly cron is registered after deploy."""
import sys, paramiko
try: sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except: pass

HOST = "103.82.193.74"
PASSWORD = sys.argv[1] if len(sys.argv) > 1 else ""

CMD = r"""
cd /opt/vp-marketing
echo "=== 1. Code deployed? ==="
grep -c 'ci-weekly\|runWeeklyAutoPost' dist/services/scheduler.js || echo "NOT in compiled scheduler"
grep -c 'runWeeklyAutoPost' dist/services/ci-auto-weekly.js 2>/dev/null && echo "ci-auto-weekly.js compiled OK"

echo ""
echo "=== 2. Git HEAD on VPS ==="
git log --oneline -3

echo ""
echo "=== 3. Test run directly ==="
cat > tmp.js <<'JS'
try {
  const m = require('./dist/services/ci-auto-weekly');
  console.log('Module exports:', Object.keys(m).join(', '));
  const { ciPublishedThisWeek } = m;
  console.log('Published this week hotel #1:', ciPublishedThisWeek(1));
} catch (e) {
  console.log('LOAD FAIL:', e.message);
}
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

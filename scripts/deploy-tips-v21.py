"""Deploy V2.1 Tips Engine + verify migration."""
import sys, paramiko
try: sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except: pass
HOST = "103.82.193.74"
PASSWORD = sys.argv[1] if len(sys.argv) > 1 else ""

CMD = r"""
set -e
cd /opt/vp-marketing

echo '=== Pull latest ==='
git fetch origin 2>&1 | tail -2
git reset --hard origin/main 2>&1 | tail -2

echo ''
echo '=== Install deps ==='
npm install --no-audit --no-fund 2>&1 | tail -3

echo ''
echo '=== Build TS ==='
npx tsc 2>&1 | tail -5

echo ''
echo '=== Restart PM2 ==='
pm2 restart vp-mkt --update-env 2>&1 | tail -2
sleep 5

echo ''
echo '=== Boot logs (look for tips tables) ==='
pm2 logs vp-mkt --lines 80 --nostream 2>&1 | grep -E "tips|V2|tables ready|🚀|Marketing Auto" | tail -10

echo ''
echo '=== DB tables verify (tips_*) ==='
sqlite3 data/db.sqlite "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'tips_%' ORDER BY name" 2>/dev/null

echo ''
echo '=== API status check ==='
curl -s -o /dev/null -w 'HTTP %{http_code}\n' http://localhost:3000/api/video-studio/status
"""

c = paramiko.SSHClient()
c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
c.connect(HOST, username="root", password=PASSWORD, timeout=20)
_, out, err = c.exec_command(CMD, timeout=240)
print(out.read().decode('utf-8', errors='replace'))
e = err.read().decode('utf-8', errors='replace')
if e.strip(): print('--STDERR--'); print(e[:500])
c.close()

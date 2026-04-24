"""Debug: check actual HTML served on VPS has new sidebar."""
import sys, paramiko
try: sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except: pass
HOST = "103.82.193.74"
PASSWORD = sys.argv[1] if len(sys.argv) > 1 else ""

CMD = r"""
cd /opt/vp-marketing
echo '=== Git status ==='
git log --oneline -3

echo ''
echo '=== Check src/public/index.html has new sidebar ==='
grep -n "Tạo video\|vs-dashboard\|data-group=\"video-studio\"" src/public/index.html | head -5

echo ''
echo '=== Check src/public/app.js has vs functions ==='
grep -n "vsLoadDashboard\|vs-dashboard" src/public/app.js | head -5

echo ''
echo '=== Test fetch / anonymous ==='
curl -s -o /tmp/index.html http://localhost:3000/ -w 'HTTP %{http_code} size=%{size_download}\n'
echo ''
echo '=== Grep served HTML for new sidebar markers ==='
grep -c "Tạo video" /tmp/index.html
grep -c "data-tab=\"vs-dashboard\"" /tmp/index.html
grep -c "data-group=\"video-studio\"" /tmp/index.html

echo ''
echo '=== Check app.js served ==='
curl -s http://localhost:3000/app.js -o /tmp/app.js -w 'HTTP %{http_code} size=%{size_download}\n'
echo 'vs-dashboard in served app.js:'
grep -c "vs-dashboard\|vsLoadDashboard" /tmp/app.js

echo ''
echo '=== PM2 uptime / restart ==='
pm2 list | grep vp-mkt

echo ''
echo '=== Check permissions ==='
ls -la src/public/index.html src/public/app.js
"""

c = paramiko.SSHClient()
c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
c.connect(HOST, username="root", password=PASSWORD, timeout=20)
_, out, err = c.exec_command(CMD, timeout=60)
print(out.read().decode('utf-8', errors='replace'))
e = err.read().decode('utf-8', errors='replace')
if e.strip(): print('--STDERR--'); print(e[:500])
c.close()

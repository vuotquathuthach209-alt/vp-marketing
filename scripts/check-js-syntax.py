"""Check app.js syntax on VPS."""
import sys, paramiko
try: sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except: pass
HOST = "103.82.193.74"
PASSWORD = sys.argv[1] if len(sys.argv) > 1 else ""

CMD = r"""
cd /opt/vp-marketing

echo '=== Node syntax check on app.js ==='
node --check src/public/app.js 2>&1

echo ''
echo '=== Last deploy timestamp ==='
ls -la src/public/app.js src/public/index.html

echo ''
echo '=== PM2 logs gần nhất 30 dòng (tìm error) ==='
pm2 logs vp-mkt --lines 30 --nostream 2>&1 | grep -iE "error|fail|exception" | tail -10

echo ''
echo '=== Search app.js for suspicious patterns ==='
# Look for unterminated strings/template literals
grep -n 'vsUseIdea.*JSON' src/public/app.js | head -3

echo ''
echo '=== Line count ==='
wc -l src/public/app.js

echo ''
echo '=== Find nav-group structure ==='
grep -n 'data-group=' src/public/index.html
"""

c = paramiko.SSHClient()
c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
c.connect(HOST, username="root", password=PASSWORD, timeout=20)
_, out, err = c.exec_command(CMD, timeout=60)
print(out.read().decode('utf-8', errors='replace'))
e = err.read().decode('utf-8', errors='replace')
if e.strip(): print('--STDERR--'); print(e[:800])
c.close()

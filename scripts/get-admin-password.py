"""Check ADMIN_PASSWORD env var on VPS."""
import sys, paramiko
try: sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except: pass
HOST = "103.82.193.74"
PASSWORD = sys.argv[1] if len(sys.argv) > 1 else ""

CMD = r"""
cd /opt/vp-marketing
echo '=== .env file ==='
if [ -f .env ]; then
  grep -i 'ADMIN_PASSWORD\|admin_password' .env || echo 'ADMIN_PASSWORD not set in .env → using default change-me-now'
else
  echo 'no .env file'
fi

echo ''
echo '=== Process env for vp-mkt ==='
ps aux | grep 'node.*dist' | head -2

echo ''
echo '=== pm2 config ==='
pm2 env 0 2>&1 | grep -i 'ADMIN_PASSWORD' || echo 'Not in PM2 env'
"""

c = paramiko.SSHClient()
c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
c.connect(HOST, username="root", password=PASSWORD, timeout=20)
_, out, err = c.exec_command(CMD, timeout=30)
print(out.read().decode('utf-8', errors='replace'))
e = err.read().decode('utf-8', errors='replace')
if e.strip(): print('--STDERR--'); print(e[:500])
c.close()

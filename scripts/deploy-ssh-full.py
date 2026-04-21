"""
Full deploy: git pull + npm install + npx tsc (rebuild dist) + pm2 restart.
Use this khi có TS changes (src/index.ts, routes, services).
"""
import sys
import os
import paramiko

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

HOST = "103.82.193.74"
USER = "root"
PASSWORD = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("VPS_PASSWORD", "")

CMD = """
set -e
cd /opt/vp-marketing
echo '---pull---'
git pull --ff-only 2>&1
echo '---npm install---'
npm install --silent 2>&1 | tail -3
echo '---tsc build---'
npx tsc 2>&1 | tail -10
echo '---restart---'
pm2 restart vp-mkt 2>&1 | tail -3
sleep 2
echo '---status---'
pm2 list | grep vp-mkt
echo '---smoke test---'
curl -s -o /dev/null -w 'homepage: %{http_code}\\n' https://app.sondervn.com/
curl -s -o /tmp/zv.txt -w 'zalo-verify-file: %{http_code} size=%{size_download}\\n' 'https://app.sondervn.com/zalo-site-verification-SEwnEuJyP15KshOkjlvY64EAwpol_3vXD3Wm.html'
echo 'zalo-verify content:'
cat /tmp/zv.txt
echo ''
"""

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, username=USER, password=PASSWORD, timeout=15, look_for_keys=False, allow_agent=False)
stdin, stdout, stderr = client.exec_command(CMD, timeout=240)
print(stdout.read().decode("utf-8", errors="replace"))
err = stderr.read().decode("utf-8", errors="replace")
if err.strip():
    print("STDERR:\n" + err, file=sys.stderr)
code = stdout.channel.recv_exit_status()
print(f"[deploy-full] exit: {code}", file=sys.stderr)
client.close()

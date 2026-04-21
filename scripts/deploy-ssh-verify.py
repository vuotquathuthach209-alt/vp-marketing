"""Verify VPS state: git HEAD, build, endpoints."""
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
cd /opt/vp-marketing
echo '---HEAD---'
git log -3 --oneline
echo '---build status---'
ls -la dist/routes/zalo.js 2>&1 | head -1
ls -la dist/services/zalo.js 2>&1 | head -1
echo '---build if needed---'
if [ ! -f dist/routes/zalo.js ] || [ src/routes/zalo.ts -nt dist/routes/zalo.js ]; then
  echo 'REBUILD needed'
  npx tsc 2>&1 | tail -10
  pm2 restart vp-mkt
  sleep 2
  echo 'REBUILD done'
fi
echo '---test endpoints---'
curl -s -o /dev/null -w 'simulate: %{http_code}\\n' -X POST http://127.0.0.1:3000/api/zalo/simulate -H 'Content-Type: application/json' -d '{"text":"test"}'
curl -s -o /dev/null -w 'zns-templates: %{http_code}\\n' http://127.0.0.1:3000/api/zalo/zns/templates
curl -s -o /dev/null -w 'conversations: %{http_code}\\n' http://127.0.0.1:3000/api/conversations/senders
echo '---health---'
curl -s http://127.0.0.1:3000/health 2>&1 | head -c 200
"""

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, username=USER, password=PASSWORD, timeout=15, look_for_keys=False, allow_agent=False)
stdin, stdout, stderr = client.exec_command(CMD, timeout=180)
print(stdout.read().decode("utf-8", errors="replace"))
err = stderr.read().decode("utf-8", errors="replace")
if err.strip():
    print("STDERR:\n" + err, file=sys.stderr)
code = stdout.channel.recv_exit_status()
print(f"[verify] exit: {code}", file=sys.stderr)
client.close()

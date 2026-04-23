"""Deploy with explicit TS build — v23 needs this since new files don't auto-compile."""
import sys, os, paramiko
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception: pass

HOST = "103.82.193.74"
USER = "root"
PASSWORD = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("VPS_PASSWORD", "")
CMD = """
set -e
cd /opt/vp-marketing
echo '---git---'
git pull --ff-only 2>&1
echo '---npm install---'
npm install --silent 2>&1 | tail -5
echo '---npm run build (tsc)---'
npm run build 2>&1 | tail -20
echo '---restart---'
pm2 restart vp-mkt 2>&1
sleep 3
echo '---status---'
pm2 list | grep vp-mkt
echo '---post-restart logs---'
pm2 logs vp-mkt --lines 40 --nostream 2>&1 | grep -iE 'intent_logs|v23|error|fail|Created|greeting' | tail -15
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
if err.strip(): print("STDERR:", err[:1000], file=sys.stderr)
print(f"[deploy] exit {stdout.channel.recv_exit_status()}", file=sys.stderr)
client.close()

"""
One-shot deploy script: SSH vào VPS bằng password + chạy deploy command.
Password lấy từ arg #1 hoặc env VPS_PASSWORD.
"""
import sys
import os
import paramiko

# Force UTF-8 output on Windows console
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
git pull --ff-only 2>&1
echo '---npm---'
npm install --silent 2>&1 | tail -5
echo '---restart---'
pm2 restart vp-mkt 2>&1
sleep 2
echo '---status---'
pm2 list | grep vp-mkt
echo '---tail logs---'
pm2 logs vp-mkt --lines 15 --nostream 2>&1 | tail -25
"""

if not PASSWORD:
    print("ERROR: pass password as arg #1 or set VPS_PASSWORD env", file=sys.stderr)
    sys.exit(1)

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
print(f"[deploy] connecting to {USER}@{HOST}...", file=sys.stderr)
client.connect(HOST, username=USER, password=PASSWORD, timeout=15, look_for_keys=False, allow_agent=False)

print(f"[deploy] running deploy script...", file=sys.stderr)
stdin, stdout, stderr = client.exec_command(CMD, timeout=180)
out = stdout.read().decode("utf-8", errors="replace")
err = stderr.read().decode("utf-8", errors="replace")
code = stdout.channel.recv_exit_status()
print(out)
if err.strip():
    print("STDERR:\n" + err, file=sys.stderr)
print(f"[deploy] exit code: {code}", file=sys.stderr)
client.close()
sys.exit(code)

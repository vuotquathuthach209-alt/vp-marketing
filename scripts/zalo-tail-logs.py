"""
Tail vp-mkt logs real-time, filter dòng có 'zalo' để xem webhook events.
Chạy khi user click Test trong Zalo console.
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
DURATION = int(sys.argv[2]) if len(sys.argv) > 2 else 60

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, username=USER, password=PASSWORD, timeout=15, look_for_keys=False, allow_agent=False)

# Check cả file log và in-memory buffer trong DURATION seconds
CMD = f"timeout {DURATION} pm2 logs vp-mkt --raw --lines 0 | grep -i --line-buffered zalo || true"
print(f"[tail] Tailing vp-mkt logs for zalo events ({DURATION}s)...", file=sys.stderr)
print(f"[tail] Bạn bấm Test trong Zalo console NGAY bây giờ để tôi thấy!", file=sys.stderr)

stdin, stdout, stderr = client.exec_command(CMD, timeout=DURATION + 10)
for line in iter(stdout.readline, ""):
    if line.strip():
        print(line, end="", flush=True)

client.close()
print("\n[tail] done", file=sys.stderr)

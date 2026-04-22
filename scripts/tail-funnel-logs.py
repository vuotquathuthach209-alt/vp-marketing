"""Tail PM2 logs for funnel events."""
import sys, os, paramiko
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception: pass

HOST = "103.82.193.74"; USER = "root"
PASSWORD = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("VPS_PASSWORD", "")
DURATION = int(sys.argv[2]) if len(sys.argv) > 2 else 30

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, username=USER, password=PASSWORD, timeout=15, look_for_keys=False, allow_agent=False)

CMD = f"""
# Trigger test first
curl -s -X POST http://127.0.0.1:3000/webhook/zalo \\
  -H 'Content-Type: application/json' \\
  -d '{{"oa_id":"328738126716568694","event_name":"user_send_text","sender":{{"id":"test_fsm_debug"}},"message":{{"text":"lấy số 1"}}}}' > /dev/null &

sleep 1
# Tail logs
timeout {DURATION} pm2 logs vp-mkt --raw --lines 0 2>&1 | grep -iE 'funnel|smartreply.*error|Error' | head -50
"""

stdin, stdout, stderr = client.exec_command(CMD, timeout=DURATION + 10)
for line in iter(stdout.readline, ""):
    if line.strip(): print(line, end="", flush=True)
client.close()

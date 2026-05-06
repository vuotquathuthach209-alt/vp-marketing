"""Quick status check for POC #9 cinema pipeline on VPS."""
import sys, os, paramiko

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

HOST = "103.82.193.74"
USER = "root"
PASSWORD = "cCxEvKZ0J3Ee6NJG"

CMD = r"""
echo '=====PROCESS====='
ps aux | grep -E 'cinema|node.*pilot' | grep -v grep | head -5
echo
echo '=====LOG TAIL (last 250 lines)====='
tail -250 /tmp/cinema-pilot.log 2>/dev/null || echo '(log not found)'
echo
echo '=====OUTPUT DIR====='
ls -la /opt/vp-marketing/data/media/cinema-out/ 2>/dev/null | tail -20
echo
echo '=====MATERIAL DIR====='
ls -la /opt/vp-marketing/data/media/cinema-shots/ 2>/dev/null | tail -20
"""

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, username=USER, password=PASSWORD, timeout=15, look_for_keys=False, allow_agent=False)

stdin, stdout, stderr = client.exec_command(CMD, timeout=60)
print(stdout.read().decode("utf-8", errors="replace"))
err = stderr.read().decode("utf-8", errors="replace")
if err.strip():
    print("STDERR:", err, file=sys.stderr)
client.close()

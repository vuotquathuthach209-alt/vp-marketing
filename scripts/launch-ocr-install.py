"""Launch OCR install as detached process."""
import sys, paramiko, time
try: sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except: pass
HOST = "103.82.193.74"
PASSWORD = sys.argv[1] if len(sys.argv) > 1 else ""

# Single command that detaches pip install completely
CMD = """bash -c '
cd /opt/vp-marketing/ocr-service
pkill -9 -f "pip install" 2>/dev/null
systemctl stop vp-mkt-ocr 2>/dev/null
rm -rf venv
python3 -m venv venv
./venv/bin/pip install --upgrade pip setuptools wheel > /tmp/ocr-install.log 2>&1
# Detach pip install completely from shell
setsid nohup ./venv/bin/pip install -r requirements.txt >> /tmp/ocr-install.log 2>&1 < /dev/null &
echo "Launched PID: $!"
sleep 3
ls -la venv/
echo "Log tail:"
tail -20 /tmp/ocr-install.log
'"""

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, username="root", password=PASSWORD, timeout=15)
_, stdout, stderr = client.exec_command(CMD, timeout=90, get_pty=False)
print("STDOUT:")
print(stdout.read().decode("utf-8", errors="replace"))
print("STDERR:")
print(stderr.read().decode("utf-8", errors="replace"))
client.close()

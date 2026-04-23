"""Launch via interactive shell — more reliable for paramiko."""
import sys, paramiko, time
try: sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except: pass
HOST = "103.82.193.74"
PASSWORD = sys.argv[1] if len(sys.argv) > 1 else ""

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, username="root", password=PASSWORD, timeout=15)

chan = client.invoke_shell()
chan.settimeout(60)

commands = [
    'cd /opt/vp-marketing/ocr-service',
    'pkill -9 -f "pip install" 2>/dev/null; true',
    'systemctl stop vp-mkt-ocr 2>/dev/null; true',
    'rm -rf venv',
    'python3 -m venv venv',
    './venv/bin/pip install --upgrade pip setuptools wheel 2>&1 | tail -3',
    'ls venv/bin/ | head -5',
    # Launch in background with setsid — detaches from session
    'setsid ./venv/bin/pip install -r requirements.txt > /tmp/ocr-install.log 2>&1 < /dev/null &',
    'sleep 2',
    'pgrep -f "pip install -r requirements" | head -3',
    'echo "=== Launch done ==="',
]

for cmd in commands:
    chan.send(cmd + '\n')
    time.sleep(2)

# Read output for 10s
time.sleep(5)
output = ''
start = time.time()
while time.time() - start < 10:
    if chan.recv_ready():
        data = chan.recv(65536).decode('utf-8', errors='replace')
        output += data
    time.sleep(0.5)

print(output)
chan.send('exit\n')
chan.close()
client.close()

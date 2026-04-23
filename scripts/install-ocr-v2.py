"""Pull latest + reinstall OCR sidecar."""
import sys, paramiko, time
try: sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except: pass

HOST = "103.82.193.74"
PASSWORD = sys.argv[1] if len(sys.argv) > 1 else ""

CMD = r"""
set -e
cd /opt/vp-marketing
echo "=== git pull ==="
git pull origin main

echo ""
echo "=== Content of requirements.txt ==="
cat ocr-service/requirements.txt

echo ""
echo "=== Running install.sh ==="
cd ocr-service
chmod +x install.sh
bash install.sh 2>&1

echo ""
echo "=== Verify service ==="
sleep 3
systemctl status vp-mkt-ocr --no-pager | head -10
echo ""
echo "=== Health check ==="
TOKEN=$(grep TOKEN /etc/vp-mkt-ocr.env 2>/dev/null | cut -d= -f2)
if [ -n "$TOKEN" ]; then
  echo "TOKEN_EXISTS=yes"
  curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8501/health
  echo ""
  echo "OCR_SERVICE_TOKEN=$TOKEN"
else
  echo "TOKEN_EXISTS=no — check /etc/vp-mkt-ocr.env"
fi
"""

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, username="root", password=PASSWORD, timeout=15)

# Stream output
chan = client.invoke_shell()
chan.settimeout(900)
chan.send(CMD + "\nexit\n")

last_data_time = time.time()
while True:
    if chan.recv_ready():
        data = chan.recv(65536).decode("utf-8", errors="replace")
        if data:
            sys.stdout.write(data)
            sys.stdout.flush()
            last_data_time = time.time()
    elif chan.exit_status_ready():
        # Read any remaining data
        while chan.recv_ready():
            data = chan.recv(65536).decode("utf-8", errors="replace")
            sys.stdout.write(data)
            sys.stdout.flush()
        break
    elif time.time() - last_data_time > 120:
        # 2 min no output = done (install.sh always outputs at end)
        print("\n[no output 2 min - done]")
        break
    else:
        time.sleep(0.5)

chan.close()
client.close()

"""Reinstall OCR sidecar with EasyOCR (wipe old venv)."""
import sys, paramiko, time
try: sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except: pass

HOST = "103.82.193.74"
PASSWORD = sys.argv[1] if len(sys.argv) > 1 else ""

CMD = r"""
cd /opt/vp-marketing
git pull origin main

echo ""
echo "=== Stop old service + wipe old venv ==="
systemctl stop vp-mkt-ocr 2>/dev/null || true
rm -rf /opt/vp-marketing/ocr-service/venv
echo "Old venv wiped."

echo ""
echo "=== Reinstall ==="
cd ocr-service
chmod +x install.sh
bash install.sh 2>&1 | tail -40

echo ""
echo "=== Wait 10s then check ==="
sleep 10
systemctl status vp-mkt-ocr --no-pager | head -15
echo ""
echo "=== Logs ==="
journalctl -u vp-mkt-ocr --no-pager -n 20
echo ""
echo "=== Health ==="
TOKEN=$(grep TOKEN /etc/vp-mkt-ocr.env | cut -d= -f2)
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8501/health
echo ""
echo "Token: $TOKEN"
"""

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, username="root", password=PASSWORD, timeout=15)
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
        while chan.recv_ready():
            data = chan.recv(65536).decode("utf-8", errors="replace")
            sys.stdout.write(data)
            sys.stdout.flush()
        break
    elif time.time() - last_data_time > 180:
        print("\n[no output 3 min - done]")
        break
    else:
        time.sleep(0.5)

chan.close()
client.close()

"""Force sync + reinstall OCR sidecar."""
import sys, paramiko, time
try: sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except: pass

HOST = "103.82.193.74"
PASSWORD = sys.argv[1] if len(sys.argv) > 1 else ""

CMD = r"""
set -e
cd /opt/vp-marketing

echo "=== Current main.py (first 30 lines) ==="
head -30 ocr-service/main.py

echo ""
echo "=== Git status + force pull ==="
git fetch origin main
git reset --hard origin/main
echo "HEAD:"
git log --oneline -1

echo ""
echo "=== Verify main.py now uses easyocr ==="
grep -nE 'easyocr|paddleocr' ocr-service/main.py | head -5

echo ""
echo "=== Verify requirements.txt ==="
cat ocr-service/requirements.txt

echo ""
echo "=== Stop service + wipe venv ==="
systemctl stop vp-mkt-ocr 2>/dev/null || true
rm -rf ocr-service/venv
sleep 2

echo ""
echo "=== Reinstall fresh ==="
cd ocr-service
bash install.sh 2>&1 | tail -30

echo ""
echo "=== Wait 15s ==="
sleep 15
systemctl status vp-mkt-ocr --no-pager | head -15

echo ""
echo "=== Health ==="
TOKEN=$(grep TOKEN /etc/vp-mkt-ocr.env | cut -d= -f2)
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8501/health
echo ""
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
        break
    elif time.time() - last_data_time > 180:
        print("\n[done - no output 3 min]")
        break
    else:
        time.sleep(0.5)

chan.close()
client.close()

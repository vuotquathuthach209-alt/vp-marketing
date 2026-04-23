"""Install PaddleOCR sidecar on VPS — long running (~10 min for first install)."""
import sys, paramiko
try: sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except: pass

HOST = "103.82.193.74"
PASSWORD = sys.argv[1] if len(sys.argv) > 1 else ""

CMD = r"""
set -e
cd /opt/vp-marketing/ocr-service
chmod +x install.sh
echo "=== Running install.sh (output streams below) ==="
bash install.sh 2>&1
echo ""
echo "=== Verify service status ==="
sleep 5
systemctl status vp-mkt-ocr --no-pager | head -15
echo ""
echo "=== Test health endpoint ==="
TOKEN=$(grep TOKEN /etc/vp-mkt-ocr.env | cut -d= -f2)
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8501/health
echo ""
echo "=== Token (lưu lại) ==="
echo "OCR_SERVICE_TOKEN=$TOKEN"
"""

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, username="root", password=PASSWORD, timeout=15)
# Use get_pty for long-running install with streaming output
chan = client.invoke_shell()
chan.settimeout(900)  # 15 min
chan.send("bash -lc '" + CMD.replace("'", "'\\''") + "'; exit\n")

output = ""
import time
last_data_time = time.time()
while True:
    if chan.recv_ready():
        data = chan.recv(65536).decode("utf-8", errors="replace")
        if data:
            output += data
            print(data, end='', flush=True)
            last_data_time = time.time()
    elif chan.exit_status_ready():
        break
    elif time.time() - last_data_time > 60:
        # No output for 60s — probably hung or done
        print("\n[no output for 60s, assuming done]")
        break
    else:
        time.sleep(0.5)

chan.close()
client.close()

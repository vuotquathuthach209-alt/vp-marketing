"""Install OCR with nohup — survive ssh disconnect."""
import sys, paramiko, time
try: sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except: pass
HOST = "103.82.193.74"
PASSWORD = sys.argv[1] if len(sys.argv) > 1 else ""

CMD = r"""
cd /opt/vp-marketing/ocr-service

echo "=== Kill any stuck pip install ==="
pkill -9 -f 'pip install' 2>/dev/null || true
systemctl stop vp-mkt-ocr 2>/dev/null || true

echo ""
echo "=== Wipe + recreate venv ==="
rm -rf venv
python3 -m venv venv

echo ""
echo "=== Upgrade pip + setuptools in venv ==="
./venv/bin/pip install --upgrade pip setuptools wheel -q

echo ""
echo "=== Launch pip install in background (nohup) ==="
nohup ./venv/bin/pip install -r requirements.txt > /tmp/ocr-install.log 2>&1 &
echo $! > /tmp/ocr-install.pid
echo "PID: $(cat /tmp/ocr-install.pid)"

echo ""
echo "=== Monitor progress (2 min preview) ==="
sleep 15
echo "venv size after 15s:"
du -sh venv 2>/dev/null

echo ""
echo "=== Done - install continues in background ==="
echo "Check later: tail -f /tmp/ocr-install.log"
echo "Wait for: pip install to finish (~5-10 min)"
"""

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, username="root", password=PASSWORD, timeout=15)
_, stdout, stderr = client.exec_command(CMD, timeout=120)
print(stdout.read().decode("utf-8", errors="replace"))
err = stderr.read().decode("utf-8", errors="replace")
if err.strip(): print("STDERR:\n" + err, file=sys.stderr)
client.close()

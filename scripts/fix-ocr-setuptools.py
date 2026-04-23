"""Quick fix: install setuptools in existing venv + restart service."""
import sys, paramiko
try: sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except: pass

HOST = "103.82.193.74"
PASSWORD = sys.argv[1] if len(sys.argv) > 1 else ""

CMD = r"""
cd /opt/vp-marketing
git pull origin main
echo "=== Installing setuptools in venv ==="
/opt/vp-marketing/ocr-service/venv/bin/pip install --upgrade setuptools wheel
echo ""
echo "=== Restart service ==="
systemctl restart vp-mkt-ocr
sleep 5
systemctl status vp-mkt-ocr --no-pager | head -15
echo ""
echo "=== Logs ==="
journalctl -u vp-mkt-ocr --no-pager -n 30
echo ""
echo "=== Health check ==="
TOKEN=$(grep TOKEN /etc/vp-mkt-ocr.env | cut -d= -f2)
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8501/health
echo ""
echo "Token: $TOKEN"
"""

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, username="root", password=PASSWORD, timeout=15)
_, stdout, stderr = client.exec_command(CMD, timeout=180)
print(stdout.read().decode("utf-8", errors="replace"))
err = stderr.read().decode("utf-8", errors="replace")
if err.strip(): print("STDERR:\n" + err, file=sys.stderr)
client.close()

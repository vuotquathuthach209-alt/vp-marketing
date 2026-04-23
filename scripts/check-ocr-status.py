"""Check OCR sidecar status after install."""
import sys, paramiko
try: sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except: pass
HOST = "103.82.193.74"
PASSWORD = sys.argv[1] if len(sys.argv) > 1 else ""
CMD = r"""
echo "=== 1. Service status ==="
systemctl status vp-mkt-ocr --no-pager | head -12
echo ""

echo "=== 2. Recent logs (last 30 lines) ==="
journalctl -u vp-mkt-ocr --no-pager -n 30

echo ""
echo "=== 3. Any pip install still running? ==="
ps aux | grep -E 'pip install|install.sh' | grep -v grep || echo "(none)"

echo ""
echo "=== 4. venv size (is pip done?) ==="
du -sh /opt/vp-marketing/ocr-service/venv 2>/dev/null || echo "no venv"

echo ""
echo "=== 5. Installed packages ==="
/opt/vp-marketing/ocr-service/venv/bin/pip list 2>/dev/null | grep -iE 'easyocr|torch|fastapi' || echo "(venv not ready)"

echo ""
echo "=== 6. Try to start service ==="
systemctl start vp-mkt-ocr 2>&1
sleep 3
systemctl status vp-mkt-ocr --no-pager | head -8

echo ""
echo "=== 7. Health check ==="
TOKEN=$(grep TOKEN /etc/vp-mkt-ocr.env 2>/dev/null | cut -d= -f2)
if [ -n "$TOKEN" ]; then
  curl -s -m 8 -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8501/health || echo "TIMEOUT/FAIL"
fi
"""
client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, username="root", password=PASSWORD, timeout=15)
_, stdout, stderr = client.exec_command(CMD, timeout=60)
print(stdout.read().decode("utf-8", errors="replace"))
err = stderr.read().decode("utf-8", errors="replace")
if err.strip(): print("STDERR:\n" + err, file=sys.stderr)
client.close()

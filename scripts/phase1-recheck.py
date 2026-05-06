"""Quick recheck Chatwoot health + DNS chat.sondervn.com after wakeup."""
import sys, paramiko, socket

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

# Check DNS first from local
try:
    ip = socket.gethostbyname("chat.sondervn.com")
    print(f"✅ DNS chat.sondervn.com → {ip}")
    dns_ready = ip == "103.82.193.74"
except Exception as e:
    print(f"⏳ DNS chat.sondervn.com NOT resolved yet: {e}")
    dns_ready = False

print()

HOST = "103.82.193.74"
USER = "root"
PASSWORD = "cCxEvKZ0J3Ee6NJG"

CMD = r"""
cd /opt/chatwoot

echo '═══ Containers ═══'
docker compose ps --format 'table {{.Name}}\t{{.Status}}\t{{.Ports}}'

echo
echo '═══ API health ═══'
curl -s http://127.0.0.1:3001/api | head -c 200; echo

echo
echo '═══ Memory usage ═══'
free -h | grep -E 'Mem|Swap'
echo

echo '═══ Nginx config status ═══'
ls -la /etc/nginx/sites-enabled/ | grep chat || echo '(no chat config)'
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

print()
if dns_ready:
    print("🎯 DNS đã resolve → có thể chạy certbot ngay!")
else:
    print("⏳ Anh chưa add DNS A record. Khi xong báo em chạy certbot.")

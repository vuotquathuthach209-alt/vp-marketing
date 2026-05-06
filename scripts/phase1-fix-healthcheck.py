"""Fix Chatwoot healthcheck false positive — /api endpoint trả 200 OK,
not /api/v1/accounts (404 vì chưa có account)."""
import sys, paramiko

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

HOST = "103.82.193.74"
USER = "root"
PASSWORD = "cCxEvKZ0J3Ee6NJG"

CMD = r"""
cd /opt/chatwoot

echo '═══ BEFORE: rails health ═══'
docker inspect --format='{{.State.Health.Status}}' chatwoot-rails

echo
echo '═══ Patch healthcheck (use /api instead of /api/v1/accounts) ═══'
sed -i 's|wget --no-verbose --tries=1 --spider http://localhost:3000/api \|\| exit 1|wget -q --spider http://localhost:3000/api \&\& exit 0 \|\| exit 1|' docker-compose.yml

# Verify edit
grep -A1 'healthcheck' docker-compose.yml | head -10

echo
echo '═══ Recreate rails container with new healthcheck ═══'
docker compose up -d --no-deps --force-recreate rails

sleep 30
echo
echo '═══ AFTER: rails health ═══'
docker inspect --format='{{.State.Health.Status}}' chatwoot-rails
docker compose ps --format 'table {{.Name}}\t{{.Status}}\t{{.Ports}}'

echo
echo '═══ API still responds ═══'
curl -s http://127.0.0.1:3001/api | head -c 200; echo
"""

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, username=USER, password=PASSWORD, timeout=15, look_for_keys=False, allow_agent=False)

stdin, stdout, stderr = client.exec_command(CMD, timeout=120, get_pty=True)
print(stdout.read().decode("utf-8", errors="replace"))
err = stderr.read().decode("utf-8", errors="replace")
if err.strip():
    print("STDERR:", err, file=sys.stderr)
client.close()

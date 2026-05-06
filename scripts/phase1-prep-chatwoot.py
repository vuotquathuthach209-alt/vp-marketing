"""PHASE 1 PREP: Audit VPS resources + check Docker + check ports + DNS.

Pre-flight checks before deploying Chatwoot:
- Free RAM, disk, CPU
- Docker + docker-compose installed
- Ports 3000/3001/8080 free or used
- Existing nginx config
- DNS chat.sondervn.com resolved?
"""
import sys, paramiko

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

HOST = "103.82.193.74"
USER = "root"
PASSWORD = "cCxEvKZ0J3Ee6NJG"

CMD = r"""
echo '═══ VPS RESOURCES ═══'
echo
echo '--- RAM ---'
free -h
echo
echo '--- DISK ---'
df -h / /opt 2>/dev/null
echo
echo '--- CPU LOAD ---'
uptime
echo

echo '═══ DOCKER ═══'
which docker && docker --version || echo 'Docker NOT installed'
which docker-compose && docker-compose --version || echo 'docker-compose NOT installed (try: docker compose)'
docker compose version 2>/dev/null || echo 'compose plugin not found'
echo
echo '--- Docker running containers ---'
docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}' 2>/dev/null || echo 'Docker daemon not running'
echo
echo '--- Docker networks ---'
docker network ls 2>/dev/null

echo
echo '═══ PORTS USED ═══'
ss -tlnp 2>/dev/null | grep -E ':(80|443|3000|3001|3306|5432|6379|8080|9000|11434)' | head -20
echo

echo '═══ NGINX ═══'
which nginx && nginx -v 2>&1 || echo 'Nginx not installed'
ls /etc/nginx/sites-enabled/ 2>/dev/null
echo
echo '--- Existing server_name lookups ---'
grep -h 'server_name' /etc/nginx/sites-enabled/* 2>/dev/null | head -10
echo

echo '═══ DNS chat.sondervn.com ═══'
host chat.sondervn.com 2>&1 | head -5 || echo 'DNS lookup failed (subdomain may not exist yet)'
host sondervn.com 2>&1 | head -3
echo

echo '═══ EXISTING SSL CERTS ═══'
ls /etc/letsencrypt/live/ 2>/dev/null || echo 'No letsencrypt certs'
echo

echo '═══ POSTGRES (existing?) ═══'
which psql 2>/dev/null && psql --version || echo 'No postgres client'
ss -tlnp 2>/dev/null | grep ':5432'
echo

echo '═══ REDIS (existing?) ═══'
which redis-cli 2>/dev/null && redis-cli --version || echo 'No redis-cli'
ss -tlnp 2>/dev/null | grep ':6379'

echo
echo '═══ SUMMARY ═══'
echo 'Ready for Chatwoot deploy if: Docker installed, Ports 3000+free, ~2GB RAM free'
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

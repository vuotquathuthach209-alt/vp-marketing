"""PHASE 1B FIX: Replace postgres:14-alpine with pgvector/pgvector:pg14
because Chatwoot 4.x uses pgvector for Captain AI agent embeddings.
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
set -e
cd /opt/chatwoot

echo '═══ STEP 1: Stop containers ═══'
docker compose down 2>&1 | tail -5

echo
echo '═══ STEP 2: Remove postgres volume (no data yet) ═══'
docker volume rm chatwoot_postgres_data 2>&1 || true

echo
echo '═══ STEP 3: Update docker-compose.yml — pgvector image ═══'
sed -i 's|image: postgres:14-alpine|image: pgvector/pgvector:pg14|' docker-compose.yml
grep 'pgvector' docker-compose.yml

echo
echo '═══ STEP 4: Pull new pgvector image ═══'
docker compose pull postgres 2>&1 | tail -5

echo
echo '═══ STEP 5: Start postgres + redis (DB only) ═══'
docker compose up -d postgres redis
sleep 8
docker compose ps

echo
echo '═══ STEP 6: Verify pgvector extension available ═══'
docker compose exec -T postgres psql -U postgres -c "SELECT * FROM pg_available_extensions WHERE name='vector';"

echo
echo '═══ STEP 7: Init Chatwoot schema (with vector ext) ═══'
docker compose run --rm rails bundle exec rails db:chatwoot_prepare 2>&1 | tail -30

echo
echo '═══ STEP 8: Start all services ═══'
docker compose up -d
sleep 20
docker compose ps

echo
echo '═══ STEP 9: Wait for rails healthy + test ═══'
for i in {1..18}; do
  HEALTH=$(docker inspect --format='{{.State.Health.Status}}' chatwoot-rails 2>/dev/null || echo 'unknown')
  echo "  attempt $i: rails health=$HEALTH"
  if [ "$HEALTH" = "healthy" ]; then break; fi
  sleep 10
done

echo
echo '═══ STEP 10: Final test ═══'
curl -s -o /dev/null -w 'HTTP %{http_code} (response time: %{time_total}s)\n' http://127.0.0.1:3001/
curl -s http://127.0.0.1:3001/api/v1/accounts | head -c 200; echo

echo
echo '═══ DONE ═══'
echo 'Internal URL: http://127.0.0.1:3001 (localhost only)'
echo 'Next: setup nginx reverse proxy + DNS chat.sondervn.com'
"""

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, username=USER, password=PASSWORD, timeout=15, look_for_keys=False, allow_agent=False)

stdin, stdout, stderr = client.exec_command(CMD, timeout=600, get_pty=True)
print(stdout.read().decode("utf-8", errors="replace"))
err = stderr.read().decode("utf-8", errors="replace")
if err.strip():
    print("STDERR:", err, file=sys.stderr)
client.close()

"""PHASE 3A: Deploy Listmonk container with dedicated Postgres.

Container architecture:
  - listmonk-app (Listmonk Go binary, port 9000 internal)
  - listmonk-db (Postgres 14, dedicated DB to avoid conflict with chatwoot)

SMTP backend will be configured AFTER user picks option (Resend recommended).

Reference: skill sonder-tech-sovereignty (Listmonk locked OSS email engine)
"""
import sys, paramiko, secrets

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

HOST = "103.82.193.74"
USER = "root"
PASSWORD = "cCxEvKZ0J3Ee6NJG"

PG_PASS = secrets.token_hex(16)
ADMIN_PASS = "Sonder@Mail2026!"  # will be required on first login

DOCKER_COMPOSE = """networks:
  listmonk-net:
    driver: bridge

volumes:
  listmonk_db:
  listmonk_uploads:

services:
  db:
    image: postgres:14-alpine
    container_name: listmonk-db
    restart: unless-stopped
    networks: [listmonk-net]
    environment:
      - POSTGRES_PASSWORD={pg_pass}
      - POSTGRES_USER=listmonk
      - POSTGRES_DB=listmonk
    volumes:
      - listmonk_db:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U listmonk"]
      interval: 10s
      timeout: 5s
      retries: 5

  app:
    image: listmonk/listmonk:v4.1.0
    container_name: listmonk-app
    restart: unless-stopped
    networks: [listmonk-net]
    ports:
      - "127.0.0.1:9000:9000"
    depends_on:
      db:
        condition: service_healthy
    environment:
      # Database
      - LISTMONK_db__host=db
      - LISTMONK_db__port=5432
      - LISTMONK_db__user=listmonk
      - LISTMONK_db__password={pg_pass}
      - LISTMONK_db__database=listmonk
      - LISTMONK_db__ssl_mode=disable
      - LISTMONK_db__max_open=25
      - LISTMONK_db__max_idle=25
      - LISTMONK_db__max_lifetime=300s

      # App
      - LISTMONK_app__address=0.0.0.0:9000
      - TZ=Asia/Ho_Chi_Minh
    volumes:
      - listmonk_uploads:/listmonk/uploads
""".format(pg_pass=PG_PASS)

CMD = f"""
set -e
mkdir -p /opt/listmonk
cd /opt/listmonk

echo === Write docker-compose.yml ===
cat > docker-compose.yml <<'COMPOSE_EOF'
{DOCKER_COMPOSE}
COMPOSE_EOF

echo === Pull images ===
docker compose pull 2>&1 | tail -5

echo
echo === Start db only first ===
docker compose up -d db
sleep 8
docker compose ps

echo
echo === Initialize Listmonk schema (--install) ===
docker compose run --rm app ./listmonk --install --idempotent --yes 2>&1 | tail -15

echo
echo === Set super admin password (env var override) ===
# Listmonk v3+ uses DB-stored super admin. Update users table.
docker compose run --rm app ./listmonk --upgrade --yes 2>&1 | tail -5

echo
echo === Start app ===
docker compose up -d app
sleep 8
docker compose ps

echo
echo === Test internal endpoint ===
curl -s --max-time 5 http://127.0.0.1:9000/api/health | head -c 300; echo
echo
echo === Get default admin credentials from DB ===
docker compose exec -T db psql -U listmonk -d listmonk -c "SELECT id, type, username, status FROM users;" 2>&1 | head -10

echo
echo === Save credentials ===
cat > .sonder-listmonk-credentials <<EOF_CREDS
# Sonder Listmonk credentials — 2026-05-06
URL_PUBLIC=https://mail.sondervn.com (chờ DNS)
URL_LOCALHOST=http://127.0.0.1:9000

# Default admin credentials (Listmonk v4 uses DB-defined)
# First login at /admin/login, then setup via UI

# Postgres credentials
PG_USER=listmonk
PG_PASS={PG_PASS}
PG_DB=listmonk

# SMTP backend NOT YET configured (Phase 3B)
EOF_CREDS
chmod 600 .sonder-listmonk-credentials
echo Credentials saved
"""

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, username=USER, password=PASSWORD, timeout=15, look_for_keys=False, allow_agent=False)

stdin, stdout, stderr = client.exec_command(CMD, timeout=420, get_pty=True)
print(stdout.read().decode("utf-8", errors="replace"))
err = stderr.read().decode("utf-8", errors="replace")
if err.strip():
    print("STDERR:", err, file=sys.stderr)
client.close()

print()
print(f">>> Postgres password: {PG_PASS}")

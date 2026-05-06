"""PHASE 1B: Deploy Chatwoot self-hosted via Docker Compose.

Architecture:
- chatwoot-web (Rails app, internal port 3000 → host 3001)
- chatwoot-worker (Sidekiq background jobs)
- postgres 14 (Chatwoot DB)
- redis 7 (Sidekiq + cache)

Volumes persist: storage/, postgres/, redis/

Network: chatwoot-net (isolated)

Reference: https://github.com/chatwoot/chatwoot/blob/develop/docker-compose.production.yaml
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
mkdir -p /opt/chatwoot
cd /opt/chatwoot

echo '═══ STEP 1: Generate secrets ═══'
SECRET_KEY=$(openssl rand -hex 64)
PG_PASS=$(openssl rand -hex 16)
REDIS_PASS=$(openssl rand -hex 16)

echo
echo '═══ STEP 2: Create .env file ═══'
cat > .env <<EOF
# ── Sonder Chatwoot configuration ──
NODE_ENV=production
RAILS_ENV=production
INSTALLATION_NAME=Sonder
INSTALLATION_ENV=docker
FRONTEND_URL=https://chat.sondervn.com
DEFAULT_LOCALE=vi
FORCE_SSL=false
ENABLE_ACCOUNT_SIGNUP=false

# ── Secrets ──
SECRET_KEY_BASE=${SECRET_KEY}

# ── Postgres ──
POSTGRES_HOST=postgres
POSTGRES_USERNAME=postgres
POSTGRES_PASSWORD=${PG_PASS}
POSTGRES_DATABASE=chatwoot
POSTGRES_PORT=5432
POSTGRES_STATEMENT_TIMEOUT=14000

# ── Redis ──
REDIS_URL=redis://default:${REDIS_PASS}@redis:6379
REDIS_PASSWORD=${REDIS_PASS}
REDIS_OPENSSL_VERIFY_MODE=none

# ── Mailer (config via UI later or Mailgun/SES) ──
MAILER_SENDER_EMAIL=Sonder Bot <noreply@sondervn.com>
SMTP_DOMAIN=sondervn.com
SMTP_ADDRESS=
SMTP_PORT=587
SMTP_USERNAME=
SMTP_PASSWORD=
SMTP_AUTHENTICATION=plain
SMTP_ENABLE_STARTTLS_AUTO=true
SMTP_OPENSSL_VERIFY_MODE=peer

# ── Storage local (no S3 cần thiết cho boutique scale) ──
ACTIVE_STORAGE_SERVICE=local

# ── Translations cache ──
RAILS_INLINE_ASSET_REQUESTS_ASYNC=true

# ── Disable telemetry ──
DISABLE_TELEMETRY=true
EOF

chmod 600 .env

echo
echo '═══ STEP 3: Create docker-compose.yml ═══'
cat > docker-compose.yml <<'YAML'
# Sonder Chatwoot — Docker Compose production
# License: MIT (Chatwoot OSS)
# Tự chủ kỹ thuật — code 100% own, no vendor lock-in
networks:
  chatwoot-net:
    driver: bridge

volumes:
  postgres_data:
  redis_data:
  chatwoot_storage:

services:
  postgres:
    image: postgres:14-alpine
    container_name: chatwoot-postgres
    restart: unless-stopped
    networks: [chatwoot-net]
    environment:
      - POSTGRES_DB=chatwoot
      - POSTGRES_USER=postgres
      - POSTGRES_PASSWORD=${POSTGRES_PASSWORD}
    volumes:
      - postgres_data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres"]
      interval: 10s
      timeout: 5s
      retries: 5

  redis:
    image: redis:7-alpine
    container_name: chatwoot-redis
    restart: unless-stopped
    networks: [chatwoot-net]
    command: ["sh", "-c", "redis-server --requirepass ${REDIS_PASSWORD}"]
    volumes:
      - redis_data:/data
    healthcheck:
      test: ["CMD-SHELL", "redis-cli -a ${REDIS_PASSWORD} ping"]
      interval: 10s
      timeout: 5s
      retries: 5

  rails:
    image: chatwoot/chatwoot:v4.5.2
    container_name: chatwoot-rails
    restart: unless-stopped
    networks: [chatwoot-net]
    ports:
      - "127.0.0.1:3001:3000"   # bind localhost only — nginx reverse proxy
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_healthy
    env_file: .env
    volumes:
      - chatwoot_storage:/app/storage
    entrypoint: docker/entrypoints/rails.sh
    command: ["bundle", "exec", "rails", "s", "-p", "3000", "-b", "0.0.0.0"]
    healthcheck:
      test: ["CMD-SHELL", "wget --no-verbose --tries=1 --spider http://localhost:3000/api || exit 1"]
      interval: 30s
      timeout: 10s
      retries: 5
      start_period: 90s

  sidekiq:
    image: chatwoot/chatwoot:v4.5.2
    container_name: chatwoot-sidekiq
    restart: unless-stopped
    networks: [chatwoot-net]
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_healthy
    env_file: .env
    volumes:
      - chatwoot_storage:/app/storage
    command: ["bundle", "exec", "sidekiq", "-C", "config/sidekiq.yml"]
YAML

echo
echo '═══ STEP 4: Pull images (this takes 2-3 min)... ═══'
docker compose pull 2>&1 | tail -10

echo
echo '═══ STEP 5: Initialize Chatwoot DB (run once) ═══'
docker compose run --rm rails bundle exec rails db:chatwoot_prepare 2>&1 | tail -20

echo
echo '═══ STEP 6: Start all services ═══'
docker compose up -d

echo
echo '═══ STEP 7: Wait for health (30s) ═══'
sleep 30
docker compose ps

echo
echo '═══ STEP 8: Test internal endpoint ═══'
curl -s -o /dev/null -w 'HTTP %{http_code} (response time: %{time_total}s)\n' http://127.0.0.1:3001/

echo
echo '═══ DONE — Next steps ═══'
echo '1. Anh add DNS A record: chat.sondervn.com → 103.82.193.74'
echo '2. Em sẽ setup nginx reverse proxy + Lets Encrypt cert'
echo '3. Anh truy cập https://chat.sondervn.com để tạo admin account'
echo
echo 'Internal access (tạm test): http://103.82.193.74:3001 (chỉ localhost qua SSH tunnel)'
echo 'Secret backup: /opt/chatwoot/.env (chmod 600)'
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

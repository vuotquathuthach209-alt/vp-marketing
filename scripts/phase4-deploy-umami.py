"""PHASE 4: Deploy Umami analytics + DNS watcher analytics.sondervn.com.

Reference: skill sonder-tech-sovereignty (Umami MIT chosen over Plausible AGPL)

Components:
- umami-app (Next.js, port 3033 internal)
- umami-db (Postgres 14, dedicated)

Auto-deploy when DNS resolves: certbot + nginx with Authelia forward auth.
"""
import sys, paramiko, secrets, hashlib

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

HOST = "103.82.193.74"
USER = "root"
PASSWORD = "cCxEvKZ0J3Ee6NJG"

PG_PASS = secrets.token_hex(16)
APP_SECRET = secrets.token_hex(32)
HASH_SALT = secrets.token_hex(16)

DOCKER_COMPOSE = f"""networks:
  umami-net:
    driver: bridge

volumes:
  umami_db:

services:
  db:
    image: postgres:14-alpine
    container_name: umami-db
    restart: unless-stopped
    networks: [umami-net]
    environment:
      - POSTGRES_USER=umami
      - POSTGRES_PASSWORD={PG_PASS}
      - POSTGRES_DB=umami
    volumes:
      - umami_db:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U umami"]
      interval: 10s
      timeout: 5s
      retries: 5

  app:
    image: ghcr.io/umami-software/umami:postgresql-v2.20.4
    container_name: umami-app
    restart: unless-stopped
    networks: [umami-net]
    ports:
      - "127.0.0.1:3033:3000"
    depends_on:
      db:
        condition: service_healthy
    environment:
      - DATABASE_URL=postgresql://umami:{PG_PASS}@db:5432/umami
      - DATABASE_TYPE=postgresql
      - APP_SECRET={APP_SECRET}
      - HASH_SALT={HASH_SALT}
      - DISABLE_TELEMETRY=1
      - DISABLE_UPDATES=1
      - REMOVE_TRAILING_SLASH=1
      - TZ=Asia/Ho_Chi_Minh
"""

WATCHER = '''#!/bin/bash
LOG=/var/log/sonder-analytics-deploy.log
LOCK=/var/run/sonder-analytics-deploy.lock
exec 200>$LOCK
flock -n 200 || exit 1
log() { echo "[$(date -Is)] $*" | tee -a $LOG; }

log "=== analytics.sondervn.com watcher started ==="

while true; do
  R=$(dig +short analytics.sondervn.com @8.8.8.8 | head -1)
  if [ "$R" = "103.82.193.74" ]; then
    log "DNS resolved!"
    break
  fi
  log "Not resolved (got: $R). Sleep 2 min."
  sleep 120
done

cat > /etc/nginx/sites-available/analytics.sondervn.com <<NGEOF
server {
    listen 80;
    listen [::]:80;
    server_name analytics.sondervn.com;
    location /.well-known/acme-challenge/ { root /var/www/html; }
    location / { return 301 https://\\$host\\$request_uri; }
}
NGEOF
ln -sf /etc/nginx/sites-available/analytics.sondervn.com /etc/nginx/sites-enabled/analytics.sondervn.com
nginx -t && nginx -s reload

certbot --nginx -d analytics.sondervn.com --non-interactive --agree-tos -m admin@sondervn.com --no-eff-email --redirect 2>&1 | tee -a $LOG

if [ ! -f /etc/letsencrypt/live/analytics.sondervn.com/fullchain.pem ]; then
  log "ERROR: certbot failed"; exit 1
fi
log "Cert obtained"

cat > /etc/nginx/sites-available/analytics.sondervn.com <<NGEOF2
server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name analytics.sondervn.com;

    ssl_certificate /etc/letsencrypt/live/analytics.sondervn.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/analytics.sondervn.com/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;

    client_max_body_size 50M;

    # Authelia subrequest
    location /authelia {
        internal;
        proxy_pass http://127.0.0.1:9091/api/verify;
        proxy_pass_request_body off;
        proxy_set_header Content-Length "";
        proxy_set_header X-Original-URL \\$scheme://\\$http_host\\$request_uri;
        proxy_set_header X-Original-Method \\$request_method;
        proxy_set_header X-Forwarded-Method \\$request_method;
        proxy_set_header X-Forwarded-Proto \\$scheme;
        proxy_set_header X-Forwarded-Host \\$http_host;
        proxy_set_header X-Forwarded-URI \\$request_uri;
        proxy_set_header X-Forwarded-For \\$remote_addr;
        proxy_set_header Connection "";
        proxy_set_header Cookie \\$http_cookie;
    }

    # Tracker script + ingest API (must be public for guests' browsers)
    location ~ ^/(api/send|script\\.js|sondervn\\.js) {
        proxy_pass http://127.0.0.1:3033;
        proxy_http_version 1.1;
        proxy_set_header Host \\$host;
        proxy_set_header X-Real-IP \\$remote_addr;
        proxy_set_header X-Forwarded-For \\$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \\$scheme;

        # CORS for tracker calls from sondervn.com
        add_header Access-Control-Allow-Origin "https://sondervn.com" always;
        add_header Access-Control-Allow-Methods "POST, GET, OPTIONS" always;
        add_header Access-Control-Allow-Headers "Content-Type" always;
    }

    # Admin UI gated by Authelia
    location / {
        auth_request /authelia;
        auth_request_set \\$target_url \\$scheme://\\$http_host\\$request_uri;
        error_page 401 =302 https://auth.sondervn.com/?rd=\\$target_url;

        proxy_pass http://127.0.0.1:3033;
        proxy_http_version 1.1;
        proxy_set_header Host \\$host;
        proxy_set_header X-Real-IP \\$remote_addr;
        proxy_set_header X-Forwarded-For \\$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \\$scheme;
        proxy_redirect off;
    }
}

server {
    listen 80;
    listen [::]:80;
    server_name analytics.sondervn.com;
    return 301 https://\\$host\\$request_uri;
}
NGEOF2

nginx -t && nginx -s reload
log "Production nginx active"

log "=== analytics.sondervn.com READY ==="
log "Anh login: https://analytics.sondervn.com (Authelia gate)"
log "Then Umami: admin / umami (default — change immediately)"

crontab -l 2>/dev/null | grep -v "sonder-analytics-watcher" | crontab -
rm -f /usr/local/bin/sonder-analytics-watcher.sh
log "Watcher self-disabled"
'''

CMD = f'''
set -e
mkdir -p /opt/umami
cd /opt/umami

cat > docker-compose.yml <<COMPOSE_EOF
{DOCKER_COMPOSE}
COMPOSE_EOF

echo === Pull images ===
docker compose pull 2>&1 | tail -5

echo
echo === Start ===
docker compose up -d
sleep 25
docker compose ps

echo
echo === Test ===
curl -sI --max-time 5 http://127.0.0.1:3033/ | head -3

echo
echo === Setup DNS watcher ===
cat > /usr/local/bin/sonder-analytics-watcher.sh <<"WATCHER_EOF"
{WATCHER}
WATCHER_EOF
chmod +x /usr/local/bin/sonder-analytics-watcher.sh
touch /var/log/sonder-analytics-deploy.log
nohup /usr/local/bin/sonder-analytics-watcher.sh > /dev/null 2>&1 &
echo "Watcher PID: $!"
sleep 2
tail -3 /var/log/sonder-analytics-deploy.log
'''

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, username=USER, password=PASSWORD, timeout=15, look_for_keys=False, allow_agent=False)

stdin, stdout, stderr = client.exec_command(CMD, timeout=300, get_pty=True)
print(stdout.read().decode("utf-8", errors="replace"))
err = stderr.read().decode("utf-8", errors="replace")
if err.strip(): print("STDERR:", err, file=sys.stderr)
client.close()

print(f"\n>>> APP_SECRET: {APP_SECRET[:20]}... (saved in container)")
print(f">>> PG_PASS: {PG_PASS[:16]}... (saved in container)")

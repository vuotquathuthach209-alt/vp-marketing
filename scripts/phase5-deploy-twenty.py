"""PHASE 5: Deploy Twenty CRM v0.32+ — modern guest CRM cho Sonder.

Reference: skill sonder-tech-sovereignty (Twenty CRM AGPLv3 chosen over EspoCRM/Salesforce)

Components:
- twenty-server (NestJS, port 3066 internal)
- twenty-worker (background jobs)
- twenty-db (Postgres 16)
- twenty-redis (separate from email queue Redis)

Auto-deploy when DNS resolves: certbot + nginx with Authelia forward auth.
"""
import sys, paramiko, secrets, base64

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

HOST = "103.82.193.74"
USER = "root"
PASSWORD = "cCxEvKZ0J3Ee6NJG"

PG_PASS = secrets.token_hex(16)
APP_SECRET = base64.b64encode(secrets.token_bytes(32)).decode()
SIGNED_FILE_TOKEN = base64.b64encode(secrets.token_bytes(32)).decode()
LOGIN_TOKEN = base64.b64encode(secrets.token_bytes(32)).decode()
REFRESH_TOKEN = base64.b64encode(secrets.token_bytes(32)).decode()
ACCESS_TOKEN = base64.b64encode(secrets.token_bytes(32)).decode()

DOCKER_COMPOSE = f"""networks:
  twenty-net:
    driver: bridge

volumes:
  twenty_db:
  twenty_data:

services:
  db:
    image: postgres:16-alpine
    container_name: twenty-db
    restart: unless-stopped
    networks: [twenty-net]
    environment:
      - POSTGRES_USER=twenty
      - POSTGRES_PASSWORD={PG_PASS}
      - POSTGRES_DB=twenty
    volumes:
      - twenty_db:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U twenty"]
      interval: 10s
      timeout: 5s
      retries: 5

  redis:
    image: redis:7-alpine
    container_name: twenty-redis
    restart: unless-stopped
    networks: [twenty-net]
    command: ["sh", "-c", "redis-server --appendonly yes"]

  server:
    image: twentycrm/twenty:latest
    container_name: twenty-server
    restart: unless-stopped
    networks: [twenty-net]
    ports:
      - "127.0.0.1:3066:3000"
    depends_on:
      db:
        condition: service_healthy
    environment:
      - PG_DATABASE_URL=postgres://twenty:{PG_PASS}@db:5432/twenty
      - REDIS_URL=redis://redis:6379
      - SERVER_URL=https://crm.sondervn.com
      - APP_SECRET={APP_SECRET}
      - SIGN_IN_PREFILLED=true
      - IS_BILLING_ENABLED=false
      - STORAGE_TYPE=local
      - SIGNED_FILE_TOKEN_SECRET={SIGNED_FILE_TOKEN}
      - LOGIN_TOKEN_SECRET={LOGIN_TOKEN}
      - REFRESH_TOKEN_SECRET={REFRESH_TOKEN}
      - ACCESS_TOKEN_SECRET={ACCESS_TOKEN}
      - DISABLE_DB_MIGRATIONS=false
      - TZ=Asia/Ho_Chi_Minh
    volumes:
      - twenty_data:/app/packages/twenty-server/.local-storage

  worker:
    image: twentycrm/twenty:latest
    container_name: twenty-worker
    restart: unless-stopped
    networks: [twenty-net]
    depends_on:
      db:
        condition: service_healthy
      server:
        condition: service_started
    environment:
      - PG_DATABASE_URL=postgres://twenty:{PG_PASS}@db:5432/twenty
      - REDIS_URL=redis://redis:6379
      - SERVER_URL=https://crm.sondervn.com
      - APP_SECRET={APP_SECRET}
      - DISABLE_DB_MIGRATIONS=true
      - SIGNED_FILE_TOKEN_SECRET={SIGNED_FILE_TOKEN}
      - LOGIN_TOKEN_SECRET={LOGIN_TOKEN}
      - REFRESH_TOKEN_SECRET={REFRESH_TOKEN}
      - ACCESS_TOKEN_SECRET={ACCESS_TOKEN}
      - STORAGE_TYPE=local
      - TZ=Asia/Ho_Chi_Minh
    command: ["yarn", "worker:prod"]
    volumes:
      - twenty_data:/app/packages/twenty-server/.local-storage
"""

WATCHER = '''#!/bin/bash
LOG=/var/log/sonder-crm-deploy.log
LOCK=/var/run/sonder-crm-deploy.lock
exec 200>$LOCK
flock -n 200 || exit 1
log() { echo "[$(date -Is)] $*" | tee -a $LOG; }

log "=== crm.sondervn.com watcher started ==="

while true; do
  R=$(dig +short crm.sondervn.com @8.8.8.8 | head -1)
  if [ "$R" = "103.82.193.74" ]; then
    log "DNS resolved!"
    break
  fi
  log "Not resolved (got: $R). Sleep 2 min."
  sleep 120
done

cat > /etc/nginx/sites-available/crm.sondervn.com <<NGEOF
server {
    listen 80;
    listen [::]:80;
    server_name crm.sondervn.com;
    location /.well-known/acme-challenge/ { root /var/www/html; }
    location / { return 301 https://$host$request_uri; }
}
NGEOF
ln -sf /etc/nginx/sites-available/crm.sondervn.com /etc/nginx/sites-enabled/crm.sondervn.com
nginx -t && nginx -s reload

certbot --nginx -d crm.sondervn.com --non-interactive --agree-tos -m admin@sondervn.com --no-eff-email --redirect 2>&1 | tee -a $LOG

if [ ! -f /etc/letsencrypt/live/crm.sondervn.com/fullchain.pem ]; then
  log "ERROR certbot fail"; exit 1
fi
log "Cert OK"

cat > /etc/nginx/sites-available/crm.sondervn.com <<'NGEOF2'
server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name crm.sondervn.com;

    ssl_certificate /etc/letsencrypt/live/crm.sondervn.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/crm.sondervn.com/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;

    client_max_body_size 100M;

    location /authelia {
        internal;
        proxy_pass http://127.0.0.1:9091/api/verify;
        proxy_pass_request_body off;
        proxy_set_header Content-Length "";
        proxy_set_header X-Original-URL $scheme://$http_host$request_uri;
        proxy_set_header X-Original-Method $request_method;
        proxy_set_header X-Forwarded-Method $request_method;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Host $http_host;
        proxy_set_header X-Forwarded-URI $request_uri;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header Connection "";
        proxy_set_header Cookie $http_cookie;
    }

    # API endpoints (programmatic access — bypass Authelia cho future bridge)
    location /api {
        proxy_pass http://127.0.0.1:3066;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location /graphql {
        proxy_pass http://127.0.0.1:3066;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # Admin UI gated by Authelia
    location / {
        auth_request /authelia;
        auth_request_set $target_url $scheme://$http_host$request_uri;
        error_page 401 =302 https://auth.sondervn.com/?rd=$target_url;

        proxy_pass http://127.0.0.1:3066;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_redirect off;
        proxy_buffering off;
        proxy_read_timeout 300s;
    }
}

server {
    listen 80;
    listen [::]:80;
    server_name crm.sondervn.com;
    return 301 https://$host$request_uri;
}
NGEOF2

nginx -t && nginx -s reload
log "Production nginx active"
log "=== crm.sondervn.com READY ==="
log "Anh login: https://crm.sondervn.com (Authelia gate)"
log "Then signup: form on first visit (no admin pre-created)"

crontab -l 2>/dev/null | grep -v "sonder-crm-watcher" | crontab -
rm -f /usr/local/bin/sonder-crm-watcher.sh
log "Watcher self-disabled"
'''

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, username=USER, password=PASSWORD, timeout=15, look_for_keys=False, allow_agent=False)

# Upload docker-compose via SFTP
sftp = client.open_sftp()
try:
    sftp.mkdir('/opt/twenty')
except: pass
with sftp.open('/opt/twenty/docker-compose.yml', 'w') as f:
    f.write(DOCKER_COMPOSE)
with sftp.open('/usr/local/bin/sonder-crm-watcher.sh', 'w') as f:
    f.write(WATCHER)
sftp.chmod('/usr/local/bin/sonder-crm-watcher.sh', 0o755)
sftp.close()
print('docker-compose + watcher uploaded')

# Pull + start
cmd = '''
cd /opt/twenty
docker compose pull 2>&1 | tail -5
docker compose up -d
sleep 30
docker compose ps
echo
echo === Test internal ===
curl -sI --max-time 10 http://127.0.0.1:3066/healthz 2>&1 | head -3
echo
echo === Start watcher ===
touch /var/log/sonder-crm-deploy.log
nohup /usr/local/bin/sonder-crm-watcher.sh > /dev/null 2>&1 &
echo "Watcher PID: $!"
sleep 2
tail -3 /var/log/sonder-crm-deploy.log
'''
stdin, stdout, stderr = client.exec_command(cmd, timeout=420, get_pty=True)
print(stdout.read().decode("utf-8", errors="replace"))
err = stderr.read().decode("utf-8", errors="replace")
if err.strip(): print("STDERR:", err, file=sys.stderr)

client.close()

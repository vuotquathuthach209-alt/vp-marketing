"""V5 Day 2: Deploy GrowthBook A/B testing platform.

Reference: skill sonder-content-v5 (3 hook variants per post via GrowthBook)

Components:
- growthbook-app (frontend Next.js)
- growthbook-api (backend Node.js)
- growthbook-mongo (data store)
- growthbook-redis (cache)

Public URL: https://gb.sondervn.com (sau khi anh add DNS)
Auth: qua Authelia gate (skill sonder-sso-identity)
"""
import sys, paramiko, secrets

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

HOST = "103.82.193.74"
USER = "root"
PASSWORD = "cCxEvKZ0J3Ee6NJG"

JWT_SECRET = secrets.token_hex(32)
ENCRYPTION_KEY = secrets.token_hex(32)
MONGO_PASS = secrets.token_hex(16)

DOCKER_COMPOSE = f"""networks:
  growthbook-net:
    driver: bridge

volumes:
  growthbook_mongo:
  growthbook_uploads:

services:
  mongo:
    image: mongo:6
    container_name: growthbook-mongo
    restart: unless-stopped
    networks: [growthbook-net]
    environment:
      - MONGO_INITDB_ROOT_USERNAME=root
      - MONGO_INITDB_ROOT_PASSWORD={MONGO_PASS}
    volumes:
      - growthbook_mongo:/data/db

  growthbook:
    image: growthbook/growthbook:latest
    container_name: growthbook-app
    restart: unless-stopped
    networks: [growthbook-net]
    ports:
      - "127.0.0.1:3077:3000"   # frontend
      - "127.0.0.1:3088:3100"   # API
    depends_on:
      - mongo
    environment:
      - NODE_ENV=production
      - JWT_SECRET={JWT_SECRET}
      - ENCRYPTION_KEY={ENCRYPTION_KEY}
      - MONGODB_URI=mongodb://root:{MONGO_PASS}@mongo:27017/growthbook?authSource=admin
      - APP_ORIGIN=https://gb.sondervn.com
      - API_HOST=https://gb.sondervn.com
      - TZ=Asia/Ho_Chi_Minh
    volumes:
      - growthbook_uploads:/usr/local/src/app/packages/back-end/uploads
"""

WATCHER = '''#!/bin/bash
LOG=/var/log/sonder-gb-deploy.log
LOCK=/var/run/sonder-gb-deploy.lock
exec 200>$LOCK
flock -n 200 || exit 1
log() { echo "[$(date -Is)] $*" | tee -a $LOG; }

log "=== gb.sondervn.com watcher started ==="

while true; do
  R=$(dig +short gb.sondervn.com @8.8.8.8 | head -1)
  if [ "$R" = "103.82.193.74" ]; then
    log "DNS resolved!"
    break
  fi
  log "Not resolved (got: $R). Sleep 2 min."
  sleep 120
done

cat > /etc/nginx/sites-available/gb.sondervn.com <<NGEOF
server {
    listen 80;
    listen [::]:80;
    server_name gb.sondervn.com;
    location /.well-known/acme-challenge/ { root /var/www/html; }
    location / { return 301 https://$host$request_uri; }
}
NGEOF
ln -sf /etc/nginx/sites-available/gb.sondervn.com /etc/nginx/sites-enabled/gb.sondervn.com
nginx -t && nginx -s reload

certbot --nginx -d gb.sondervn.com --non-interactive --agree-tos -m admin@sondervn.com --no-eff-email --redirect 2>&1 | tee -a $LOG

if [ ! -f /etc/letsencrypt/live/gb.sondervn.com/fullchain.pem ]; then
  log "ERROR certbot fail"; exit 1
fi
log "Cert OK"

cat > /etc/nginx/sites-available/gb.sondervn.com <<'NGEOF2'
server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name gb.sondervn.com;

    ssl_certificate /etc/letsencrypt/live/gb.sondervn.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/gb.sondervn.com/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;

    client_max_body_size 50M;

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

    # SDK endpoints (no auth — vp-marketing tracking)
    location ~ ^/(api/v1|api/features|api/eval) {
        proxy_pass http://127.0.0.1:3088;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        add_header Access-Control-Allow-Origin "*" always;
        add_header Access-Control-Allow-Methods "POST, GET, OPTIONS" always;
    }

    # Admin UI gated by Authelia
    location / {
        auth_request /authelia;
        auth_request_set $target_url $scheme://$http_host$request_uri;
        error_page 401 =302 https://auth.sondervn.com/?rd=$target_url;

        proxy_pass http://127.0.0.1:3077;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_redirect off;
    }
}

server {
    listen 80;
    listen [::]:80;
    server_name gb.sondervn.com;
    return 301 https://$host$request_uri;
}
NGEOF2

nginx -t && nginx -s reload
log "GrowthBook public LIVE"
log "Anh login: https://gb.sondervn.com (Authelia gate → signup form)"
crontab -l 2>/dev/null | grep -v "sonder-gb-watcher" | crontab -
rm -f /usr/local/bin/sonder-gb-watcher.sh
log "Watcher self-disabled"
'''

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, username=USER, password=PASSWORD, timeout=15, look_for_keys=False, allow_agent=False)

# Upload via SFTP (avoid bash escape issues)
sftp = client.open_sftp()
try:
    sftp.mkdir('/opt/growthbook')
except: pass
with sftp.open('/opt/growthbook/docker-compose.yml', 'w') as f:
    f.write(DOCKER_COMPOSE)
with sftp.open('/usr/local/bin/sonder-gb-watcher.sh', 'w') as f:
    f.write(WATCHER)
sftp.chmod('/usr/local/bin/sonder-gb-watcher.sh', 0o755)
sftp.close()
print('Files uploaded')

cmd = '''
cd /opt/growthbook
echo === Pull images ===
docker compose pull 2>&1 | tail -5
echo
echo === Start ===
docker compose up -d
sleep 15
docker compose ps
echo
echo === Test internal ===
curl -sI --max-time 10 http://127.0.0.1:3077/ 2>&1 | head -3
curl -sI --max-time 10 http://127.0.0.1:3088/ 2>&1 | head -3
echo
echo === Start DNS watcher ===
touch /var/log/sonder-gb-deploy.log
nohup /usr/local/bin/sonder-gb-watcher.sh > /dev/null 2>&1 &
echo "Watcher PID: $!"
sleep 2
tail -3 /var/log/sonder-gb-deploy.log
'''

stdin, stdout, stderr = client.exec_command(cmd, timeout=300, get_pty=True)
print(stdout.read().decode("utf-8", errors="replace"))
client.close()

print(f"\n>>> JWT_SECRET: {JWT_SECRET[:20]}... (saved in container env)")
print(f">>> MONGO_PASS: {MONGO_PASS[:16]}...")

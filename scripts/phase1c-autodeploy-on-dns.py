"""PHASE 1C AUTOMATED: Deploy autorun watcher trên VPS.

Watcher polls DNS chat.sondervn.com every 2 min. When resolves:
  1. Stop old Chatwoot localhost binding
  2. Update Chatwoot env: FRONTEND_URL=https://chat.sondervn.com
  3. Write nginx config for chat.sondervn.com
  4. Run certbot --nginx -d chat.sondervn.com
  5. Recreate rails container
  6. Test public URL
  7. Write status to /var/log/sonder-chat-deploy.log
  8. Self-disable (run once)
"""
import sys, paramiko

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

HOST = "103.82.193.74"
USER = "root"
PASSWORD = "cCxEvKZ0J3Ee6NJG"

WATCHER_SCRIPT = '''#!/bin/bash
# Sonder Chatwoot DNS watcher + auto-deploy
# Polls chat.sondervn.com every 2 min, when resolves runs full setup

LOG=/var/log/sonder-chat-deploy.log
LOCK=/var/run/sonder-chat-deploy.lock

exec 200>$LOCK
flock -n 200 || exit 1

log() { echo "[$(date -Is)] $*" | tee -a $LOG; }

log "=== Sonder Chatwoot DNS watcher started ==="

while true; do
  RESOLVED=$(dig +short chat.sondervn.com @8.8.8.8 | head -1)
  if [ "$RESOLVED" = "103.82.193.74" ]; then
    log "DNS resolved! chat.sondervn.com -> $RESOLVED"
    break
  fi
  log "DNS not yet resolved (got: '$RESOLVED'). Sleeping 2 min..."
  sleep 120
done

log "=== Starting auto-deploy ==="

# Step 1: Write nginx HTTP-only config (for ACME challenge)
log "Writing nginx config (HTTP only for cert)..."
cat > /etc/nginx/sites-available/chat.sondervn.com <<NGINX_EOF
server {
    listen 80;
    listen [::]:80;
    server_name chat.sondervn.com;

    location /.well-known/acme-challenge/ {
        root /var/www/html;
    }

    location / {
        return 301 https://\\$host\\$request_uri;
    }
}
NGINX_EOF

ln -sf /etc/nginx/sites-available/chat.sondervn.com /etc/nginx/sites-enabled/chat.sondervn.com
mkdir -p /var/www/html/.well-known/acme-challenge
nginx -t && nginx -s reload
log "nginx HTTP-only ready"

# Step 2: Run certbot
log "Running certbot --nginx -d chat.sondervn.com..."
certbot --nginx -d chat.sondervn.com --non-interactive --agree-tos -m admin@sondervn.com --no-eff-email --redirect 2>&1 | tee -a $LOG

if [ ! -f /etc/letsencrypt/live/chat.sondervn.com/fullchain.pem ]; then
  log "ERROR: certbot failed — cert not obtained"
  exit 1
fi

log "Cert obtained successfully"

# Step 3: Write production nginx config with proxy
log "Writing production nginx config..."
cat > /etc/nginx/sites-available/chat.sondervn.com <<NGINX_PROD_EOF
server {
    server_name chat.sondervn.com;
    client_max_body_size 100M;

    location /cable {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \\$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \\$host;
        proxy_set_header X-Real-IP \\$remote_addr;
        proxy_set_header X-Forwarded-For \\$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \\$scheme;
        proxy_buffering off;
        proxy_read_timeout 36000s;
    }

    location / {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Host \\$host;
        proxy_set_header X-Real-IP \\$remote_addr;
        proxy_set_header X-Forwarded-For \\$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \\$scheme;
        proxy_redirect off;
        proxy_buffering off;
        proxy_read_timeout 90s;
    }

    listen [::]:443 ssl ipv6only=on;
    listen 443 ssl;
    ssl_certificate /etc/letsencrypt/live/chat.sondervn.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/chat.sondervn.com/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;
}

server {
    if (\\$host = chat.sondervn.com) {
        return 301 https://\\$host\\$request_uri;
    }
    listen 80;
    listen [::]:80;
    server_name chat.sondervn.com;
    return 404;
}
NGINX_PROD_EOF

nginx -t && nginx -s reload
log "Production nginx config active"

# Step 4: Update Chatwoot env to point to chat.sondervn.com
log "Updating Chatwoot env..."
cd /opt/chatwoot
sed -i "s|^FRONTEND_URL=.*|FRONTEND_URL=https://chat.sondervn.com|" .env
sed -i "/^RAILS_RELATIVE_URL_ROOT=/d" .env
sed -i "s|^FORCE_SSL=.*|FORCE_SSL=false|" .env
log "env updated"

# Step 5: Recreate rails + sidekiq
log "Recreating Chatwoot containers..."
docker compose up -d --no-deps --force-recreate rails sidekiq

# Wait for healthy
log "Waiting for rails healthy (max 120s)..."
for i in $(seq 1 24); do
  H=$(docker inspect --format="{{.State.Health.Status}}" chatwoot-rails 2>/dev/null)
  log "  attempt $i: rails=$H"
  [ "$H" = "healthy" ] && break
  sleep 5
done

# Step 6: Public test
log "Public test:"
curl -sI --max-time 10 https://chat.sondervn.com/ 2>&1 | head -5 | tee -a $LOG
curl -s --max-time 10 https://chat.sondervn.com/api 2>&1 | head -c 300 | tee -a $LOG
echo "" >> $LOG

log "=== AUTO-DEPLOY COMPLETE ==="
log "Chatwoot URL: https://chat.sondervn.com/"
log "Anh truy cập URL trên để tạo admin account"

# Self-disable: remove cron entry
crontab -l 2>/dev/null | grep -v "sonder-chat-watcher" | crontab -
rm -f /usr/local/bin/sonder-chat-watcher.sh
log "Watcher self-disabled"
'''

CMD = f'''
set -e

echo "=== Install Python script as watcher ==="
cat > /usr/local/bin/sonder-chat-watcher.sh <<"EOF"
{WATCHER_SCRIPT}
EOF
chmod +x /usr/local/bin/sonder-chat-watcher.sh

echo
echo "=== Verify certbot installed ==="
which certbot || apt-get install -y -qq certbot python3-certbot-nginx

echo
echo "=== Initialize log file ==="
touch /var/log/sonder-chat-deploy.log
chmod 644 /var/log/sonder-chat-deploy.log

echo
echo "=== Launch watcher in background (nohup) ==="
nohup /usr/local/bin/sonder-chat-watcher.sh > /dev/null 2>&1 &
echo "Watcher PID: $!"

sleep 3
echo
echo "=== First log lines ==="
tail -5 /var/log/sonder-chat-deploy.log

echo
echo "=== Status: watcher polling DNS every 2 min ==="
echo "When chat.sondervn.com resolves to 103.82.193.74, full deploy will run automatically."
echo "Tail log to see progress: tail -f /var/log/sonder-chat-deploy.log"
'''

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, username=USER, password=PASSWORD, timeout=15, look_for_keys=False, allow_agent=False)

stdin, stdout, stderr = client.exec_command(CMD, timeout=120, get_pty=True)
print(stdout.read().decode("utf-8", errors="replace"))
err = stderr.read().decode("utf-8", errors="replace")
if err.strip():
    print("STDERR:", err, file=sys.stderr)
client.close()

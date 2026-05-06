"""Setup analytics.sondervn.com watcher (Umami already deployed)."""
import sys, paramiko

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

HOST = "103.82.193.74"
USER = "root"
PASSWORD = "cCxEvKZ0J3Ee6NJG"

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
    location / { return 301 https://$host$request_uri; }
}
NGEOF
ln -sf /etc/nginx/sites-available/analytics.sondervn.com /etc/nginx/sites-enabled/analytics.sondervn.com
nginx -t && nginx -s reload

certbot --nginx -d analytics.sondervn.com --non-interactive --agree-tos -m admin@sondervn.com --no-eff-email --redirect 2>&1 | tee -a $LOG

if [ ! -f /etc/letsencrypt/live/analytics.sondervn.com/fullchain.pem ]; then
  log "ERROR certbot fail"; exit 1
fi
log "Cert OK"

cat > /etc/nginx/sites-available/analytics.sondervn.com <<'NGEOF2'
server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name analytics.sondervn.com;

    ssl_certificate /etc/letsencrypt/live/analytics.sondervn.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/analytics.sondervn.com/privkey.pem;
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

    # Tracker public endpoints (no Authelia gate so guest browsers can ping)
    location ~ ^/(api/send|script\\.js|sondervn\\.js) {
        proxy_pass http://127.0.0.1:3033;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        add_header Access-Control-Allow-Origin "*" always;
        add_header Access-Control-Allow-Methods "POST, GET, OPTIONS" always;
        add_header Access-Control-Allow-Headers "Content-Type" always;
    }

    # Admin UI gated by Authelia
    location / {
        auth_request /authelia;
        auth_request_set $target_url $scheme://$http_host$request_uri;
        error_page 401 =302 https://auth.sondervn.com/?rd=$target_url;

        proxy_pass http://127.0.0.1:3033;
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
    server_name analytics.sondervn.com;
    return 301 https://$host$request_uri;
}
NGEOF2

nginx -t && nginx -s reload
log "Production nginx active"
log "=== analytics.sondervn.com READY ==="
log "Anh login: https://analytics.sondervn.com"
log "Default Umami: admin / umami (CHANGE NGAY khi vào)"

crontab -l 2>/dev/null | grep -v "sonder-analytics-watcher" | crontab -
rm -f /usr/local/bin/sonder-analytics-watcher.sh
log "Watcher self-disabled"
'''

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, username=USER, password=PASSWORD, timeout=15, look_for_keys=False, allow_agent=False)

sftp = client.open_sftp()
with sftp.open('/usr/local/bin/sonder-analytics-watcher.sh', 'w') as f:
    f.write(WATCHER)
sftp.chmod('/usr/local/bin/sonder-analytics-watcher.sh', 0o755)
sftp.close()

cmd = '''
touch /var/log/sonder-analytics-deploy.log
nohup /usr/local/bin/sonder-analytics-watcher.sh > /dev/null 2>&1 &
echo "Watcher PID: $!"
sleep 2
tail -3 /var/log/sonder-analytics-deploy.log
'''

stdin, stdout, stderr = client.exec_command(cmd, timeout=20, get_pty=True)
print(stdout.read().decode("utf-8", errors="replace"))
client.close()

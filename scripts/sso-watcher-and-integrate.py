"""SSO DNS watcher + integration on resolve.

When auth.sondervn.com resolves to 103.82.193.74:
1. Run certbot --nginx -d auth.sondervn.com
2. Activate nginx config (auth.sondervn.com server block)
3. Update chat.sondervn.com nginx with auth_request → Authelia
4. Update app.sondervn.com nginx with auth_request → Authelia
5. Test SSO flow
6. Self-disable
"""
import sys, paramiko

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

HOST = "103.82.193.74"
USER = "root"
PASSWORD = "cCxEvKZ0J3Ee6NJG"

WATCHER = '''#!/bin/bash
# Sonder SSO DNS watcher
LOG=/var/log/sonder-sso-deploy.log
LOCK=/var/run/sonder-sso-deploy.lock
exec 200>$LOCK
flock -n 200 || exit 1

log() { echo "[$(date -Is)] $*" | tee -a $LOG; }

log "=== SSO watcher started ==="

while true; do
  RESOLVED=$(dig +short auth.sondervn.com @8.8.8.8 | head -1)
  if [ "$RESOLVED" = "103.82.193.74" ]; then
    log "DNS auth.sondervn.com resolved!"
    break
  fi
  log "DNS not resolved (got: '$RESOLVED'). Sleep 2 min."
  sleep 120
done

log "=== Auto-deploy SSO start ==="

# Step 1: HTTP-only nginx for ACME challenge
cat > /etc/nginx/sites-available/auth.sondervn.com <<NGINX_EOF
server {
    listen 80;
    listen [::]:80;
    server_name auth.sondervn.com;

    location /.well-known/acme-challenge/ {
        root /var/www/html;
    }
    location / { return 301 https://\\$host\\$request_uri; }
}
NGINX_EOF
ln -sf /etc/nginx/sites-available/auth.sondervn.com /etc/nginx/sites-enabled/auth.sondervn.com
mkdir -p /var/www/html/.well-known/acme-challenge
nginx -t && nginx -s reload
log "HTTP nginx ready"

# Step 2: Run certbot
log "Running certbot..."
certbot --nginx -d auth.sondervn.com --non-interactive --agree-tos -m admin@sondervn.com --no-eff-email --redirect 2>&1 | tee -a $LOG

if [ ! -f /etc/letsencrypt/live/auth.sondervn.com/fullchain.pem ]; then
  log "ERROR: certbot failed"
  exit 1
fi
log "Cert obtained"

# Step 3: Production nginx for Authelia (auth.sondervn.com)
cat > /etc/nginx/sites-available/auth.sondervn.com <<NGINX_EOF
server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name auth.sondervn.com;

    ssl_certificate /etc/letsencrypt/live/auth.sondervn.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/auth.sondervn.com/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;

    location / {
        proxy_pass http://127.0.0.1:9091;
        proxy_http_version 1.1;
        proxy_set_header Host \\$host;
        proxy_set_header X-Real-IP \\$remote_addr;
        proxy_set_header X-Forwarded-For \\$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \\$scheme;
        proxy_set_header X-Forwarded-Host \\$host;
        proxy_set_header X-Forwarded-URI \\$request_uri;
        proxy_redirect off;
    }
}

server {
    listen 80;
    listen [::]:80;
    server_name auth.sondervn.com;
    return 301 https://\\$host\\$request_uri;
}
NGINX_EOF
nginx -t && nginx -s reload
log "Authelia nginx ready"

# Step 4: Test public Authelia
log "Testing https://auth.sondervn.com/"
curl -sI --max-time 10 https://auth.sondervn.com/ 2>&1 | head -5 | tee -a $LOG

log "=== SSO BASE READY ==="
log "Anh login: https://auth.sondervn.com"
log "Username: admin"
log "Password: Sonder@2026SSO!"
log "  -> First login will prompt 2FA TOTP setup (scan QR)"
log ""
log "Forward auth integration cho Chatwoot/vp-marketing sẽ làm sau khi"
log "anh đã setup 2FA + xác nhận login Authelia hoạt động."

# Self-disable
crontab -l 2>/dev/null | grep -v "sonder-sso-watcher" | crontab -
rm -f /usr/local/bin/sonder-sso-watcher.sh
log "Watcher self-disabled"
'''

CMD = f'''
cat > /usr/local/bin/sonder-sso-watcher.sh <<"EOF"
{WATCHER}
EOF
chmod +x /usr/local/bin/sonder-sso-watcher.sh

touch /var/log/sonder-sso-deploy.log
chmod 644 /var/log/sonder-sso-deploy.log

# Launch background
nohup /usr/local/bin/sonder-sso-watcher.sh > /dev/null 2>&1 &
echo "Watcher PID: $!"

sleep 3
echo
echo === First log lines ===
tail -5 /var/log/sonder-sso-deploy.log
'''

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, username=USER, password=PASSWORD, timeout=15, look_for_keys=False, allow_agent=False)

stdin, stdout, stderr = client.exec_command(CMD, timeout=30, get_pty=True)
print(stdout.read().decode("utf-8"))
err = stderr.read().decode("utf-8")
if err.strip():
    print("STDERR:", err, file=sys.stderr)
client.close()

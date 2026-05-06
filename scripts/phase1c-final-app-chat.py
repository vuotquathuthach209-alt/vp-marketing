"""PHASE 1C FINAL: Mount Chatwoot tại https://app.sondervn.com/chat

App.sondervn.com là subdomain DUY NHẤT đang resolve trên project này.
mkt.sondervn.com đã bị xóa DNS, chat.sondervn.com chưa có.

Plan:
1. Revert mkt nginx config về proxy port 3000 (vp-marketing) — không sao vì DNS không hoạt động
2. Set Chatwoot env: RAILS_RELATIVE_URL_ROOT=/chat, FRONTEND_URL=https://app.sondervn.com/chat
3. Recreate rails container
4. Rewrite app.sondervn.com nginx: location /chat + /chat/cable trước location /
5. Reload nginx + test
"""
import sys, paramiko

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

HOST = "103.82.193.74"
USER = "root"
PASSWORD = "cCxEvKZ0J3Ee6NJG"

# New app.sondervn.com config — keep vp-marketing on /, add Chatwoot on /chat
NEW_APP_NGINX = '''server {
    server_name app.sondervn.com;
    client_max_body_size 100M;

    # ── Sonder Chatwoot path-based mount ──
    location /chat/cable {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering off;
        proxy_read_timeout 36000s;
    }

    location /chat {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_redirect off;
        proxy_buffering off;
        proxy_read_timeout 90s;
        client_max_body_size 100m;
    }

    # ── vp-marketing dashboard (existing) ──
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 300s;
    }

    listen [::]:443 ssl; # managed by Certbot
    listen 443 ssl; # managed by Certbot
    ssl_certificate /etc/letsencrypt/live/app.sondervn.com/fullchain.pem; # managed by Certbot
    ssl_certificate_key /etc/letsencrypt/live/app.sondervn.com/privkey.pem; # managed by Certbot
    include /etc/letsencrypt/options-ssl-nginx.conf; # managed by Certbot
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem; # managed by Certbot
}

server {
    if ($host = app.sondervn.com) {
        return 301 https://$host$request_uri;
    }
    listen 80;
    listen [::]:80;
    server_name app.sondervn.com;
    return 404;
}
'''

# Restore mkt.sondervn.com to vp-marketing original (config was kept simple)
ORIG_MKT_NGINX = '''server {
    server_name mkt.sondervn.com;
    client_max_body_size 50M;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 300s;
    }

    listen [::]:443 ssl ipv6only=on; # managed by Certbot
    listen 443 ssl; # managed by Certbot
    ssl_certificate /etc/letsencrypt/live/mkt.sondervn.com/fullchain.pem; # managed by Certbot
    ssl_certificate_key /etc/letsencrypt/live/mkt.sondervn.com/privkey.pem; # managed by Certbot
    include /etc/letsencrypt/options-ssl-nginx.conf; # managed by Certbot
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem; # managed by Certbot
}

server {
    if ($host = mkt.sondervn.com) {
        return 301 https://$host$request_uri;
    }
    listen 80;
    listen [::]:80;
    server_name mkt.sondervn.com;
    return 404;
}
'''

CMD = f"""
set -e
cd /opt/chatwoot

echo '═══ STEP 1: Update Chatwoot .env for /chat prefix ═══'
sed -i 's|^FRONTEND_URL=.*|FRONTEND_URL=https://app.sondervn.com/chat|' .env
grep -q '^RAILS_RELATIVE_URL_ROOT=' .env && \\
  sed -i 's|^RAILS_RELATIVE_URL_ROOT=.*|RAILS_RELATIVE_URL_ROOT=/chat|' .env || \\
  echo 'RAILS_RELATIVE_URL_ROOT=/chat' >> .env
sed -i 's|^FORCE_SSL=.*|FORCE_SSL=false|' .env
echo '--- env vars ---'
grep -E '^(FRONTEND_URL|RAILS_RELATIVE_URL_ROOT|FORCE_SSL)' .env

echo
echo '═══ STEP 2: Recreate rails + sidekiq ═══'
docker compose up -d --no-deps --force-recreate rails sidekiq

echo
echo '═══ STEP 3: Wait for rails healthy ═══'
for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18; do
  H=$(docker inspect --format='{{{{.State.Health.Status}}}}' chatwoot-rails 2>/dev/null)
  echo "[$i] rails=$H"
  [ "$H" = "healthy" ] && break
  sleep 5
done

echo
echo '═══ STEP 4: Internal /chat/api test ═══'
curl -s --max-time 5 -i http://127.0.0.1:3001/chat/api 2>&1 | head -10

echo
echo '═══ STEP 5: Restore mkt.sondervn.com nginx (revert) ═══'
cat > /etc/nginx/sites-available/mkt.sondervn.com <<'NGEOF1'
{ORIG_MKT_NGINX}
NGEOF1

echo
echo '═══ STEP 6: Update app.sondervn.com nginx with /chat mount ═══'
cp /etc/nginx/sites-available/app.sondervn.com /etc/nginx/sites-available/app.sondervn.com.bak.$(date +%s)
cat > /etc/nginx/sites-available/app.sondervn.com <<'NGEOF2'
{NEW_APP_NGINX}
NGEOF2

echo
echo '═══ STEP 7: Test + reload nginx ═══'
nginx -t
nginx -s reload

echo
echo '═══ STEP 8: Public test ═══'
sleep 3
echo '--- HTTPS app.sondervn.com (vp-marketing) ---'
curl -sI --max-time 10 https://app.sondervn.com/ | head -5
echo
echo '--- HTTPS app.sondervn.com/chat (Chatwoot) ---'
curl -sI --max-time 10 https://app.sondervn.com/chat/ | head -8
echo
echo '--- /chat/api JSON ---'
curl -s --max-time 10 https://app.sondervn.com/chat/api | head -c 300; echo

echo
echo '═══ DONE ═══'
echo 'Chatwoot URL: https://app.sondervn.com/chat'
echo 'vp-marketing dashboard: https://app.sondervn.com/ (intact)'
"""

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, username=USER, password=PASSWORD, timeout=15, look_for_keys=False, allow_agent=False)

stdin, stdout, stderr = client.exec_command(CMD, timeout=300, get_pty=True)
print(stdout.read().decode("utf-8", errors="replace"))
err = stderr.read().decode("utf-8", errors="replace")
if err.strip():
    print("STDERR:", err, file=sys.stderr)
client.close()

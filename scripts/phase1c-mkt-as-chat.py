"""PHASE 1C v3: Repurpose mkt.sondervn.com làm Chatwoot subdomain.
Lý do: app.sondervn.com vẫn vp-marketing, mkt.sondervn.com đang trùng với app
(cả 2 đều proxy 3000) → mkt thừa, em dùng làm Chatwoot.

Steps:
1. Revert env path-based (FRONTEND_URL=https://mkt.sondervn.com, remove RAILS_RELATIVE_URL_ROOT)
2. Recreate rails container
3. Rewrite nginx mkt.sondervn.com config: proxy 3000→3001 + WebSocket /cable
4. Reload + test
"""
import sys, paramiko

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

HOST = "103.82.193.74"
USER = "root"
PASSWORD = "cCxEvKZ0J3Ee6NJG"

NEW_NGINX_CONFIG = '''server {
    server_name mkt.sondervn.com;
    client_max_body_size 100M;

    # WebSocket / ActionCable for Chatwoot live chat
    location /cable {
        proxy_pass http://127.0.0.1:3001/cable;
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

    location / {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_redirect off;
        proxy_buffering off;
        proxy_read_timeout 90s;
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

echo '═══ STEP 1: Revert env to subdomain root ═══'
sed -i 's|^FRONTEND_URL=.*|FRONTEND_URL=https://mkt.sondervn.com|' .env
sed -i '/^RAILS_RELATIVE_URL_ROOT=/d' .env
echo '--- Updated env ---'
grep -E '^(FRONTEND_URL|FORCE_SSL|RAILS_RELATIVE_URL_ROOT|INSTALLATION_NAME)' .env

echo
echo '═══ STEP 2: Recreate rails + sidekiq ═══'
docker compose up -d --no-deps --force-recreate rails sidekiq
sleep 60

echo
echo '═══ STEP 3: Test internal endpoint ═══'
curl -s http://127.0.0.1:3001/api | head -c 250; echo
curl -sI http://127.0.0.1:3001/ | head -8

echo
echo '═══ STEP 4: Backup + write new nginx config ═══'
cp /etc/nginx/sites-available/mkt.sondervn.com /etc/nginx/sites-available/mkt.sondervn.com.bak.vpmkt.$(date +%s)

cat > /etc/nginx/sites-available/mkt.sondervn.com <<'NGEOF'
{NEW_NGINX_CONFIG}
NGEOF

echo '--- Test nginx config ---'
nginx -t

echo
echo '═══ STEP 5: Remove old chat.sondervn.com placeholder ═══'
rm -f /etc/nginx/sites-enabled/chat.sondervn.com
nginx -s reload

echo
echo '═══ STEP 6: Public test https://mkt.sondervn.com ═══'
sleep 2
curl -sI https://mkt.sondervn.com/ | head -10
echo
curl -s https://mkt.sondervn.com/api | head -c 300; echo

echo
echo '═══ DONE ═══'
echo 'Chatwoot now at: https://mkt.sondervn.com/'
echo 'vp-marketing dashboard remains at: https://app.sondervn.com/'
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

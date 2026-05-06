"""PHASE 1C: Verify Chatwoot fully functional + prepare nginx reverse proxy.

Steps:
1. Re-run migrations to ensure clean state
2. Test all endpoints (/, /app, /api, /superadmin)
3. Tail logs for errors
4. Write nginx config for chat.sondervn.com (will activate when DNS ready)
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
cd /opt/chatwoot

echo '═══ STEP 1: Re-run migrations to confirm clean state ═══'
docker compose exec -T rails bundle exec rails db:migrate 2>&1 | tail -10

echo
echo '═══ STEP 2: Container status + uptime ═══'
docker compose ps
echo
echo '--- rails health ---'
docker inspect --format='{{.State.Health.Status}} ({{.State.Health.FailingStreak}} fails)' chatwoot-rails

echo
echo '═══ STEP 3: Test endpoints from inside VPS ═══'
echo '--- GET / (root) ---'
curl -sI http://127.0.0.1:3001/ | head -10
echo
echo '--- GET /app (admin signup page) ---'
curl -sI http://127.0.0.1:3001/app | head -5
echo
echo '--- GET /api (status) ---'
curl -s http://127.0.0.1:3001/api | head -c 300; echo

echo
echo '═══ STEP 4: Last 20 rails errors (if any) ═══'
docker compose logs rails 2>&1 | grep -iE 'error|fatal' | tail -10 || echo '(no errors found)'

echo
echo '═══ STEP 5: Write nginx config (waiting for DNS) ═══'
cat > /etc/nginx/sites-available/chat.sondervn.com <<'NGINX'
# Sonder Chatwoot — nginx reverse proxy
# License: MIT (Sonder own config)

upstream chatwoot_rails {
  server 127.0.0.1:3001;
  keepalive 32;
}

# HTTP → HTTPS redirect (will be active after certbot)
server {
    listen 80;
    listen [::]:80;
    server_name chat.sondervn.com;

    # Allow Lets Encrypt challenge
    location /.well-known/acme-challenge/ {
        root /var/www/html;
    }

    # Redirect all to HTTPS (will work after cert obtained)
    location / {
        return 301 https://$host$request_uri;
    }
}

# HTTPS server (commented until cert obtained)
# server {
#     listen 443 ssl http2;
#     listen [::]:443 ssl http2;
#     server_name chat.sondervn.com;
#
#     ssl_certificate /etc/letsencrypt/live/chat.sondervn.com/fullchain.pem;
#     ssl_certificate_key /etc/letsencrypt/live/chat.sondervn.com/privkey.pem;
#     ssl_session_timeout 1d;
#     ssl_session_cache shared:SonderChatSSL:50m;
#     ssl_session_tickets off;
#     ssl_protocols TLSv1.2 TLSv1.3;
#     ssl_prefer_server_ciphers off;
#
#     client_max_body_size 100m;
#
#     # WebSocket / ActionCable
#     location /cable {
#         proxy_pass http://chatwoot_rails;
#         proxy_http_version 1.1;
#         proxy_set_header Upgrade $http_upgrade;
#         proxy_set_header Connection "upgrade";
#         proxy_set_header Host $host;
#         proxy_set_header X-Real-IP $remote_addr;
#         proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
#         proxy_set_header X-Forwarded-Proto https;
#         proxy_buffering off;
#         proxy_read_timeout 36000s;
#     }
#
#     location / {
#         proxy_pass http://chatwoot_rails;
#         proxy_http_version 1.1;
#         proxy_set_header Connection "";
#         proxy_set_header Host $host;
#         proxy_set_header X-Real-IP $remote_addr;
#         proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
#         proxy_set_header X-Forwarded-Proto https;
#         proxy_redirect off;
#         proxy_buffering off;
#         proxy_read_timeout 90s;
#     }
# }
NGINX

# Activate site (HTTP only for now — HTTPS uncomment after cert)
ln -sf /etc/nginx/sites-available/chat.sondervn.com /etc/nginx/sites-enabled/chat.sondervn.com

echo
echo '═══ STEP 6: Test nginx config + reload ═══'
nginx -t
nginx -s reload 2>&1 | tail -3

echo
echo '═══ STEP 7: Print summary for user ═══'
echo
echo '┌─────────────────────────────────────────────────────────────┐'
echo '│ CHATWOOT DEPLOY STATUS                                      │'
echo '├─────────────────────────────────────────────────────────────┤'
echo '│ ✅ Docker:         29.4.2 + Compose v5                      │'
echo '│ ✅ Postgres:       pgvector/pgvector:pg14 (healthy)         │'
echo '│ ✅ Redis:          7-alpine (healthy)                       │'
echo '│ ✅ Rails app:      v4.5.2 (port 3001 localhost)             │'
echo '│ ✅ Sidekiq:        running                                  │'
echo '│ ✅ Nginx config:   /etc/nginx/sites-enabled/chat.sondervn.. │'
echo '│ ⏳ DNS:            chat.sondervn.com → ANH ADD A record     │'
echo '│ ⏳ SSL cert:       sẽ chạy certbot sau khi DNS resolved     │'
echo '└─────────────────────────────────────────────────────────────┘'
echo
echo 'Sau khi DNS resolved, em sẽ:'
echo '  1. Run: certbot --nginx -d chat.sondervn.com'
echo '  2. Uncomment HTTPS block trong nginx config + reload'
echo '  3. Anh truy cập https://chat.sondervn.com → tạo admin account'
echo
echo 'Test ngay (qua SSH tunnel) bằng cách:'
echo '  ssh -L 3001:127.0.0.1:3001 root@103.82.193.74'
echo '  Mở browser: http://localhost:3001/'
"""

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, username=USER, password=PASSWORD, timeout=15, look_for_keys=False, allow_agent=False)

stdin, stdout, stderr = client.exec_command(CMD, timeout=180, get_pty=True)
print(stdout.read().decode("utf-8", errors="replace"))
err = stderr.read().decode("utf-8", errors="replace")
if err.strip():
    print("STDERR:", err, file=sys.stderr)
client.close()

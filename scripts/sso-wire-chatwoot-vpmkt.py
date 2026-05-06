"""Wire Chatwoot + vp-marketing nginx with Authelia forward auth.

Strategy:
- Add `auth_request /authelia` directive to existing nginx blocks
- On 401 → redirect to https://auth.sondervn.com/?rd=<original_url>
- After Authelia login → user comes back authenticated
- App's own login still applies (Chatwoot has internal login)
  but anh just remember password via browser

This is "URL gate" approach — Authelia controls WHO accesses the URL.
Inside the app, Chatwoot's own auth still applies (2-layer security).
"""
import sys, paramiko

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

HOST = "103.82.193.74"
USER = "root"
PASSWORD = "cCxEvKZ0J3Ee6NJG"

# Updated chat.sondervn.com config — adds Authelia gate
CHAT_NGINX = """server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name chat.sondervn.com;

    ssl_certificate /etc/letsencrypt/live/chat.sondervn.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/chat.sondervn.com/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;

    client_max_body_size 100M;

    # Authelia auth_request endpoint (internal subrequest)
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

    # WebSocket — Authelia doesn't gate WebSocket (uses cookie from gate)
    location /cable {
        # Skip auth_request for WebSocket — it shares cookie session
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

    # API endpoints — Chatwoot API uses tokens, not user session — skip Authelia
    # to allow programmatic access from vp-marketing bridge
    location /api/ {
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

    # Public chat widget assets — should be accessible without auth
    # (skip authelia for /public, /widget, /packs)
    location ~ ^/(public|widget|packs|webhooks)/ {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_redirect off;
        proxy_buffering off;
    }

    # Main dashboard (and everything else) gated by Authelia
    location / {
        auth_request /authelia;
        auth_request_set $target_url $scheme://$http_host$request_uri;
        auth_request_set $user $upstream_http_remote_user;
        auth_request_set $groups $upstream_http_remote_groups;
        auth_request_set $name $upstream_http_remote_name;
        auth_request_set $email $upstream_http_remote_email;
        error_page 401 =302 https://auth.sondervn.com/?rd=$target_url;

        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Remote-User $user;
        proxy_set_header Remote-Groups $groups;
        proxy_set_header Remote-Name $name;
        proxy_set_header Remote-Email $email;
        proxy_redirect off;
        proxy_buffering off;
        proxy_read_timeout 90s;
    }
}

server {
    listen 80;
    listen [::]:80;
    server_name chat.sondervn.com;
    return 301 https://$host$request_uri;
}
"""

# Updated app.sondervn.com config — adds Authelia gate
# But carefully: vp-marketing has internal /api endpoints that bots need
# Skip /api, /webhooks, /public for Authelia gate
APP_NGINX = """server {
    server_name app.sondervn.com;
    client_max_body_size 100M;

    # Authelia subrequest
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

    # Skip auth for API + webhooks + public assets (bots need access)
    location ~ ^/(api|webhooks|public|sitemap|robots|health) {
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

    # Dashboard pages gated by Authelia
    location / {
        auth_request /authelia;
        auth_request_set $target_url $scheme://$http_host$request_uri;
        auth_request_set $user $upstream_http_remote_user;
        auth_request_set $groups $upstream_http_remote_groups;
        auth_request_set $email $upstream_http_remote_email;
        error_page 401 =302 https://auth.sondervn.com/?rd=$target_url;

        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Remote-User $user;
        proxy_set_header Remote-Groups $groups;
        proxy_set_header Remote-Email $email;
        proxy_read_timeout 300s;
    }

    listen [::]:443 ssl;
    listen 443 ssl;
    ssl_certificate /etc/letsencrypt/live/app.sondervn.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/app.sondervn.com/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;
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
"""

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, username=USER, password=PASSWORD, timeout=15, look_for_keys=False, allow_agent=False)

print(">>> Backup current configs")
_, o, _ = client.exec_command(
    "cp /etc/nginx/sites-available/chat.sondervn.com /etc/nginx/sites-available/chat.sondervn.com.preauthelia.bak.$(date +%s); "
    "cp /etc/nginx/sites-available/app.sondervn.com /etc/nginx/sites-available/app.sondervn.com.preauthelia.bak.$(date +%s); "
    "ls -la /etc/nginx/sites-available/*.preauthelia.bak.* | head -5",
    timeout=10)
print(o.read().decode("utf-8"))

print(">>> Upload new configs via SFTP")
sftp = client.open_sftp()
with sftp.open("/etc/nginx/sites-available/chat.sondervn.com", "w") as f:
    f.write(CHAT_NGINX)
with sftp.open("/etc/nginx/sites-available/app.sondervn.com", "w") as f:
    f.write(APP_NGINX)
sftp.close()
print("Configs uploaded")

print("\n>>> Test + reload nginx")
_, o, _ = client.exec_command("nginx -t 2>&1; echo ---; nginx -s reload 2>&1; echo ---; sleep 2", timeout=15)
print(o.read().decode("utf-8"))

print("\n>>> Test public URLs (should redirect to Authelia)")
_, o, _ = client.exec_command(
    'echo "=== chat.sondervn.com (no cookie) ==="; '
    'curl -sI --max-time 8 https://chat.sondervn.com/ | head -5; '
    'echo; echo "=== app.sondervn.com (no cookie) ==="; '
    'curl -sI --max-time 8 https://app.sondervn.com/ | head -5; '
    'echo; echo "=== auth.sondervn.com still works ==="; '
    'curl -sI --max-time 8 https://auth.sondervn.com/ | head -5; '
    'echo; echo "=== chat /api still accessible (no Authelia gate) ==="; '
    'curl -sI --max-time 8 https://chat.sondervn.com/api | head -5; '
    'echo; echo "=== app /api still accessible ==="; '
    'curl -sI --max-time 8 https://app.sondervn.com/api/ping 2>&1 | head -5',
    timeout=60)
print(o.read().decode("utf-8"))

client.close()

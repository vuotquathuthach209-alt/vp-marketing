"""Deploy Authelia central SSO trên VPS Sonder.

Components:
- Authelia container (auth.sondervn.com)
- Forward auth nginx config cho chat.sondervn.com + app.sondervn.com
- Single user: admin@sondervn.com (same password as Chatwoot for now,
  will rotate after first login)

User flow:
1. User truy cập https://chat.sondervn.com
2. Nginx forward_auth → Authelia
3. Nếu chưa login → redirect tới https://auth.sondervn.com
4. User đăng nhập Authelia 1 lần
5. Cookie .sondervn.com → mọi *.sondervn.com auto-authenticated
"""
import sys, paramiko, secrets, hashlib

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

HOST = "103.82.193.74"
USER = "root"
PASSWORD = "cCxEvKZ0J3Ee6NJG"

# Generate strong secrets
JWT_SECRET = secrets.token_urlsafe(48)
SESSION_SECRET = secrets.token_urlsafe(48)
STORAGE_KEY = secrets.token_urlsafe(48)

DOCKER_COMPOSE = """networks:
  sso-net:
    driver: bridge

services:
  authelia:
    image: authelia/authelia:4.38
    container_name: authelia
    restart: unless-stopped
    networks: [sso-net]
    ports:
      - "127.0.0.1:9091:9091"
    volumes:
      - ./config:/config
      - ./data:/data
    environment:
      - TZ=Asia/Ho_Chi_Minh
    healthcheck:
      test: ["CMD", "authelia", "--version"]
      interval: 30s
      timeout: 5s
      retries: 3
"""

# Authelia configuration.yml
AUTHELIA_CONFIG = f"""---
# Sonder Authelia SSO config
# Reference: skill sonder-sso-identity

server:
  address: 'tcp://0.0.0.0:9091/'

log:
  level: info
  format: text

theme: light

identity_validation:
  reset_password:
    jwt_secret: '{JWT_SECRET}'

totp:
  issuer: Sonder Vietnam
  algorithm: sha1
  digits: 6
  period: 30

authentication_backend:
  password_reset:
    disable: false
  refresh_interval: 5m
  file:
    path: /config/users_database.yml
    password:
      algorithm: argon2id
      iterations: 3
      memory: 65536
      parallelism: 4
      key_length: 32
      salt_length: 16

access_control:
  default_policy: deny
  rules:
    - domain: 'auth.sondervn.com'
      policy: bypass
    # Chatwoot — admin only with 2FA
    - domain: 'chat.sondervn.com'
      policy: two_factor
      subject:
        - 'group:admins'
    # vp-marketing — admin only with 2FA
    - domain: 'app.sondervn.com'
      policy: two_factor
      subject:
        - 'group:admins'
    # Future apps
    - domain: 'mail.sondervn.com'
      policy: two_factor
      subject:
        - 'group:admins'
    - domain: 'analytics.sondervn.com'
      policy: two_factor
      subject:
        - 'group:admins'
    - domain: 'crm.sondervn.com'
      policy: two_factor
      subject:
        - 'group:admins'

session:
  secret: '{SESSION_SECRET}'
  cookies:
    - domain: 'sondervn.com'
      authelia_url: 'https://auth.sondervn.com'
      default_redirection_url: 'https://chat.sondervn.com'
      expiration: 1h
      inactivity: 30m
      remember_me: 1M

regulation:
  max_retries: 5
  find_time: 2m
  ban_time: 5m

storage:
  encryption_key: '{STORAGE_KEY}'
  local:
    path: /data/db.sqlite3

notifier:
  disable_startup_check: true
  filesystem:
    filename: /data/notifications.txt
"""

# Authelia users database
USERS_DB = """---
users:
  admin:
    disabled: false
    displayname: 'Sonder Admin'
    # Password: Sonder@2026SSO! (will be hashed below by deploy script)
    password: '$argon2id$v=19$m=65536,t=3,p=4$PLACEHOLDER$PLACEHOLDER'
    email: admin@sondervn.com
    groups:
      - admins
"""

# Nginx config for auth.sondervn.com (Authelia portal)
NGINX_AUTH = """server {
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
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Host $host;
        proxy_set_header X-Forwarded-URI $request_uri;
        proxy_redirect off;
    }
}

server {
    listen 80;
    listen [::]:80;
    server_name auth.sondervn.com;

    location /.well-known/acme-challenge/ {
        root /var/www/html;
    }

    location / {
        return 301 https://$host$request_uri;
    }
}
"""

# Snippet for forward auth to include in protected nginx server blocks
NGINX_AUTH_SNIPPET = """# /etc/nginx/snippets/authelia-authrequest.conf
# Include this in protected server blocks

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

    proxy_set_header Content-Length "";
    proxy_set_header Connection "";

    proxy_pass_request_headers on;
    proxy_set_header Cookie $http_cookie;
}
"""

NGINX_AUTHREQ_BLOCK = """# /etc/nginx/snippets/authelia-authrequest-call.conf
# Include INSIDE location blocks that need auth

auth_request /authelia;
auth_request_set $target_url $scheme://$http_host$request_uri;
auth_request_set $user $upstream_http_remote_user;
auth_request_set $groups $upstream_http_remote_groups;
auth_request_set $name $upstream_http_remote_name;
auth_request_set $email $upstream_http_remote_email;

proxy_set_header Remote-User $user;
proxy_set_header Remote-Groups $groups;
proxy_set_header Remote-Name $name;
proxy_set_header Remote-Email $email;

error_page 401 =302 https://auth.sondervn.com/?rd=$target_url;
"""

print("=" * 60)
print("Authelia deploy script — generates secrets locally")
print("=" * 60)

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, username=USER, password=PASSWORD, timeout=15, look_for_keys=False, allow_agent=False)

# Step 1: Create directory structure
print("\n>>> Step 1: Create /opt/authelia structure")
_, o, _ = client.exec_command(
    "mkdir -p /opt/authelia/config /opt/authelia/data && chmod 700 /opt/authelia/data"
    " && ls -la /opt/authelia/", timeout=10)
print(o.read().decode("utf-8"))

# Step 2: Upload docker-compose.yml + config files
print(">>> Step 2: Upload docker-compose.yml + config")
sftp = client.open_sftp()
with sftp.open("/opt/authelia/docker-compose.yml", "w") as f:
    f.write(DOCKER_COMPOSE)
with sftp.open("/opt/authelia/config/configuration.yml", "w") as f:
    f.write(AUTHELIA_CONFIG)
with sftp.open("/opt/authelia/config/users_database.yml", "w") as f:
    f.write(USERS_DB)
sftp.chmod("/opt/authelia/config/configuration.yml", 0o600)
sftp.chmod("/opt/authelia/config/users_database.yml", 0o600)

# Upload nginx snippets
sftp.mkdir_or_pass = lambda p: None
try:
    sftp.mkdir("/etc/nginx/snippets")
except Exception:
    pass

with sftp.open("/etc/nginx/snippets/authelia-authrequest.conf", "w") as f:
    f.write(NGINX_AUTH_SNIPPET)
with sftp.open("/etc/nginx/snippets/authelia-authrequest-call.conf", "w") as f:
    f.write(NGINX_AUTHREQ_BLOCK)
sftp.close()
print("Files uploaded")

# Step 3: Pull Authelia image + start
print("\n>>> Step 3: Pull image + start Authelia")
_, o, _ = client.exec_command(
    "cd /opt/authelia && docker compose pull && docker compose up -d", timeout=300, get_pty=True)
print(o.read().decode("utf-8")[-1500:])

# Step 4: Wait + hash password + update users_database.yml
print("\n>>> Step 4: Hash password Sonder@2026SSO! and update users_database.yml")
_, o, _ = client.exec_command(
    "sleep 8 && docker compose -f /opt/authelia/docker-compose.yml exec -T authelia "
    "authelia crypto hash generate argon2 --password 'Sonder@2026SSO!' 2>&1 | tail -3",
    timeout=30)
hash_output = o.read().decode("utf-8")
print(hash_output)

# Extract hash from output
import re
m = re.search(r'(\$argon2id\$[^\s]+)', hash_output)
if not m:
    print("ERROR: Could not extract hash from output")
    sys.exit(1)
PASSWORD_HASH = m.group(1)
print(f"Hash: {PASSWORD_HASH[:30]}...")

# Update users_database.yml with real hash
USERS_DB_REAL = USERS_DB.replace(
    "$argon2id$v=19$m=65536,t=3,p=4$PLACEHOLDER$PLACEHOLDER",
    PASSWORD_HASH
)
sftp = client.open_sftp()
with sftp.open("/opt/authelia/config/users_database.yml", "w") as f:
    f.write(USERS_DB_REAL)
sftp.chmod("/opt/authelia/config/users_database.yml", 0o600)
sftp.close()

# Step 5: Restart authelia
print("\n>>> Step 5: Restart Authelia with hashed password")
_, o, _ = client.exec_command(
    "cd /opt/authelia && docker compose restart authelia && sleep 5 && docker compose ps",
    timeout=30, get_pty=True)
print(o.read().decode("utf-8"))

# Step 6: Verify
print("\n>>> Step 6: Verify Authelia health")
_, o, _ = client.exec_command(
    "curl -s --max-time 5 http://127.0.0.1:9091/api/state | head -c 300", timeout=15)
print(o.read().decode("utf-8"))

# Save credentials
print("\n>>> Save SSO credentials")
CREDS = f"""# Sonder Authelia SSO — Credentials
# Created: 2026-05-06
# Skill: sonder-sso-identity

# === Login ===
URL=https://auth.sondervn.com
USERNAME=admin
EMAIL=admin@sondervn.com
PASSWORD=Sonder@2026SSO!

# === First login: setup TOTP 2FA ===
# After first login, Authelia will prompt to scan QR code with
# Google Authenticator / Authy / 1Password / Bitwarden TOTP

# === Secrets (for backup) ===
JWT_SECRET={JWT_SECRET[:20]}...
SESSION_SECRET={SESSION_SECRET[:20]}...
STORAGE_KEY={STORAGE_KEY[:20]}...

# Full secrets stored in /opt/authelia/config/configuration.yml (chmod 600)
"""
sftp = client.open_sftp()
with sftp.open("/opt/authelia/.sonder-sso-credentials", "w") as f:
    f.write(CREDS)
sftp.chmod("/opt/authelia/.sonder-sso-credentials", 0o600)
sftp.close()

print("\n" + "=" * 60)
print("AUTHELIA DEPLOYED")
print("=" * 60)
print("Internal URL: http://127.0.0.1:9091 (localhost only)")
print("Public URL: https://auth.sondervn.com (CHỜ DNS + nginx)")
print("Login: admin@sondervn.com / Sonder@2026SSO!")
print()
print("NEXT:")
print("1. Anh add DNS A record: auth.sondervn.com → 103.82.193.74")
print("2. Em sẽ certbot + nginx config + integrate Chatwoot/vp-marketing")

client.close()

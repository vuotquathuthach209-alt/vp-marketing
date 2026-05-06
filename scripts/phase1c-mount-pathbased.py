"""PHASE 1C: Mount Chatwoot tại https://app.sondervn.com/chatwoot/ (path-based).

Lý do: chat.sondervn.com chưa có DNS, app.sondervn.com đã có cert + đang trỏ VPS.
Path-based requires:
  - Chatwoot RAILS_RELATIVE_URL_ROOT=/chatwoot
  - FRONTEND_URL=https://app.sondervn.com/chatwoot
  - Nginx location /chatwoot/ proxy + WebSocket support
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

echo '═══ STEP 1: Update Chatwoot .env ═══'
# Backup
cp .env .env.bak.$(date +%s)

# Update FRONTEND_URL
sed -i 's|^FRONTEND_URL=.*|FRONTEND_URL=https://app.sondervn.com/chatwoot|' .env

# Add RAILS_RELATIVE_URL_ROOT if not exists
grep -q '^RAILS_RELATIVE_URL_ROOT=' .env || echo 'RAILS_RELATIVE_URL_ROOT=/chatwoot' >> .env

# Force SSL since behind HTTPS proxy
sed -i 's|^FORCE_SSL=.*|FORCE_SSL=true|' .env

# Verify
echo '--- Updated .env vars ---'
grep -E '^(FRONTEND_URL|RAILS_RELATIVE_URL_ROOT|FORCE_SSL|INSTALLATION_NAME)' .env

echo
echo '═══ STEP 2: Recreate rails + sidekiq containers ═══'
docker compose up -d --no-deps --force-recreate rails sidekiq

echo
echo '═══ STEP 3: Wait for rails ═══'
for i in {1..15}; do
  H=$(docker inspect --format='{{.State.Health.Status}}' chatwoot-rails 2>/dev/null || echo 'na')
  echo "  attempt $i: rails=$H"
  if [ "$H" = "healthy" ]; then break; fi
  sleep 6
done

echo
echo '═══ STEP 4: Test internal endpoint with new prefix ═══'
curl -s http://127.0.0.1:3001/chatwoot/api | head -c 250; echo
curl -sI http://127.0.0.1:3001/chatwoot/ | head -8

echo
echo '═══ STEP 5: Patch nginx app.sondervn.com config ═══'
# Backup
cp /etc/nginx/sites-available/app.sondervn.com /etc/nginx/sites-available/app.sondervn.com.bak.$(date +%s)

# Insert /chatwoot/ location BEFORE existing 'location /' block in HTTPS server
# Strategy: use Python to do safe insert
python3 <<'PYEOF'
import re
path = '/etc/nginx/sites-available/app.sondervn.com'
with open(path) as f:
    content = f.read()

if '/chatwoot' in content:
    print("[skip] /chatwoot location already exists")
else:
    # Find first 'location / {' inside HTTPS server (listen 443) block
    chatwoot_block = """
    # ── Sonder Chatwoot path-based mount ──
    # WebSocket / ActionCable for live chat
    location /chatwoot/cable {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header X-Forwarded-Host $host;
        proxy_set_header X-Forwarded-Port 443;
        proxy_buffering off;
        proxy_read_timeout 36000s;
    }

    location /chatwoot {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header X-Forwarded-Host $host;
        proxy_set_header X-Forwarded-Port 443;
        proxy_redirect off;
        proxy_buffering off;
        proxy_read_timeout 90s;
        client_max_body_size 100m;
    }
"""
    # Insert before 'location /' inside HTTPS (443) server block
    # Find listen 443 and the next location / after it
    pattern = r'(listen \[::\]:443 ssl[^}]*?)\n(\s*)(location / \{)'
    new = re.sub(pattern, r'\1\n' + chatwoot_block + r'\n\2\3', content, count=1)
    if new == content:
        # Try simpler pattern
        pattern2 = r'(listen 443 ssl[^}]*?)\n(\s*)(location / \{)'
        new = re.sub(pattern2, r'\1\n' + chatwoot_block + r'\n\2\3', content, count=1)
    if new == content:
        print("[ERROR] Could not find injection point — manual edit needed")
        print("Showing config first 100 lines:")
        print('\n'.join(content.split('\n')[:100]))
    else:
        with open(path, 'w') as f:
            f.write(new)
        print("[ok] Inserted /chatwoot location block")
PYEOF

echo
echo '═══ STEP 6: Test + reload nginx ═══'
nginx -t
nginx -s reload

echo
echo '═══ STEP 7: Test public URL ═══'
sleep 2
echo '--- HTTPS test from VPS itself (Host: app.sondervn.com) ---'
curl -sI https://app.sondervn.com/chatwoot/ -H 'Host: app.sondervn.com' --resolve 'app.sondervn.com:443:127.0.0.1' | head -10
echo
echo '--- API test ---'
curl -s https://app.sondervn.com/chatwoot/api | head -c 300; echo

echo
echo '═══ DONE ═══'
echo 'Chatwoot URL: https://app.sondervn.com/chatwoot/'
echo 'Anh truy cập URL trên → page sẽ redirect tới /installation/onboarding'
echo 'Tạo admin account đầu tiên (email + password)'
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

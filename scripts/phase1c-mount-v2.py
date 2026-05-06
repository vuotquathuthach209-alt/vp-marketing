"""PHASE 1C v2: Mount Chatwoot path-based — fixed quote nesting issue."""
import sys, paramiko

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

HOST = "103.82.193.74"
USER = "root"
PASSWORD = "cCxEvKZ0J3Ee6NJG"

# Step A: edit env + recreate containers
CMD_A = r"""
set -e
cd /opt/chatwoot

echo '═══ Update Chatwoot .env ═══'
cp .env .env.bak.$(date +%s)
sed -i 's|^FRONTEND_URL=.*|FRONTEND_URL=https://app.sondervn.com/chatwoot|' .env
grep -q '^RAILS_RELATIVE_URL_ROOT=' .env || echo 'RAILS_RELATIVE_URL_ROOT=/chatwoot' >> .env
sed -i 's|^FORCE_SSL=.*|FORCE_SSL=true|' .env
echo '--- Updated ---'
grep -E '^(FRONTEND_URL|RAILS_RELATIVE_URL_ROOT|FORCE_SSL)' .env

echo
echo '═══ Recreate rails + sidekiq ═══'
docker compose up -d --no-deps --force-recreate rails sidekiq

echo
echo '═══ Wait for rails ═══'
for i in 1 2 3 4 5 6 7 8 9 10 11 12; do
  H=$(docker inspect --format='{{.State.Health.Status}}' chatwoot-rails 2>/dev/null || echo 'na')
  echo "  attempt $i: rails=$H"
  if [ "$H" = "healthy" ]; then break; fi
  sleep 6
done

echo
echo '═══ Test internal /chatwoot/api ═══'
curl -s http://127.0.0.1:3001/chatwoot/api | head -c 300; echo
"""

# Step B: write nginx patch helper + run it
NGINX_PATCH_PY = '''
import re, sys

path = "/etc/nginx/sites-available/app.sondervn.com"
with open(path) as f:
    content = f.read()

if "/chatwoot" in content:
    print("[skip] /chatwoot already in config")
    sys.exit(0)

block = """
    # === Sonder Chatwoot path-based mount ===
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

# Find HTTPS server block and inject before existing location /
# Try multiple patterns — file may have ipv6 first or ipv4 first
patterns = [
    r"(listen \\[::\\]:443 ssl[^\\n]*\\n[^\\n]*listen 443 ssl[^\\n]*\\n)(\\s*server_name[^\\n]*\\n)",
    r"(listen 443 ssl[^\\n]*\\n)(\\s*server_name[^\\n]*\\n)",
]

new = content
for p in patterns:
    if re.search(p, content):
        # Insert AFTER server_name line in the 443 block
        m = re.search(p, content)
        idx = m.end()
        # Find the next 'location /' after this position
        loc_match = re.search(r"(\\n\\s*)location / \\{", content[idx:])
        if loc_match:
            insert_pos = idx + loc_match.start()
            new = content[:insert_pos] + "\\n" + block + content[insert_pos:]
            break

if new == content:
    print("[ERROR] could not find injection point")
    sys.exit(1)

with open(path, "w") as f:
    f.write(new)
print("[ok] /chatwoot location block injected")
'''

CMD_B = f"""
set -e

echo '═══ Backup nginx config ═══'
cp /etc/nginx/sites-available/app.sondervn.com /etc/nginx/sites-available/app.sondervn.com.bak.$(date +%s)

echo
echo '═══ Inject /chatwoot location ═══'
cat > /tmp/patch_nginx.py <<'EOF_PY'
{NGINX_PATCH_PY}
EOF_PY
python3 /tmp/patch_nginx.py

echo
echo '═══ Test + reload nginx ═══'
nginx -t
nginx -s reload

echo
echo '═══ Verify location injected ═══'
grep -A2 '/chatwoot' /etc/nginx/sites-available/app.sondervn.com | head -20

echo
echo '═══ Public test ═══'
curl -sI https://app.sondervn.com/chatwoot/ | head -10
curl -s https://app.sondervn.com/chatwoot/api | head -c 300; echo
"""

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, username=USER, password=PASSWORD, timeout=15, look_for_keys=False, allow_agent=False)

print(">>> STEP A: env + recreate containers")
stdin, stdout, stderr = client.exec_command(CMD_A, timeout=180, get_pty=True)
print(stdout.read().decode("utf-8", errors="replace"))
e = stderr.read().decode("utf-8", errors="replace")
if e.strip(): print("STDERR-A:", e, file=sys.stderr)

print()
print(">>> STEP B: nginx patch + test")
stdin, stdout, stderr = client.exec_command(CMD_B, timeout=60, get_pty=True)
print(stdout.read().decode("utf-8", errors="replace"))
e = stderr.read().decode("utf-8", errors="replace")
if e.strip(): print("STDERR-B:", e, file=sys.stderr)

client.close()

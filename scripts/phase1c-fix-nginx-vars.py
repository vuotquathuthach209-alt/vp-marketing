"""Fix nginx config — bash heredoc ate $variables. Use SFTP to upload literal content."""
import sys, paramiko, io

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

HOST = "103.82.193.74"
USER = "root"
PASSWORD = "cCxEvKZ0J3Ee6NJG"

NGINX_CONFIG = """server {
    listen 443 ssl;
    listen [::]:443 ssl;
    http2 on;
    server_name chat.sondervn.com;

    ssl_certificate /etc/letsencrypt/live/chat.sondervn.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/chat.sondervn.com/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;

    client_max_body_size 100M;

    location /cable {
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
}

server {
    listen 80;
    listen [::]:80;
    server_name chat.sondervn.com;
    return 301 https://$host$request_uri;
}
"""

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, username=USER, password=PASSWORD, timeout=15, look_for_keys=False, allow_agent=False)

# Upload config via SFTP
sftp = client.open_sftp()
print("Uploading nginx config via SFTP...")
with sftp.open("/etc/nginx/sites-available/chat.sondervn.com", "w") as f:
    f.write(NGINX_CONFIG)
sftp.close()
print("Uploaded.")

# Verify + reload
cmd = """
echo === Verify variables present ===
grep -E 'proxy_set_header (Host|Upgrade|X-Real-IP)' /etc/nginx/sites-available/chat.sondervn.com

echo
echo === Test config + reload ===
nginx -t
nginx -s reload

sleep 2

echo
echo === Public test https://chat.sondervn.com/ ===
curl -sI --max-time 10 https://chat.sondervn.com/ | head -10

echo
echo === /api ===
curl -s --max-time 10 https://chat.sondervn.com/api

echo
echo === Internal /api (proxy direction) ===
curl -s --max-time 5 -H 'Host: chat.sondervn.com' http://127.0.0.1:3001/api | head -c 300
"""

stdin, stdout, stderr = client.exec_command(cmd, timeout=60)
print(stdout.read().decode("utf-8", errors="replace"))
err = stderr.read().decode("utf-8", errors="replace")
if err.strip():
    print("STDERR:", err, file=sys.stderr)
client.close()

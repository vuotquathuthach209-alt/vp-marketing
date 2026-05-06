"""PHASE 2 DEPLOY: pull + build + add env + configure Chatwoot inbox webhook."""
import sys, paramiko

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

HOST = "103.82.193.74"
USER = "root"
PASSWORD = "cCxEvKZ0J3Ee6NJG"

CMD = """
set -e
cd /opt/vp-marketing

echo === STEP 1: git pull ===
git pull --ff-only 2>&1 | tail -5

echo
echo === STEP 2: TS build ===
npm run build 2>&1 | tail -8

echo
echo === STEP 3: append Chatwoot env to .env ===
if ! grep -q '^CHATWOOT_BRIDGE_ENABLED' .env; then
cat >> .env <<'EOF_ENV'

# === Chatwoot Bridge (Phase 2, 2026-05-06) ===
# Reference: skill sonder-tech-sovereignty
CHATWOOT_BRIDGE_ENABLED=true
CHATWOOT_BASE_URL=https://chat.sondervn.com
CHATWOOT_API_TOKEN=JvHWnJ3QJXN669Qz1qBJAext
CHATWOOT_ACCOUNT_ID=1
CHATWOOT_INBOX_ID=1
CHATWOOT_INBOX_IDENTIFIER=fb-sonder-892083053979896
CHATWOOT_INBOX_HMAC_TOKEN=dgUuaJjMVRFyX21PHfveH1vt
EOF_ENV
echo 'env appended'
else
echo 'env already configured (skip)'
fi
chmod 600 .env

echo
echo === STEP 4: Restart PM2 ===
pm2 restart vp-mkt 2>&1 | tail -3

echo
echo === STEP 5: Wait + check log ===
sleep 5
pm2 logs vp-mkt --lines 30 --nostream 2>&1 | grep -iE 'chatwoot|bridge|chatwoot_bridge_mappings' | tail -10

echo
echo === STEP 6: Update Chatwoot inbox webhook URL via Rails console ===
docker compose -f /opt/chatwoot/docker-compose.yml exec -T rails bundle exec rails runner '
inbox = Inbox.find(1)
inbox.channel.update!(webhook_url: "https://app.sondervn.com/webhooks/chatwoot-bridge/fb-sonder")
puts "Inbox webhook updated: #{inbox.channel.webhook_url}"
' 2>&1 | grep -v INFO | tail -5

echo
echo === STEP 7: Test internal route exists ===
curl -sI --max-time 5 https://app.sondervn.com/webhooks/chatwoot-bridge/fb-sonder | head -5
"""

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, username=USER, password=PASSWORD, timeout=15, look_for_keys=False, allow_agent=False)

stdin, stdout, stderr = client.exec_command(CMD, timeout=240, get_pty=True)
print(stdout.read().decode("utf-8", errors="replace"))
err = stderr.read().decode("utf-8", errors="replace")
if err.strip():
    print("STDERR:", err, file=sys.stderr)
client.close()

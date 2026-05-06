"""PHASE 1C alternative: Mount Chatwoot tại /chatwoot path trên existing subdomain
(app.sondervn.com hoặc mkt.sondervn.com) thay vì chờ DNS chat.sondervn.com.

Lợi: tận dụng cert có sẵn, no DNS dependency.
Hại: Chatwoot path-based cần RAILS_RELATIVE_URL_ROOT + WebSocket config careful.
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
echo '═══ STEP 1: Inspect existing nginx configs ═══'
echo
echo '--- app.sondervn.com config (root + listen lines) ---'
grep -E 'server_name|listen|location|root|proxy_pass' /etc/nginx/sites-available/app.sondervn.com 2>/dev/null | head -30

echo
echo '--- mkt.sondervn.com config ---'
grep -E 'server_name|listen|location|root|proxy_pass' /etc/nginx/sites-available/mkt.sondervn.com 2>/dev/null | head -30

echo
echo '═══ STEP 2: List ALL subdomains pointing to this VPS ═══'
echo '--- Quick test common subdomains ---'
for sub in chat inbox support bot help admin api crm chatwoot; do
  ip=$(host $sub.sondervn.com 2>&1 | grep -oP 'address \K[\d.]+' | head -1)
  if [ -n "$ip" ]; then echo "  $sub.sondervn.com → $ip"; fi
done

echo
echo '═══ STEP 3: Check existing cert SAN list ═══'
for d in app.sondervn.com mkt.sondervn.com; do
  echo "--- $d cert ---"
  openssl x509 -in /etc/letsencrypt/live/$d/cert.pem -noout -text 2>/dev/null | grep -A1 'Subject Alternative Name' | tail -1
done

echo
echo '═══ STEP 4: Check if there is sondervn.com nginx (root) ═══'
grep -E 'server_name|listen' /etc/nginx/sites-available/sondervn.com 2>/dev/null || echo '(no sondervn.com root config)'

echo
echo '═══ DECISION POINT ═══'
echo 'If chat.sondervn.com NOT resolving anywhere, options:'
echo '  A. Path-based: https://mkt.sondervn.com/chatwoot/'
echo '  B. Path-based: https://app.sondervn.com/chatwoot/'
echo '  C. New server block + cert chat.sondervn.com (cần DNS)'
"""

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, username=USER, password=PASSWORD, timeout=15, look_for_keys=False, allow_agent=False)

stdin, stdout, stderr = client.exec_command(CMD, timeout=60)
print(stdout.read().decode("utf-8", errors="replace"))
err = stderr.read().decode("utf-8", errors="replace")
if err.strip():
    print("STDERR:", err, file=sys.stderr)
client.close()

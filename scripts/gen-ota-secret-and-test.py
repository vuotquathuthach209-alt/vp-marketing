"""Generate shared secret cho OTA Raw + self-test endpoint /push."""
import sys, os, paramiko, secrets, json, hmac, hashlib, time, urllib.request
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception: pass

HOST = "103.82.193.74"; USER = "root"
PASSWORD = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("VPS_PASSWORD", "")

# Generate secret
SECRET = secrets.token_hex(32)
print(f"[gen] Generated new secret: {SECRET[:8]}...{SECRET[-6:]}  (length {len(SECRET)})")

# Save to bot DB via SSH
CMD_SAVE = f"""
cd /opt/vp-marketing
cat > tmp-save-secret.js <<'JS'
const Database = require('better-sqlite3');
const db = new Database('data/db.sqlite');
const now = Date.now();
db.prepare(`INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)`)
  .run('ota_raw_secret', '{SECRET}', now);
console.log('✓ Saved ota_raw_secret to settings');
const r = db.prepare("SELECT key, substr(value,1,8) as preview, length(value) as len FROM settings WHERE key='ota_raw_secret'").get();
console.log(JSON.stringify(r));
db.close();
JS
node tmp-save-secret.js
rm -f tmp-save-secret.js
"""

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, username=USER, password=PASSWORD, timeout=15, look_for_keys=False, allow_agent=False)
stdin, stdout, stderr = client.exec_command(CMD_SAVE, timeout=30)
print(stdout.read().decode("utf-8", errors="replace"))
err = stderr.read().decode("utf-8", errors="replace")
if err.strip(): print("STDERR:\n" + err, file=sys.stderr)
client.close()

# Wait 2s for any propagation
time.sleep(1)

# ── Self-test: push sample hotel ──
print("\n[test] Send sample batch with HMAC...")
payload = {
    "batch_id": f"test-selftest-{int(time.time())}",
    "type": "hotels",
    "items": [
        {
            "ota_id": "test-self-001",
            "data": {
                "name": "Sample Test Hotel (self-test)",
                "address": "123 Đường Nào Đó, Quận 1, HCM",
                "city": "Ho Chi Minh",
                "district": "Q1",
                "type": "hotel",
                "rental_mode": "nightly",
                "star_rating": 3,
                "phone": "+84909999999",
            }
        }
    ]
}
body = json.dumps(payload).encode("utf-8")
sig = hmac.new(SECRET.encode(), body, hashlib.sha256).hexdigest()

req = urllib.request.Request(
    "https://app.sondervn.com/api/ota-raw/push",
    data=body,
    method="POST",
    headers={
        "Content-Type": "application/json",
        "X-OTA-Signature": f"sha256={sig}",
        "X-OTA-Timestamp": str(int(time.time() * 1000)),
        "X-OTA-Source": "self-test",
    },
)
try:
    with urllib.request.urlopen(req, timeout=15) as r:
        body = r.read().decode("utf-8", errors="replace")
        print(f"[test] HTTP {r.status}")
        print(body)
except urllib.error.HTTPError as e:
    print(f"[test] HTTP {e.code}")
    print(e.read().decode("utf-8", errors="replace"))

# Test bad signature → expect 401
print("\n[test] Send with BAD signature (expect 401)...")
req_bad = urllib.request.Request(
    "https://app.sondervn.com/api/ota-raw/push",
    data=b'{"batch_id":"x","type":"hotels","items":[{"ota_id":"x","data":{}}]}',
    method="POST",
    headers={
        "Content-Type": "application/json",
        "X-OTA-Signature": "sha256=0000000000000000000000000000000000000000000000000000000000000000",
        "X-OTA-Timestamp": str(int(time.time() * 1000)),
        "X-OTA-Source": "self-test",
    },
)
try:
    with urllib.request.urlopen(req_bad, timeout=15) as r:
        print(f"[test] Unexpected HTTP {r.status}: {r.read().decode('utf-8')}")
except urllib.error.HTTPError as e:
    print(f"[test] Got HTTP {e.code} (expected 401): {e.read().decode('utf-8')}")

print(f"\n\n═══════════════════════════════════════════")
print(f"🔑 SHARED SECRET (copy this, gửi OTA team):")
print(f"═══════════════════════════════════════════")
print(SECRET)
print(f"═══════════════════════════════════════════")

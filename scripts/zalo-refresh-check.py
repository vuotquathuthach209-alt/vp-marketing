"""Test Zalo refresh_token endpoint — verify credentials chain is valid."""
import sys
import urllib.request
import urllib.error
import urllib.parse

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

APP_ID = "1125683119493780855"
APP_SECRET = "GUZI3qP6QivL7OW94VD7"
REFRESH_TOKEN = sys.argv[1] if len(sys.argv) > 1 else ""

if not REFRESH_TOKEN:
    print("usage: zalo-refresh-check.py <refresh_token>")
    sys.exit(1)

# https://developers.zalo.me/docs/official-account-api/bat-dau/xac-thuc-va-uy-quyen-cho-ung-dung-getaccesstoken
body = urllib.parse.urlencode({
    "refresh_token": REFRESH_TOKEN,
    "app_id": APP_ID,
    "grant_type": "refresh_token",
}).encode("utf-8")

req = urllib.request.Request(
    "https://oauth.zaloapp.com/v4/oa/access_token",
    data=body,
    method="POST",
    headers={
        "secret_key": APP_SECRET,
        "Content-Type": "application/x-www-form-urlencoded",
    },
)

try:
    with urllib.request.urlopen(req, timeout=15) as r:
        print(f"HTTP {r.status}")
        print(r.read().decode("utf-8", errors="replace"))
except urllib.error.HTTPError as e:
    print(f"HTTP {e.code}")
    print(e.read().decode("utf-8", errors="replace"))
except Exception as e:
    print(f"ERR: {e}")

"""Try all known Zalo OA send endpoints with various message tags."""
import sys
import urllib.request
import urllib.error
import urllib.parse
import json

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

TOKEN = sys.argv[1] if len(sys.argv) > 1 else ""
USER_ID = "5742053080582146621"  # Hùng Nguyễn
TEXT = "Test từ bot Sonder"

if not TOKEN:
    print("usage: token")
    sys.exit(1)


def post(label, url, body_dict):
    body = json.dumps(body_dict).encode("utf-8")
    req = urllib.request.Request(url, data=body, method="POST", headers={
        "access_token": TOKEN, "Content-Type": "application/json",
    })
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            data = r.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as e:
        data = e.read().decode("utf-8", errors="replace")
    except Exception as e:
        data = str(e)
    print(f"{label:55s} → {data[:120]}")


print("=== Free-tier endpoints (nên work sau CS window 48h) ===\n")

# v3.0 CS message (customer service) — reply trong 48h sau khi user nhắn
post("v3.0 /oa/message/cs",
     "https://openapi.zalo.me/v3.0/oa/message/cs",
     {"recipient": {"user_id": USER_ID}, "message": {"text": TEXT}})

# v3.0 CS with message_tag
post("v3.0 /oa/message/cs +tag NON_PROMOTION_SUBSCRIPTION",
     "https://openapi.zalo.me/v3.0/oa/message/cs",
     {"recipient": {"user_id": USER_ID}, "message": {"text": TEXT}, "message_tag": "NON_PROMOTION_SUBSCRIPTION"})

# v3.0 followups (newer endpoint)
post("v3.0 /oa/message/followups",
     "https://openapi.zalo.me/v3.0/oa/message/followups",
     {"recipient": {"user_id": USER_ID}, "message": {"text": TEXT}})

# transaction message (for booking confirmation)
post("v3.0 /oa/message/transaction",
     "https://openapi.zalo.me/v3.0/oa/message/transaction",
     {"recipient": {"user_id": USER_ID}, "message": {"text": TEXT}})

# v3.0 promotion (paid)
post("v3.0 /oa/message/promotion",
     "https://openapi.zalo.me/v3.0/oa/message/promotion",
     {"recipient": {"user_id": USER_ID}, "message": {"text": TEXT}})

# v3.0 generic (some docs say use this)
post("v3.0 /oa/message",
     "https://openapi.zalo.me/v3.0/oa/message",
     {"recipient": {"user_id": USER_ID}, "message": {"text": TEXT}})

# v2.0 legacy
post("v2.0 /oa/message (header)",
     "https://openapi.zalo.me/v2.0/oa/message",
     {"recipient": {"user_id": USER_ID}, "message": {"text": TEXT}})

print("\n=== Read-only endpoints (maybe free) ===\n")

# Get OA info
req = urllib.request.Request("https://openapi.zalo.me/v2.0/oa/getoa", headers={"access_token": TOKEN})
try:
    with urllib.request.urlopen(req, timeout=10) as r:
        print(f"{'v2.0 /oa/getoa':55s} → {r.read().decode()[:200]}")
except urllib.error.HTTPError as e:
    print(f"{'v2.0 /oa/getoa':55s} → {e.read().decode()[:200]}")

# Get user profile
data = urllib.parse.quote(json.dumps({"user_id": USER_ID}))
req = urllib.request.Request(f"https://openapi.zalo.me/v2.0/oa/getprofile?data={data}", headers={"access_token": TOKEN})
try:
    with urllib.request.urlopen(req, timeout=10) as r:
        print(f"{'v2.0 /oa/getprofile':55s} → {r.read().decode()[:200]}")
except urllib.error.HTTPError as e:
    print(f"{'v2.0 /oa/getprofile':55s} → {e.read().decode()[:200]}")

# List followers
data = urllib.parse.quote('{"offset":0,"count":5}')
req = urllib.request.Request(f"https://openapi.zalo.me/v2.0/oa/getlistfollower?data={data}", headers={"access_token": TOKEN})
try:
    with urllib.request.urlopen(req, timeout=10) as r:
        print(f"{'v2.0 /oa/getlistfollower':55s} → {r.read().decode()[:200]}")
except urllib.error.HTTPError as e:
    print(f"{'v2.0 /oa/getlistfollower':55s} → {e.read().decode()[:200]}")

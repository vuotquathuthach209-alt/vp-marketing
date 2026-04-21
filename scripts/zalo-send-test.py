"""
Test gửi tin thử từ bot → Zalo user.
Call zaloSendText() logic trực tiếp, không cần auth admin.
"""
import sys
import os
import urllib.request
import urllib.error
import urllib.parse
import json

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

ACCESS_TOKEN = sys.argv[1] if len(sys.argv) > 1 else ""
USER_ID = sys.argv[2] if len(sys.argv) > 2 else "5742053080582146621"  # Hùng Nguyễn
TEXT = sys.argv[3] if len(sys.argv) > 3 else "Test từ bot Sonder 🏨 — nếu bạn nhận được tin này nghĩa là Zalo OA đã kết nối thành công!"

if not ACCESS_TOKEN:
    print("usage: zalo-send-test.py <access_token> [user_id] [text]")
    sys.exit(1)


def call(label, url, method="GET", headers=None, body=None):
    req = urllib.request.Request(url, method=method, headers=headers or {}, data=body)
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            data = r.read().decode("utf-8", errors="replace")
            status = r.status
    except urllib.error.HTTPError as e:
        status = e.code
        data = e.read().decode("utf-8", errors="replace")
    except Exception as e:
        status = -1
        data = str(e)
    print(f"\n=== {label} ===")
    print(f"{method} {url}")
    print(f"HTTP {status}")
    print(data[:600])
    return data


# Send text message to user via OA API (v3.0 CS format)
# Docs: https://developers.zalo.me/docs/official-account-api/tra-cuu-thong-tin/tra-cuu-thong-tin-oa-post-4977
payload = json.dumps({
    "recipient": {"user_id": USER_ID},
    "message": {"text": TEXT}
}).encode("utf-8")

# Try v3.0 OA API endpoint for sending CS message (free within 48h after user msg)
call("Send OA v3.0 CS", "https://openapi.zalo.me/v3.0/oa/message/cs",
     method="POST",
     headers={"access_token": ACCESS_TOKEN, "Content-Type": "application/json"},
     body=payload)

# v2.0 send message (legacy)
payload_v2 = urllib.parse.quote(json.dumps({
    "recipient": {"user_id": USER_ID},
    "message": {"text": TEXT}
}))
call("Send OA v2.0 (legacy)",
     f"https://openapi.zalo.me/v2.0/oa/message?access_token={ACCESS_TOKEN}&data={payload_v2}",
     method="POST")

# v3.0 transaction message
call("Send OA v3.0 transaction", "https://openapi.zalo.me/v3.0/oa/message/transaction",
     method="POST",
     headers={"access_token": ACCESS_TOKEN, "Content-Type": "application/json"},
     body=payload)

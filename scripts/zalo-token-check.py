"""
Kiểm tra token Zalo đã cung cấp là User Access Token hay OA Access Token.
- User token: gọi được https://graph.zalo.me/v2.0/me
- OA token: gọi được https://openapi.zalo.me/v3.0/oa/get_profile
"""
import sys
import urllib.request
import urllib.error
import json

TOKEN = sys.argv[1] if len(sys.argv) > 1 else ""
if not TOKEN:
    print("usage: zalo-token-check.py <access_token>", file=sys.stderr)
    sys.exit(1)

def call(url, hdr_name):
    req = urllib.request.Request(url, headers={hdr_name: TOKEN})
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            body = r.read().decode("utf-8", errors="replace")
            return r.status, body
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", errors="replace")
    except Exception as e:
        return -1, str(e)

print("=== Test 1: User API (graph.zalo.me/me) ===")
code, body = call("https://graph.zalo.me/v2.0/me?fields=id,name", "access_token")
print(f"HTTP {code}")
print(body[:500])
print()

print("=== Test 2: OA Profile API (openapi.zalo.me/oa) ===")
code, body = call("https://openapi.zalo.me/v3.0/oa/get_profile", "access_token")
print(f"HTTP {code}")
print(body[:500])
print()

print("=== Test 3: Get list of OA recent messages ===")
code, body = call("https://openapi.zalo.me/v3.0/oa/message/recent_chat?data={\"offset\":0,\"count\":5}", "access_token")
print(f"HTTP {code}")
print(body[:500])

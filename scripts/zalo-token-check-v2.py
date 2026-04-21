"""
Test token Zalo với nhiều endpoint OA API khác nhau.
Zalo có cả v2.0 và v3.0, URL và header khác nhau.
"""
import sys
import urllib.request
import urllib.error
import urllib.parse

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

TOKEN = sys.argv[1] if len(sys.argv) > 1 else ""
if not TOKEN:
    print("usage: zalo-token-check-v2.py <access_token>", file=sys.stderr)
    sys.exit(1)


def call(label, url, headers=None):
    headers = headers or {}
    req = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            body = r.read().decode("utf-8", errors="replace")
            status = r.status
    except urllib.error.HTTPError as e:
        status = e.code
        body = e.read().decode("utf-8", errors="replace")
    except Exception as e:
        status = -1
        body = str(e)
    print(f"\n=== {label} ===")
    print(f"URL: {url}")
    print(f"Hdr: {headers}")
    print(f"HTTP {status}")
    print(body[:600])


# 1) User API (to compare)
call("User /me v2.0", f"https://graph.zalo.me/v2.0/me?fields=id,name&access_token={TOKEN}")

# 2) OA API v2.0 with query string access_token
call("OA getoa v2.0 (query)", f"https://openapi.zalo.me/v2.0/oa/getoa?access_token={TOKEN}")

# 3) OA API v2.0 with header
call("OA getoa v2.0 (header)", "https://openapi.zalo.me/v2.0/oa/getoa", {"access_token": TOKEN})

# 4) OA API v3.0 get_profile
call("OA get_profile v3.0", "https://openapi.zalo.me/v3.0/oa/get_profile", {"access_token": TOKEN})

# 5) OA API v2.0 listfollower
data = urllib.parse.quote('{"offset":0,"count":5}')
call("OA listfollower v2.0", f"https://openapi.zalo.me/v2.0/oa/getlistfollower?data={data}", {"access_token": TOKEN})

# 6) OA API v3.0 list recent chat
call("OA recent_chat v3.0", f"https://openapi.zalo.me/v3.0/oa/message/recent_chat?data={urllib.parse.quote(chr(123) + chr(34) + 'offset' + chr(34) + ':0,' + chr(34) + 'count' + chr(34) + ':5' + chr(125))}", {"access_token": TOKEN})

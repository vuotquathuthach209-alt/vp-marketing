"""EMERGENCY audit: identify which photos FB took down + correlate to source.

Strategy:
1. List ALL recent posts (v5t_posts + posts + auto_post_history) in last 7 days
2. For each, check FB Graph API: is the post still accessible? (a 200 = OK, 400/404 = removed)
3. For removed posts, identify the image source (Drive vs AI vs stock)
4. Compute pHash of each image to detect dupes
5. Generate report
"""
import paramiko, sys, json, time
try: sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except: pass

c = paramiko.SSHClient()
c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
c.connect("103.82.193.74", username="root", password="cCxEvKZ0J3Ee6NJG", timeout=30)


def sql(q, label=""):
    if label: print(f"\n=== {label} ===")
    _, o, _ = c.exec_command(f'sqlite3 -header -column /opt/vp-marketing/data/db.sqlite "{q}"', timeout=20)
    out = o.read().decode("utf-8", errors="replace")
    print(out)
    return out


def sh(cmd, timeout=30):
    _, o, _ = c.exec_command(cmd, timeout=timeout)
    return o.read().decode("utf-8", errors="replace")


print("=" * 80)
print("COPYRIGHT TAKEDOWN AUDIT — VP Marketing")
print("=" * 80)

# 1. Show all recent v5t_posts (today's V5T publishes)
sql(
    "SELECT id, type, status, fb_post_id, picked_footage_id, datetime(posted_at/1000, 'unixepoch') AS posted "
    "FROM v5t_posts WHERE posted_at > strftime('%s', 'now', '-2 days') * 1000 ORDER BY posted_at DESC;",
    "V5T posts last 48h"
)

# 2. Show v5t_post_images for those posts
sql(
    "SELECT vp.id AS post_id, vp.type, vp.fb_post_id, vpi.position, vpi.footage_id, vf.filename, vf.path "
    "FROM v5t_posts vp "
    "JOIN v5t_post_images vpi ON vpi.post_id = vp.id "
    "LEFT JOIN v5_footage vf ON vf.id = vpi.footage_id "
    "WHERE vp.posted_at > strftime('%s', 'now', '-2 days') * 1000 "
    "ORDER BY vp.id DESC, vpi.position;",
    "Images used in recent V5T posts"
)

# 3. Show auto-post product history recent
sql(
    "SELECT id, hotel_id, image_url, datetime(created_at/1000, 'unixepoch') AS posted, fb_post_id "
    "FROM auto_post_history WHERE created_at > strftime('%s', 'now', '-7 days') * 1000 "
    "ORDER BY created_at DESC LIMIT 10;",
    "Auto-post product last 7 days"
)

# 4. Show old posts (manual + scheduled) recent
sql(
    "SELECT id, page_id, status, fb_post_id, media_id, datetime(created_at/1000, 'unixepoch') AS created "
    "FROM posts WHERE created_at > strftime('%s', 'now', '-7 days') * 1000 ORDER BY created_at DESC LIMIT 10;",
    "posts table last 7 days"
)

# 5. Check FB Page access tokens via Graph API for recent posts
# Get fb_post_ids that should still be live
_, o, _ = c.exec_command(
    """sqlite3 -separator '|' /opt/vp-marketing/data/db.sqlite "SELECT pg.access_token FROM pages pg WHERE pg.id = 1 LIMIT 1;" """,
    timeout=10
)
token = o.read().decode("utf-8", errors="replace").strip()

if token:
    # Pull recent v5t fb_post_ids + check each
    _, o, _ = c.exec_command(
        """sqlite3 -separator '|' /opt/vp-marketing/data/db.sqlite "SELECT id, fb_post_id FROM v5t_posts WHERE fb_post_id IS NOT NULL ORDER BY posted_at DESC LIMIT 10;" """,
        timeout=10
    )
    pairs = [l.split("|") for l in o.read().decode("utf-8").strip().split("\n") if l]

    print(f"\n=== FB Post Status Check (via Graph API) ===")
    print(f"{'POST_ID':<6} {'FB_POST_ID':<45} {'STATUS':<10} {'REASON'}")
    print("-" * 90)
    for pid, fb_id in pairs:
        cmd = f'curl -sS -m 10 "https://graph.facebook.com/v21.0/{fb_id}?fields=id,message&access_token={token}" 2>&1'
        out = sh(cmd, timeout=15)
        try:
            data = json.loads(out)
            if "error" in data:
                err_msg = data["error"].get("message", "unknown")
                status = "GONE"
                reason = err_msg[:60]
            else:
                status = "LIVE"
                reason = ""
        except:
            status = "?"
            reason = out[:60]
        icon = "✅" if status == "LIVE" else "❌"
        print(f"  {pid:<5} {fb_id[:40]:<43} {icon} {status:<6} {reason}")
        time.sleep(0.3)

# 6. Same for auto_post_history
if token:
    _, o, _ = c.exec_command(
        """sqlite3 -separator '|' /opt/vp-marketing/data/db.sqlite "SELECT id, fb_post_id FROM auto_post_history WHERE fb_post_id IS NOT NULL ORDER BY created_at DESC LIMIT 10;" """,
        timeout=10
    )
    pairs = [l.split("|") for l in o.read().decode("utf-8").strip().split("\n") if l]
    if pairs:
        print(f"\n=== Auto-Post History FB Status ===")
        for pid, fb_id in pairs:
            cmd = f'curl -sS -m 10 "https://graph.facebook.com/v21.0/{fb_id}?fields=id,message&access_token={token}"'
            out = sh(cmd, timeout=15)
            try:
                data = json.loads(out)
                status = "GONE" if "error" in data else "LIVE"
                err = data.get("error", {}).get("message", "") if "error" in data else ""
            except:
                status = "?"
                err = ""
            icon = "✅" if status == "LIVE" else "❌"
            print(f"  auto_post #{pid:<3} {fb_id[:40]:<43} {icon} {status:<5} {err[:60]}")
            time.sleep(0.3)

# 7. Show source breakdown of all images currently in v5_footage
print("\n" + "=" * 70)
sql(
    "SELECT uploaded_by, COUNT(*) AS n FROM v5_footage GROUP BY uploaded_by;",
    "v5_footage by uploaded_by (source)"
)

# 8. Show gdrive_images source breakdown
sql(
    "SELECT image_source, COUNT(*) AS n FROM gdrive_images GROUP BY image_source;",
    "gdrive_images by source"
)

# 9. Show recent FB Page metrics issues
print("\n=== Recent fb-metrics errors ===")
print(sh("pm2 logs vp-mkt --lines 200 --nostream --raw 2>&1 | grep -iE 'copyright|removed|takedown|violation' | tail -10"))

c.close()
print("\n✅ EMERGENCY AUDIT done")

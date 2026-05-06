"""Deep diagnose: which posts? FB Graph API live check + YouTube channel check."""
import sys, paramiko, json

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

HOST = "103.82.193.74"
USER = "root"
PASSWORD = "cCxEvKZ0J3Ee6NJG"

CMD = r"""
cd /opt/vp-marketing

echo '=====POSTS 18-26 IDENTITY (the all-zero set)====='
sqlite3 -header -column data/db.sqlite <<'SQL'
SELECT
  p.id, p.page_id, p.media_type, p.status,
  substr(p.caption, 1, 70) as caption,
  p.fb_post_id,
  datetime(p.published_at/1000, 'unixepoch', '+7 hours') as published_vn,
  pa.name as page_name,
  substr(pa.access_token, 1, 25) as token_prefix
FROM posts p
LEFT JOIN pages pa ON pa.id = p.page_id
WHERE p.id BETWEEN 18 AND 30
ORDER BY p.id;
SQL

echo
echo '=====PAGES TABLE====='
sqlite3 -header -column data/db.sqlite <<'SQL'
SELECT id, name, fb_page_id, length(access_token) as token_len, status
FROM pages;
SQL

echo
echo '=====RECENT story_episodes (auto-published anthology)====='
sqlite3 -header -column data/db.sqlite <<'SQL'
SELECT
  id, episode_no, title,
  status,
  fb_post_id,
  CAST(json_extract(metadata,'$.fb_video_id') AS TEXT) as fb_video_id,
  CAST(json_extract(metadata,'$.youtube_video_id') AS TEXT) as yt_video_id,
  datetime(published_at/1000,'unixepoch','+7 hours') as published_vn
FROM story_episodes
WHERE published_at IS NOT NULL
ORDER BY id DESC
LIMIT 20;
SQL

echo
echo '=====settings.fb_video_id_NccJbAIA4 (ep14)====='
sqlite3 data/db.sqlite "SELECT id, episode_no, fb_post_id, json_extract(metadata,'\$.fb_video_id') as v FROM story_episodes WHERE id=14;" 2>/dev/null

echo
echo '=====FB Page access_token + Graph API live check====='
NODE_SCRIPT='
const Database = require("better-sqlite3");
const axios = require("axios");
const db = new Database("/opt/vp-marketing/data/db.sqlite", { readonly: true });

const pages = db.prepare("SELECT id, name, fb_page_id, access_token FROM pages").all();
console.log("Pages count:", pages.length);

const FB_VIDEOS = [
  "T7NccJbAIA4",            // ep14 fb_video_id from metadata
];

(async () => {
  for (const p of pages) {
    if (!p.access_token) continue;
    console.log("\n=== Page:", p.name, "fb_page_id:", p.fb_page_id, "===");

    // Get last 10 posts on page with insights
    try {
      const r = await axios.get(`https://graph.facebook.com/v21.0/${p.fb_page_id}/published_posts`, {
        params: {
          access_token: p.access_token,
          fields: "id,created_time,message,attachments{media_type,subattachments},insights.metric(post_impressions,post_impressions_unique,post_reactions_by_type_total,post_video_views,post_clicks)",
          limit: 15,
        },
        timeout: 30000,
      });
      const posts = r.data.data || [];
      console.log(`  Posts found: ${posts.length}`);
      for (const post of posts.slice(0, 12)) {
        const ins = (post.insights?.data || []).reduce((acc, x) => {
          acc[x.name] = x.values?.[0]?.value;
          return acc;
        }, {});
        const reach = ins.post_impressions_unique || 0;
        const imps = ins.post_impressions || 0;
        const views = ins.post_video_views || 0;
        const reactsObj = ins.post_reactions_by_type_total || {};
        const reactsTotal = Object.values(reactsObj).reduce((a, b) => a + (b || 0), 0);
        const created = post.created_time?.slice(0, 16);
        const msgPreview = (post.message || "[no message]").slice(0, 50).replace(/\n/g, " ");
        const mediaType = post.attachments?.data?.[0]?.media_type || "";
        console.log(`    [${created}] ${mediaType.padEnd(10)} reach=${String(reach).padStart(6)} imps=${String(imps).padStart(6)} views=${String(views).padStart(6)} reacts=${reactsTotal} | "${msgPreview}"`);
      }
    } catch (e) {
      console.log("  Graph err:", e.response?.data?.error?.message || e.message);
    }
  }
  db.close();
})().catch(e => { console.error("FATAL:", e); process.exit(1); });
'
node -e "$NODE_SCRIPT" 2>&1 | head -120

echo
echo '=====YouTube channel published list====='
sqlite3 data/db.sqlite "SELECT key, length(value) as l FROM settings WHERE key IN ('youtube_refresh_token','youtube_client_id','youtube_client_secret','enable_publish_youtube','google_api_key','youtube_token_granted_at');"
"""

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, username=USER, password=PASSWORD, timeout=15, look_for_keys=False, allow_agent=False)

stdin, stdout, stderr = client.exec_command(CMD, timeout=120)
print(stdout.read().decode("utf-8", errors="replace"))
err = stderr.read().decode("utf-8", errors="replace")
if err.strip():
    print("STDERR:", err, file=sys.stderr)
client.close()

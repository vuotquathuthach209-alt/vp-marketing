"""Final diagnose: Anthology video posts, FB Graph API correct metrics, YouTube channel."""
import sys, paramiko

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

HOST = "103.82.193.74"
USER = "root"
PASSWORD = "cCxEvKZ0J3Ee6NJG"

CMD = r"""
cd /opt/vp-marketing

echo '=====story_episodes COLUMNS (correct names)====='
sqlite3 data/db.sqlite "PRAGMA table_info(story_episodes);" | head -30

echo
echo '=====PAGES table COLUMNS====='
sqlite3 data/db.sqlite "PRAGMA table_info(pages);"

echo
echo '=====LIVE FB GRAPH API for ALL recent video posts on page====='
NODE_SCRIPT='
const Database = require("better-sqlite3");
const axios = require("axios");
const db = new Database("/opt/vp-marketing/data/db.sqlite", { readonly: true });
const pages = db.prepare("SELECT * FROM pages").all();
db.close();

(async () => {
  for (const p of pages) {
    if (!p.access_token) continue;
    console.log("\n=== PAGE:", p.name, "(fb_page_id:", p.fb_page_id + ") ===");

    // Get recent posts with media + counts (no insights to avoid invalid metric error)
    try {
      const r = await axios.get(`https://graph.facebook.com/v21.0/${p.fb_page_id}/published_posts`, {
        params: {
          access_token: p.access_token,
          fields: "id,created_time,message,attachments{media_type,description,subattachments,target},reactions.summary(total_count),comments.summary(total_count),shares",
          limit: 25,
        },
        timeout: 30000,
      });
      const posts = r.data.data || [];
      console.log(`  Total recent posts: ${posts.length}`);
      for (const post of posts) {
        const created = post.created_time?.slice(0, 16);
        const mediaType = post.attachments?.data?.[0]?.media_type || "text";
        const reacts = post.reactions?.summary?.total_count || 0;
        const cmts = post.comments?.summary?.total_count || 0;
        const sh = post.shares?.count || 0;
        const msgPreview = (post.message || "[no message]").slice(0, 60).replace(/\n/g, " ");
        console.log(`  [${created}] ${mediaType.padEnd(10)} reacts=${String(reacts).padStart(4)} cmts=${String(cmts).padStart(3)} shares=${String(sh).padStart(3)} | "${msgPreview}"`);
      }
    } catch (e) {
      console.log("  ERR:", e.response?.data?.error?.message || e.message);
    }

    // For VIDEO posts specifically, fetch video views via /videos endpoint
    try {
      const v = await axios.get(`https://graph.facebook.com/v21.0/${p.fb_page_id}/videos`, {
        params: {
          access_token: p.access_token,
          fields: "id,created_time,description,length,views,permalink_url",
          limit: 15,
        },
        timeout: 30000,
      });
      const vids = v.data.data || [];
      console.log(`\n  --- VIDEOS (${vids.length}) ---`);
      for (const vid of vids) {
        const created = vid.created_time?.slice(0, 16);
        const len = vid.length ? `${Math.round(vid.length)}s` : "?";
        const desc = (vid.description || "").slice(0, 50).replace(/\n/g, " ");
        console.log(`  [${created}] id=${vid.id} len=${len} views=${vid.views || 0} | "${desc}"`);
      }
    } catch (e) {
      console.log("  VIDEOS ERR:", e.response?.data?.error?.message || e.message);
    }
  }
})().catch(e => console.error("FATAL:", e));
'
node -e "$NODE_SCRIPT" 2>&1

echo
echo '=====YOUTUBE channel + last uploads via API====='
YT_NODE='
const Database = require("better-sqlite3");
const axios = require("axios");
const db = new Database("/opt/vp-marketing/data/db.sqlite", { readonly: true });
const get = (k) => db.prepare("SELECT value FROM settings WHERE key=?").get(k)?.value;
const cid = get("youtube_client_id");
const csec = get("youtube_client_secret");
const ref = get("youtube_refresh_token");
db.close();

if (!cid || !csec || !ref) { console.log("Missing YT credentials"); process.exit(0); }

(async () => {
  // refresh access token
  let access;
  try {
    const r = await axios.post("https://oauth2.googleapis.com/token", new URLSearchParams({
      client_id: cid, client_secret: csec, refresh_token: ref, grant_type: "refresh_token"
    }), { timeout: 30000 });
    access = r.data.access_token;
    console.log("YT access token OK");
  } catch (e) {
    console.log("YT refresh ERR:", e.response?.data?.error_description || e.message);
    process.exit(0);
  }

  // Get my channel uploads playlist
  try {
    const ch = await axios.get("https://www.googleapis.com/youtube/v3/channels", {
      params: { part: "snippet,contentDetails,statistics", mine: "true" },
      headers: { Authorization: `Bearer ${access}` }, timeout: 30000,
    });
    const channel = ch.data.items?.[0];
    if (!channel) { console.log("No channel found"); return; }
    console.log("Channel:", channel.snippet.title, "subscribers:", channel.statistics?.subscriberCount, "totalViews:", channel.statistics?.viewCount, "videoCount:", channel.statistics?.videoCount);
    const uploadsPlaylist = channel.contentDetails?.relatedPlaylists?.uploads;
    if (!uploadsPlaylist) { console.log("No uploads playlist"); return; }

    // Get last 20 uploads
    const pl = await axios.get("https://www.googleapis.com/youtube/v3/playlistItems", {
      params: { part: "snippet,contentDetails", playlistId: uploadsPlaylist, maxResults: 20 },
      headers: { Authorization: `Bearer ${access}` }, timeout: 30000,
    });
    const items = pl.data.items || [];
    console.log(`\nLast ${items.length} uploads:`);
    const ids = items.map(i => i.contentDetails.videoId).join(",");
    const stats = await axios.get("https://www.googleapis.com/youtube/v3/videos", {
      params: { part: "snippet,statistics,contentDetails", id: ids },
      headers: { Authorization: `Bearer ${access}` }, timeout: 30000,
    });
    for (const v of stats.data.items || []) {
      const title = (v.snippet.title || "").slice(0, 60);
      const pub = v.snippet.publishedAt?.slice(0, 16);
      const dur = v.contentDetails.duration;
      const views = v.statistics?.viewCount || 0;
      const likes = v.statistics?.likeCount || 0;
      const cmts = v.statistics?.commentCount || 0;
      console.log(`  [${pub}] ${dur.padEnd(8)} views=${String(views).padStart(6)} likes=${String(likes).padStart(4)} cmts=${String(cmts).padStart(3)} | "${title}"`);
    }
  } catch (e) {
    console.log("YT API ERR:", e.response?.data?.error?.message || e.message);
  }
})();
'
node -e "$YT_NODE" 2>&1

echo
echo '=====AUTO_POST_HISTORY 14d (the high volume hard-sell module)====='
sqlite3 -header -column data/db.sqlite <<'SQL'
SELECT
  COUNT(*) as total_auto_posts,
  COUNT(CASE WHEN status='posted' THEN 1 END) as posted,
  COUNT(CASE WHEN status='failed' THEN 1 END) as failed,
  MIN(datetime(created_at/1000,'unixepoch','+7 hours')) as first,
  MAX(datetime(created_at/1000,'unixepoch','+7 hours')) as last
FROM auto_post_history
WHERE created_at > strftime('%s', 'now', '-14 days') * 1000;
SQL

echo
echo '=====What Anthology has been actually published (story_episodes)====='
sqlite3 -header -column data/db.sqlite "SELECT id, episode_no, title, status, datetime(published_at/1000,'unixepoch','+7 hours') as pub_vn FROM story_episodes WHERE status='published' ORDER BY id DESC LIMIT 8;"
"""

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, username=USER, password=PASSWORD, timeout=15, look_for_keys=False, allow_agent=False)

stdin, stdout, stderr = client.exec_command(CMD, timeout=180)
print(stdout.read().decode("utf-8", errors="replace"))
err = stderr.read().decode("utf-8", errors="replace")
if err.strip():
    print("STDERR:", err, file=sys.stderr)
client.close()

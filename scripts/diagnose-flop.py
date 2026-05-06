"""Diagnose flop: pull FB metrics for recent video posts + compare with baseline."""
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

echo '=====RECENT ANTHOLOGY EPISODES (last 14)====='
sqlite3 -header -column data/db.sqlite <<'SQL'
SELECT
  id, episode_no, title,
  substr(character_slug,1,8) as char,
  hook_pattern,
  status,
  substr(scheduled_for, 1, 16) as scheduled,
  substr(published_at, 1, 16) as published,
  fb_post_id,
  ROUND(actual_cost_usd, 2) as cost
FROM story_episodes
ORDER BY id DESC
LIMIT 14;
SQL

echo
echo '=====FB POST METRICS (most recent published)====='
sqlite3 -header -column data/db.sqlite <<'SQL'
SELECT
  fb_post_id,
  substr(message, 1, 60) as caption,
  reach,
  impressions,
  reactions,
  comments,
  shares,
  video_views,
  ROUND(CAST(video_views AS FLOAT) / NULLIF(reach,0) * 100, 1) as vtr_pct,
  substr(created_at, 1, 16) as posted
FROM fb_post_insights
WHERE created_at > datetime('now','-21 days')
ORDER BY created_at DESC
LIMIT 20;
SQL

echo
echo '=====FB INSIGHTS TABLE COLUMNS====='
sqlite3 data/db.sqlite ".schema fb_post_insights" 2>/dev/null | head -40

echo
echo '=====PUBLISHED FB POSTS TABLE====='
sqlite3 data/db.sqlite ".tables" | tr ' ' '\n' | grep -iE 'fb|post|publish|insight' | sort -u

echo
echo '=====CHECK fb_videos_published (if exists)====='
sqlite3 -header -column data/db.sqlite "SELECT * FROM sqlite_master WHERE type='table' AND name LIKE '%fb%';" 2>/dev/null

echo
echo '=====EPISODE 14 RAW (bgm-fix one)====='
sqlite3 data/db.sqlite "SELECT * FROM story_episodes WHERE id IN (13,14,15) ORDER BY id;" 2>/dev/null

echo
echo '=====BASELINE — TẬP 1 metrics if available====='
sqlite3 data/db.sqlite "SELECT id, episode_no, title, fb_post_id, status, published_at FROM story_episodes WHERE episode_no=1 LIMIT 3;" 2>/dev/null
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

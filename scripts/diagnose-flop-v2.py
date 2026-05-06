"""Diagnose flop v2: pull FB + YouTube metrics for recent video posts."""
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

echo '=====TABLES with metric/youtube/video====='
sqlite3 data/db.sqlite ".tables" | tr ' ' '\n' | grep -iE 'metric|youtube|yt|video|publish|post' | sort -u

echo
echo '=====video_publish_log schema====='
sqlite3 data/db.sqlite ".schema video_publish_log" 2>/dev/null

echo
echo '=====post_metrics schema====='
sqlite3 data/db.sqlite ".schema post_metrics" 2>/dev/null

echo
echo '=====posts schema (find videos)====='
sqlite3 data/db.sqlite ".schema posts" 2>/dev/null | head -40

echo
echo '=====video_publish_log RECENT 20====='
sqlite3 -header -column data/db.sqlite <<'SQL'
SELECT
  id,
  substr(video_path, -50) as video,
  fb_post_id,
  yt_video_id,
  fb_views,
  fb_reactions,
  fb_comments,
  fb_shares,
  yt_views,
  yt_likes,
  yt_comments,
  substr(published_at, 1, 16) as published,
  substr(last_metric_pull, 1, 16) as last_pull
FROM video_publish_log
ORDER BY id DESC
LIMIT 20;
SQL

echo
echo '=====post_metrics RECENT 30 ====='
sqlite3 -header -column data/db.sqlite <<'SQL'
SELECT * FROM post_metrics
ORDER BY id DESC
LIMIT 30;
SQL

echo
echo '=====posts (anthology related, last 14)====='
sqlite3 -header -column data/db.sqlite <<'SQL'
SELECT
  id,
  fb_post_id,
  substr(message, 1, 60) as caption,
  source,
  status,
  substr(created_at, 1, 16) as created
FROM posts
WHERE created_at > datetime('now','-14 days') OR source LIKE '%anth%' OR source LIKE '%cinema%' OR source LIKE '%storytelling%'
ORDER BY id DESC
LIMIT 30;
SQL

echo
echo '=====YouTube tokens in settings (any)====='
sqlite3 data/db.sqlite "SELECT key FROM settings WHERE key LIKE '%youtube%' OR key LIKE '%yt_%' OR key LIKE '%google%' OR key LIKE '%oauth%';" 2>/dev/null

echo
echo '=====FB token settings====='
sqlite3 data/db.sqlite "SELECT key, length(value) as len FROM settings WHERE key LIKE '%fb%token%' OR key LIKE '%page%' OR key LIKE '%insta%';" 2>/dev/null
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

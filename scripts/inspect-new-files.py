"""Đọc từng file mới quan trọng trên VPS để hiểu chức năng."""
import sys, paramiko
try: sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except: pass
HOST = "103.82.193.74"
PASSWORD = sys.argv[1] if len(sys.argv) > 1 else ""

CMD = r"""
cd /opt/vp-marketing

echo '═══════════════════════════════════════════════'
echo 'youtube-publisher.ts (đầu file)'
echo '═══════════════════════════════════════════════'
head -50 src/services/youtube-publisher.ts

echo ''
echo '═══════════════════════════════════════════════'
echo 'story-engine.ts (đầu file)'
echo '═══════════════════════════════════════════════'
head -60 src/services/story-engine.ts

echo ''
echo '═══════════════════════════════════════════════'
echo 'story-to-video.ts (đầu file — file rất lớn 60KB)'
echo '═══════════════════════════════════════════════'
head -80 src/services/story-to-video.ts

echo ''
echo '═══════════════════════════════════════════════'
echo 'stories.ts route (đầu file)'
echo '═══════════════════════════════════════════════'
head -50 src/routes/stories.ts

echo ''
echo '═══════════════════════════════════════════════'
echo 'youtube-oauth.ts route (đầu file)'
echo '═══════════════════════════════════════════════'
head -50 src/routes/youtube-oauth.ts

echo ''
echo '═══════════════════════════════════════════════'
echo 'Diff src/index.ts (có routes mới nào mounted?)'
echo '═══════════════════════════════════════════════'
git diff src/index.ts

echo ''
echo '═══════════════════════════════════════════════'
echo 'Diff src/services/scheduler.ts (cron jobs mới?)'
echo '═══════════════════════════════════════════════'
git diff src/services/scheduler.ts

echo ''
echo '═══════════════════════════════════════════════'
echo 'New DB tables — schema'
echo '═══════════════════════════════════════════════'
sqlite3 data/db.sqlite ".schema story_series" 2>/dev/null
echo ''
sqlite3 data/db.sqlite ".schema story_episodes" 2>/dev/null
echo ''
sqlite3 data/db.sqlite ".schema cross_post_log" 2>/dev/null
echo ''
sqlite3 data/db.sqlite ".schema broadcast_campaigns" 2>/dev/null
echo ''
sqlite3 data/db.sqlite ".schema broadcast_sends" 2>/dev/null
echo ''
sqlite3 data/db.sqlite ".schema auto_post_history" 2>/dev/null
"""

c = paramiko.SSHClient()
c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
c.connect(HOST, username="root", password=PASSWORD, timeout=20)
_, out, err = c.exec_command(CMD, timeout=60)
print(out.read().decode('utf-8', errors='replace'))
e = err.read().decode('utf-8', errors='replace')
if e.strip(): print('--STDERR--'); print(e[:500])
c.close()

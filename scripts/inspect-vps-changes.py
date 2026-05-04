"""Liệt kê chi tiết files mới + modified trên VPS."""
import sys, paramiko
try: sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except: pass
HOST = "103.82.193.74"
PASSWORD = sys.argv[1] if len(sys.argv) > 1 else ""

CMD = r"""
cd /opt/vp-marketing

echo '═══════════════════════════════════════════════'
echo '1. VPS HEAD vs origin/main'
echo '═══════════════════════════════════════════════'
echo "VPS HEAD: $(git rev-parse HEAD)"
echo "Origin main: $(git rev-parse origin/main 2>/dev/null || git ls-remote origin main | head -1)"
echo ""

echo '═══════════════════════════════════════════════'
echo '2. Files modified LOCALLY trên VPS (chưa commit)'
echo '═══════════════════════════════════════════════'
git diff --stat
echo ''
echo '─── Detail diff (first 100 lines per file) ───'
git diff --name-only | head -10

echo ''
echo '═══════════════════════════════════════════════'
echo '3. Untracked files trên VPS (files mới chưa add vào git)'
echo '═══════════════════════════════════════════════'
git ls-files --others --exclude-standard | head -50

echo ''
echo '═══════════════════════════════════════════════'
echo '4. New TS files (modified after Apr 25 + not in our git)'
echo '═══════════════════════════════════════════════'
echo '─ Check youtube-publisher.ts ─'
ls -la src/services/youtube-publisher.ts 2>/dev/null && git log --oneline -1 -- src/services/youtube-publisher.ts 2>/dev/null
echo ''
echo '─ Check story-engine.ts ─'
ls -la src/services/story-engine.ts 2>/dev/null && git log --oneline -1 -- src/services/story-engine.ts 2>/dev/null
echo ''
echo '─ Check story-to-video.ts ─'
ls -la src/services/story-to-video.ts 2>/dev/null && git log --oneline -1 -- src/services/story-to-video.ts 2>/dev/null
echo ''
echo '─ Check stories.ts route ─'
ls -la src/routes/stories.ts 2>/dev/null && git log --oneline -1 -- src/routes/stories.ts 2>/dev/null
echo ''
echo '─ Check youtube-oauth.ts route ─'
ls -la src/routes/youtube-oauth.ts 2>/dev/null && git log --oneline -1 -- src/routes/youtube-oauth.ts 2>/dev/null

echo ''
echo '═══════════════════════════════════════════════'
echo '5. New tables không có trong git (so với init schema)'
echo '═══════════════════════════════════════════════'
sqlite3 data/db.sqlite "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name" | grep -E "story|youtube|cross_post|blog_bridge|broadcast" 2>/dev/null

echo ''
echo '═══════════════════════════════════════════════'
echo '6. package.json changes'
echo '═══════════════════════════════════════════════'
git diff package.json | head -50
"""

c = paramiko.SSHClient()
c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
c.connect(HOST, username="root", password=PASSWORD, timeout=20)
_, out, err = c.exec_command(CMD, timeout=60)
print(out.read().decode('utf-8', errors='replace'))
e = err.read().decode('utf-8', errors='replace')
if e.strip(): print('--STDERR--'); print(e[:500])
c.close()

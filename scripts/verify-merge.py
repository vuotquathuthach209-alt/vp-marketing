"""Verify Video Studio merged into main admin panel."""
import sys, paramiko
try: sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except: pass
HOST = "103.82.193.74"
PASSWORD = sys.argv[1] if len(sys.argv) > 1 else ""

CMD = r"""
echo '=== 1. Check sidebar tabs in main index.html ==='
grep -c 'data-tab="vs-dashboard"' /opt/vp-marketing/src/public/index.html
echo 'vs- tabs count:'
grep -o 'data-tab="vs-[a-z]*"' /opt/vp-marketing/src/public/index.html | sort -u

echo ''
echo '=== 2. Check panels in main index.html ==='
grep -o 'data-panel="vs-[a-z]*"' /opt/vp-marketing/src/public/index.html | sort -u

echo ''
echo '=== 3. Check vs functions in app.js ==='
grep -c "^async function vs\|^function vs" /opt/vp-marketing/src/public/app.js
grep -o "^async function vs[A-Z][a-zA-Z]*\|^function vs[A-Z][a-zA-Z]*" /opt/vp-marketing/src/public/app.js | sort -u | head -20

echo ''
echo '=== 4. Standalone files status ==='
ls -la /opt/vp-marketing/src/public/video-studio.html 2>/dev/null
ls -la /opt/vp-marketing/src/public/video-studio.js 2>/dev/null || echo 'video-studio.js: removed'

echo ''
echo '=== 5. Index HTML serve check ==='
curl -s -o /dev/null -w 'HTTP %{http_code}\n' http://localhost:3000/index.html

echo ''
echo '=== 6. Video Studio API ==='
curl -s -o /dev/null -w 'HTTP %{http_code}\n' http://localhost:3000/api/video-studio/status

echo ''
echo '=== 7. DB tables ==='
sqlite3 /opt/vp-marketing/data/db.sqlite "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'video_%' ORDER BY name" 2>/dev/null

echo ''
echo '=== 8. FFmpeg status ==='
which ffmpeg && ffmpeg -version 2>&1 | head -1
"""

c = paramiko.SSHClient()
c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
c.connect(HOST, username="root", password=PASSWORD, timeout=20)
_, out, err = c.exec_command(CMD, timeout=60)
print(out.read().decode('utf-8', errors='replace'))
e = err.read().decode('utf-8', errors='replace')
if e.strip(): print('--STDERR--'); print(e[:500])
c.close()

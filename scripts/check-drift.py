"""So sánh local vs VPS deployed — phát hiện drift."""
import sys, paramiko
try: sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except: pass
HOST = "103.82.193.74"
PASSWORD = sys.argv[1] if len(sys.argv) > 1 else ""

CMD = r"""
cd /opt/vp-marketing
echo '=== Git status trên VPS ==='
git status --short
echo ''
echo '=== Latest commit on VPS ==='
git log --oneline -3
echo ''
echo '=== Branch trên VPS ==='
git rev-parse --abbrev-ref HEAD
echo ''
echo '=== Có file modified locally trên VPS không? ==='
git diff --stat HEAD 2>/dev/null | tail -5
echo ''
echo '=== Untracked files trên VPS ==='
git ls-files --others --exclude-standard | head -20
echo ''
echo '=== PM2 status ==='
pm2 list 2>&1 | grep vp-mkt
echo ''
echo '=== App đang chạy commit nào? ==='
ls -la /opt/vp-marketing/dist/index.js 2>/dev/null | head -1
echo ''
echo '=== File mới có sync chưa? ==='
ls -la /opt/vp-marketing/src/services/video-studio/ 2>/dev/null
echo ''
echo '=== DB tables (video_*) ==='
sqlite3 data/db.sqlite "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'video_%' ORDER BY name" 2>/dev/null

echo ''
echo '=== DB tables (agentic_*) ==='
sqlite3 data/db.sqlite "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'agentic_%' ORDER BY name" 2>/dev/null

echo ''
echo '=== Setting check (API keys) ==='
sqlite3 data/db.sqlite "SELECT key, CASE WHEN length(value) > 0 THEN '[has value, ' || length(value) || ' chars]' ELSE '[empty]' END FROM settings WHERE key LIKE '%api_key%' OR key LIKE 'vs_%' OR key = 'video_studio_enabled' ORDER BY key" 2>/dev/null
"""

c = paramiko.SSHClient()
c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
c.connect(HOST, username="root", password=PASSWORD, timeout=20)
_, out, err = c.exec_command(CMD, timeout=60)
print(out.read().decode('utf-8', errors='replace'))
e = err.read().decode('utf-8', errors='replace')
if e.strip(): print('--STDERR--'); print(e[:500])
c.close()

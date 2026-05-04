"""So sánh git log + check files mới trên VPS."""
import sys, paramiko
try: sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except: pass
HOST = "103.82.193.74"
PASSWORD = sys.argv[1] if len(sys.argv) > 1 else ""

CMD = r"""
cd /opt/vp-marketing
echo '=== Git log on VPS (last 20 commits) ==='
git log --oneline -20
echo ''
echo '=== Remote tracking ==='
git remote -v
echo ''
echo '=== Branches ==='
git branch -a
echo ''
echo '=== Diff trong tree (any local mods?) ==='
git diff --stat
echo ''
echo '=== Files trong dist (most recent 20) ==='
find dist -type f -name '*.js' -newer /tmp -mmin -10000 2>/dev/null | head -10
echo ''
echo '=== Find ts files modified after Apr 25 ==='
find src -type f -name '*.ts' -newer /etc/hostname -mtime -10 2>/dev/null | head -30
echo ''
echo '=== Specific Video Studio files modification times ==='
find src/services/video-studio src/routes/video-studio.ts src/public/index.html src/public/app.js -type f 2>/dev/null | xargs ls -la 2>/dev/null
echo ''
echo '=== Check for new DB tables not in our migration ==='
sqlite3 data/db.sqlite "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name" | wc -l
echo 'Total tables (vs ~80 expected after our v27 + video studio)'
echo ''
echo '=== All settings keys count ==='
sqlite3 data/db.sqlite "SELECT COUNT(*) FROM settings" 2>/dev/null
"""

c = paramiko.SSHClient()
c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
c.connect(HOST, username="root", password=PASSWORD, timeout=20)
_, out, err = c.exec_command(CMD, timeout=60)
print(out.read().decode('utf-8', errors='replace'))
e = err.read().decode('utf-8', errors='replace')
if e.strip(): print('--STDERR--'); print(e[:500])
c.close()

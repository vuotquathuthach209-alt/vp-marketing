"""Reset VPS git về match origin/main (an toàn vì content đã sync 2 chiều)."""
import sys, paramiko
try: sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except: pass
HOST = "103.82.193.74"
PASSWORD = sys.argv[1] if len(sys.argv) > 1 else ""

CMD = r"""
cd /opt/vp-marketing

echo '═══ Step 1: Stash uncommitted changes (safety net) ═══'
git stash push -u -m "pre-sync-$(date +%Y%m%d-%H%M)" 2>&1 | tail -3

echo ''
echo '═══ Step 2: Pull origin (fast-forward to GitHub) ═══'
git fetch origin 2>&1 | tail -3
git reset --hard origin/main 2>&1 | tail -3

echo ''
echo '═══ Step 3: Verify HEAD ═══'
git log --oneline -1
echo ''

echo '═══ Step 4: Diff stash vs current (xem có gì khác) ═══'
git stash list | head -3
echo ''
echo 'Diff stash@{0} vs HEAD (chỉ list files khác):'
git stash show stash@{0} --stat 2>&1 | head -20

echo ''
echo '═══ Step 5: Drop stash nếu identical với HEAD ═══'
DIFF_LINES=$(git stash show stash@{0} 2>/dev/null | wc -l)
echo "Stash diff lines: $DIFF_LINES"

if [ "$DIFF_LINES" = "0" ]; then
  echo 'Identical → safe drop stash'
  git stash drop stash@{0}
else
  echo 'Khác → giữ stash để inspect, không drop tự động'
  echo 'Để xem: git stash show -p stash@{0}'
fi

echo ''
echo '═══ Final state ═══'
echo 'Branch:'
git rev-parse --abbrev-ref HEAD
echo 'Latest commit:'
git log --oneline -1
echo 'Working tree:'
git status --short | head -5
echo 'Stashes:'
git stash list | head -3
"""

c = paramiko.SSHClient()
c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
c.connect(HOST, username="root", password=PASSWORD, timeout=20)
_, out, err = c.exec_command(CMD, timeout=60)
print(out.read().decode('utf-8', errors='replace'))
e = err.read().decode('utf-8', errors='replace')
if e.strip(): print('--STDERR--'); print(e[:500])
c.close()

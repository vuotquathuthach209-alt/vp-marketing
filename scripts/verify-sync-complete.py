"""Verify Local = GitHub = VPS sau khi sync."""
import sys, paramiko, subprocess
try: sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except: pass
HOST = "103.82.193.74"
PASSWORD = sys.argv[1] if len(sys.argv) > 1 else ""

print("=== LOCAL latest commit ===")
local = subprocess.check_output(["git", "log", "--oneline", "-1"], cwd=r"C:\Users\USER\tự động đăng facebook").decode("utf-8", errors="replace").strip()
print(local)

print("\n=== Origin main ===")
origin = subprocess.check_output(["git", "log", "--oneline", "-1", "origin/main"], cwd=r"C:\Users\USER\tự động đăng facebook").decode("utf-8", errors="replace").strip()
print(origin)

print("\n=== VPS git status ===")
CMD = r"""
cd /opt/vp-marketing
echo 'VPS HEAD:'
git log --oneline -1
echo ''
echo 'Pull from origin:'
git fetch origin 2>&1 | tail -3
echo 'Origin main on VPS:'
git log --oneline origin/main -1
echo ''
echo 'Status before pull:'
git status --short | head -10
echo '...'
echo ''
echo 'NOTE: VPS có local files modifications. Để pull cần:'
echo '  git stash → git pull → check files match'
echo 'Hoặc reset hard nếu trust GitHub:'
echo '  git fetch origin && git reset --hard origin/main'
"""

c = paramiko.SSHClient()
c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
c.connect(HOST, username="root", password=PASSWORD, timeout=20)
_, out, err = c.exec_command(CMD, timeout=30)
print(out.read().decode('utf-8', errors='replace'))
e = err.read().decode('utf-8', errors='replace')
if e.strip(): print('--STDERR--'); print(e[:500])
c.close()

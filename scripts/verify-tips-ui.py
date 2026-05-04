"""Verify Tips + Weekend UI tabs deployed."""
import sys, paramiko
try: sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except: pass
HOST = "103.82.193.74"
PASSWORD = sys.argv[1] if len(sys.argv) > 1 else ""

CMD = r"""
cd /opt/vp-marketing
echo '=== Sidebar tabs ==='
grep -o 'data-tab="vs-tips"\|data-tab="vs-weekend"' src/public/index.html | sort -u

echo ''
echo '=== Panels ==='
grep -o 'data-panel="vs-tips"\|data-panel="vs-weekend"' src/public/index.html | sort -u

echo ''
echo '=== JS functions ==='
grep -c "^async function vsTips\|^function vsTips\|^async function vsWeekend\|^function vsWeekend" src/public/app.js
echo "Functions found:"
grep -o "^async function vs\(Tips\|Weekend\)[A-Z][a-zA-Z]*\|^function vs\(Tips\|Weekend\)[A-Z][a-zA-Z]*" src/public/app.js | sort -u | head -25

echo ''
echo '=== Tab router ==='
grep -E "vs-tips|vs-weekend" src/public/app.js | head -5
"""

c = paramiko.SSHClient()
c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
c.connect(HOST, username="root", password=PASSWORD, timeout=20)
_, out, err = c.exec_command(CMD, timeout=30)
print(out.read().decode('utf-8', errors='replace'))
e = err.read().decode('utf-8', errors='replace')
if e.strip(): print('--STDERR--'); print(e[:500])
c.close()

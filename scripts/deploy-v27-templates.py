"""Deploy v27 DB-driven template engine to VPS + verify seed."""
import sys, paramiko
try: sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except: pass
HOST = "103.82.193.74"
PASSWORD = sys.argv[1] if len(sys.argv) > 1 else ""

CMD = r"""
set -e
cd /opt/vp-marketing
echo '=== Pull latest code ==='
git pull origin main 2>&1 | tail -3
echo ''
echo '=== Install ALL deps (incl dev for build) ==='
npm install --no-audit --no-fund 2>&1 | tail -3
echo ''
echo '=== Build TypeScript ==='
npx tsc 2>&1 | tail -10
echo ''
echo '=== Restart PM2 ==='
pm2 restart vp-mkt --update-env 2>&1 | tail -3
echo ''
echo '=== Wait for boot ==='
sleep 5
echo ''
echo '=== Check seeder logs ==='
pm2 logs vp-mkt --lines 60 --nostream 2>&1 | grep -E '(template-seeder|agentic_templates|v27|Marketing Auto|Error|error)' | tail -25
echo ''
echo '=== Verify table count by category ==='
sqlite3 /opt/vp-marketing/data/db.sqlite "SELECT category, COUNT(*) as n FROM agentic_templates WHERE active=1 GROUP BY category ORDER BY category;" 2>/dev/null
echo ''
echo '=== All template IDs ==='
sqlite3 /opt/vp-marketing/data/db.sqlite "SELECT id FROM agentic_templates WHERE active=1 ORDER BY category, id;" 2>/dev/null
echo ''
echo '=== Sample render test ==='
sqlite3 /opt/vp-marketing/data/db.sqlite "SELECT substr(content, 1, 120) || '...' FROM agentic_templates WHERE id='first_contact_warm';" 2>/dev/null
"""

c = paramiko.SSHClient()
c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
c.connect(HOST, username="root", password=PASSWORD, timeout=20)
_, out, err = c.exec_command(CMD, timeout=240)
print(out.read().decode('utf-8', errors='replace'))
e = err.read().decode('utf-8', errors='replace')
if e.strip(): print('--STDERR--'); print(e)
c.close()

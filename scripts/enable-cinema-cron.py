"""Enable Cinema T7 12h weekly cron + verify settings."""
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

echo '=====CURRENT CINEMA SETTINGS====='
sqlite3 data/db.sqlite "SELECT key, value FROM settings WHERE key LIKE 'cinema_%' ORDER BY key;"

echo
echo '=====ENABLING CRON + PILOT mode 90s====='
NOW=$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")
sqlite3 data/db.sqlite <<SQL
INSERT INTO settings(key,value,updated_at) VALUES('cinema_cron_enabled','true','$NOW')
  ON CONFLICT(key) DO UPDATE SET value='true', updated_at='$NOW';
INSERT INTO settings(key,value,updated_at) VALUES('cinema_target_duration_sec','90','$NOW')
  ON CONFLICT(key) DO UPDATE SET value='90', updated_at='$NOW';
INSERT INTO settings(key,value,updated_at) VALUES('cinema_max_cost_per_episode','3.00','$NOW')
  ON CONFLICT(key) DO UPDATE SET value='3.00', updated_at='$NOW';
INSERT INTO settings(key,value,updated_at) VALUES('cinema_auto_publish','false','$NOW')
  ON CONFLICT(key) DO UPDATE SET value='false', updated_at='$NOW';
SQL

echo
echo '=====POST-UPDATE SETTINGS====='
sqlite3 data/db.sqlite "SELECT key, value FROM settings WHERE key LIKE 'cinema_%' ORDER BY key;"

echo
echo '=====RESTART PM2 to pick up cron flag====='
pm2 restart vp-mkt 2>&1 | tail -5

echo
echo '=====CRON HEARTBEAT (last 10 lines)====='
sleep 3
pm2 logs vp-mkt --lines 50 --nostream 2>&1 | grep -iE 'cinema.*cron|scheduled|sat' | tail -10

echo
echo '=====NEXT T7 12h schedule check====='
echo "Next Saturday 12:00 ICT:"
date -d 'next Saturday 12:00' '+%A %Y-%m-%d %H:%M %Z'
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

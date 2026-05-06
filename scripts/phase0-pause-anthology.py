"""PHASE 0: Pause Anthology daily cron — stop burning $300/mo.

Anthology daily đang chạy 17h generate + 19h publish, reach=0, không attribution booking.
Theo skill sonder-tech-sovereignty: tạm pause cho đến khi có >5000 organic followers.
Cinema weekly T7 GIỮ ($7/mo, brand asset cho website + email).
"""
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

echo '=====BEFORE====='
sqlite3 -header -column data/db.sqlite "SELECT key,value FROM settings WHERE key IN ('vs_anthology_cron_enabled','cinema_cron_enabled','product_auto_post_enabled','crosspost_nhatot247_disabled') ORDER BY key;"

echo
echo '=====SET vs_anthology_cron_enabled=false====='
NOW=$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")
sqlite3 data/db.sqlite <<SQL
INSERT INTO settings(key,value,updated_at) VALUES('vs_anthology_cron_enabled','false','$NOW')
  ON CONFLICT(key) DO UPDATE SET value='false', updated_at='$NOW';
INSERT INTO settings(key,value,updated_at) VALUES('vs_anthology_pause_reason','flop diagnose 2026-05-06: reach=0, no booking attribution. See skill sonder-tech-sovereignty.','$NOW')
  ON CONFLICT(key) DO UPDATE SET value='flop diagnose 2026-05-06: reach=0, no booking attribution. See skill sonder-tech-sovereignty.', updated_at='$NOW';
INSERT INTO settings(key,value,updated_at) VALUES('vs_anthology_pause_date','2026-05-06','$NOW')
  ON CONFLICT(key) DO UPDATE SET value='2026-05-06', updated_at='$NOW';
SQL

echo
echo '=====AFTER====='
sqlite3 -header -column data/db.sqlite "SELECT key,value FROM settings WHERE key IN ('vs_anthology_cron_enabled','vs_anthology_pause_reason','vs_anthology_pause_date','cinema_cron_enabled','product_auto_post_enabled') ORDER BY key;"

echo
echo '=====RESTART PM2====='
pm2 restart vp-mkt 2>&1 | tail -3

echo
echo '=====VERIFY (logs)====='
sleep 5
pm2 logs vp-mkt --lines 60 --nostream 2>&1 | grep -iE 'anthology|cinema|product-auto-post' | tail -15
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

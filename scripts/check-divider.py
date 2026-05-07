"""Check Google Drive / divider folder settings."""
import sys, paramiko

try: sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except: pass

c = paramiko.SSHClient()
c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
c.connect("103.82.193.74", username="root", password="cCxEvKZ0J3Ee6NJG", timeout=15)
_, o, _ = c.exec_command(
    "sqlite3 /opt/vp-marketing/data/db.sqlite "
    "\"SELECT key, length(value), substr(value,1,50) FROM settings "
    "WHERE key LIKE '%drive%' OR key LIKE '%folder%' OR key LIKE '%divider%' OR key LIKE '%upload%' OR key LIKE '%gdrive%' OR key LIKE '%telegram%';\"",
    timeout=10,
)
print(o.read().decode("utf-8", errors="replace"))
c.close()

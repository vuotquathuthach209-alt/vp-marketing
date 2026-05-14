"""Run tsc build on VPS + restart."""
import paramiko, sys, io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")
HOST = "103.82.193.74"; USER = "root"; PASS = "cCxEvKZ0J3Ee6NJG"

CMDS = [
    "cd /opt/vp-marketing && npm run build 2>&1 | tail -30",
    "ls -la /opt/vp-marketing/dist/services/seo/article-writer.js 2>&1",
    "pm2 restart vp-mkt",
    "sleep 3 && pm2 logs vp-mkt --lines 10 --nostream 2>&1 | tail -25",
]

cl = paramiko.SSHClient()
cl.set_missing_host_key_policy(paramiko.AutoAddPolicy())
cl.connect(HOST, 22, USER, PASS, timeout=30, banner_timeout=60)
for c in CMDS:
    print(f"\n$ {c}")
    _, o, e = cl.exec_command(c, timeout=180)
    out = o.read().decode("utf-8", errors="replace")
    err = e.read().decode("utf-8", errors="replace")
    if out: print(out.rstrip())
    if err: print("STDERR:", err.rstrip())
cl.close()

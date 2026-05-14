"""Check how the VPS handles TS → dist."""
import paramiko, sys, io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")
HOST = "103.82.193.74"; USER = "root"; PASS = "cCxEvKZ0J3Ee6NJG"

CMDS = [
    "ls /opt/vp-marketing/dist/services/seo/ 2>&1",
    "cat /opt/vp-marketing/package.json | head -30",
    "ls /opt/vp-marketing/dist/services/seo/article-writer.* 2>&1",
]

cl = paramiko.SSHClient()
cl.set_missing_host_key_policy(paramiko.AutoAddPolicy())
cl.connect(HOST, 22, USER, PASS, timeout=30, banner_timeout=60)
for c in CMDS:
    print(f"\n$ {c}")
    _, o, e = cl.exec_command(c, timeout=30)
    out = o.read().decode("utf-8", errors="replace")
    err = e.read().decode("utf-8", errors="replace")
    if out: print(out.rstrip())
    if err: print("STDERR:", err.rstrip())
cl.close()

"""Deploy: git pull + npm install + pm2 restart on VPS."""
import paramiko, sys, time, io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")

HOST = "103.82.193.74"
USER = "root"
PASS = "cCxEvKZ0J3Ee6NJG"

CMDS = [
    "cd /opt/vp-marketing && git pull",
    "cd /opt/vp-marketing && npm install --no-audit --no-fund 2>&1 | tail -3",
    "cd /opt/vp-marketing && npm run build 2>&1 | tail -10",
    "pm2 restart vp-mkt",
    "sleep 3 && pm2 logs vp-mkt --lines 10 --nostream 2>&1 | tail -15",
]

def run():
    cl = paramiko.SSHClient()
    cl.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    print(f"Connecting to {USER}@{HOST}...", flush=True)
    cl.connect(HOST, port=22, username=USER, password=PASS, timeout=30, banner_timeout=60)
    for cmd in CMDS:
        print(f"\n$ {cmd}", flush=True)
        t0 = time.time()
        stdin, stdout, stderr = cl.exec_command(cmd, timeout=240)
        out = stdout.read().decode("utf-8", errors="replace")
        err = stderr.read().decode("utf-8", errors="replace")
        if out: print(out.rstrip(), flush=True)
        if err: print("STDERR:", err.rstrip(), flush=True, file=sys.stderr)
        print(f"  ({time.time()-t0:.1f}s)", flush=True)
    cl.close()

if __name__ == "__main__":
    run()

"""Install FFmpeg on VPS (required for Video Studio compose)."""
import sys, paramiko
try: sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except: pass
HOST = "103.82.193.74"
PASSWORD = sys.argv[1] if len(sys.argv) > 1 else ""

CMD = r"""
echo '=== Install ffmpeg + ffprobe ==='
apt-get update -qq 2>&1 | tail -3
DEBIAN_FRONTEND=noninteractive apt-get install -y ffmpeg 2>&1 | tail -5
echo ''
echo '=== Verify ==='
which ffmpeg && ffmpeg -version 2>&1 | head -2
echo ''
which ffprobe && ffprobe -version 2>&1 | head -1
echo ''
echo '=== Check codecs (need libx264 + aac) ==='
ffmpeg -codecs 2>&1 | grep -E 'libx264|aac' | head -5
"""

c = paramiko.SSHClient()
c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
c.connect(HOST, username="root", password=PASSWORD, timeout=30)
_, out, err = c.exec_command(CMD, timeout=300)
print(out.read().decode('utf-8', errors='replace'))
e = err.read().decode('utf-8', errors='replace')
if e.strip(): print('--STDERR--'); print(e[:1500])
c.close()

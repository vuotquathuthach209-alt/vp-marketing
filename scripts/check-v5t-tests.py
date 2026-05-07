"""Check V5T test results 8 + 9."""
import sys, paramiko

try: sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except: pass

c = paramiko.SSHClient()
c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
c.connect("103.82.193.74", username="root", password="cCxEvKZ0J3Ee6NJG", timeout=15)

queries = [
    "SELECT id, type, theme, status, substr(caption_a, 1, 400) as cap FROM v5t_posts WHERE id IN (8, 9);",
    "SELECT vpi.post_id, vf.filename, vf.location, vf.moment_tag, substr(vf.notes, 1, 150) as notes FROM v5t_post_images vpi LEFT JOIN v5_footage vf ON vf.id = vpi.footage_id WHERE vpi.post_id IN (8, 9);",
]

for q in queries:
    print("=" * 50)
    _, o, _ = c.exec_command(f'sqlite3 -header -column /opt/vp-marketing/data/db.sqlite "{q}"', timeout=10)
    print(o.read().decode("utf-8", errors="replace"))
    print()

c.close()

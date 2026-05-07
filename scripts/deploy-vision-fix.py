"""Deploy vision parsing fix + run backfill on 60 untagged photos."""
import sys, paramiko, time

try: sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except: pass

c = paramiko.SSHClient()
c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
c.connect("103.82.193.74", username="root", password="cCxEvKZ0J3Ee6NJG", timeout=30)


def run(cmd, label="", timeout=180):
    print(f"\n=== {label or cmd[:60]} ===")
    _, o, e = c.exec_command(cmd, timeout=timeout)
    out = o.read().decode("utf-8", errors="replace")
    err = e.read().decode("utf-8", errors="replace")
    if out.strip():
        print(out[-3000:])
    if err.strip() and "warning" not in err.lower():
        print(f"[stderr] {err[-1500:]}")
    return out, err


# 1. Pull + rebuild
run("cd /opt/vp-marketing && git pull origin main", "git pull")
run("cd /opt/vp-marketing && npm run build 2>&1 | tail -20", "tsc build", timeout=300)

# 2. Restart so new schema migration runs
run("pm2 restart vp-mkt && sleep 3 && pm2 status vp-mkt", "pm2 restart")

# 3. Show pre-backfill stats
print("\n" + "=" * 60)
print("BEFORE BACKFILL:")
run(
    'sqlite3 -header -column /opt/vp-marketing/data/db.sqlite '
    '"SELECT COUNT(*) AS total, '
    'SUM(CASE WHEN moment_tag IS NOT NULL THEN 1 ELSE 0 END) AS tagged, '
    'SUM(CASE WHEN moment_tag IS NULL THEN 1 ELSE 0 END) AS untagged '
    'FROM v5_footage WHERE media_type = \'image\' OR media_type IS NULL;"',
    "footage stats",
)

# 4. Run backfill via Node script (calls backfillVisionTags(100))
backfill_script = """
const { backfillVisionTags } = require('/opt/vp-marketing/dist/services/v5t/gdrive-sync');
(async () => {
  console.log('[backfill] starting on up to 100 untagged photos...');
  const r = await backfillVisionTags(100);
  console.log(JSON.stringify(r, null, 2));
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
"""

# Save script to remote
sftp = c.open_sftp()
with sftp.open("/tmp/backfill-vision.js", "w") as f:
    f.write(backfill_script)
sftp.close()

run("cd /opt/vp-marketing && node /tmp/backfill-vision.js 2>&1 | tail -80", "backfill run", timeout=900)

# 5. Show post-backfill stats
print("\n" + "=" * 60)
print("AFTER BACKFILL:")
run(
    'sqlite3 -header -column /opt/vp-marketing/data/db.sqlite '
    '"SELECT COUNT(*) AS total, '
    'SUM(CASE WHEN moment_tag IS NOT NULL THEN 1 ELSE 0 END) AS tagged, '
    'SUM(CASE WHEN moment_tag IS NULL THEN 1 ELSE 0 END) AS untagged '
    'FROM v5_footage WHERE media_type = \'image\' OR media_type IS NULL;"',
    "footage stats AFTER",
)

# 6. Show tag diversity (top moment_tags)
run(
    'sqlite3 -header -column /opt/vp-marketing/data/db.sqlite '
    '"SELECT moment_tag, COUNT(*) AS n FROM v5_footage '
    'WHERE moment_tag IS NOT NULL '
    'GROUP BY moment_tag ORDER BY n DESC LIMIT 25;"',
    "moment_tag distribution (top 25)",
)

# 7. Show location diversity
run(
    'sqlite3 -header -column /opt/vp-marketing/data/db.sqlite '
    '"SELECT location, COUNT(*) AS n FROM v5_footage '
    'WHERE location IS NOT NULL '
    'GROUP BY location ORDER BY n DESC;"',
    "location distribution",
)

# 8. Verify picked_footage_id column exists
run(
    'sqlite3 /opt/vp-marketing/data/db.sqlite '
    '"PRAGMA table_info(v5t_posts);" | grep picked_footage',
    "verify picked_footage_id column",
)

c.close()
print("\n✅ Deploy + backfill DONE")

"""Deploy carousel feature + smoke test that current inventory falls back to single."""
import sys, paramiko

try: sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except: pass

c = paramiko.SSHClient()
c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
c.connect("103.82.193.74", username="root", password="cCxEvKZ0J3Ee6NJG", timeout=30)


def run(cmd, label="", timeout=180):
    print(f"\n=== {label or cmd[:50]} ===")
    _, o, e = c.exec_command(cmd, timeout=timeout)
    out = o.read().decode("utf-8", errors="replace")
    err = e.read().decode("utf-8", errors="replace")
    if out.strip(): print(out[-2500:])
    if err.strip() and "warning" not in err.lower(): print(f"[stderr] {err[-1000:]}")


run("cd /opt/vp-marketing && git pull origin main", "pull")
run("cd /opt/vp-marketing && npm run build 2>&1 | tail -5", "build", timeout=300)
run("pm2 restart vp-mkt && sleep 3", "restart")

# Inventory check — should be 0 tips photos, ~93 general
run(
    'sqlite3 -header -column /opt/vp-marketing/data/db.sqlite '
    '"SELECT '
    '  SUM(CASE WHEN notes LIKE \'%content_type:tips%\' THEN 1 ELSE 0 END) AS tips, '
    '  SUM(CASE WHEN notes LIKE \'%content_type:story%\' THEN 1 ELSE 0 END) AS story, '
    '  SUM(CASE WHEN notes LIKE \'%content_type:general%\' THEN 1 ELSE 0 END) AS general, '
    '  COUNT(*) AS total '
    'FROM v5_footage WHERE media_type = \'image\' OR media_type IS NULL;"',
    "inventory by content_type",
)

# Compose post #11 (tips_post draft) — should compose carousel since 93 general available
print("\n" + "=" * 60)
print("Smoke test: compose post #11 (tips_post)...")
test_script = """
const { composeV5TPost } = require('/opt/vp-marketing/dist/services/v5t/composer');
(async () => {
  const r = await composeV5TPost(11);
  console.log(JSON.stringify({
    ok: r.ok,
    image_count: r.images.length,
    cost: r.total_cost_usd,
    error: r.error,
    paths: r.images.map(i => i.composed_path),
    footage_ids: r.images.map(i => i.footage_id),
  }, null, 2));
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
"""

sftp = c.open_sftp()
with sftp.open("/tmp/test-compose.js", "w") as f:
    f.write(test_script)
sftp.close()

run("cd /opt/vp-marketing && node /tmp/test-compose.js 2>&1 | tail -40", "compose post #11", timeout=180)

# Verify v5t_post_images for post 11
run(
    'sqlite3 -header -column /opt/vp-marketing/data/db.sqlite '
    '"SELECT vpi.position, vpi.footage_id, vpi.has_text_overlay, '
    'vf.filename FROM v5t_post_images vpi '
    'LEFT JOIN v5_footage vf ON vf.id = vpi.footage_id '
    'WHERE vpi.post_id = 11 ORDER BY vpi.position;"',
    "v5t_post_images for post 11",
)

# Footage_id distinct check
run(
    'sqlite3 /opt/vp-marketing/data/db.sqlite '
    '"SELECT COUNT(DISTINCT footage_id) AS distinct_count, '
    'COUNT(*) AS total_count FROM v5t_post_images WHERE post_id = 11;"',
    "carousel within-post dedup verify (distinct should equal total)",
)

c.close()
print("\n✅ Carousel deploy + smoke test DONE")

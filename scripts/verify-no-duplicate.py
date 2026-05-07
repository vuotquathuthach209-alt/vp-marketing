"""Verify no-duplicate photo picker works after vision fix.

Steps:
1. Show current usage state (photos used in posts #8, #9)
2. Generate 5 fresh posts via API
3. Confirm none of them re-use photos from #8 or #9
4. Show inventory remaining (photos never used)
"""
import sys, paramiko, time, json

try: sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except: pass

c = paramiko.SSHClient()
c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
c.connect("103.82.193.74", username="root", password="cCxEvKZ0J3Ee6NJG", timeout=30)


def sql(q, label=""):
    if label: print(f"\n=== {label} ===")
    _, o, _ = c.exec_command(f'sqlite3 -header -column /opt/vp-marketing/data/db.sqlite "{q}"', timeout=15)
    out = o.read().decode("utf-8", errors="replace")
    print(out)
    return out


# 1. Show photos already used in v5t_post_images (the blacklist)
sql(
    "SELECT vpi.post_id, vpi.footage_id, vf.filename "
    "FROM v5t_post_images vpi LEFT JOIN v5_footage vf ON vf.id = vpi.footage_id "
    "ORDER BY vpi.post_id;",
    "Photos already used in v5t posts (the blacklist)",
)

# 2. Show inventory: how many photos are NEVER USED
sql(
    "SELECT COUNT(*) as never_used "
    "FROM v5_footage vf "
    "WHERE (vf.media_type = 'image' OR vf.media_type IS NULL) "
    "AND NOT EXISTS (SELECT 1 FROM v5t_post_images vpi WHERE vpi.footage_id = vf.id);",
    "Inventory: photos never used in any post",
)

# 3. Inventory by content_type (now that vision is fixed)
sql(
    "SELECT "
    "  SUM(CASE WHEN notes LIKE '%content_type:tips%' THEN 1 ELSE 0 END) AS tips, "
    "  SUM(CASE WHEN notes LIKE '%content_type:story%' THEN 1 ELSE 0 END) AS story, "
    "  SUM(CASE WHEN notes LIKE '%content_type:general%' THEN 1 ELSE 0 END) AS general, "
    "  COUNT(*) AS total "
    "FROM v5_footage WHERE media_type = 'image' OR media_type IS NULL;",
    "Inventory by content_type",
)

# 4. Trigger 5 fresh post generations via internal call
print("\n" + "=" * 60)
print("Generating 5 fresh posts via Node script...")

gen_script = """
const { generateV5TPost } = require('/opt/vp-marketing/dist/services/v5t/post-writer');
(async () => {
  const results = [];
  for (let i = 0; i < 5; i++) {
    const type = i % 2 === 0 ? 'tips_post' : 'story_post';
    const post = await generateV5TPost({ type, generated_by: 'verify-no-dup' });
    if (post) {
      results.push({ id: post.id, type, picked: 'see DB' });
    } else {
      results.push({ id: null, type, error: 'no photo or gen fail' });
    }
  }
  console.log(JSON.stringify(results, null, 2));
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
"""

sftp = c.open_sftp()
with sftp.open("/tmp/gen-5posts.js", "w") as f:
    f.write(gen_script)
sftp.close()

_, o, e = c.exec_command(
    "cd /opt/vp-marketing && timeout 600 node /tmp/gen-5posts.js 2>&1 | tail -60",
    timeout=620,
)
print(o.read().decode("utf-8", errors="replace"))

# 5. Show all posts generated, with their picked_footage_id
sql(
    "SELECT id, type, theme, picked_footage_id, status, "
    "datetime(created_at/1000, 'unixepoch') AS created "
    "FROM v5t_posts WHERE generated_by = 'verify-no-dup' ORDER BY id DESC;",
    "5 newly generated posts",
)

# 6. Check for duplicates among the new posts
sql(
    "SELECT picked_footage_id, COUNT(*) AS times_picked, "
    "GROUP_CONCAT(id) AS post_ids "
    "FROM v5t_posts "
    "WHERE picked_footage_id IS NOT NULL "
    "GROUP BY picked_footage_id "
    "HAVING times_picked > 1;",
    "DUPLICATE CHECK: any photo picked twice?",
)

# 7. Show inventory after
sql(
    "SELECT COUNT(*) as never_used_after "
    "FROM v5_footage vf "
    "WHERE (vf.media_type = 'image' OR vf.media_type IS NULL) "
    "AND NOT EXISTS ("
    "  SELECT 1 FROM v5t_post_images vpi WHERE vpi.footage_id = vf.id"
    ") "
    "AND NOT EXISTS ("
    "  SELECT 1 FROM v5t_posts vp WHERE vp.picked_footage_id = vf.id"
    ");",
    "Inventory remaining (excluding draft picks)",
)

c.close()
print("\n✅ Verification complete")

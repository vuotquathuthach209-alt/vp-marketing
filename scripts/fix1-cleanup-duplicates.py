"""FIX 1: Delete duplicate videos on FB pages + disable Nhà Tốt 247 cross-post.

Strategy:
- Group videos last 30 days by (first 50 chars of description, length rounded)
- Keep oldest, delete the rest via Graph API DELETE
- Disable Nhà Tốt 247 page from active cross-posting (settings flag)
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

echo '=====STEP 1: identify + delete duplicate videos====='
NODE_DEDUP='
const Database = require("better-sqlite3");
const axios = require("axios");
const db = new Database("/opt/vp-marketing/data/db.sqlite");

const pages = db.prepare("SELECT * FROM pages").all();

(async () => {
  let totalDeleted = 0, totalKept = 0;
  for (const p of pages) {
    if (!p.access_token) continue;
    console.log(`\n=== PAGE: ${p.name} (${p.fb_page_id}) ===`);

    let videos = [];
    try {
      const v = await axios.get(`https://graph.facebook.com/v21.0/${p.fb_page_id}/videos`, {
        params: { access_token: p.access_token, fields: "id,created_time,description,length", limit: 50 },
        timeout: 30000,
      });
      videos = v.data.data || [];
    } catch (e) { console.log("List ERR:", e.message); continue; }

    // Only consider videos in last 30 days
    const cutoff = Date.now() - 30*24*3600*1000;
    videos = videos.filter(v => new Date(v.created_time).getTime() > cutoff);
    console.log(`  videos in last 30d: ${videos.length}`);

    // Group by (caption-first-60, length-rounded)
    const groups = new Map();
    for (const v of videos) {
      const key = `${(v.description||"").trim().slice(0,60)}|${Math.round(v.length||0)}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(v);
    }

    // For each group with size > 1, keep oldest, delete rest
    for (const [key, vids] of groups) {
      if (vids.length <= 1) continue;
      vids.sort((a,b) => new Date(a.created_time) - new Date(b.created_time));
      const keep = vids[0];
      const dups = vids.slice(1);
      console.log(`\n  [DUP] "${keep.description?.slice(0,40)}..." len=${Math.round(keep.length||0)}s, ${vids.length} copies`);
      console.log(`        KEEP: id=${keep.id} created=${keep.created_time?.slice(0,16)}`);
      for (const d of dups) {
        try {
          const r = await axios.delete(`https://graph.facebook.com/v21.0/${d.id}`, {
            params: { access_token: p.access_token }, timeout: 30000,
          });
          console.log(`        DELETED: id=${d.id} created=${d.created_time?.slice(0,16)} → ${JSON.stringify(r.data)}`);
          totalDeleted++;
        } catch (e) {
          console.log(`        DELETE FAIL id=${d.id}: ${e.response?.data?.error?.message || e.message}`);
        }
      }
      totalKept++;
    }
  }
  console.log(`\n=== SUMMARY: kept ${totalKept} originals, deleted ${totalDeleted} duplicates ===`);
  db.close();
})().catch(e => { console.error("FATAL:", e); process.exit(1); });
'
node -e "$NODE_DEDUP" 2>&1

echo
echo '=====STEP 2: disable Nhà Tốt 247 cross-post====='
NOW=$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")
sqlite3 data/db.sqlite <<SQL
INSERT INTO settings(key,value,updated_at) VALUES('crosspost_nhatot247_disabled','true','$NOW')
  ON CONFLICT(key) DO UPDATE SET value='true', updated_at='$NOW';
INSERT INTO settings(key,value,updated_at) VALUES('crosspost_anthology_only_main_page','true','$NOW')
  ON CONFLICT(key) DO UPDATE SET value='true', updated_at='$NOW';
SQL

echo
echo '=====STEP 3: verify settings + count remaining videos====='
sqlite3 -header -column data/db.sqlite "SELECT key, value FROM settings WHERE key LIKE 'crosspost%' OR key LIKE 'anthology%publish%';" 2>/dev/null

echo
echo '=====STEP 4: check page_crosspost_links table (deactivate Nhà Tốt links)====='
sqlite3 data/db.sqlite ".schema page_crosspost_links" 2>/dev/null
sqlite3 -header -column data/db.sqlite "SELECT * FROM page_crosspost_links;" 2>/dev/null
"""

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, username=USER, password=PASSWORD, timeout=15, look_for_keys=False, allow_agent=False)

stdin, stdout, stderr = client.exec_command(CMD, timeout=300)
print(stdout.read().decode("utf-8", errors="replace"))
err = stderr.read().decode("utf-8", errors="replace")
if err.strip():
    print("STDERR:", err, file=sys.stderr)
client.close()

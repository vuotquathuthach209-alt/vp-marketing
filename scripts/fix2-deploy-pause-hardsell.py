"""FIX 2 deploy: pull code + set product_auto_post_enabled=false + restart pm2.
Also deactivates page_crosspost_links row id=1 (Sonder → Nhà Tốt 247) to reinforce Fix 1."""
import sys, paramiko

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

HOST = "103.82.193.74"
USER = "root"
PASSWORD = "cCxEvKZ0J3Ee6NJG"

CMD = r"""
set -e
cd /opt/vp-marketing
echo '=====GIT PULL====='
git pull --ff-only 2>&1 | tail -8

echo
echo '=====BUILD====='
npm run build 2>&1 | tail -5

echo
echo '=====SET SETTINGS====='
NOW=$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")
sqlite3 data/db.sqlite <<SQL
INSERT INTO settings(key,value,updated_at) VALUES('product_auto_post_enabled','false','$NOW')
  ON CONFLICT(key) DO UPDATE SET value='false', updated_at='$NOW';
UPDATE page_crosspost_links SET active=0 WHERE source_page_id=1 AND target_page_id=2;
SELECT 'product_auto_post_enabled =', value FROM settings WHERE key='product_auto_post_enabled';
SELECT 'crosspost_link_active =', active FROM page_crosspost_links WHERE id=1;
SQL

echo
echo '=====RESTART PM2====='
pm2 restart vp-mkt 2>&1 | tail -3

echo
echo '=====VERIFY (logs)====='
sleep 5
pm2 logs vp-mkt --lines 80 --nostream 2>&1 | grep -iE 'scheduler|cinema|anthology|product-auto-post|cron' | tail -20

echo
echo '=====REMAINING DUP CHECK (post-fix verification)====='
NODE_VERIFY='
const Database = require("better-sqlite3");
const axios = require("axios");
const db = new Database("/opt/vp-marketing/data/db.sqlite", { readonly: true });
const pages = db.prepare("SELECT * FROM pages").all();
db.close();
(async () => {
  for (const p of pages) {
    if (!p.access_token) continue;
    try {
      const v = await axios.get(`https://graph.facebook.com/v21.0/${p.fb_page_id}/videos`, {
        params: { access_token: p.access_token, fields: "id,created_time,description,length", limit: 30 },
        timeout: 30000,
      });
      const cutoff = Date.now() - 30*24*3600*1000;
      const vids = (v.data.data || []).filter(x => new Date(x.created_time).getTime() > cutoff);
      const groups = new Map();
      for (const x of vids) {
        const key = `${(x.description||"").slice(0,40)}|${Math.round(x.length||0)}`;
        groups.set(key, (groups.get(key)||0) + 1);
      }
      let dupCount = 0;
      for (const [k,c] of groups) if (c > 1) dupCount += c-1;
      console.log(`  ${p.name}: total=${vids.length} duplicates_remaining=${dupCount}`);
    } catch (e) { console.log("  err:", e.message); }
  }
})();
'
node -e "$NODE_VERIFY" 2>&1
"""

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, username=USER, password=PASSWORD, timeout=15, look_for_keys=False, allow_agent=False)

stdin, stdout, stderr = client.exec_command(CMD, timeout=180)
print(stdout.read().decode("utf-8", errors="replace"))
err = stderr.read().decode("utf-8", errors="replace")
if err.strip():
    print("STDERR:", err, file=sys.stderr)
client.close()

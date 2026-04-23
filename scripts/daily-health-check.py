"""Daily health check — auto weekly + bot routing status."""
import sys, paramiko
try: sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except: pass

HOST = "103.82.193.74"
PASSWORD = sys.argv[1] if len(sys.argv) > 1 else ""

CMD = r"""
cd /opt/vp-marketing

echo "=== 1. PM2 status ==="
pm2 describe vp-mkt 2>&1 | grep -E 'status|uptime|restarts|memory' | head -10

echo ""
echo "=== 2. Auto weekly post — bài hôm qua còn live không? ==="
cat > tmp.js <<'JS'
(async () => {
  const Database = require('better-sqlite3');
  const axios = require('axios');
  const db = new Database('data/db.sqlite');

  // Check remix_drafts published in last 48h
  const recent = db.prepare(`SELECT rd.*, p.access_token, p.name as page_name FROM remix_drafts rd LEFT JOIN pages p ON p.hotel_id = rd.hotel_id WHERE rd.status='published' AND rd.published_at > ? ORDER BY rd.published_at DESC LIMIT 3`).all(Date.now() - 48*3600*1000);
  console.log('Published in last 48h:', recent.length);
  for (const r of recent) {
    console.log('  draft #' + r.id + ' page=' + r.page_name + ' fb=' + r.fb_post_id);
    try {
      const f = await axios.get(`https://graph.facebook.com/v18.0/${r.fb_post_id}`, {
        params: { access_token: r.access_token, fields: 'id,permalink_url,created_time' },
        timeout: 10000,
      });
      console.log('    ✅ still live: ' + f.data.permalink_url);
    } catch (e) {
      console.log('    ❌ fb check fail:', e.response?.data?.error?.message || e.message);
    }
  }
  db.close();
})();
JS
node tmp.js; rm -f tmp.js

echo ""
echo "=== 3. Scheduler crons — xem 'ci-weekly' đã đăng ký chưa ==="
pm2 logs vp-mkt --raw --lines 500 --nostream 2>&1 | grep -iE 'scheduler.*Đã khởi động|ci-weekly|cron' | tail -5

echo ""
echo "=== 4. News articles pipeline — mới nhất ==="
cat > tmp.js <<'JS'
const Database = require('better-sqlite3');
const db = new Database('data/db.sqlite');
const last24h = Date.now() - 24*3600_000;
const cnt = db.prepare(`SELECT status, COUNT(*) as n FROM news_articles WHERE fetched_at > ? GROUP BY status`).all(last24h);
console.log('Articles fetched last 24h:');
cnt.forEach(c => console.log('  ' + c.status + ': ' + c.n));
db.close();
JS
node tmp.js; rm -f tmp.js

echo ""
echo "=== 5. Bot chat errors last 24h ==="
pm2 logs vp-mkt --raw --lines 1000 --nostream 2>&1 | grep -iE 'error|exception|UNHANDLED' | grep -v 'ci-weekly.*none' | tail -10

echo ""
echo "=== 6. Zalo/FB webhook hits (recent) ==="
pm2 logs vp-mkt --raw --lines 300 --nostream 2>&1 | grep -iE 'webhook.*zalo|funnel.*hotel|gemini-intent' | tail -10
"""

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, username="root", password=PASSWORD, timeout=15)
_, stdout, stderr = client.exec_command(CMD, timeout=60)
print(stdout.read().decode("utf-8", errors="replace"))
err = stderr.read().decode("utf-8", errors="replace")
if err.strip(): print("STDERR:\n" + err, file=sys.stderr)
client.close()

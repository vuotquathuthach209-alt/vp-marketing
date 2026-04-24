"""Test v26 Phase B engagement feedback loop."""
import sys, paramiko
try: sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except: pass
HOST = "103.82.193.74"
PASSWORD = sys.argv[1] if len(sys.argv) > 1 else ""

CMD = r"""
cd /opt/vp-marketing
cat > tmp.js <<'JS'
process.chdir('/opt/vp-marketing');
const Database = require('better-sqlite3');
const db = new Database('data/db.sqlite');

(async () => {
  // 1. Check auto_post_history với posts đã publish
  console.log('=== 1. Published auto-posts ===');
  const hist = db.prepare(`
    SELECT h.id, h.hotel_id, h.angle_used, h.post_id, h.published_at, p.fb_post_id,
           (strftime('%s','now')*1000 - h.published_at)/3600000 as hours_old
    FROM auto_post_history h
    LEFT JOIN posts p ON p.id = h.post_id
    WHERE h.status = 'published' AND h.published_at IS NOT NULL
    ORDER BY h.published_at DESC LIMIT 10
  `).all();
  console.log('Published count:', hist.length);
  hist.forEach(h => console.log(`  history #${h.id} post=${h.post_id} hotel=${h.hotel_id} angle=${h.angle_used} age=${h.hours_old.toFixed(1)}h fb=${h.fb_post_id?.slice(-10) || '?'}`));

  // 2. Check post_metrics available
  console.log('\n=== 2. Post metrics data ===');
  const metrics = db.prepare(`
    SELECT pm.post_id, pm.reactions, pm.comments, pm.shares, pm.impressions,
           MAX(pm.snapshot_at) as latest
    FROM post_metrics pm
    WHERE pm.post_id IN (SELECT post_id FROM auto_post_history WHERE status = 'published' AND post_id IS NOT NULL)
    GROUP BY pm.post_id
  `).all();
  console.log('Posts với metrics:', metrics.length);
  metrics.forEach(m => console.log(`  post=${m.post_id} reactions=${m.reactions} comments=${m.comments} shares=${m.shares} imp=${m.impressions}`));

  // 3. Trigger engagement feedback update
  console.log('\n=== 3. Run engagement feedback ===');
  const { updateEngagementFeedback, getEngagementStats, getEngagementMultiplier } = require('/opt/vp-marketing/dist/services/product-auto-post/engagement-feedback');
  const r = await updateEngagementFeedback();
  console.log('Result:', JSON.stringify(r, null, 2));

  // 4. Engagement stats
  console.log('\n=== 4. Engagement stats ===');
  const stats = getEngagementStats(30);
  console.log('By hotel:', JSON.stringify(stats.by_hotel.slice(0, 5), null, 2));
  console.log('By angle:', JSON.stringify(stats.by_angle, null, 2));
  console.log('Top posts:', JSON.stringify(stats.top_posts.slice(0, 3), null, 2));

  // 5. Engagement multiplier cho từng hotel
  console.log('\n=== 5. Engagement multipliers ===');
  [6, 7, 1792315228].forEach(hid => {
    const m = getEngagementMultiplier(hid);
    console.log(`  hotel #${hid}: multiplier = ${m.toFixed(2)}x`);
  });

  db.close();
})();
JS
node tmp.js
rm tmp.js
"""

c = paramiko.SSHClient()
c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
c.connect(HOST, username="root", password=PASSWORD, timeout=15)
_, out, _ = c.exec_command(CMD, timeout=60)
print(out.read().decode('utf-8'))
c.close()

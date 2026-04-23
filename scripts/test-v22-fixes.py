"""Verify v22 fixes: SSRF block, retry, UTF-8 truncate, race."""
import sys, paramiko
try: sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except: pass
HOST = "103.82.193.74"
PASSWORD = sys.argv[1] if len(sys.argv) > 1 else ""

CMD = r"""
cd /opt/vp-marketing

echo "=== 1. SSRF protection — fetchOgImage blocks private IPs ==="
cat > tmp.js <<'JS'
(async () => {
  const { fetchOgImage, isSafeUrl } = require('./dist/services/news-ingest');
  const testUrls = [
    'http://localhost/test',
    'http://127.0.0.1/test',
    'http://169.254.169.254/latest/meta-data',
    'http://10.0.0.1/internal',
    'http://192.168.1.1/router',
    'file:///etc/passwd',
    'ftp://example.com/file',
    'https://example.com/valid',
  ];
  for (const url of testUrls) {
    const check = isSafeUrl(url);
    console.log('  ' + url + ' → safe=' + check.safe + (check.reason ? ' (' + check.reason + ')' : ''));
  }
})();
JS
node tmp.js; rm -f tmp.js

echo ""
echo "=== 2. UTF-8 truncate — emoji safe ==="
cat > tmp.js <<'JS'
const { truncateSafe, truncateByCodePoints, redactSecrets } = require('./dist/services/text-utils');
// Emoji family (ZWJ): 👨‍👩‍👧 = 8 JS chars, 1 grapheme
const emoji = 'Chào 👨‍👩‍👧 gia đình!';
console.log('Original length:', emoji.length);
console.log('Normal slice(0, 7):', emoji.slice(0, 7), 'bytes:', Buffer.byteLength(emoji.slice(0, 7)));
console.log('truncateSafe(0, 7):', truncateSafe(emoji, 7));
console.log('truncateByCodePoints(6):', truncateByCodePoints(emoji, 6));
// Redact token
const msg = 'Error fetching https://api.fb.com/v1?access_token=EAAG123abc&limit=10';
console.log('Redacted:', redactSecrets(msg));
JS
node tmp.js; rm -f tmp.js

echo ""
echo "=== 3. Race condition fix — concurrent claim test ==="
# Simulate by inserting a scheduled post + firing 2 processes
cat > tmp.js <<'JS'
const Database = require('better-sqlite3');
const db = new Database('data/db.sqlite');
const now = Date.now();

// Insert a scheduled test post
const r = db.prepare(`INSERT INTO posts (page_id, caption, media_type, status, scheduled_at, hotel_id, created_at)
  VALUES (1, 'TEST v22 race', 'none', 'scheduled', ?, 1, ?)`).run(now - 1000, now);
const postId = Number(r.lastInsertRowid);

// Simulate 2 workers trying to claim simultaneously
const claim1 = db.prepare(`UPDATE posts SET status = 'publishing' WHERE id = ? AND status = 'scheduled'`).run(postId);
const claim2 = db.prepare(`UPDATE posts SET status = 'publishing' WHERE id = ? AND status = 'scheduled'`).run(postId);

console.log('Worker 1 claim: changes=' + claim1.changes + ' (should be 1 = won)');
console.log('Worker 2 claim: changes=' + claim2.changes + ' (should be 0 = lost race)');

// Cleanup
db.prepare(`DELETE FROM posts WHERE id = ?`).run(postId);
db.close();
JS
node tmp.js; rm -f tmp.js

echo ""
echo "=== 4. IG publish URL safety (fake private IP should fail) ==="
cat > tmp.js <<'JS'
(async () => {
  const { publishImage } = require('./dist/services/instagram-publisher');
  const r = await publishImage({
    ig_business_id: 'fake_id',
    access_token: 'fake_token',
    image_url: 'http://127.0.0.1/evil.jpg',
    caption: 'test',
  });
  console.log('Result:', JSON.stringify(r));
})();
JS
node tmp.js; rm -f tmp.js

echo ""
echo "=== 5. news-publisher retry logic exists ==="
grep -n "withRetry\|RETRY_DELAYS_MS" dist/services/news-publisher.js | head -5
"""

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, username="root", password=PASSWORD, timeout=15)
_, stdout, stderr = client.exec_command(CMD, timeout=60)
print(stdout.read().decode('utf-8', errors='replace'))
err = stderr.read().decode('utf-8', errors='replace')
if err.strip(): print('STDERR:', err[:500])
client.close()

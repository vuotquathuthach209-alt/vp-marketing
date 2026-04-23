"""Test v21 multi-platform: schema + share package + seed groups."""
import sys, paramiko
try: sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except: pass
HOST = "103.82.193.74"
PASSWORD = sys.argv[1] if len(sys.argv) > 1 else ""

CMD = r"""
cd /opt/vp-marketing

echo "=== 1. Verify 4 tables ==="
cat > tmp.js <<'JS'
const Database = require('better-sqlite3');
const db = new Database('data/db.sqlite');
['instagram_accounts', 'page_crosspost_links', 'share_packages', 'suggested_fb_groups'].forEach(t => {
  const cols = db.prepare(`PRAGMA table_info(${t})`).all();
  console.log('  ' + t + ': ' + cols.length + ' cols');
});
db.close();
JS
node tmp.js; rm -f tmp.js

echo ""
echo "=== 2. Seed default FB groups ==="
cat > tmp.js <<'JS'
const { seedDefaultGroups } = require('./dist/services/share-helper');
console.log('Created:', seedDefaultGroups(), 'groups');
const Database = require('better-sqlite3');
const db = new Database('data/db.sqlite');
const groups = db.prepare(`SELECT name, category, member_count FROM suggested_fb_groups ORDER BY member_count DESC`).all();
groups.forEach(g => console.log('  ' + g.name + ' [' + g.category + '] — ' + (g.member_count ? g.member_count.toLocaleString() + ' members' : '?')));
db.close();
JS
node tmp.js; rm -f tmp.js

echo ""
echo "=== 3. Create a sample Share Package ==="
cat > tmp.js <<'JS'
const { createSharePackage } = require('./dist/services/share-helper');
const pkg = createSharePackage({
  hotel_id: 1,
  source_post_id: null,
  source_type: 'manual',
  caption: 'Anh/chị biết không, Sonder Airport có căn hộ view phi trường cực đẹp, giá chỉ từ 3.6tr/tháng! Phù hợp cho digital nomad + khách công tác dài hạn. #SonderVN #LongStayVN',
  image_url: 'https://mkt.sondervn.com/media/sample.jpg',
});
console.log('Package #' + pkg.id);
console.log('Hashtags:', pkg.hashtags.join(' '));
console.log('Suggested groups:', pkg.suggested_groups.length);
pkg.suggested_groups.slice(0, 5).forEach(g => console.log('  - ' + g.name + ' [' + g.category + ']'));
JS
node tmp.js; rm -f tmp.js

echo ""
echo "=== 4. IG verify (need real tokens) ==="
cat > tmp.js <<'JS'
const { verifyIgAccount } = require('./dist/services/instagram-publisher');
// Dùng fake token để test error path
verifyIgAccount('fake_ig_id_123', 'fake_token').then(r => {
  console.log('Verify result (expected fail):', JSON.stringify(r));
});
JS
node tmp.js; rm -f tmp.js

echo ""
echo "=== 5. FB Cross-post link setup ==="
cat > tmp.js <<'JS'
const Database = require('better-sqlite3');
const db = new Database('data/db.sqlite');

// List existing pages
const pages = db.prepare(`SELECT id, name, hotel_id FROM pages`).all();
console.log('Available pages:');
pages.forEach(p => console.log('  #' + p.id + ' "' + p.name + '" hotel=' + p.hotel_id));

// Demo: add crosspost link (source=page 1 → target=page 2)
if (pages.length >= 2) {
  const { addCrossPostLink, getCrossPostLinks } = require('./dist/services/fb-crosspost');
  const id = addCrossPostLink({
    source_page_id: pages[0].id,
    target_page_id: pages[1].id,
    delay_minutes: 10,
    modify_caption: 'PREPEND:Cross-post from ' + pages[0].name + ' 🔗',
  });
  console.log('Added crosspost link #' + id);
  const links = getCrossPostLinks(pages[0].id);
  console.log('Active links for page ' + pages[0].id + ':', links.length);
}
db.close();
JS
node tmp.js; rm -f tmp.js

echo ""
echo "=== 6. List pending share packages ==="
cat > tmp.js <<'JS'
const { getPendingPackages } = require('./dist/services/share-helper');
const pkgs = getPendingPackages(1, 5);
console.log('Pending packages:', pkgs.length);
pkgs.forEach(p => {
  console.log('  #' + p.id + ' ' + p.source_type + ' — "' + p.caption.slice(0, 60) + '..."');
  console.log('    Tags:', p.hashtags.slice(0, 5).join(' '));
});
JS
node tmp.js; rm -f tmp.js
"""

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, username="root", password=PASSWORD, timeout=15)
_, stdout, stderr = client.exec_command(CMD, timeout=90)
print(stdout.read().decode('utf-8', errors='replace'))
err = stderr.read().decode('utf-8', errors='replace')
if err.strip(): print('STDERR:', err[:500])
client.close()

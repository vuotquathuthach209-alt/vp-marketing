"""Comprehensive DB installation check for VP MKT."""
import sys, paramiko
try: sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except: pass

HOST = "103.82.193.74"
PASSWORD = sys.argv[1] if len(sys.argv) > 1 else ""

CMD = r"""
cd /opt/vp-marketing
ls -lh data/db.sqlite 2>&1 | head -1

echo ""
echo "=== ALL TABLES ==="
cat > tmp.js <<'JS'
const Database = require('better-sqlite3');
const db = new Database('data/db.sqlite');
const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`).all();
console.log('Total tables:', tables.length);
tables.forEach(t => console.log('  ' + t.name));

console.log('\n=== ROW COUNTS (key tables) ===');
const keyTables = [
  'pages', 'posts', 'media', 'campaigns',
  'hotels', 'mkt_hotels', 'hotel_profile', 'hotel_room_catalog', 'hotel_amenities',
  'hotel_knowledge_embeddings', 'content_sections', 'wiki_entries',
  'news_articles', 'news_post_drafts', 'news_sources',
  'inspiration_posts', 'remix_drafts',
  'conversation_memory', 'bot_conversation_state', 'customer_contacts', 'customer_memory',
  'ab_tests', 'ab_variants', 'learnings',
  'users', 'zalo_oas', 'zalo_articles',
  'room_images', 'post_metrics', 'settings',
];
for (const t of keyTables) {
  try {
    const r = db.prepare(`SELECT COUNT(*) as n FROM ${t}`).get();
    console.log('  ' + t + ': ' + r.n);
  } catch (e) {
    console.log('  ' + t + ': MISSING');
  }
}

console.log('\n=== BOT INTELLIGENCE check ===');
// Hotels active
const activeHotels = db.prepare(`SELECT id, ota_hotel_id, status, url_slug FROM mkt_hotels WHERE status = 'active'`).all();
console.log('Active mkt_hotels:', activeHotels.length);
activeHotels.forEach(h => console.log('  #' + h.id + ' ota=' + h.ota_hotel_id + ' slug=' + h.url_slug));

// Hotel profiles
const profiles = db.prepare(`SELECT hotel_id, name_canonical, city, district, property_type, star_rating FROM hotel_profile`).all();
console.log('\nhotel_profile rows:', profiles.length);
profiles.forEach(p => console.log('  #' + p.hotel_id + ' ' + p.name_canonical + ' | ' + (p.district || '?') + ', ' + (p.city || '?') + ' | ' + p.property_type + ' | ' + (p.star_rating || '?') + '⭐'));

// Rooms
const rooms = db.prepare(`SELECT COUNT(*) as n, COUNT(DISTINCT hotel_id) as hotels FROM hotel_room_catalog`).get();
console.log('\nhotel_room_catalog: ' + rooms.n + ' rooms across ' + rooms.hotels + ' hotels');

// RAG embeddings
const emb = db.prepare(`SELECT COUNT(*) as n, COUNT(DISTINCT chunk_type) as types FROM hotel_knowledge_embeddings`).get();
console.log('hotel_knowledge_embeddings: ' + emb.n + ' chunks, ' + emb.types + ' chunk types');
const chunkByType = db.prepare(`SELECT chunk_type, COUNT(*) as n FROM hotel_knowledge_embeddings GROUP BY chunk_type ORDER BY n DESC`).all();
chunkByType.slice(0, 10).forEach(c => console.log('    ' + c.chunk_type + ': ' + c.n));

// Wiki
const wiki = db.prepare(`SELECT COUNT(*) as n, COUNT(DISTINCT namespace) as ns FROM wiki_entries`).get();
console.log('wiki_entries: ' + wiki.n + ' entries, ' + wiki.ns + ' namespaces');

console.log('\n=== SETTINGS (config per install) ===');
const settings = db.prepare(`SELECT key, substr(value, 1, 80) as val FROM settings LIMIT 30`).all();
settings.forEach(s => console.log('  ' + s.key + ' = ' + s.val));

console.log('\n=== FACEBOOK PAGES ===');
const pages = db.prepare(`SELECT id, name, fb_page_id, hotel_id, LENGTH(access_token) as token_len FROM pages`).all();
pages.forEach(p => console.log('  #' + p.id + ' "' + p.name + '" fb=' + p.fb_page_id + ' hotel=' + p.hotel_id + ' token=' + p.token_len + 'chars'));

console.log('\n=== ZALO OA ===');
try {
  const zalo = db.prepare(`SELECT oa_id, oa_name, hotel_id, LENGTH(access_token) as token_len, expires_at FROM zalo_oas`).all();
  if (zalo.length === 0) console.log('  (no Zalo OAs)');
  zalo.forEach(z => console.log('  oa=' + z.oa_id + ' "' + z.oa_name + '" hotel=' + z.hotel_id + ' expires=' + new Date(z.expires_at).toISOString()));
} catch { console.log('  table missing'); }

console.log('\n=== RECENT BOT ACTIVITY (last 7d) ===');
const weekAgo = Date.now() - 7*24*3600_000;
try {
  const msgs = db.prepare(`SELECT COUNT(*) as n FROM conversation_memory WHERE created_at > ?`).get(weekAgo);
  console.log('  Messages last 7d: ' + msgs.n);
} catch {}
try {
  const contacts = db.prepare(`SELECT COUNT(*) as n FROM customer_contacts WHERE created_at > ?`).get(weekAgo);
  console.log('  Leads captured 7d: ' + contacts.n);
} catch {}
try {
  const fsmStates = db.prepare(`SELECT stage, COUNT(*) as n FROM bot_conversation_state GROUP BY stage ORDER BY n DESC LIMIT 5`).all();
  console.log('  FSM stages:');
  fsmStates.forEach(s => console.log('    ' + s.stage + ': ' + s.n));
} catch {}

db.close();
JS
node tmp.js; rm -f tmp.js

echo ""
echo "=== .env vars (redacted) ==="
grep -v '^#' .env 2>/dev/null | grep -E 'API_KEY|TOKEN|SECRET|PASSWORD' | while read line; do
  key=$(echo "$line" | cut -d'=' -f1)
  val=$(echo "$line" | cut -d'=' -f2-)
  len=${#val}
  echo "  $key = [${len} chars]"
done
grep -v '^#' .env 2>/dev/null | grep -vE 'API_KEY|TOKEN|SECRET|PASSWORD' | head -10

echo ""
echo "=== OTA DB connection test ==="
cat > tmp.js <<'JS'
(async () => {
  try {
    const { otaQueryReadOnly } = require('./dist/services/ota-readonly-guard');
    const r = await otaQueryReadOnly('SELECT COUNT(*) as n FROM hotels WHERE is_active = 1');
    console.log('OTA DB OK, active hotels:', r?.[0]?.n);
  } catch (e) {
    console.log('OTA DB fail:', e.message);
  }
})();
JS
node tmp.js; rm -f tmp.js
"""

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, username="root", password=PASSWORD, timeout=15)
_, stdout, stderr = client.exec_command(CMD, timeout=60)
print(stdout.read().decode("utf-8", errors="replace"))
err = stderr.read().decode("utf-8", errors="replace")
if err.strip(): print("STDERR:\n" + err, file=sys.stderr)
client.close()

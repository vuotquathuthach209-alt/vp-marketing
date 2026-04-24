"""Check what images data exists for hotels."""
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

console.log('=== hotel_profile all fields ===');
const cols = db.prepare(`PRAGMA table_info(hotel_profile)`).all();
console.log('Columns:', cols.map(c => c.name).join(', '));

console.log('\n=== Hotels with data ===');
const hotels = db.prepare(`SELECT hotel_id, name_canonical, length(scraped_data) as sd_len, substr(scraped_data, 1, 200) as sd_preview FROM hotel_profile`).all();
hotels.forEach(h => {
  console.log(`\n#${h.hotel_id} ${h.name_canonical}`);
  console.log(`  scraped_data length: ${h.sd_len || 0}`);
  if (h.sd_preview) console.log(`  preview: ${h.sd_preview}`);
});

console.log('\n=== room_images ===');
const ri = db.prepare(`SELECT hotel_id, COUNT(*) as n FROM room_images WHERE active = 1 GROUP BY hotel_id`).all();
ri.forEach(r => console.log(`  hotel ${r.hotel_id}: ${r.n} images`));

console.log('\n=== hotel_room_catalog (có photos_urls) ===');
const hrc = db.prepare(`SELECT hotel_id, room_key, display_name_vi, photos_urls FROM hotel_room_catalog LIMIT 10`).all();
hrc.forEach(r => {
  console.log(`  hotel ${r.hotel_id} room ${r.room_key}: ${r.display_name_vi}`);
  if (r.photos_urls) {
    try {
      const urls = JSON.parse(r.photos_urls);
      console.log(`    photos: ${Array.isArray(urls) ? urls.length : 0}, first: ${JSON.stringify(urls?.[0] || '').slice(0, 100)}`);
    } catch { console.log(`    photos_urls (raw): ${r.photos_urls.slice(0, 100)}`); }
  }
});

console.log('\n=== Parse scraped_data.images for hotels ===');
hotels.forEach(h => {
  try {
    const full = db.prepare(`SELECT scraped_data FROM hotel_profile WHERE hotel_id = ?`).get(h.hotel_id);
    if (!full?.scraped_data) return;
    const sd = JSON.parse(full.scraped_data);
    const imgs = sd.images || sd.photos || [];
    const coverImage = sd.coverImage || sd.cover_image_url;
    console.log(`  #${h.hotel_id}: cover=${!!coverImage} images_arr=${Array.isArray(imgs) ? imgs.length : 'not-array'}`);
    if (coverImage) console.log(`    cover URL: ${coverImage.toString().slice(0, 80)}`);
  } catch (e) {
    console.log(`  #${h.hotel_id}: parse fail: ${e.message}`);
  }
});

db.close();
JS

node tmp.js
rm -f tmp.js
"""

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, username="root", password=PASSWORD, timeout=15)
_, stdout, stderr = client.exec_command(CMD, timeout=60)
print(stdout.read().decode('utf-8', errors='replace'))
err = stderr.read().decode('utf-8', errors='replace')
if err.strip(): print('STDERR:', err[:500])
client.close()

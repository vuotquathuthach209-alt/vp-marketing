"""Test v26 Phase A vectors: vectorize + similar + semantic search."""
import sys, paramiko
try: sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except: pass
HOST = "103.82.193.74"
PASSWORD = sys.argv[1] if len(sys.argv) > 1 else ""

CMD = r"""
cd /opt/vp-marketing
cat > tmp.js <<'JS'
process.chdir('/opt/vp-marketing');
(async () => {
  const {
    vectorizeAllActiveHotels,
    findSimilarHotels,
    semanticSearchHotels,
    getDistinctiveAspects,
  } = require('/opt/vp-marketing/dist/services/product-auto-post/hotel-vectorizer');

  console.log('=== 1. Vectorize all active hotels ===');
  const r = await vectorizeAllActiveHotels();
  console.log(JSON.stringify(r, null, 2));

  console.log('\n=== 2. Similar to Sonder Airport (#6) ===');
  const sim = await findSimilarHotels(6, 5);
  sim.forEach(s => console.log(`  ${s.name} (hotel #${s.hotel_id}): similarity ${(s.similarity * 100).toFixed(1)}%`));

  console.log('\n=== 3. Semantic search natural language ===');
  const queries = [
    'chỗ yên tĩnh work remote gần sân bay',
    'căn hộ giá rẻ Tân Bình có bếp',
    'khách sạn view đẹp có hồ bơi',
  ];
  for (const q of queries) {
    console.log(`\nQuery: "${q}"`);
    const rs = await semanticSearchHotels(q, 3);
    rs.forEach((x, i) => console.log(`  ${i+1}. ${x.name} (${(x.similarity * 100).toFixed(1)}%)`));
  }

  console.log('\n=== 4. Distinctive aspects of Sonder Airport ===');
  const d = await getDistinctiveAspects(6);
  console.log(d || '(no distinctive data)');
})();
JS
node tmp.js
rm tmp.js
"""

c = paramiko.SSHClient()
c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
c.connect(HOST, username="root", password=PASSWORD, timeout=15)
_, out, _ = c.exec_command(CMD, timeout=120)
print(out.read().decode('utf-8'))
c.close()

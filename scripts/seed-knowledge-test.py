"""Seed initial wiki + rebuild embeddings + test semantic query."""
import sys, os, paramiko
try: sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except: pass

HOST = "103.82.193.74"
PASSWORD = sys.argv[1] if len(sys.argv) > 1 else ""

CMD = r"""
cd /opt/vp-marketing

echo '=== 1. Seed initial wiki entries ==='
cat > tmp.js <<'JS'
const Database = require('better-sqlite3');
const db = new Database('data/db.sqlite');
const now = Date.now();

const wiki = [
  {
    namespace: 'brand',
    slug: 'sonder-overview',
    title: 'Về Sonder',
    content: `**Sonder** là nền tảng đặt phòng trực tuyến + chuỗi khách sạn/căn hộ dịch vụ tại Việt Nam. Bên em có nhiều loại hình: khách sạn, homestay, villa và căn hộ dịch vụ (CHDV) — phù hợp mọi nhu cầu từ du lịch ngắn ngày đến ở dài hạn.

**Tầm nhìn**: Trở thành nền tảng lưu trú hàng đầu Việt Nam, phục vụ cả khách du lịch và người cần chỗ ở dài hạn.

**Cam kết**: Giá tốt, phòng chất lượng, chăm sóc 24/7 qua bot AI + đội ngũ nhân viên chuyên nghiệp.`,
    tags: 'sonder,brand,giới thiệu,công ty',
  },
  {
    namespace: 'policies',
    slug: 'booking-policy',
    title: 'Chính sách đặt phòng',
    content: `**Đặt phòng**: Xác nhận qua SĐT trong 15 phút sau khi khách yêu cầu qua bot.

**Thanh toán**: Chuyển khoản trước 50% giữ phòng, 50% còn lại khi check-in. Một số phòng thuê tháng cần đặt cọc 1 tháng.

**Hủy phòng**:
- Hủy trước 48h: hoàn 100%
- Hủy 24-48h: hoàn 50%
- Hủy dưới 24h: không hoàn (trừ trường hợp bất khả kháng)

**Đổi ngày**: Miễn phí nếu báo trước 48h và phòng còn trống.`,
    tags: 'policy,đặt phòng,thanh toán,hủy phòng',
  },
  {
    namespace: 'policies',
    slug: 'payment-methods',
    title: 'Phương thức thanh toán',
    content: `Bên em chấp nhận:
- 💳 **Chuyển khoản ngân hàng** (Vietcombank, Techcombank, VPBank...)
- 📱 **Ví điện tử**: MoMo, ZaloPay, VNPay
- 💵 **Tiền mặt tại quầy** (khi check-in)
- 💳 **Thẻ Visa/Mastercard** (một số chỗ)

Khách ở dài hạn (CHDV): có thể setup tự động chuyển khoản hàng tháng.`,
    tags: 'payment,thanh toán,chuyển khoản,momo,ví điện tử',
  },
  {
    namespace: 'location',
    slug: 'tan-binh-guide',
    title: 'Guide khu vực Tân Bình',
    content: `**Tân Bình** là quận gần sân bay Tân Sơn Nhất — rất thuận tiện cho khách công tác, du lịch quá cảnh.

**Điểm nổi bật**:
- 🛫 **Sân bay Tân Sơn Nhất** chỉ 2-5km
- 🍜 **Chợ Phạm Văn Hai** — ẩm thực đường phố
- 🛍 **Lotte Mart Cộng Hoà** — mua sắm
- ⛪ **Nhà thờ Đức Bà** (~15 phút taxi vào Q1)

**Di chuyển**:
- Grab/taxi sân bay đến hotel: 50-80k VND (5-10 phút)
- Grab đến Q1 trung tâm: 80-150k (15-25 phút)

**Ăn ngon gần hotel**: Bánh mì Huỳnh Hoa, Cơm tấm Ba Ghiền, Phở Lệ.`,
    tags: 'tan binh,sân bay,tsn,location,ăn uống',
  },
  {
    namespace: 'services',
    slug: 'airport-pickup',
    title: 'Dịch vụ đưa đón sân bay',
    content: `Sonder có dịch vụ **đưa đón sân bay Tân Sơn Nhất** cho khách (có phí):
- 🚗 Xe 4 chỗ: 150k/lượt
- 🚐 Xe 7 chỗ: 250k/lượt
- 🏨 Free shuttle (chỉ Sonder Airport) nếu khách ở ≥ 3 đêm

**Đặt xe**: liên hệ hotline 0348 644 833 trước khi hạ cánh 2h.
**Giờ hoạt động**: 24/7.`,
    tags: 'airport,pickup,đưa đón,shuttle,sân bay',
  },
  {
    namespace: 'faq',
    slug: 'checkin-early',
    title: 'Có check-in sớm được không?',
    content: `**Check-in chuẩn**: 14:00

**Check-in sớm** (tùy phòng trống):
- Trước 12:00: có thể miễn phí nếu phòng đã sạch
- Trước 10:00: phụ phí 30% giá phòng
- Trước 06:00: phụ phí 50% giá phòng
- Early morning (4-6h): liên hệ trước 24h, tùy tình trạng phòng

**Gợi ý**: nếu flight về sớm, book thêm 1 đêm trước để có phòng ngay khi đến.`,
    tags: 'checkin,sớm,early,giờ nhận phòng',
  },
];

let created = 0;
for (const w of wiki) {
  const existing = db.prepare(`SELECT id FROM knowledge_wiki WHERE namespace = ? AND slug = ?`).get(w.namespace, w.slug);
  if (existing) {
    db.prepare(`UPDATE knowledge_wiki SET title=?, content=?, tags=?, active=1, updated_at=? WHERE id=?`)
      .run(w.title, w.content, w.tags, now, existing.id);
  } else {
    db.prepare(`INSERT INTO knowledge_wiki (namespace, slug, title, content, tags, active, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 1, ?, ?)`)
      .run(w.namespace, w.slug, w.title, w.content, w.tags, now, now);
    created++;
  }
}
console.log(`Seeded ${wiki.length} wiki entries (${created} new)`);

// Show by namespace
const counts = db.prepare(`SELECT namespace, COUNT(*) as n FROM knowledge_wiki WHERE active = 1 GROUP BY namespace`).all();
counts.forEach(c => console.log(`  ${c.namespace}: ${c.n}`));

db.close();
JS
node tmp.js
rm -f tmp.js

echo
echo '=== 2. Trigger rebuild ALL embeddings ==='
cat > tmp2.js <<'JS'
(async () => {
  try {
    const { rebuildAllEmbeddings } = require('./dist/services/knowledge-sync');
    const r = await rebuildAllEmbeddings();
    console.log('Rebuild result:', JSON.stringify(r, null, 2));
  } catch (e) {
    console.log('ERR:', e.message);
  }
})();
JS
node tmp2.js
rm -f tmp2.js

echo
echo '=== 3. Test semantic search ==='
cat > tmp3.js <<'JS'
(async () => {
  const { semanticSearch } = require('./dist/services/knowledge-sync');
  const queries = [
    'chỗ nào có bếp và máy giặt',
    'gần sân bay tiện',
    'phòng cho 2 người view đẹp',
    'ở dài hạn mấy tháng',
  ];
  for (const q of queries) {
    console.log(`\n--- Query: "${q}" ---`);
    const hits = await semanticSearch(q, { topK: 3, minScore: 0.3 });
    hits.forEach((h, i) => console.log(`${i+1}. [${h.chunk_type}] ${(h.score * 100).toFixed(0)}% — ${h.chunk_text.slice(0, 100)}`));
  }
})();
JS
node tmp3.js
rm -f tmp3.js

echo
echo '=== 4. Test unified query ==='
cat > tmp4.js <<'JS'
(async () => {
  const { unifiedQuery } = require('./dist/services/knowledge-sync');
  const queries = [
    'giới thiệu Sonder đi',
    'thanh toán bằng cách nào',
    'Tân Bình có gì hay',
    'check-in sớm được không',
  ];
  for (const q of queries) {
    console.log(`\n--- "${q}" ---`);
    const r = await unifiedQuery(q);
    console.log('Tier:', r.tier, '| Confidence:', r.confidence.toFixed(2));
    r.answer_snippets.forEach((s, i) => console.log(`${i+1}. ${s.slice(0, 200)}`));
  }
})();
JS
node tmp4.js
rm -f tmp4.js
"""

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, username="root", password=PASSWORD, timeout=15)
_, stdout, stderr = client.exec_command(CMD, timeout=180)
print(stdout.read().decode("utf-8", errors="replace"))
err = stderr.read().decode("utf-8", errors="replace")
if err.strip(): print("STDERR:\n" + err, file=sys.stderr)
client.close()

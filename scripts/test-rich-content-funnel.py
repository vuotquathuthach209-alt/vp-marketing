"""E2E test: OTA push hotel với content_sections đầy đủ → Qwen classify → Tier 1/2/3 populated."""
import sys, os, paramiko, json, hmac, hashlib, time, urllib.request
try: sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except: pass

HOST = "103.82.193.74"
PASSWORD = sys.argv[1] if len(sys.argv) > 1 else ""

# Shared secret from memory.md
SECRET = "25c1e4f8bf7a1999c3f4be72e5c1357e878ae5814214999deb698bd3bfe5d321"

# Rich sample hotel payload
payload = {
    "batch_id": f"test-rich-{int(time.time())}",
    "type": "hotels",
    "items": [
        {
            "ota_id": "sonder-airport-rich-demo",
            "data": {
                "name": "Sonder Airport Rich Demo",
                "address": "789 Đường Dân Chủ, Tân Bình, HCM",
                "city": "Ho Chi Minh",
                "district": "Tân Bình",
                "property_type": "homestay",
                "rental_mode": "nightly",
                "star_rating": 4,
                "phone": "+84909888777",
                "latitude": 10.8171,
                "longitude": 106.6589,
                "description": "Homestay ấm cúng gần sân bay Tân Sơn Nhất, phục vụ chu đáo 24/7",
                "content_sections": {
                    "brand_story": "Sonder Airport Rich được mở từ 2023 bởi nhóm sinh viên trẻ muốn mang đến trải nghiệm homestay tốt nhất cho khách quốc tế đi công tác và du lịch. Chúng tôi tin rằng nơi ở không chỉ là giường và phòng mà còn là cảm xúc.",
                    "host_story": "Chủ nhà là anh Tuấn — 10 năm trong du lịch, nói được Anh và Hàn. Anh tự tay đón khách mỗi buổi sáng với cà phê và croissant.",
                    "house_rules": [
                        "Không hút thuốc trong phòng",
                        "Không thú cưng (trừ dịch vụ hỗ trợ)",
                        "Check-in 14:00-22:00, muộn hơn liên hệ trước",
                        "Giờ yên tĩnh 22:00-07:00"
                    ],
                    "transport": "Taxi/Grab từ sân bay Tân Sơn Nhất chỉ 8 phút, khoảng 50-80k VND. Xe buýt số 152 dừng cách hotel 200m. Miễn phí đưa đón nếu đặt ≥ 3 đêm.",
                    "attractions": [
                        "Công viên Hoàng Văn Thụ (2km, 10 phút)",
                        "Chợ Phạm Văn Hai — ẩm thực đường phố (500m)",
                        "Nhà thờ Đức Bà Q1 (20 phút xe)",
                        "Dinh Độc Lập (25 phút xe)"
                    ],
                    "nearby_dining": [
                        "Bánh mì Huỳnh Hoa — nổi tiếng toàn Sài Gòn (300m)",
                        "Phở Lệ — phở bò lâu năm (400m)",
                        "Cơm tấm Ba Ghiền — cơm tấm Nam bộ đỉnh (500m)",
                        "Highlands Coffee (150m)",
                        "Bánh cuốn Hải Nam (700m)"
                    ],
                    "neighborhood": "Tân Bình là quận gần sân bay TSN, yên tĩnh về đêm nhưng sầm uất ban ngày. Có nhiều quán ăn nổi tiếng, trung tâm thương mại Lotte Cộng Hoà, chợ truyền thống Phạm Văn Hai.",
                    "promotions": [
                        {
                            "title": "Summer Deal 2026",
                            "discount": "20% OFF",
                            "description": "Giảm 20% cho booking ≥ 3 đêm từ 1/6 đến 31/8/2026",
                            "valid_until": "2026-08-31"
                        },
                        {
                            "title": "Flash Sale",
                            "discount": "400k chỉ 300k",
                            "description": "Đặc biệt cuối tuần, còn 2 phòng",
                            "valid_until": "2026-05-15"
                        }
                    ],
                    "seasonal_offers": [
                        {"title": "Tết 2027", "description": "Free breakfast + late check-out 15:00"}
                    ],
                    "reviews_summary": "9.2/10 based on 145 đánh giá. Điểm nổi bật: phòng sạch sẽ (9.5), vị trí tuyệt vời (9.3), chủ nhà nhiệt tình (9.6), giá hợp lý (9.0). Khách quốc tế đánh giá cao ngôn ngữ host.",
                    "testimonials": [
                        {"name": "Anh Khoa (Hà Nội)", "quote": "Phòng sạch, chủ nhà cực kỳ thân thiện. Sẽ quay lại!", "stars": 5},
                        {"name": "Jisoo Kim (Seoul)", "quote": "Best homestay near airport. Recommended!", "stars": 5},
                        {"name": "Chị Lan (Đà Nẵng)", "quote": "Vị trí thuận tiện, breakfast ngon.", "stars": 4}
                    ],
                    "safety_features": [
                        "Smoke alarm tất cả phòng",
                        "Fire extinguisher",
                        "24/7 CCTV sảnh",
                        "Khóa từ digital",
                        "Emergency contact 24/7"
                    ],
                    "wellness_services": ["Free yoga mat cho thuê", "Thông tin nearby spa (cách 1km)"],
                    "family_features": [
                        "Giường trẻ em miễn phí (0-5 tuổi)",
                        "Kids menu breakfast",
                        "Game boards trong sảnh"
                    ],
                    "accessibility_features": ["Thang máy tới tất cả tầng", "Phòng ADA friendly tầng 1"],
                    "pet_policy": "Chấp nhận chó nhỏ (<5kg) với phụ phí 100k/ngày. Cần báo trước.",
                    "loyalty_program": {
                        "name": "Sonder Stay Rewards",
                        "benefits": "Đặt 5 lần được free 1 đêm + priority room upgrade",
                        "description": "Tích luỹ 1 điểm mỗi 100k chi tiêu"
                    },
                    "sustainability_practices": [
                        "Tái sử dụng khăn tắm",
                        "Đèn LED tiết kiệm điện",
                        "Không cung cấp chai nước nhựa dùng 1 lần (có bình nước filter)",
                        "Tách rác tái chế"
                    ],
                    "faqs": [
                        {"question": "Có đưa đón sân bay không?", "answer": "Có, 150k/lượt xe 4 chỗ. Free nếu ở ≥ 3 đêm."},
                        {"question": "Gửi đồ được không?", "answer": "Được, giữ miễn phí tối đa 24h trong tủ khoá."},
                        {"question": "Wifi tốc độ thế nào?", "answer": "300 Mbps, phù hợp video call và streaming 4K."},
                        {"question": "Có phòng cho 4 người không?", "answer": "Có, phòng Family 2 giường đôi giá 900k/đêm."}
                    ]
                }
            }
        }
    ]
}

# Send to ota-raw/push
body = json.dumps(payload).encode("utf-8")
sig = hmac.new(SECRET.encode(), body, hashlib.sha256).hexdigest()

print(f"[test] Pushing rich content hotel to OTA raw...")
req = urllib.request.Request(
    "https://app.sondervn.com/api/ota-raw/push",
    data=body, method="POST",
    headers={
        "Content-Type": "application/json",
        "X-OTA-Signature": f"sha256={sig}",
        "X-OTA-Timestamp": str(int(time.time() * 1000)),
        "X-OTA-Source": "test-rich",
    }
)
try:
    with urllib.request.urlopen(req, timeout=15) as r:
        print(f"[push] HTTP {r.status}")
        print(r.read().decode("utf-8"))
except Exception as e:
    print(f"[push] ERR: {e}")

# Wait + trigger classifier + rebuild + test
CMD = r"""
cd /opt/vp-marketing

sleep 2
echo "=== Trigger Qwen classifier ==="
cat > tmp.js <<'JS'
(async () => {
  const { runQwenClassifierBatch } = require('./dist/services/qwen-classifier');
  const r = await runQwenClassifierBatch();
  console.log(JSON.stringify(r, null, 2));
})();
JS
node tmp.js
rm -f tmp.js

echo ""
echo "=== Check hotel_profile ==="
cat > tmp.js <<'JS'
const Database = require('better-sqlite3');
const db = new Database('data/db.sqlite');
const h = db.prepare(`SELECT hotel_id, name_canonical, property_type, star_rating, scraped_data FROM hotel_profile WHERE name_canonical LIKE '%Rich Demo%'`).get();
if (h) {
  console.log(`Hotel found: #${h.hotel_id} ${h.name_canonical} ${h.property_type} ${h.star_rating}⭐`);
  const sd = JSON.parse(h.scraped_data || '{}');
  console.log('content_sections keys:', Object.keys(sd.content_sections || {}).join(', '));
}
db.close();
JS
node tmp.js
rm -f tmp.js

echo ""
echo "=== Rebuild embeddings cho hotel mới ==="
cat > tmp.js <<'JS'
(async () => {
  const Database = require('better-sqlite3');
  const db = new Database('data/db.sqlite');
  const h = db.prepare(`SELECT hotel_id FROM hotel_profile WHERE name_canonical LIKE '%Rich Demo%'`).get();
  db.close();
  if (h) {
    const { rebuildEmbeddings } = require('./dist/services/knowledge-sync');
    const r = await rebuildEmbeddings(h.hotel_id);
    console.log(`Rebuild hotel ${h.hotel_id}:`, JSON.stringify(r));
  }
})();
JS
node tmp.js
rm -f tmp.js

echo ""
echo "=== Chunks breakdown theo type ==="
cat > tmp.js <<'JS'
const Database = require('better-sqlite3');
const db = new Database('data/db.sqlite');
const h = db.prepare(`SELECT hotel_id FROM hotel_profile WHERE name_canonical LIKE '%Rich Demo%'`).get();
if (h) {
  const rows = db.prepare(`SELECT chunk_type, COUNT(*) as n FROM hotel_knowledge_embeddings WHERE hotel_id = ? GROUP BY chunk_type ORDER BY n DESC`).all(h.hotel_id);
  rows.forEach(r => console.log(`  ${r.chunk_type}: ${r.n}`));
  const total = rows.reduce((a, b) => a + b.n, 0);
  console.log(`  TOTAL: ${total} chunks`);
}

console.log('\n=== Auto-generated Wiki entries ===');
const wiki = db.prepare(`SELECT namespace, slug, title FROM knowledge_wiki WHERE slug LIKE '%hotel-%' OR slug LIKE '%area-%' OR slug LIKE '%promo-%' OR slug LIKE '%rules-%' OR slug LIKE '%reviews-%' ORDER BY namespace, slug`).all();
wiki.forEach(w => console.log(`  [${w.namespace}] ${w.slug} — ${w.title}`));

db.close();
JS
node tmp.js
rm -f tmp.js

echo ""
echo "=== Test semantic search với rich data ==="
cat > tmp.js <<'JS'
(async () => {
  const { semanticSearch } = require('./dist/services/knowledge-sync');
  const queries = [
    'homestay có đưa đón sân bay không',
    'gần bánh mì ngon',
    'có cho trẻ em không',
    'chủ nhà nói tiếng Anh',
    'safety an toàn',
    'loyalty khách thân thiết',
    'eco friendly tiết kiệm',
  ];
  for (const q of queries) {
    const hits = await semanticSearch(q, { topK: 2, minScore: 0.3 });
    console.log(`\n"${q}" →`);
    hits.forEach((h, i) => console.log(`  ${i+1}. [${h.chunk_type}] ${(h.score*100).toFixed(0)}% — ${h.chunk_text.slice(0, 100)}`));
  }
})();
JS
node tmp.js
rm -f tmp.js
"""

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, username="root", password=PASSWORD, timeout=15)
_, stdout, stderr = client.exec_command(CMD, timeout=180)
print(stdout.read().decode("utf-8", errors="replace"))
err = stderr.read().decode("utf-8", errors="replace")
if err.strip(): print("STDERR:\n" + err, file=sys.stderr)
client.close()

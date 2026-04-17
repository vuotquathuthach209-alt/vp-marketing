/**
 * Seed wiki với tham số cơ bản — chăm sóc khách hàng VN.
 * Chạy: npx tsx src/scripts/seed-wiki.ts
 *
 * Nạp các mục:
 *  - business/sonder-brand       (always_inject) — giới thiệu thương hiệu
 *  - business/customer-care-tone (always_inject) — giọng điệu CSKH
 *  - faq/*                       — 15 câu hỏi thường gặp VN
 *  - lesson/*                    — bài học closing, đối phó khách do dự
 */
import { db, getSetting } from '../db';

interface WikiEntry {
  namespace: 'business' | 'product' | 'campaign' | 'faq' | 'lesson';
  slug: string;
  title: string;
  content: string;
  tags: string[];
  always_inject?: boolean;
}

const ENTRIES: WikiEntry[] = [
  // ═══ BUSINESS (always inject) ═══
  {
    namespace: 'business',
    slug: 'sonder-brand',
    title: 'Thương hiệu Sonder Vietnam',
    tags: ['sonder', 'thương hiệu', 'giới thiệu'],
    always_inject: true,
    content: `Sonder Vietnam là chuỗi khách sạn boutique tập trung vào trải nghiệm cá nhân hóa, giá minh bạch và dịch vụ thân thiện.

ĐẶC ĐIỂM NỔI BẬT:
- Đặt trực tiếp luôn rẻ hơn OTA (Agoda, Booking) tối thiểu 5-10%
- Miễn phí hủy trước ngày check-in
- Thanh toán tại nơi / chuyển khoản / thẻ / MoMo / VNPay
- Hỗ trợ 24/7 qua inbox Facebook + hotline

CAM KẾT: Không phụ phí ẩn. Không pressure selling. Nếu khách do dự — tụi mình gửi hình phòng + báo giá chi tiết trước rồi khách quyết.`,
  },
  {
    namespace: 'business',
    slug: 'customer-care-tone',
    title: 'Giọng điệu CSKH Sonder',
    tags: ['tone', 'cskh', 'giọng điệu'],
    always_inject: true,
    content: `GIỌNG CHUẨN khi trả lời khách:
- Xưng hô: "mình" (bot) — "bạn/anh/chị" (khách). Thân thiện như bạn bè, KHÔNG dùng "quý khách", "thưa ngài".
- Ngắn gọn: 2-4 câu, 1-2 emoji. Không viết dài dòng.
- CHỦ ĐỘNG gợi ý bước tiếp theo: "Bạn cho mình biết ngày check-in nhé?", "Gõ 'hình' mình gửi ảnh phòng nha".
- Khi không biết: "Để mình kiểm tra và báo lại bạn nhé!" (KHÔNG bịa).
- Khi khách do dự: gửi hình phòng + review thật → không ép.
- Khi khách phàn nàn: xin lỗi CHÂN THÀNH + xin SĐT → chuyển quản lý xử lý trong 5 phút.

CẤM:
- Không hứa giảm giá ngoài chính sách
- Không bình luận về đối thủ
- Không hỏi thông tin nhạy cảm (CMND, số thẻ) qua chat`,
  },

  // ═══ FAQ ═══
  {
    namespace: 'faq',
    slug: 'check-in-som',
    title: 'Nhận phòng sớm (Early Check-in)',
    tags: ['check-in', 'nhận sớm', 'early'],
    content: `Giờ check-in chuẩn: 14:00. Nhận sớm tùy tình trạng phòng:
- Trước 12:00 (trước 2h): phụ thu 30% giá đêm
- Trước 10:00 (trước 4h): phụ thu 50% giá đêm
- Trước 08:00: tính 1 đêm
MẸO: Báo trước 1 ngày để mình giữ phòng cho bạn. Miễn phí gửi hành lý nếu đến sớm chưa có phòng.`,
  },
  {
    namespace: 'faq',
    slug: 'check-out-muon',
    title: 'Trả phòng muộn (Late Check-out)',
    tags: ['check-out', 'trả muộn', 'late'],
    content: `Giờ check-out chuẩn: 12:00. Trả muộn:
- +2h (đến 14:00): phụ thu 30%
- +4h (đến 16:00): phụ thu 50%
- Sau 18:00: tính thêm 1 đêm
Báo lễ tân từ tối hôm trước để được ưu tiên.`,
  },
  {
    namespace: 'faq',
    slug: 'thanh-toan',
    title: 'Các hình thức thanh toán',
    tags: ['thanh toán', 'payment', 'chuyển khoản'],
    content: `Chấp nhận:
✅ Tiền mặt tại lễ tân
✅ Chuyển khoản ngân hàng (MB, Vietcombank, TCB)
✅ Thẻ Visa/Mastercard/JCB (không phụ thu)
✅ Ví MoMo, VNPay, ZaloPay
✅ Apple Pay / Google Pay
Xuất hóa đơn VAT miễn phí — gửi thông tin công ty trước check-in 24h.`,
  },
  {
    namespace: 'faq',
    slug: 'huy-phong',
    title: 'Chính sách hủy phòng',
    tags: ['hủy', 'huỷ', 'cancel', 'refund', 'hoàn tiền'],
    content: `✅ Hủy MIỄN PHÍ trước 18:00 ngày trước check-in
⚠️ Hủy trong ngày: phụ thu 50% đêm đầu
❌ No-show (không đến): tính 100% đêm đầu
Đổi ngày miễn phí 1 lần nếu báo trước 24h và còn phòng cùng hạng. Refund chuyển khoản trong 3-5 ngày làm việc.`,
  },
  {
    namespace: 'faq',
    slug: 'tre-em',
    title: 'Chính sách trẻ em',
    tags: ['trẻ em', 'kid', 'em bé', 'nôi'],
    content: `- Trẻ dưới 6 tuổi: MIỄN PHÍ khi ngủ chung giường bố mẹ
- Trẻ 6-11 tuổi: phụ thu 150k/đêm (ăn sáng + giường phụ nếu có)
- Từ 12 tuổi: tính như người lớn
Miễn phí nôi em bé (báo trước). Có ghế ăn em bé tại nhà hàng.`,
  },
  {
    namespace: 'faq',
    slug: 'an-sang',
    title: 'Ăn sáng & nhà hàng',
    tags: ['ăn sáng', 'breakfast', 'nhà hàng'],
    content: `Buffet sáng 6:30-10:00 tại nhà hàng tầng trệt. Menu Á-Âu phong phú, phở – bún – trứng ốp-la – bánh mì tươi – trái cây theo mùa – cà phê phin.
- Giá lẻ: 180k/người
- Đã gồm khi đặt gói "có ăn sáng"
Phục vụ phòng (room service) 6:00-23:00.`,
  },
  {
    namespace: 'faq',
    slug: 'wifi-tien-ich',
    title: 'Wifi & Tiện ích',
    tags: ['wifi', 'tiện ích', 'amenities', 'gym', 'hồ bơi'],
    content: `📶 Wifi: MIỄN PHÍ, tốc độ cao (100+ Mbps), phủ toàn bộ khách sạn.
🅿️ Đỗ xe: miễn phí xe máy, ô tô tùy chi nhánh (báo trước để giữ chỗ).
💪 Gym: 6:00-22:00 (tùy chi nhánh).
🏊 Hồ bơi: 6:00-21:00 (tùy chi nhánh).
🧖 Spa/Massage: đặt trước 1h qua lễ tân.
🛎️ Dịch vụ giặt ủi: nhận trước 10:00, trả trong ngày.`,
  },
  {
    namespace: 'faq',
    slug: 'thu-cung',
    title: 'Chính sách thú cưng (Pet-friendly)',
    tags: ['thú cưng', 'pet', 'chó', 'mèo'],
    content: `Một số chi nhánh chấp nhận thú cưng:
- Dưới 10kg: phụ thu 200k/đêm (phí vệ sinh)
- Trên 10kg: liên hệ lễ tân
- Yêu cầu: có dây xích / chuồng, đã tiêm phòng
- Không được lên giường/sofa, dùng đồ ăn riêng
Gọi trước để xác nhận phòng pet-friendly còn trống.`,
  },
  {
    namespace: 'faq',
    slug: 'thue-theo-gio',
    title: 'Thuê phòng theo giờ',
    tags: ['theo giờ', 'hourly', 'nghỉ trưa'],
    content: `Thuê theo giờ áp dụng phòng trống, 9:00-22:00:
- Block 2h đầu: 40% giá đêm
- Mỗi giờ tiếp: +15%
- Tối đa 5h = bằng 1 đêm
Báo trước 1h qua inbox hoặc hotline. Nhận phòng trong 5 phút.`,
  },
  {
    namespace: 'faq',
    slug: 'hoa-don-vat',
    title: 'Xuất hóa đơn VAT',
    tags: ['hóa đơn', 'vat', 'invoice', 'công ty'],
    content: `Miễn phí xuất hóa đơn VAT 10%. Gửi trước check-in 24h:
- Tên công ty
- Mã số thuế
- Địa chỉ đăng ký
- Email nhận hóa đơn điện tử
Xuất trong 24h sau check-out, gửi qua email.`,
  },
  {
    namespace: 'faq',
    slug: 'dua-don-san-bay',
    title: 'Dịch vụ đưa đón sân bay',
    tags: ['sân bay', 'đưa đón', 'airport', 'taxi'],
    content: `Dịch vụ xe 4/7 chỗ đến/đi sân bay:
- Nội Bài / Tân Sơn Nhất: 350k-450k/chiều
- Đà Nẵng: 250k/chiều
Đặt trước 4h. Tài xế đón tận cửa ra, cầm biển tên khách. Miễn phí 1 chai nước + wifi xe.`,
  },
  {
    namespace: 'faq',
    slug: 'gia-tot-nhat',
    title: 'Tại sao đặt trực tiếp rẻ hơn?',
    tags: ['giá tốt', 'trực tiếp', 'agoda', 'booking', 'ota'],
    content: `Đặt trực tiếp qua inbox hoặc hotline rẻ hơn OTA 5-10% vì:
1. Không mất phí hoa hồng OTA (15-18%)
2. Được áp dụng deal loyalty riêng
3. Được ưu tiên nâng hạng phòng khi còn trống
4. Hủy/đổi linh hoạt hơn chính sách OTA
Inbox ngày check-in + loại phòng, mình báo giá tốt nhất trong 2 phút!`,
  },
  {
    namespace: 'faq',
    slug: 'khu-vuc-lan-can',
    title: 'Khu vực lân cận & điểm tham quan',
    tags: ['gần đây', 'tham quan', 'nearby', 'ăn uống'],
    content: `Khách sạn nằm gần trung tâm, đi bộ 5-10 phút đến:
- Chợ/phố ẩm thực đặc sản địa phương
- Quán cà phê + coworking nổi tiếng
- Ngân hàng, ATM, tiệm thuốc 24/7
- Trạm xe buýt + bãi Grab/Gojek
Lễ tân có bản đồ tham quan + gợi ý menu ăn theo ngân sách. Hỏi là có!`,
  },
  {
    namespace: 'faq',
    slug: 'an-toan-bao-mat',
    title: 'An toàn & bảo mật',
    tags: ['an toàn', 'bảo mật', 'security', 'két'],
    content: `- Thẻ khóa phòng từ tính, mỗi khách 2 thẻ
- Két an toàn trong phòng (mã số riêng)
- Camera hành lang 24/7, bảo vệ trực đêm
- Thang máy dùng thẻ phòng (chống lạ xâm nhập)
- Cam kết KHÔNG chia sẻ thông tin khách cho bên thứ 3
Mất chìa/thẻ: phụ thu 100k/chiếc.`,
  },
  {
    namespace: 'faq',
    slug: 'nhom-dong',
    title: 'Đặt phòng nhóm / sự kiện',
    tags: ['nhóm', 'group', 'sự kiện', 'đoàn', 'tiệc'],
    content: `Đặt ≥5 phòng cùng lúc:
- Giảm 8-15% theo mùa
- Miễn phí 1 phòng cho trưởng đoàn (nhóm ≥10 phòng)
- Hỗ trợ set-up welcome drink + banner
- Phòng họp/tiệc: 500k-2tr/buổi tùy sức chứa
Gửi thông tin: ngày, số phòng, số người → báo giá chi tiết trong 30 phút.`,
  },
  {
    namespace: 'faq',
    slug: 'khach-nuoc-ngoai',
    title: 'Khách nước ngoài / Visa',
    tags: ['nước ngoài', 'foreign', 'visa', 'passport'],
    content: `Đón tất cả quốc tịch. Yêu cầu:
- Hộ chiếu còn hiệu lực
- Visa hợp lệ (hoặc miễn visa)
- Đăng ký tạm trú online — lễ tân làm miễn phí
Có nhân viên nói tiếng Anh 24/7. Menu ăn sáng + thực đơn song ngữ.`,
  },

  // ═══ LESSON — đúc kết từ kinh nghiệm CSKH ═══
  {
    namespace: 'lesson',
    slug: 'khach-do-du-gia',
    title: 'Xử lý khách do dự về giá',
    tags: ['do dự', 'đắt', 'rẻ', 'so sánh'],
    content: `Khi khách nói "đắt quá" / "để nghĩ xem":
1. KHÔNG giảm giá ngay → mất biên
2. Gửi ngay 3-5 hình phòng đẹp nhất + 1 review 5 sao thật
3. Nhấn mạnh value: "Giá này đã gồm ăn sáng + wifi + hồ bơi"
4. Tạo urgency nhẹ: "Hôm nay còn 2 phòng hạng này, cuối tuần full rồi"
5. Nếu vẫn do dự → xin SĐT "để mình báo khi có deal tốt hơn"`,
  },
  {
    namespace: 'lesson',
    slug: 'chot-booking-nhanh',
    title: 'Quy trình chốt booking trong 3 phút',
    tags: ['chốt', 'closing', 'booking'],
    content: `Khi khách hỏi giá / hình → tiến hành:
1. Xác nhận NGÀY + SỐ KHÁCH + SỐ ĐÊM (3 thông tin)
2. Báo giá chính xác từ OTA DB (không ước lượng)
3. Gửi link thanh toán VNPay/MoMo HOẶC số TK chuyển khoản
4. Xác nhận khi thấy ảnh bill → gửi mã booking
5. Đặt lời hứa: "Mình sẽ chuẩn bị phòng view đẹp nhất cho bạn nha!"
Mục tiêu: 3 tin nhắn → giá, 5 tin nhắn → chốt.`,
  },
  {
    namespace: 'lesson',
    slug: 'khach-phan-nan',
    title: 'Xử lý khách phàn nàn',
    tags: ['phàn nàn', 'complaint', 'bức xúc'],
    content: `Khi khách bức xúc:
1. KHÔNG bào chữa. Bắt đầu bằng "Mình thành thật xin lỗi..."
2. Hỏi cụ thể: "Bạn cho mình biết vấn đề xảy ra lúc nào, ở đâu?"
3. XIN SỐ ĐIỆN THOẠI → chuyển quản lý trong 5 phút
4. Đề xuất compensate: voucher đêm miễn phí / nâng hạng phòng / hoàn 1 phần
5. Sau xử lý: follow-up sau 24h hỏi khách hài lòng chưa
NGUYÊN TẮC: Khách bức xúc = cơ hội biến thành fan trung thành.`,
  },
];

function upsert(entry: WikiEntry) {
  const now = Date.now();
  const row = db.prepare(
    `SELECT id FROM knowledge_wiki WHERE namespace = ? AND slug = ?`
  ).get(entry.namespace, entry.slug) as any;

  if (row) {
    db.prepare(
      `UPDATE knowledge_wiki SET title=?, content=?, tags=?, always_inject=?, active=1, updated_at=? WHERE id=?`
    ).run(
      entry.title, entry.content, JSON.stringify(entry.tags),
      entry.always_inject ? 1 : 0, now, row.id,
    );
    return 'updated';
  }
  db.prepare(
    `INSERT INTO knowledge_wiki (namespace, slug, title, content, tags, always_inject, active, hotel_id, updated_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, 1, ?, ?)`
  ).run(
    entry.namespace, entry.slug, entry.title, entry.content,
    JSON.stringify(entry.tags), entry.always_inject ? 1 : 0, now, now,
  );
  return 'inserted';
}

export function seedWikiDefaults(): { inserted: number; updated: number; total: number } {
  let ins = 0, upd = 0;
  for (const e of ENTRIES) {
    const act = upsert(e);
    if (act === 'inserted') ins++; else upd++;
  }
  return { inserted: ins, updated: upd, total: ENTRIES.length };
}

export const DEFAULT_WIKI_ENTRIES = ENTRIES;

function main() {
  console.log(`\n🌱 Seeding wiki với ${ENTRIES.length} entries...\n`);
  let ins = 0, upd = 0;
  for (const e of ENTRIES) {
    const act = upsert(e);
    if (act === 'inserted') ins++; else upd++;
    console.log(`  ${act === 'inserted' ? '✨' : '🔄'} [${e.namespace}] ${e.slug} — ${e.title}`);
  }
  console.log(`\n✅ Done. ${ins} mới, ${upd} cập nhật.\n`);

  // Stats
  const byNs = db.prepare(
    `SELECT namespace, COUNT(*) as c FROM knowledge_wiki WHERE active = 1 GROUP BY namespace ORDER BY namespace`
  ).all() as any[];
  console.log('📊 Wiki hiện tại:');
  for (const r of byNs) console.log(`   ${r.namespace}: ${r.c}`);

  // Hotel + OTA check
  const hotels = db.prepare(`SELECT id, name, ota_hotel_id FROM mkt_hotels`).all() as any[];
  console.log(`\n🏨 ${hotels.length} khách sạn:`);
  for (const h of hotels) {
    const cache = db.prepare(`SELECT address, district, city, phone, check_in_time, check_out_time, star_rating FROM mkt_hotels_cache WHERE ota_hotel_id = ?`).get(h.ota_hotel_id) as any;
    console.log(`   [${h.id}] ${h.name} ${h.ota_hotel_id ? `→ OTA#${h.ota_hotel_id}` : '(chưa link OTA)'}`);
    if (cache) {
      const addr = [cache.address, cache.district, cache.city].filter(Boolean).join(', ');
      console.log(`       📍 ${addr || '(chưa có địa chỉ)'}`);
      console.log(`       📞 ${cache.phone || '(chưa có SĐT)'} | ⏰ ${cache.check_in_time || '14:00'} / ${cache.check_out_time || '12:00'}${cache.star_rating ? ` | ⭐ ${cache.star_rating}` : ''}`);
    } else {
      console.log(`       ⚠️  Chưa có cache — chạy sync OTA để nạp data phòng + tiện ích`);
    }
  }

  const otaCfg = getSetting('ota_db_host');
  console.log(`\n🗄️  OTA DB: ${otaCfg ? '✅ đã cấu hình (' + otaCfg + ')' : '❌ chưa cấu hình'}`);
  if (!otaCfg) {
    console.log('   → Vào Settings → OTA Integration để cấu hình MySQL OTA');
    console.log('   → Sau đó nhấn "Sync OTA" để nạp phòng, giá, tiện ích real-time vào cache');
  }
}

// Only run main() when invoked directly (not when imported)
if (require.main === module) {
  main();
}

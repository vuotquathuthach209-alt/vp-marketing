/**
 * Seed realistic Sonder reply template variants for A/B testing.
 * Idempotent.
 */

import { db } from '../db';

interface VariantSeed {
  template_key: string;
  variants: Array<{ name: string; content: string; weight?: number }>;
}

const TEMPLATE_VARIANTS: VariantSeed[] = [
  // 1. Greeting cho khách mới (first inbox)
  {
    template_key: 'greeting_new',
    variants: [
      {
        name: 'A', // Warm + CTA rõ
        content: 'Chào anh/chị! 👋 Em là Lan — tư vấn viên Sonder.\n\nEm có thể giúp gì ạ?\n  🏨 Check giá phòng\n  📍 Tư vấn chọn chỗ\n  💳 Đặt phòng ngay',
      },
      {
        name: 'B', // Ngắn gọn
        content: 'Dạ Sonder em nghe! 🌿 Anh/chị cần em hỗ trợ gì ạ?',
      },
      {
        name: 'C', // Product-first
        content: 'Chào anh/chị! 👋\n\nSonder là chuỗi 7 chỗ ở tại HCM (gần sân bay, quận 1, Bình Thạnh). Phòng từ **550k/đêm**, CHDV thuê tháng từ 3.6tr.\n\nAnh/chị muốn em tư vấn cụ thể chỗ nào ạ?',
      },
    ],
  },

  // 2. Show results — khi có danh sách phòng match
  {
    template_key: 'show_results_list',
    variants: [
      {
        name: 'A', // Bullet list có emoji
        content: 'Dạ bên em có **{{count}} lựa chọn** phù hợp:\n\n{{rows}}\n\n✨ Anh/chị thích option nào để em tư vấn kỹ hơn ạ?',
      },
      {
        name: 'B', // Social proof
        content: 'Em tìm được {{count}} chỗ — đều được khách đánh giá 4⭐+ ạ:\n\n{{rows}}\n\n💬 Nhắn số thứ tự để em tư vấn nhé!',
      },
    ],
  },

  // 3. Show results — hết phòng (empty state)
  {
    template_key: 'show_results_empty',
    variants: [
      {
        name: 'A', // Empathy + alternatives
        content: '😔 Tiếc quá, hôm đó bên em đã kín phòng rồi ạ.\n\nEm có thể gợi ý:\n  📅 Ngày khác gần đó\n  🏨 Chỗ tương tự\n  📱 Để SĐT, em notify khi có khách hủy\n\nAnh/chị chọn option nào ạ?',
      },
      {
        name: 'B', // Urgent + scarcity
        content: '⚠️ Ngày anh/chị chọn đang cực kỳ đông — bên em hết phòng rồi ạ.\n\n**Gợi ý nhanh:** các ngày liền kề còn phòng từ {{alt_price}}/đêm. Em có thể send link đặt nhanh qua web không ạ?',
      },
    ],
  },

  // 4. Closing — xin SĐT để chốt deal
  {
    template_key: 'closing_ask_phone',
    variants: [
      {
        name: 'A', // Straightforward
        content: 'Anh/chị để lại SĐT, em giữ lock giá phòng + gửi QR code đặt cọc ngay qua Zalo ạ 📱',
      },
      {
        name: 'B', // Social proof
        content: 'Dạ để em giữ phòng cho anh/chị (ưu tiên giá đang giảm), anh/chị để lại SĐT em gọi tư vấn cọc trong 5 phút nhé 🙏',
      },
      {
        name: 'C', // Value + speed
        content: '👉 Chỉ cần để SĐT, em sẽ:\n  1️⃣ Gửi QR VietQR số tiền cụ thể\n  2️⃣ Lock giá trong 15 phút\n  3️⃣ Xác nhận booking ngay khi cọc xong\n\nAnh/chị cho em số nhé 🙌',
      },
    ],
  },

  // 5. Cancellation policy reply (cho chính sách hủy)
  {
    template_key: 'policy_cancellation_reply',
    variants: [
      {
        name: 'A', // Structured bullets
        content: '📋 Chính sách hủy phòng Sonder:\n\n• Hủy trước 48h: **hoàn 100%** tiền cọc\n• Hủy 24-48h: hoàn 50%\n• Hủy < 24h hoặc no-show: không hoàn\n\nAnh/chị cần em support thêm gì không ạ?',
      },
      {
        name: 'B', // Conversational
        content: 'Dạ chính sách hủy bên em công bằng lắm ạ:\n  - **Trước 48h**: hoàn tiền đầy đủ ✅\n  - 24-48h: hoàn 1 nửa\n  - < 24h: giữ cọc\n\nThường khách báo trước 1-2 ngày là không vấn đề gì đâu ạ 🙌',
      },
    ],
  },
];

export function seedReplyTemplates(): { created: number; skipped: number } {
  const now = Date.now();
  let created = 0, skipped = 0;

  for (const seed of TEMPLATE_VARIANTS) {
    for (const variant of seed.variants) {
      const exists = db.prepare(
        `SELECT id FROM reply_templates WHERE hotel_id = 0 AND template_key = ? AND variant_name = ?`
      ).get(seed.template_key, variant.name);
      if (exists) { skipped++; continue; }

      db.prepare(
        `INSERT INTO reply_templates
         (hotel_id, template_key, variant_name, content, weight, active, is_winner,
          impressions, conversions, created_at, updated_at)
         VALUES (0, ?, ?, ?, ?, 1, 0, 0, 0, ?, ?)`
      ).run(
        seed.template_key, variant.name, variant.content,
        variant.weight || 100,
        now, now,
      );
      created++;
    }
  }

  console.log(`[reply-tmpl-seed] created=${created} skipped=${skipped}`);
  return { created, skipped };
}

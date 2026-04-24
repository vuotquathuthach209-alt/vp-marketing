/**
 * Template Seeder — v27 Agentic
 *
 * Seed 25 default templates vào `agentic_templates` table khi boot.
 * Chỉ insert nếu template chưa tồn tại (idempotent).
 *
 * Admin có thể sửa content trên UI — seeder KHÔNG override.
 * Muốn reset về default: xoá row + restart, hoặc dùng endpoint /reset.
 *
 * Categories:
 *   - discovery  (5): lần đầu chào, tìm hiểu nhu cầu
 *   - gathering  (4): gom slot booking
 *   - info       (4): trả lời câu hỏi thông tin
 *   - objection  (3): khách chê giá / vị trí / kích thước
 *   - decision   (3): chốt deal
 *   - handoff    (3): chuyển nhân viên
 *   - misc       (3): smalltalk / bye / after hours
 *
 * Tổng: 25 templates. Mục tiêu cover 80% scenarios.
 */

import { db } from '../../db';

export interface SeedTemplate {
  id: string;
  category: 'discovery' | 'gathering' | 'info' | 'objection' | 'decision' | 'handoff' | 'misc';
  description: string;
  trigger_conditions?: any;       // JSON — sẽ khớp với context để chọn template
  content: string;                // Mustache-like: {{customerName}}, {{hotline}}, ...
  quick_replies?: Array<{ title: string; payload: string }>;
  confidence?: number;
}

const HOTLINE = '0348 644 833';

// Reusable string replacement of HOTLINE
const H = '{{hotline}}';

export const DEFAULT_TEMPLATES: SeedTemplate[] = [
  /* ═══════════════════════════════════════════════════════════
     DISCOVERY (5) — Turn 1-2, chào & hiểu nhu cầu
     ═══════════════════════════════════════════════════════════ */

  {
    id: 'first_contact_warm',
    category: 'discovery',
    description: 'Turn 1 — khách mới, chào ấm, 3 options (default fallback)',
    // Chỉ 1 điều kiện: turn_number=1 — làm default/fallback cho first turn.
    // Các template cụ thể hơn (first_vague, first_with_urgency, first_with_question)
    // có NHIỀU conditions hơn nên thắng khi conditions của chúng match.
    trigger_conditions: { turn_number: 1 },
    content: `Dạ em chào anh/chị 👋

Em là trợ lý AI của **SONDER** — nền tảng hỗ trợ lưu trú trực tuyến tại TP.HCM.

Em có thể giúp anh/chị:
  1️⃣  Tư vấn đặt phòng (homestay / khách sạn / CHDV)
  2️⃣  Tìm thông tin (giá, tiện nghi, vị trí)
  3️⃣  Kết nối nhân viên CSKH: 📞 ${H}

Anh/chị cần em hỗ trợ gì ạ?`,
    quick_replies: [
      { title: '🏨 Đặt phòng', payload: 'intent_booking' },
      { title: '📋 Xem thông tin', payload: 'intent_info' },
      { title: '👤 Gặp nhân viên', payload: 'intent_handoff' },
    ],
    confidence: 1.0,
  },

  {
    id: 'returning_customer_greet',
    category: 'discovery',
    description: 'Turn 1 — khách cũ, personalized',
    trigger_conditions: { turn_number: 1, customer_is_returning: true },
    content: `Dạ em chào {{customerName}} ạ 💚

{{#isVip}}Anh/chị là khách VIP của Sonder 🌟{{/isVip}}
{{^isVip}}Em nhớ lần trước anh/chị đã đặt bên em rồi 😊{{/isVip}}

Lần này em hỗ trợ gì ạ?
  1️⃣  Đặt phòng (giống lần trước, hoặc tìm chỗ mới)
  2️⃣  Xem lịch sử booking / thông tin khác
  3️⃣  Nói chuyện với nhân viên: 📞 ${H}`,
    quick_replies: [
      { title: '🏨 Đặt lại', payload: 'intent_rebook' },
      { title: '🔍 Tìm chỗ mới', payload: 'intent_booking' },
      { title: '📞 Gặp nhân viên', payload: 'intent_handoff' },
    ],
    confidence: 1.0,
  },

  {
    id: 'first_with_question',
    category: 'discovery',
    description: 'Turn 1 — khách mở đầu với câu hỏi luôn (giá / tiện nghi / vị trí)',
    trigger_conditions: { turn_number: 1, intent: 'info_question' },
    content: `Dạ em chào anh/chị 👋 Em là trợ lý Sonder.

Em thấy anh/chị đang hỏi về **{{topic}}** — để em trả lời chính xác, anh/chị cho em biết thêm:
  - Anh/chị muốn đặt ngắn ngày hay thuê tháng?
  - Khu vực nào ở TP.HCM ạ?

Hoặc em gửi bảng giá tổng quát trước, anh/chị xem rồi mình tư vấn tiếp nhé 🙌`,
    quick_replies: [
      { title: '📊 Bảng giá tổng', payload: 'info_price_range' },
      { title: '🏨 Tư vấn đặt phòng', payload: 'intent_booking' },
      { title: '👤 Gặp nhân viên', payload: 'intent_handoff' },
    ],
    confidence: 0.95,
  },

  {
    id: 'first_with_urgency',
    category: 'discovery',
    description: 'Turn 1 — khách gấp (gấp/ngay/bây giờ/đêm nay)',
    trigger_conditions: { turn_number: 1, keywords_any: ['gấp', 'ngay', 'bây giờ', 'đêm nay', 'check-in luôn'] },
    content: `Dạ em hiểu anh/chị cần gấp ạ 🏃‍♂️ Em xử lý nhanh nhé!

Cho em xin NHANH 3 thông tin:
  📅 Bao nhiêu đêm? (từ hôm nay)
  👥 Mấy người?
  📍 Khu vực ưu tiên? (sân bay / Q1 / Bình Thạnh)

Em check phòng trống NGAY. Nếu vội quá, anh/chị gọi thẳng hotline cũng được:
📞 **${H}** (có người trực 24/7)`,
    quick_replies: [
      { title: '📞 Gọi ngay', payload: 'handoff_now' },
      { title: '1 đêm 2 người sân bay', payload: 'quick_1n_2p_airport' },
    ],
    confidence: 0.95,
  },

  {
    id: 'first_vague',
    category: 'discovery',
    description: 'Turn 1 — khách chào mơ hồ ("alo", "hi", "dạ")',
    trigger_conditions: { turn_number: 1, message_length_lt: 10 },
    content: `Dạ em chào anh/chị 😊

Em là trợ lý Sonder. Anh/chị cho em biết đang cần:
  🏨 **Đặt phòng** (ngắn ngày / thuê tháng)
  📋 **Tìm thông tin** (giá, vị trí, tiện nghi)
  👤 **Nói chuyện với nhân viên**

Anh/chị chọn giúp em ạ 🙌`,
    quick_replies: [
      { title: '🏨 Đặt phòng', payload: 'intent_booking' },
      { title: '📋 Thông tin', payload: 'intent_info' },
      { title: '👤 Nhân viên', payload: 'intent_handoff' },
    ],
    confidence: 0.9,
  },

  /* ═══════════════════════════════════════════════════════════
     GATHERING (4) — Turn 2-4, gom slot booking
     ═══════════════════════════════════════════════════════════ */

  {
    id: 'discover_short_stay_batch',
    category: 'gathering',
    description: 'Turn 2 — hỏi gộp 4 slot short-term',
    trigger_conditions: { intent: 'booking', rental_mode: 'short_term', slot_completeness_lt: 0.3 },
    content: `Dạ em tư vấn đặt phòng ngắn ngày ạ! Để chính xác, anh/chị cho em xin 4 thông tin:

  📅 Ngày check-in + số đêm (VD: 25/5, 2 đêm)
  👥 Số khách (VD: 2 người lớn, 1 bé)
  💰 Budget dự kiến / đêm (VD: dưới 1tr)
  📍 Khu vực muốn ở (VD: gần sân bay, Q1)

Anh/chị trả lời 1 câu đầy đủ được nha, ví dụ:
_"25/5 2 đêm 2 người 800k gần sân bay"_

Hoặc từng phần cũng được, em lắng nghe ạ 😊`,
    quick_replies: [
      { title: '📅 Hôm nay', payload: 'dates_today' },
      { title: '📅 Cuối tuần', payload: 'dates_weekend' },
      { title: '📅 Tuần sau', payload: 'dates_nextweek' },
    ],
    confidence: 0.95,
  },

  {
    id: 'discover_long_stay_batch',
    category: 'gathering',
    description: 'Turn 2 — hỏi gộp 5 slot long-term CHDV',
    trigger_conditions: { intent: 'booking', rental_mode: 'long_term', slot_completeness_lt: 0.3 },
    content: `Dạ em tư vấn căn hộ thuê tháng (CHDV) ạ. Anh/chị cho em xin:

  📅 Ngày dọn vào (VD: đầu tháng sau)
  ⏱️  Thời gian thuê (VD: 3 tháng, 6 tháng)
  👥 Số người ở
  💰 Budget dự kiến / tháng (VD: 6-8tr)
  📍 Khu vực ưu tiên (Q1, Bình Thạnh, Tân Bình...)

Ví dụ: _"đầu tháng 6, thuê 6 tháng, 2 người, 7tr/tháng, Tân Bình"_`,
    quick_replies: [
      { title: '⏱ 3 tháng', payload: 'months_3' },
      { title: '⏱ 6 tháng', payload: 'months_6' },
      { title: '⏱ 1 năm+', payload: 'months_12' },
    ],
    confidence: 0.95,
  },

  {
    id: 'partial_info_gentle',
    category: 'gathering',
    description: 'Khách trả lời 2-3/4 slot, hỏi nhẹ thiếu gì',
    trigger_conditions: { intent: 'booking', slot_completeness_gte: 0.3, slot_completeness_lt: 0.8 },
    content: `Dạ em nhận thông tin rồi ạ 👍

Anh/chị cho em xin thêm: **{{missingSlots}}**

Một câu gọn thôi là đủ ạ 😊`,
    confidence: 0.9,
  },

  {
    id: 'answer_first_then_ask',
    category: 'gathering',
    description: 'Khách hỏi info giữa flow booking — trả lời info rồi tiếp tục hỏi slot',
    trigger_conditions: { intent: 'info_question', in_booking_flow: true },
    content: `Dạ em trả lời câu hỏi của anh/chị trước ạ:

**{{answerPreview}}**

Còn về booking, em đang cần thêm: **{{missingSlots}}**. Anh/chị cho em xin để em check phòng nhé 🙌`,
    confidence: 0.9,
  },

  /* ═══════════════════════════════════════════════════════════
     INFO (4) — trả lời câu hỏi thông tin chung
     ═══════════════════════════════════════════════════════════ */

  {
    id: 'price_overview',
    category: 'info',
    description: 'Bảng giá tổng quát Sonder',
    trigger_conditions: { intent: 'info_question', sub_category: 'price' },
    content: `Dạ em cập nhật giá phòng Sonder ạ 💰

  🏨 **Khách sạn**: từ **450k/đêm** (weekday)
  🏡 **Homestay**: từ **550k/đêm**
  🏢 **Căn hộ dịch vụ (CHDV)** thuê tháng: từ **3.6tr/tháng**

👉 Cuối tuần cộng 20%
👉 Ở 3+ đêm giảm 5%
👉 Cancel trước 48h hoàn 100%

Anh/chị ở mấy đêm + mấy người + khu vực nào, em báo giá CHÍNH XÁC nhé 🙌`,
    quick_replies: [
      { title: '🏨 Đặt phòng', payload: 'intent_booking' },
      { title: '📍 Xem vị trí', payload: 'intent_location' },
    ],
    confidence: 1.0,
  },

  {
    id: 'amenity_inquiry',
    category: 'info',
    description: 'Khách hỏi tiện nghi (wifi, máy lạnh, bếp, giặt...)',
    trigger_conditions: { intent: 'info_question', sub_category: 'amenity' },
    content: `Dạ tiện nghi ở Sonder đầy đủ ạ ✨

  📶 Wifi tốc độ cao (miễn phí)
  ❄️ Điều hòa tất cả phòng
  🧺 Máy giặt (CHDV) / giặt ủi theo yêu cầu
  🍳 Bếp đầy đủ (CHDV & homestay)
  🚿 Nước nóng 24/7
  🔐 Khoá thông minh, camera hành lang

Anh/chị cần tiện nghi đặc biệt nào không ạ? (bồn tắm, view đẹp, gym, hồ bơi...)`,
    quick_replies: [
      { title: '🛁 Bồn tắm', payload: 'amenity_bathtub' },
      { title: '🌅 View đẹp', payload: 'amenity_view' },
      { title: '💪 Gym/Pool', payload: 'amenity_gym' },
    ],
    confidence: 0.95,
  },

  {
    id: 'location_inquiry',
    category: 'info',
    description: 'Khách hỏi Sonder ở đâu',
    trigger_conditions: { intent: 'info_question', sub_category: 'location' },
    content: `Dạ Sonder có các chỗ ở tại **TP.HCM** ạ 📍

  ✈️ **Gần sân bay TSN** (Tân Bình) — tiện bay sớm/muộn
  🏙️ **Trung tâm Q1** (Bùi Viện, chợ Bến Thành) — phố đi bộ, ăn uống
  🌳 **Bình Thạnh** (gần cầu Sài Gòn) — yên tĩnh, gần Landmark 81

Mỗi chỗ có phòng đa dạng: studio → 2PN gia đình.
Anh/chị muốn em gợi ý chỗ cụ thể khu vực nào ạ?`,
    quick_replies: [
      { title: '✈️ Sân bay', payload: 'area_airport' },
      { title: '🏙️ Q1', payload: 'area_q1' },
      { title: '🌳 Bình Thạnh', payload: 'area_binhthanh' },
    ],
    confidence: 1.0,
  },

  {
    id: 'policy_inquiry',
    category: 'info',
    description: 'Khách hỏi policy (cancel, refund, check-in time, thú cưng)',
    trigger_conditions: { intent: 'info_question', sub_category: 'policy' },
    content: `Dạ em gửi policy Sonder ạ 📋

  🕐 **Check-in**: từ 14:00 — **Check-out**: trước 12:00
  🔄 **Hủy phòng**: trước 48h hoàn 100%, trong 48h mất 1 đêm
  💳 **Thanh toán**: cọc 30% giữ phòng, phần còn lại check-in
  🐕 **Thú cưng**: tùy chỗ (vài căn cho phép, cần báo trước)
  🚭 **Hút thuốc**: cấm hoàn toàn trong phòng (phạt 500k)

Anh/chị có câu hỏi về policy cụ thể nào không ạ?`,
    quick_replies: [
      { title: '🐕 Thú cưng', payload: 'policy_pet' },
      { title: '🔄 Hủy phòng', payload: 'policy_cancel' },
      { title: '👤 Nhân viên', payload: 'intent_handoff' },
    ],
    confidence: 0.95,
  },

  /* ═══════════════════════════════════════════════════════════
     OBJECTION (3) — khách chê → không gây áp lực
     ═══════════════════════════════════════════════════════════ */

  {
    id: 'price_objection',
    category: 'objection',
    description: 'Khách chê giá cao',
    trigger_conditions: { keywords_any: ['mắc', 'đắt', 'cao quá', 'quá mắc', 'rẻ hơn'] },
    content: `Dạ em hiểu ạ 🙏 Giá có vẻ cao so với kỳ vọng của anh/chị.

Em có vài option tiết kiệm hơn:
  💡 **Weekday** (T2-T5): giá gốc, không phụ thu
  💡 **Ở 3+ đêm**: giảm thêm 5%
  💡 **Homestay phòng nhỏ**: từ **380k/đêm** (weekday)
  💡 **CHDV studio thuê tháng**: tính ra **~200k/đêm**

Anh/chị muốn em gợi ý option nào ạ? Hoặc cho em biết budget, em tìm đúng khoảng giá 🙌`,
    quick_replies: [
      { title: '💡 Dưới 500k/đêm', payload: 'budget_lt500' },
      { title: '🏢 Thuê tháng rẻ', payload: 'mode_long_term' },
      { title: '👤 Nhân viên', payload: 'intent_handoff' },
    ],
    confidence: 0.9,
  },

  {
    id: 'location_objection',
    category: 'objection',
    description: 'Khách chê vị trí (xa, không tiện)',
    trigger_conditions: { keywords_any: ['xa', 'không tiện', 'khu khác', 'gần hơn'] },
    content: `Dạ vị trí là quan trọng ạ 📍 Em gợi ý thêm khu khác nhé:

  ✈️ **Tân Bình** (gần sân bay, 15 phút tới Q1 bằng Grab)
  🏙️ **Q1** (trung tâm, đi bộ phố Tây, chợ Bến Thành)
  🌳 **Bình Thạnh** (gần Landmark 81, yên tĩnh hơn Q1)

Anh/chị cần ở **gần đâu cụ thể**? (công ty, trường, địa điểm du lịch...) Em tìm chỗ gần đó nhất ạ.`,
    quick_replies: [
      { title: '✈️ Sân bay', payload: 'area_airport' },
      { title: '🏙️ Trung tâm Q1', payload: 'area_q1' },
      { title: '📍 Khu khác', payload: 'area_other' },
    ],
    confidence: 0.9,
  },

  {
    id: 'size_objection',
    category: 'objection',
    description: 'Khách chê phòng nhỏ / không đủ chỗ',
    trigger_conditions: { keywords_any: ['nhỏ quá', 'chật', 'không đủ', 'rộng hơn'] },
    content: `Dạ em hiểu ạ 🙏 Em gợi ý phòng rộng hơn:

  🏡 **Studio lớn** (30-35m²): 1-2 người, 1 giường queen + sofa
  🏠 **1PN riêng** (40-45m²): 2-3 người, có phòng khách
  🏢 **2PN** (60-70m²): 4-5 người, gia đình thoải mái

Anh/chị ở **mấy người** ạ? Em báo size phù hợp + giá luôn 🙌`,
    quick_replies: [
      { title: '👥 2 người', payload: 'guests_2' },
      { title: '👨‍👩‍👧 3-4 người', payload: 'guests_3_4' },
      { title: '👨‍👩‍👧‍👦 5+ người', payload: 'guests_5plus' },
    ],
    confidence: 0.9,
  },

  /* ═══════════════════════════════════════════════════════════
     DECISION (3) — khách sắp chốt
     ═══════════════════════════════════════════════════════════ */

  {
    id: 'comparison_help',
    category: 'decision',
    description: 'Khách phân vân giữa 2-3 option',
    trigger_conditions: { keywords_any: ['cái nào', 'chọn', 'so sánh', 'phân vân', 'khác nhau'] },
    content: `Dạ em so sánh giúp ạ 🔍

{{#hasOptions}}{{optionsComparison}}{{/hasOptions}}
{{^hasOptions}}Anh/chị đang phân vân giữa những chỗ nào ạ? Gửi em tên/link để em so sánh giá, vị trí, tiện nghi giúp 🙌{{/hasOptions}}

Theo em, chọn chỗ dựa vào:
  1. **Vị trí** — gần điểm anh/chị cần tới nhất
  2. **Giá** — phù hợp budget
  3. **Tiện nghi** — phù hợp nhu cầu (có bếp / view / yên tĩnh)

Anh/chị ưu tiên tiêu chí nào nhất ạ?`,
    confidence: 0.85,
  },

  {
    id: 'confirm_booking_summary',
    category: 'decision',
    description: 'Tóm tắt booking trước khi xin SĐT',
    trigger_conditions: { intent: 'booking', slot_completeness_gte: 0.8 },
    content: `📋 Em tóm tắt đơn ạ:

{{#hotelName}}• **Chỗ ở**: {{hotelName}}
{{/hotelName}}{{#district}}• **Khu vực**: {{district}}
{{/district}}{{#checkinDate}}• **Check-in**: {{checkinDate}} — {{nights}} đêm
{{/checkinDate}}{{#guests}}• **Khách**: {{guests}}
{{/guests}}{{#priceFrom}}• **Giá**: {{priceFrom}}
{{/priceFrom}}
Đúng ý anh/chị chưa ạ? Em xin **SĐT** để nhân viên xác nhận trong 15 phút nhé 🙌`,
    quick_replies: [
      { title: '✅ Đúng, xin SĐT', payload: 'confirm_yes' },
      { title: '✏️ Đổi lại', payload: 'confirm_edit' },
    ],
    confidence: 0.9,
  },

  {
    id: 'deposit_sent',
    category: 'decision',
    description: 'Khách đã gửi cọc / xác nhận đặt — cảm ơn + next steps',
    trigger_conditions: { keywords_any: ['đã chuyển', 'đã cọc', 'đã gửi', 'xong rồi'] },
    content: `Dạ em cảm ơn anh/chị đã tin tưởng Sonder 💚

**Next steps:**
  ✅ Em forward info cho nhân viên
  📧 Anh/chị sẽ nhận email xác nhận trong 15 phút
  📞 Nhân viên gọi confirm trong 30 phút
  🔑 Hướng dẫn check-in sẽ gửi qua Zalo 1 ngày trước

Nếu cần gấp: 📞 **${H}** (8h-22h)

Cảm ơn anh/chị, chúc kỳ nghỉ vui vẻ! 🌸`,
    confidence: 1.0,
  },

  /* ═══════════════════════════════════════════════════════════
     HANDOFF (3)
     ═══════════════════════════════════════════════════════════ */

  {
    id: 'offer_handoff_soft',
    category: 'handoff',
    description: 'Khi stuck 2 turn, đề nghị nhẹ nhàng',
    trigger_conditions: { stuck_turns_gte: 2 },
    content: `Dạ em thấy anh/chị cần tư vấn kỹ hơn ạ 🙏

Để đảm bảo chính xác nhất, em có thể:
  📞 Kết nối **ngay** với nhân viên qua hotline: **${H}**
  💬 Hoặc anh/chị để lại SĐT, nhân viên gọi lại trong 5 phút

Anh/chị chọn cách nào ạ?`,
    quick_replies: [
      { title: '📞 Gọi ngay', payload: 'handoff_now' },
      { title: '💬 Để SĐT', payload: 'handoff_callback' },
      { title: '↩️ Tiếp tục chat', payload: 'continue_bot' },
    ],
    confidence: 1.0,
  },

  {
    id: 'force_handoff_apology',
    category: 'handoff',
    description: 'Stuck 3 turn → xin lỗi + force handoff',
    trigger_conditions: { stuck_turns_gte: 3 },
    content: `Dạ em xin lỗi vì đã chưa hiểu rõ ý anh/chị ạ 🙏

Em kết nối nhân viên ngay để hỗ trợ nhanh nhất:
  📞 **${H}** (8h-22h hằng ngày)

{{#customerName}}Nhân viên sẽ gọi {{customerName}} trong 5 phút.{{/customerName}}{{^customerName}}Anh/chị có thể gọi hotline, hoặc để lại SĐT em báo nhân viên.{{/customerName}}

Em chuyển thông tin toàn bộ cuộc chat cho nhân viên rồi ạ 💚`,
    quick_replies: [
      { title: '📞 Gọi ngay', payload: 'handoff_now' },
      { title: '💬 Để SĐT', payload: 'handoff_callback' },
    ],
    confidence: 1.0,
  },

  {
    id: 'outside_scope_safety',
    category: 'handoff',
    description: 'Câu hỏi ngoài scope data (thú cưng 40kg, visa, xe đưa đón...) → safety',
    trigger_conditions: { confidence_lt: 0.4, rag_match_lt: 0.4 },
    content: `Dạ em xin lỗi, em chưa có thông tin chính xác về vấn đề này ạ 🙏

Để đảm bảo anh/chị nhận info ĐÚNG, em kết nối với lễ tân nhé:
  📞 **${H}** (8h-22h)

Nhân viên sẽ trả lời anh/chị trong vài phút thôi ạ 💚`,
    quick_replies: [
      { title: '📞 Gọi ngay', payload: 'handoff_now' },
      { title: '💬 Để SĐT', payload: 'handoff_callback' },
    ],
    confidence: 1.0,
  },

  /* ═══════════════════════════════════════════════════════════
     MISC (3)
     ═══════════════════════════════════════════════════════════ */

  {
    id: 'smalltalk_polite',
    category: 'misc',
    description: 'Khách thank / ok / cảm ơn — ack nhẹ',
    trigger_conditions: { intent: 'smalltalk' },
    content: `Dạ không có chi ạ 😊 Anh/chị còn cần em hỗ trợ gì nữa không?`,
    quick_replies: [
      { title: '🏨 Đặt phòng', payload: 'intent_booking' },
      { title: '👋 Tạm biệt', payload: 'intent_bye' },
    ],
    confidence: 1.0,
  },

  {
    id: 'friendly_goodbye',
    category: 'misc',
    description: 'Khách bye',
    trigger_conditions: { intent: 'bye' },
    content: `Dạ em cảm ơn anh/chị đã quan tâm Sonder ạ 💚

Lúc nào cần đặt phòng, anh/chị cứ inbox em hoặc gọi:
📞 **${H}**

Chúc anh/chị một ngày tốt lành! 🌸`,
    confidence: 1.0,
  },

  {
    id: 'after_hours_acknowledge',
    category: 'misc',
    description: 'Khách inbox sau 22h — báo giờ trực',
    trigger_conditions: { after_hours: true },
    content: `Dạ em chào anh/chị 🌙

Bên em làm việc **8h-22h** hằng ngày. Hiện tại đã ngoài giờ hành chính rồi ạ.

Em note tin nhắn, nhân viên sẽ phản hồi sớm nhất sáng mai.

Nếu gấp:
  📞 **${H}** (hotline trực đêm cho case khẩn cấp)
  💬 Anh/chị để lại: nhu cầu + SĐT, em chuyển ngay cho nhân viên`,
    quick_replies: [
      { title: '📞 Gọi hotline', payload: 'handoff_now' },
      { title: '💬 Để SĐT', payload: 'handoff_callback' },
    ],
    confidence: 1.0,
  },
];

/**
 * Seed all templates idempotently (chỉ insert nếu chưa có).
 *
 * Gọi lúc boot. Không override templates admin đã edit.
 */
export function seedTemplates(force: boolean = false): { inserted: number; skipped: number } {
  const now = Date.now();
  let inserted = 0;
  let skipped = 0;

  const existsStmt = db.prepare(`SELECT id FROM agentic_templates WHERE id = ?`);
  const insertStmt = db.prepare(`
    INSERT INTO agentic_templates
      (id, category, description, trigger_conditions, content, quick_replies, confidence, active, hotel_id, version, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1, 0, 1, ?, ?)
  `);
  const updateStmt = db.prepare(`
    UPDATE agentic_templates
    SET category = ?, description = ?, trigger_conditions = ?, content = ?, quick_replies = ?, confidence = ?, updated_at = ?, version = version + 1
    WHERE id = ?
  `);

  for (const t of DEFAULT_TEMPLATES) {
    const content = t.content.replace(/\{\{hotline\}\}/g, HOTLINE);
    const triggerJson = t.trigger_conditions ? JSON.stringify(t.trigger_conditions) : null;
    const qrJson = t.quick_replies ? JSON.stringify(t.quick_replies) : null;
    const conf = t.confidence ?? 0.9;

    const existing = existsStmt.get(t.id);
    if (existing && !force) {
      skipped++;
      continue;
    }
    if (existing && force) {
      updateStmt.run(t.category, t.description, triggerJson, content, qrJson, conf, now, t.id);
      inserted++;
    } else {
      insertStmt.run(t.id, t.category, t.description, triggerJson, content, qrJson, conf, now, now);
      inserted++;
    }
  }

  console.log(`[template-seeder] inserted=${inserted} skipped=${skipped} (force=${force})`);
  return { inserted, skipped };
}

/**
 * Auto-seed on boot. Chỉ chạy khi table empty HOẶC có template mới thêm trong code.
 */
export function autoSeedIfNeeded(): void {
  try {
    const row = db.prepare(`SELECT COUNT(*) as n FROM agentic_templates`).get() as any;
    const count = row?.n || 0;

    if (count === 0) {
      console.log('[template-seeder] empty table, seeding 25 defaults...');
      seedTemplates(false);
      return;
    }

    // Check: có template trong code mà DB chưa có?
    const existingIds = new Set(
      (db.prepare(`SELECT id FROM agentic_templates`).all() as any[]).map(r => r.id)
    );
    const missing = DEFAULT_TEMPLATES.filter(t => !existingIds.has(t.id));
    if (missing.length > 0) {
      console.log(`[template-seeder] ${missing.length} new template(s) in code, seeding...`);
      seedTemplates(false);
    }
  } catch (e: any) {
    console.warn('[template-seeder] auto-seed skip:', e?.message);
  }
}

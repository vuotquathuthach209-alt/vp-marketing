/**
 * Template Library — v27 Agentic Bot
 *
 * PRIMARY: Load templates từ DB (agentic_templates table) qua template-engine.
 * FALLBACK: 15 hardcoded templates (nếu DB empty / error).
 *
 * Admin có thể edit content live qua admin UI. Cache 5 phút.
 *
 * Mỗi template:
 *   - Không dùng AI (cost = 0)
 *   - Đúng persona em/anh/chị
 *   - Có quick_replies phù hợp
 *   - Mustache-like vars: {{customerName}}, {{hotline}}, {{missingSlots}}...
 */

import { renderTemplateById, getTemplateById as getDbTemplate } from './template-engine';

export interface TemplateVars {
  hotelName?: string;
  hotline?: string;
  priceFrom?: string;
  district?: string;
  customerName?: string;
  customerTier?: string;
  isVip?: boolean;
  missingSlots?: string;
  turnNumber?: number;
  topic?: string;
  answerPreview?: string;
  checkinDate?: string;
  nights?: number | string;
  guests?: string;
  [key: string]: any;
}

export interface Template {
  id: string;
  description: string;
  content: (vars: TemplateVars) => string;
  quick_replies?: (vars: TemplateVars) => Array<{ title: string; payload: string }>;
  confidence: number;       // Template trả lời này CAO (0.9+)
}

const HOTLINE = '0348 644 833';

const TEMPLATES: Record<string, Template> = {
  /* ═══════════════════════════════════════════
     TURN 1: GREETING OPENING (khách mới)
     ═══════════════════════════════════════════ */

  greeting_opening: {
    id: 'greeting_opening',
    description: 'Turn 1 — giới thiệu bản thân + 3 options',
    content: () => `Dạ em chào anh/chị 👋

Em là trợ lý AI của SONDER — nền tảng hỗ trợ lưu trú trực tuyến tại TP.HCM.

Em có thể giúp anh/chị:
  1️⃣  Tư vấn đặt phòng (homestay/khách sạn/CHDV)
  2️⃣  Tìm thông tin khách sạn (giá, tiện nghi, vị trí)
  3️⃣  Kết nối nhân viên CSKH: 📞 ${HOTLINE}

Anh/chị cần em hỗ trợ gì ạ?`,
    quick_replies: () => [
      { title: '🏨 Đặt phòng', payload: 'intent_booking' },
      { title: '📋 Xem thông tin', payload: 'intent_info' },
      { title: '👤 Gặp nhân viên', payload: 'intent_handoff' },
    ],
    confidence: 1.0,
  },

  greeting_returning: {
    id: 'greeting_returning',
    description: 'Turn 1 — khách cũ, personalized',
    content: (v) => `Dạ em chào ${v.customerName || 'anh/chị'} ạ 💚

Em nhớ rồi, ${v.customerTier === 'vip' ? 'anh/chị là khách VIP của Sonder' : 'lần trước anh/chị đã đặt bên em'}. Lần này em hỗ trợ gì ạ?

  1️⃣  Đặt phòng (giống lần trước, hoặc tìm chỗ mới)
  2️⃣  Xem lịch sử booking / thông tin khác
  3️⃣  Nói chuyện với nhân viên: 📞 ${HOTLINE}`,
    quick_replies: () => [
      { title: '🏨 Đặt lại', payload: 'intent_rebook' },
      { title: '🔍 Tìm chỗ mới', payload: 'intent_booking' },
      { title: '📞 Gặp nhân viên', payload: 'intent_handoff' },
    ],
    confidence: 1.0,
  },

  /* ═══════════════════════════════════════════
     TURN 2-3: NEED DISCOVERY (batch question)
     ═══════════════════════════════════════════ */

  discover_short_stay: {
    id: 'discover_short_stay',
    description: 'Turn 2 — hỏi gộp thông tin short-term booking',
    content: () => `Dạ em tư vấn đặt phòng ngắn ngày ạ! Để tư vấn chính xác, anh/chị cho em xin 4 thông tin:

  📅 Ngày check-in + số đêm (VD: 25/5, 2 đêm)
  👥 Số khách (VD: 2 người lớn, 1 bé)
  💰 Budget dự kiến / đêm (VD: dưới 1tr)
  📍 Khu vực muốn ở (VD: gần sân bay, Q1)

Anh/chị có thể trả lời 1 câu đầy đủ, ví dụ:
"25/5 2 đêm 2 người 800k gần sân bay"

Hoặc trả lời từng phần cũng được, em lắng nghe ạ 😊`,
    quick_replies: () => [
      { title: '📅 Hôm nay', payload: 'dates_today' },
      { title: '📅 Cuối tuần', payload: 'dates_weekend' },
      { title: '📅 Tuần sau', payload: 'dates_nextweek' },
    ],
    confidence: 0.95,
  },

  discover_long_stay: {
    id: 'discover_long_stay',
    description: 'Turn 2 — hỏi gộp cho CHDV thuê tháng',
    content: () => `Dạ em tư vấn căn hộ thuê tháng (CHDV) ạ. Anh/chị cho em xin:

  📅 Ngày dọn vào (VD: đầu tháng sau)
  ⏱️  Thời gian thuê (VD: 3 tháng, 6 tháng)
  👥 Số người ở
  💰 Budget dự kiến / tháng (VD: 6-8tr)
  📍 Khu vực ưu tiên (Q1, Bình Thạnh, Tân Bình...)

Ví dụ: "đầu tháng 6, thuê 6 tháng, 2 người, 7tr/tháng, Tân Bình"`,
    quick_replies: () => [
      { title: '⏱ 3 tháng', payload: 'months_3' },
      { title: '⏱ 6 tháng', payload: 'months_6' },
      { title: '⏱ 1 năm+', payload: 'months_12' },
    ],
    confidence: 0.95,
  },

  discover_clarify_intent: {
    id: 'discover_clarify_intent',
    description: 'Turn 2 — khách intent mơ hồ, hỏi lại',
    content: () => `Dạ em muốn tư vấn cho anh/chị chính xác nhất ạ. Anh/chị cho em biết nhu cầu chính:

  🏨 Thuê NGẮN ngày (1-14 đêm)
  🏢 Thuê DÀI tháng (1+ tháng, CHDV)
  📋 Chỉ cần tìm thông tin (giá, vị trí...)
  👤 Nói chuyện với nhân viên Sonder

Anh/chị chọn giúp em nhé 🙌`,
    quick_replies: () => [
      { title: '🏨 Thuê đêm', payload: 'mode_short_term' },
      { title: '🏢 Thuê tháng', payload: 'mode_long_term' },
      { title: '📋 Tìm info', payload: 'intent_info' },
      { title: '👤 Nhân viên', payload: 'intent_handoff' },
    ],
    confidence: 0.9,
  },

  /* ═══════════════════════════════════════════
     INFO QUERIES (answer từ RAG hoặc structured)
     ═══════════════════════════════════════════ */

  info_price_range: {
    id: 'info_price_range',
    description: 'Price overview across all hotels',
    content: (v) => `Dạ em cập nhật giá phòng Sonder ạ 💰

  🏨 Khách sạn: từ **450k/đêm** (weekday)
  🏡 Homestay: từ **550k/đêm**
  🏢 Căn hộ dịch vụ (CHDV) thuê tháng: từ **3.6tr/tháng**

Giá cuối tuần cộng 20%. Ở 3+ đêm giảm 5%. Cancel trước 48h hoàn 100% ạ.

Anh/chị ở mấy đêm + mấy người + khu vực nào, em báo giá chính xác nhé 🙌`,
    quick_replies: () => [
      { title: '🏨 Đặt phòng', payload: 'intent_booking' },
      { title: '📍 Xem vị trí', payload: 'intent_location' },
    ],
    confidence: 1.0,
  },

  info_location_overview: {
    id: 'info_location_overview',
    description: 'Location map cho khách muốn biết Sonder ở đâu',
    content: () => `Dạ Sonder có các chỗ ở tại TP.HCM ạ 📍

  ✈️ Gần sân bay TSN (Tân Bình)
  🏙️ Trung tâm Q1 (gần Bùi Viện, chợ Bến Thành)
  🌳 Khu Bình Thạnh (yên tĩnh, gần cầu Sài Gòn)

Mỗi chỗ có phòng đa dạng: từ studio đến 2PN gia đình.
Anh/chị muốn em gợi ý chỗ cụ thể nào ạ?`,
    quick_replies: () => [
      { title: '✈️ Sân bay', payload: 'area_airport' },
      { title: '🏙️ Q1', payload: 'area_q1' },
      { title: '🌳 Bình Thạnh', payload: 'area_binhthanh' },
    ],
    confidence: 1.0,
  },

  /* ═══════════════════════════════════════════
     HANDOFF / SAFETY (zero AI risk)
     ═══════════════════════════════════════════ */

  handoff_offer: {
    id: 'handoff_offer',
    description: 'Đề nghị chuyển sang nhân viên sau 2-3 turns stuck',
    content: () => `Dạ em thấy anh/chị cần tư vấn kỹ hơn ạ 🙏

Để đảm bảo chính xác nhất, em có thể:
  📞 Kết nối ngay với nhân viên CSKH qua hotline: **${HOTLINE}**
  💬 Hoặc anh/chị để lại SĐT, nhân viên gọi lại trong 5 phút

Anh/chị chọn cách nào ạ?`,
    quick_replies: () => [
      { title: '📞 Gọi ngay', payload: 'handoff_now' },
      { title: '💬 Để SĐT', payload: 'handoff_callback' },
      { title: '↩️ Tiếp tục chat bot', payload: 'continue_bot' },
    ],
    confidence: 1.0,
  },

  handoff_execute: {
    id: 'handoff_execute',
    description: 'Thực hiện handoff — notify Telegram staff',
    content: (v) => `Dạ em đã báo nhân viên bên em rồi ạ 🙏

📞 Hotline: **${HOTLINE}** (8h-22h hằng ngày)
${v.customerName ? `Nhân viên sẽ gọi ${v.customerName} trong 5 phút.` : 'Anh/chị có thể gọi hotline luôn hoặc đợi nhân viên liên hệ.'}

Cảm ơn anh/chị đã tin tưởng Sonder! 💚`,
    confidence: 1.0,
  },

  safety_unknown: {
    id: 'safety_unknown',
    description: 'Hallucination guard — không có data, handoff',
    content: () => `Dạ em xin lỗi, em chưa có thông tin chính xác về vấn đề này ạ 🙏

Để đảm bảo anh/chị nhận info đúng, em kết nối với lễ tân nhé:
  📞 **${HOTLINE}** (8h-22h)

Nhân viên sẽ trả lời anh/chị trong vài phút thôi ạ.`,
    confidence: 1.0,
  },

  /* ═══════════════════════════════════════════
     BOOKING FLOW (sau khi đủ slot)
     ═══════════════════════════════════════════ */

  ack_slots_partial: {
    id: 'ack_slots_partial',
    description: 'Acknowledge slots filled + ask missing',
    content: (v) => `Dạ em note ${v.missingSlots ? 'một số thông tin rồi' : ''} ạ 👍

${v.missingSlots ? `Anh/chị cho em xin thêm: ${v.missingSlots}` : 'Để em check phòng trống ngay.'}

${v.missingSlots ? 'Anh/chị trả lời 1 câu gọn là được ạ 😊' : ''}`,
    confidence: 0.95,
  },

  booking_confirm_summary: {
    id: 'booking_confirm_summary',
    description: 'Tóm tắt booking trước khi xin SĐT',
    content: (v) => `📋 Em tóm tắt đơn ạ:

${v.hotelName ? `• Chỗ ở: **${v.hotelName}**` : ''}
${v.district ? `• Khu vực: ${v.district}` : ''}
${v.priceFrom ? `• Giá: ${v.priceFrom}` : ''}

Đúng ý anh/chị chưa ạ? Em xin SĐT để nhân viên xác nhận trong 15 phút nhé 🙌`,
    quick_replies: () => [
      { title: '✅ Đúng, xin SĐT', payload: 'confirm_yes' },
      { title: '✏️ Đổi lại', payload: 'confirm_edit' },
    ],
    confidence: 0.9,
  },

  /* ═══════════════════════════════════════════
     MISC
     ═══════════════════════════════════════════ */

  smalltalk_acknowledge: {
    id: 'smalltalk_acknowledge',
    description: 'Simple ack khi khách nói thank/ok/cảm ơn',
    content: () => `Dạ không có chi ạ 😊 Anh/chị còn cần em hỗ trợ gì nữa không?`,
    quick_replies: () => [
      { title: '🏨 Đặt phòng', payload: 'intent_booking' },
      { title: '👋 Tạm biệt', payload: 'intent_bye' },
    ],
    confidence: 1.0,
  },

  bye_friendly: {
    id: 'bye_friendly',
    description: 'Khách say bye',
    content: () => `Dạ em cảm ơn anh/chị đã quan tâm Sonder ạ 💚

Lúc nào cần đặt phòng, anh/chị cứ inbox em hoặc gọi hotline nhé:
📞 ${HOTLINE}

Chúc anh/chị một ngày tốt lành! 🌸`,
    confidence: 1.0,
  },
};

/**
 * Template ID alias map — Seeder dùng ID khác (first_contact_warm) nhưng legacy code
 * gọi 'greeting_opening'. Map để không break orchestrator / safety-guard.
 */
const ID_ALIASES: Record<string, string> = {
  greeting_opening: 'first_contact_warm',
  greeting_returning: 'returning_customer_greet',
  discover_short_stay: 'discover_short_stay_batch',
  discover_long_stay: 'discover_long_stay_batch',
  discover_clarify_intent: 'first_vague',
  info_price_range: 'price_overview',
  info_location_overview: 'location_inquiry',
  handoff_offer: 'offer_handoff_soft',
  handoff_execute: 'force_handoff_apology',
  safety_unknown: 'outside_scope_safety',
  ack_slots_partial: 'partial_info_gentle',
  booking_confirm_summary: 'confirm_booking_summary',
  smalltalk_acknowledge: 'smalltalk_polite',
  bye_friendly: 'friendly_goodbye',
};

/**
 * Get template by ID (DB first, then hardcoded fallback).
 */
export function getTemplate(id: string): Template | null {
  // Try DB via alias OR direct id
  const dbId = ID_ALIASES[id] || id;
  try {
    const dbTemplate = getDbTemplate(dbId);
    if (dbTemplate) {
      return {
        id: dbTemplate.id,
        description: dbTemplate.description,
        content: (vars: TemplateVars) => {
          const rendered = renderTemplateById(dbId, vars as any);
          return rendered?.content || '';
        },
        quick_replies: dbTemplate.quick_replies
          ? () => dbTemplate.quick_replies!
          : undefined,
        confidence: dbTemplate.confidence,
      };
    }
  } catch {}

  // Fallback: hardcoded
  return TEMPLATES[id] || null;
}

/**
 * Render template với variables.
 * DB-first: thử load từ agentic_templates, fallback hardcoded nếu không có.
 */
export function renderTemplate(
  id: string,
  vars: TemplateVars = {},
): { content: string; quick_replies?: Array<{ title: string; payload: string }>; confidence: number } | null {
  // Try DB (with alias resolution)
  const dbId = ID_ALIASES[id] || id;
  try {
    const r = renderTemplateById(dbId, vars as any);
    if (r) {
      return {
        content: r.content,
        quick_replies: r.quick_replies,
        confidence: r.confidence,
      };
    }
  } catch (e: any) {
    console.warn('[template-library] DB render fail for', id, ':', e?.message);
  }

  // Fallback: hardcoded
  const t = TEMPLATES[id];
  if (!t) return null;
  return {
    content: t.content(vars),
    quick_replies: t.quick_replies ? t.quick_replies(vars) : undefined,
    confidence: t.confidence,
  };
}

/**
 * List all templates (for admin UI).
 * DB first (active only), fallback hardcoded nếu DB empty.
 */
export function listTemplates(): Array<{ id: string; description: string }> {
  try {
    const { loadTemplates } = require('./template-engine');
    const dbList = loadTemplates() as Array<{ id: string; description: string }>;
    if (dbList.length > 0) {
      return dbList.map(t => ({ id: t.id, description: t.description }));
    }
  } catch {}
  return Object.values(TEMPLATES).map(t => ({
    id: t.id,
    description: t.description,
  }));
}

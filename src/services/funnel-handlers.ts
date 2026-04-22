/**
 * Funnel Handlers — 1 handler per state của FSM.
 *
 * Mỗi handler nhận state + merged slots + user message → returns:
 *   { reply: string, next_stage: Stage, quick_replies?: QuickReply[], images?: Card[] }
 *
 * Logic chung:
 *   - Handler không side-effect vào DB (chỉ return intent). Main dispatcher
 *     save state sau khi handler return.
 *   - Empathy phrases random per reply (natural voice).
 *   - Quick replies: phù hợp FB (persistent menu) + Zalo (rich message list).
 */

import { db } from '../db';
import { ConversationState, Stage, BookingSlots, decideNextStage } from './conversation-fsm';
import { searchByArea, searchNearby } from './hotel-knowledge';

/* ═══════════════════════════════════════════
   Types
   ═══════════════════════════════════════════ */

export interface QuickReply {
  title: string;
  payload?: string;
}

export interface PropertyCard {
  property_id: number;
  name: string;
  subtitle?: string;
  image_url?: string;
  price_display?: string;
  buttons?: Array<{ title: string; type: 'postback' | 'url'; payload: string }>;
}

export interface HandlerResult {
  reply: string;
  next_stage: Stage;
  quick_replies?: QuickReply[];
  cards?: PropertyCard[];
  images?: string[];
  meta?: Record<string, any>;
}

/* ═══════════════════════════════════════════
   Empathy bank
   ═══════════════════════════════════════════ */

const EMPATHY = {
  acknowledge: ['Dạ em hiểu rồi ạ', 'Dạ được ạ', 'Ok ạ', 'Dạ em note nhé', 'Tuyệt vời', 'Oke ạ'],
  thinking: ['Em check nhanh ạ...', 'Để em xem ạ...', 'Em kiểm tra trong data ạ...'],
  confirm: ['Đúng rồi ạ', 'Chuẩn luôn', 'Dạ đúng ạ'],
  soft_decline: ['Rất tiếc là bên em chưa có ạ', 'Dạ hiện tại em chưa có chỗ match ạ'],
};

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

const PROP_LABEL: Record<string, string> = {
  hotel: 'Khách sạn',
  homestay: 'Homestay',
  villa: 'Villa',
  apartment: 'Căn hộ dịch vụ (CHDV)',
  resort: 'Resort',
  guesthouse: 'Guesthouse',
  hostel: 'Hostel',
};

const PROP_EMOJI: Record<string, string> = {
  hotel: '🏨',
  homestay: '🏡',
  villa: '🏖',
  apartment: '🏢',
  resort: '🌴',
  guesthouse: '🛏',
  hostel: '🎒',
};

/* ═══════════════════════════════════════════
   Helper — query network property types
   ═══════════════════════════════════════════ */

function getNetworkPropertyTypes(): Record<string, number> {
  const rows = db.prepare(`
    SELECT hp.property_type, COUNT(*) as n
    FROM hotel_profile hp
    WHERE EXISTS (SELECT 1 FROM mkt_hotels mh WHERE mh.ota_hotel_id = hp.hotel_id AND mh.status = 'active')
    GROUP BY hp.property_type
  `).all() as any[];
  const out: Record<string, number> = {};
  for (const r of rows) {
    if (r.property_type) out[r.property_type] = r.n;
  }
  return out;
}

function formatVND(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1) + 'tr';
  if (n >= 1_000) return (n / 1_000).toFixed(0) + 'k';
  return n.toLocaleString('vi-VN');
}

function formatVNDFull(n: number): string {
  return n.toLocaleString('vi-VN') + '₫';
}

/* ═══════════════════════════════════════════
   S2. PROPERTY_TYPE_ASK
   ═══════════════════════════════════════════ */

export function handlePropertyTypeAsk(state: ConversationState): HandlerResult {
  const types = getNetworkPropertyTypes();
  const entries = Object.entries(types).filter(([, n]) => n > 0);

  if (entries.length === 0) {
    return {
      reply: 'Em xin lỗi, hệ thống hiện đang cập nhật dữ liệu khách sạn. Anh/chị để lại SĐT, team em sẽ gọi tư vấn trực tiếp ạ.',
      next_stage: 'UNCLEAR_FALLBACK',
    };
  }

  const lines = entries.map(([type, n]) => {
    const label = PROP_LABEL[type] || type;
    const emoji = PROP_EMOJI[type] || '🏠';
    const desc = type === 'apartment' ? 'thuê dài, có bếp + máy giặt'
      : type === 'homestay' ? 'ấm cúng, giá tốt'
      : type === 'villa' ? 'rộng rãi, phù hợp nhóm/gia đình'
      : type === 'resort' ? 'nghỉ dưỡng, đầy đủ tiện nghi'
      : 'tiện nghi chuẩn';
    return `${emoji} **${label}** (${n} chỗ) — ${desc}`;
  });

  const quickReplies: QuickReply[] = entries.slice(0, 4).map(([type]) => ({
    title: `${PROP_EMOJI[type] || '🏠'} ${PROP_LABEL[type] || type}`,
    payload: `property_type_${type}`,
  }));

  return {
    reply: `Chào anh/chị! 👋 Em là trợ lý Sonder — nền tảng đặt phòng trực tuyến.\n\n` +
      `Anh/chị cần loại hình nào ạ?\n\n` +
      lines.join('\n') + `\n\n` +
      `Cho em biết loại hình + ngày check-in + số khách, em tư vấn chỗ phù hợp nhất ạ! 🙌`,
    next_stage: 'PROPERTY_TYPE_ASK',
    quick_replies: quickReplies,
  };
}

/* ═══════════════════════════════════════════
   S4. DATES_ASK (short-term)
   ═══════════════════════════════════════════ */

export function handleDatesAsk(state: ConversationState): HandlerResult {
  const typeLabel = PROP_LABEL[state.slots.property_type || 'hotel'] || 'chỗ ở';
  return {
    reply: `${pick(EMPATHY.acknowledge)}. Anh/chị dự định check-in ${typeLabel.toLowerCase()} ngày nào ạ?\n\n` +
      `Em gợi ý: "25/5", "tuần sau 3 đêm", "cuối tuần", "hôm nay"...`,
    next_stage: 'DATES_ASK',
    quick_replies: [
      { title: '📅 Hôm nay', payload: 'dates_today' },
      { title: '📅 Ngày mai', payload: 'dates_tomorrow' },
      { title: '📅 Cuối tuần', payload: 'dates_weekend' },
      { title: '📅 Tuần sau', payload: 'dates_nextweek' },
    ],
  };
}

/* ═══════════════════════════════════════════
   S5. MONTHS_ASK (long-term CHDV)
   ═══════════════════════════════════════════ */

export function handleMonthsAsk(state: ConversationState): HandlerResult {
  return {
    reply: `${pick(EMPATHY.acknowledge)}. Anh/chị dự kiến thuê CHDV bao nhiêu tháng ạ?`,
    next_stage: 'MONTHS_ASK',
    quick_replies: [
      { title: '1 tháng', payload: 'months_1' },
      { title: '3 tháng', payload: 'months_3' },
      { title: '6 tháng', payload: 'months_6' },
      { title: '1 năm+', payload: 'months_12' },
    ],
  };
}

/* ═══════════════════════════════════════════
   S6. CHDV_STARTDATE_ASK
   ═══════════════════════════════════════════ */

export function handleChdvStartDateAsk(state: ConversationState): HandlerResult {
  return {
    reply: `Anh/chị dự kiến dọn vào ngày nào ạ?`,
    next_stage: 'CHDV_STARTDATE_ASK',
    quick_replies: [
      { title: '📅 Tuần sau', payload: 'start_nextweek' },
      { title: '📅 Đầu tháng sau', payload: 'start_next_month' },
      { title: '📅 Cuối tháng sau', payload: 'start_end_next_month' },
      { title: '💬 Khác (tự nhập)', payload: 'start_custom' },
    ],
  };
}

/* ═══════════════════════════════════════════
   S7. GUESTS_ASK
   ═══════════════════════════════════════════ */

export function handleGuestsAsk(state: ConversationState): HandlerResult {
  const isLong = state.slots.rental_mode === 'long_term';
  const reply = isLong
    ? `Mấy người sẽ sinh hoạt ở CHDV ạ?`
    : `Mấy khách anh/chị ơi? (người lớn + trẻ em)`;

  return {
    reply,
    next_stage: 'GUESTS_ASK',
    quick_replies: [
      { title: '1 khách', payload: 'guests_1' },
      { title: '2 khách', payload: 'guests_2' },
      { title: '3 khách', payload: 'guests_3' },
      { title: '4+ khách', payload: 'guests_4plus' },
    ],
  };
}

/* ═══════════════════════════════════════════
   S8. BUDGET_ASK
   ═══════════════════════════════════════════ */

export function handleBudgetAsk(state: ConversationState): HandlerResult {
  const isLong = state.slots.rental_mode === 'long_term';
  const isHourly = state.slots.rental_sub_mode === 'hourly';

  if (isHourly) {
    return {
      reply: `Mức giá dự tính tầm bao nhiêu/giờ ạ?`,
      next_stage: 'BUDGET_ASK',
      quick_replies: [
        { title: '< 200k/h', payload: 'budget_h_low' },
        { title: '200-400k/h', payload: 'budget_h_mid' },
        { title: '400k+/h', payload: 'budget_h_high' },
        { title: 'Giá nào cũng được', payload: 'budget_any' },
      ],
    };
  }

  if (isLong) {
    return {
      reply: `Mức giá dự tính tầm bao nhiêu/tháng ạ?`,
      next_stage: 'BUDGET_ASK',
      quick_replies: [
        { title: '< 5 triệu', payload: 'budget_m_low' },
        { title: '5-10 triệu', payload: 'budget_m_mid' },
        { title: '10-20 triệu', payload: 'budget_m_high' },
        { title: '20 triệu+', payload: 'budget_m_premium' },
      ],
    };
  }

  return {
    reply: `Mức giá dự tính tầm bao nhiêu/đêm ạ?`,
    next_stage: 'BUDGET_ASK',
    quick_replies: [
      { title: '< 500k', payload: 'budget_n_low' },
      { title: '500k-1tr', payload: 'budget_n_mid' },
      { title: '1-2tr', payload: 'budget_n_high' },
      { title: '2tr+', payload: 'budget_n_premium' },
    ],
  };
}

/* ═══════════════════════════════════════════
   S9. AREA_ASK
   ═══════════════════════════════════════════ */

export function handleAreaAsk(state: ConversationState): HandlerResult {
  const typeLabel = PROP_LABEL[state.slots.property_type || 'hotel'] || 'chỗ ở';
  return {
    reply: `Anh/chị muốn ở khu vực nào ạ?\nVd: Q1, Q3, sân bay TSN, Bình Thạnh, Tân Bình...`,
    next_stage: 'AREA_ASK',
    quick_replies: [
      { title: 'Q1 (trung tâm)', payload: 'area_q1' },
      { title: 'Sân bay TSN', payload: 'area_airport' },
      { title: 'Bình Thạnh', payload: 'area_binhthanh' },
      { title: 'Tân Bình', payload: 'area_tanbinh' },
      { title: 'Đâu cũng được', payload: 'area_any' },
    ],
  };
}

/* ═══════════════════════════════════════════
   S10. CHDV_EXTRAS_ASK (long-term)
   ═══════════════════════════════════════════ */

export function handleChdvExtrasAsk(state: ConversationState): HandlerResult {
  return {
    reply: `Anh/chị có yêu cầu gì thêm không ạ?\n\n` +
      `• 💧 Điện nước bao trọn\n` +
      `• 🍳 Bếp đầy đủ\n` +
      `• 🧺 Máy giặt riêng\n` +
      `• 🚗 Chỗ đậu xe`,
    next_stage: 'CHDV_EXTRAS_ASK',
    quick_replies: [
      { title: '✅ Có hết', payload: 'extras_all' },
      { title: 'Chỉ wifi + bếp', payload: 'extras_wifi_kitchen' },
      { title: 'Tự thỏa thuận', payload: 'extras_flexible' },
    ],
  };
}

/* ═══════════════════════════════════════════
   S11. SHOW_RESULTS
   ═══════════════════════════════════════════ */

export function handleShowResults(state: ConversationState): HandlerResult {
  const slots = state.slots;
  const isLong = slots.rental_mode === 'long_term';

  // Query matching properties
  let results = searchByArea({
    city: slots.city,
    district: slots.area_type === 'district' ? slots.area_normalized : undefined,
    property_type: slots.property_type,
    max_price: slots.budget_max,
    min_guests: slots.guests_adults,
    limit: 5,
  });

  // Fallback: nếu không có exact type, try all similar
  if (results.length === 0 && slots.property_type === 'hotel') {
    for (const alt of ['homestay', 'villa', 'guesthouse', 'resort']) {
      results = searchByArea({ city: slots.city, district: slots.area_type === 'district' ? slots.area_normalized : undefined, property_type: alt, max_price: slots.budget_max, min_guests: slots.guests_adults, limit: 5 });
      if (results.length) break;
    }
  }

  if (results.length === 0) {
    return {
      reply: `${pick(EMPATHY.soft_decline)} với các tiêu chí hiện tại 😔\n\n` +
        `Anh/chị có thể:\n` +
        `• Tăng ngân sách\n` +
        `• Đổi khu vực khác\n` +
        `• Xem tất cả options không filter\n\n` +
        `Hoặc để em gọi lại tư vấn trực tiếp ạ?`,
      next_stage: 'SHOW_RESULTS',
      quick_replies: [
        { title: '💰 Tăng budget', payload: 'adjust_budget' },
        { title: '📍 Đổi khu vực', payload: 'adjust_area' },
        { title: '📱 Để SĐT, em gọi', payload: 'ask_phone' },
      ],
    };
  }

  const rows = results.map((h, i) => {
    const propLabel = PROP_LABEL[h.property_type || 'hotel'] || 'Chỗ ở';
    const emoji = PROP_EMOJI[h.property_type || 'hotel'] || '🏠';
    const priceStr = h.min_price > 0
      ? isLong ? ` — từ ${formatVND(h.min_price)}/tháng` : ` — từ ${formatVND(h.min_price)}/đêm`
      : '';
    const stars = h.star_rating ? ' ' + '⭐'.repeat(h.star_rating) : '';
    const loc = h.district ? ` (${h.district})` : '';
    const usp = h.usp_top3?.[0] ? ` — ${h.usp_top3[0]}` : '';
    return `${i + 1}. ${emoji} **${h.name}**${stars}${loc}${priceStr}${usp}`;
  });

  const cards: PropertyCard[] = results.map(h => ({
    property_id: h.hotel_id,
    name: h.name,
    subtitle: `${h.district || ''}${h.min_price ? ' · ' + formatVND(h.min_price) + (isLong ? '/tháng' : '/đêm') : ''}`,
    price_display: h.min_price ? formatVNDFull(h.min_price) : '',
    buttons: [
      { title: 'Chọn', type: 'postback', payload: `pick_property_${h.hotel_id}` },
    ],
  }));

  state.slots.shown_property_ids = results.map(h => h.hotel_id);

  return {
    reply: `Dạ bên em có ${results.length} lựa chọn phù hợp ạ:\n\n${rows.join('\n\n')}\n\n` +
      `Anh/chị thấy hợp với option nào thì em tư vấn kỹ hơn nhé ạ 😊`,
    next_stage: 'SHOW_RESULTS',
    cards,
    quick_replies: results.slice(0, 4).map((_, i) => ({
      title: `Chọn ${i + 1}`,
      payload: `pick_property_${results[i].hotel_id}`,
    })),
  };
}

/* ═══════════════════════════════════════════
   S12. PROPERTY_PICKED
   ═══════════════════════════════════════════ */

export function handlePropertyPicked(state: ConversationState): HandlerResult {
  const propId = state.slots.selected_property_id;
  if (!propId) {
    return { reply: 'Anh/chị chọn chỗ nào ạ?', next_stage: 'SHOW_RESULTS' };
  }
  const hotel = db.prepare(`SELECT * FROM hotel_profile WHERE hotel_id = ?`).get(propId) as any;
  if (!hotel) {
    return { reply: 'Em không tìm thấy thông tin chỗ đó ạ 😔', next_stage: 'SHOW_RESULTS' };
  }

  const rooms = db.prepare(
    `SELECT id, display_name_vi, max_guests, price_weekday, price_hourly, bed_config
     FROM hotel_room_catalog WHERE hotel_id = ? ORDER BY price_weekday LIMIT 10`
  ).all(propId) as any[];

  const isLong = state.slots.rental_mode === 'long_term';
  const emoji = PROP_EMOJI[hotel.property_type || 'hotel'] || '🏨';
  const stars = hotel.star_rating ? ' ' + '⭐'.repeat(hotel.star_rating) : '';
  const addr = [hotel.district, hotel.city].filter(Boolean).join(', ');

  const roomLines = rooms.map(r => {
    const monthlyEst = r.price_weekday ? r.price_weekday * 30 : 0;
    const price = isLong
      ? (monthlyEst ? `~${formatVND(monthlyEst)}/tháng` : 'giá liên hệ')
      : (r.price_weekday ? `${formatVND(r.price_weekday)}/đêm` : 'giá liên hệ');
    return `🛏 ${r.display_name_vi} (${r.max_guests} khách${r.bed_config ? `, ${r.bed_config}` : ''}) — ${price}`;
  });

  return {
    reply: `Dạ ${emoji} **${hotel.name_canonical}**${stars}\n` +
      (addr ? `📍 ${addr}\n` : '') +
      (hotel.phone ? `📞 ${hotel.phone}\n` : '') +
      `\n**Các loại phòng:**\n${roomLines.join('\n') || '(đang cập nhật)'}\n\n` +
      `Anh/chị muốn xem ảnh + đặt loại nào ạ?`,
    next_stage: 'PROPERTY_PICKED',
    quick_replies: rooms.slice(0, 4).map(r => ({
      title: r.display_name_vi.slice(0, 20),
      payload: `pick_room_${r.id}`,
    })),
  };
}

/* ═══════════════════════════════════════════
   S13. SHOW_ROOMS
   ═══════════════════════════════════════════ */

export function handleShowRooms(state: ConversationState): HandlerResult {
  const roomId = state.slots.selected_room_id;
  if (!roomId) {
    return { reply: 'Anh/chị chọn loại phòng nào ạ?', next_stage: 'PROPERTY_PICKED' };
  }
  const room = db.prepare(`SELECT * FROM hotel_room_catalog WHERE id = ?`).get(roomId) as any;
  if (!room) return { reply: 'Không tìm thấy phòng ạ', next_stage: 'PROPERTY_PICKED' };

  const images = db.prepare(
    `SELECT image_url FROM room_images WHERE hotel_id = ? AND room_type_name = ? AND active = 1 ORDER BY display_order LIMIT 5`
  ).all(room.hotel_id, room.display_name_vi) as any[];

  return {
    reply: `📸 **${room.display_name_vi}**\n` +
      (room.bed_config ? `🛏 ${room.bed_config}\n` : '') +
      (room.max_guests ? `👥 ${room.max_guests} khách\n` : '') +
      (room.size_m2 ? `📐 ${room.size_m2}m²\n` : '') +
      `\nAnh/chị muốn đặt phòng này luôn không ạ?`,
    next_stage: 'SHOW_ROOMS',
    images: images.map(i => i.image_url).filter(Boolean),
    quick_replies: [
      { title: '📞 Đặt ngay', payload: 'confirm_book' },
      { title: '❓ Hỏi thêm', payload: 'ask_more' },
      { title: '🔍 Xem chỗ khác', payload: 'back_results' },
    ],
  };
}

/* ═══════════════════════════════════════════
   S14. CONFIRMATION_BEFORE_CLOSE
   ═══════════════════════════════════════════ */

export function handleConfirmationBeforeClose(state: ConversationState): HandlerResult {
  const s = state.slots;
  const hotel = s.selected_property_id
    ? db.prepare(`SELECT name_canonical, district, city, phone FROM hotel_profile WHERE hotel_id = ?`).get(s.selected_property_id) as any
    : null;
  const room = s.selected_room_id
    ? db.prepare(`SELECT display_name_vi, price_weekday FROM hotel_room_catalog WHERE id = ?`).get(s.selected_room_id) as any
    : null;

  const isLong = s.rental_mode === 'long_term';
  const price = isLong
    ? (room?.price_weekday ? room.price_weekday * 30 : s.budget_max || 0)
    : room?.price_weekday || s.budget_max || 0;
  const qty = isLong ? (s.months || 1) : (s.nights || 1);
  const total = price * qty;
  const unit = isLong ? 'tháng' : 'đêm';

  const summary = [
    `📋 **Em tóm tắt đơn đặt:**`,
    hotel ? `• Chỗ ở: ${PROP_EMOJI[hotel.property_type || 'hotel'] || '🏨'} ${hotel.name_canonical}` : null,
    hotel?.district ? `• 📍 ${hotel.district}, ${hotel.city}` : null,
    room ? `• Loại phòng: ${room.display_name_vi}` : null,
    s.checkin_date ? `• Check-in: ${s.checkin_date}${s.checkout_date ? ` → ${s.checkout_date}` : ''}${s.nights ? ` (${s.nights} đêm)` : ''}` : null,
    isLong && s.months ? `• Thuê: ${s.months} tháng` : null,
    s.guests_adults ? `• Khách: ${s.guests_adults}${s.guests_children ? ` + ${s.guests_children} bé` : ''}` : null,
    price > 0 ? `• Giá: ${formatVNDFull(price)}/${unit}` : null,
    total > 0 && qty > 1 ? `• **Tổng tạm: ${formatVNDFull(total)}**` : null,
  ].filter(Boolean).join('\n');

  return {
    reply: summary + `\n\nĐúng ý anh/chị chưa ạ? Em xin SĐT để team xác nhận trong 15 phút nhé 🙌`,
    next_stage: 'CONFIRMATION_BEFORE_CLOSE',
    quick_replies: [
      { title: '✅ Đúng, xin SĐT', payload: 'confirm_yes' },
      { title: '✏️ Đổi lại', payload: 'confirm_edit' },
    ],
  };
}

/* ═══════════════════════════════════════════
   S15. CLOSING_CONTACT
   ═══════════════════════════════════════════ */

export function handleClosingContact(state: ConversationState): HandlerResult {
  const hasName = !!state.slots.name;
  const hasPhone = !!state.slots.phone;

  if (hasName && hasPhone) {
    return { reply: '', next_stage: 'BOOKING_DRAFT_CREATED' }; // will be handled by S16
  }

  const ask: string[] = [];
  if (!hasName) ask.push('• Họ tên anh/chị:');
  if (!hasPhone) ask.push('• SĐT:');

  return {
    reply: `Dạ em xin thông tin để chốt ạ:\n\n${ask.join('\n')}\n\n📞 Team em gọi xác nhận + gửi link thanh toán trong 15 phút!`,
    next_stage: 'CLOSING_CONTACT',
  };
}

/* ═══════════════════════════════════════════
   S16. BOOKING_DRAFT_CREATED (handled separately — tạo pending_booking + notify)
   ═══════════════════════════════════════════ */

export function handleBookingDraftCreated(state: ConversationState): HandlerResult {
  const s = state.slots;
  const hotel = s.selected_property_id
    ? db.prepare(`SELECT name_canonical FROM hotel_profile WHERE hotel_id = ?`).get(s.selected_property_id) as any
    : null;
  const room = s.selected_room_id
    ? db.prepare(`SELECT display_name_vi FROM hotel_room_catalog WHERE id = ?`).get(s.selected_room_id) as any
    : null;

  const summary = [
    `✅ Em đã gửi thông tin cho team:`,
    '',
    `• Tên: ${s.name || '(chưa rõ)'}`,
    `• SĐT: ${s.phone || '(chưa rõ)'}`,
    hotel ? `• Chỗ ở: ${hotel.name_canonical}` : null,
    room ? `• Phòng: ${room.display_name_vi}` : null,
    s.checkin_date ? `• Ngày: ${s.checkin_date}${s.checkout_date ? ' → ' + s.checkout_date : ''}${s.nights ? ` (${s.nights} đêm)` : ''}` : null,
    s.months ? `• Thuê ${s.months} tháng` : null,
    s.guests_adults ? `• ${s.guests_adults} khách` : null,
    '',
    `📞 Team em sẽ gọi xác nhận trong 15 phút ạ. Cảm ơn anh/chị! 🙏`,
  ].filter(Boolean).join('\n');

  return {
    reply: summary,
    next_stage: 'BOOKING_DRAFT_CREATED',
  };
}

/* ═══════════════════════════════════════════
   S17. UNCLEAR_FALLBACK
   ═══════════════════════════════════════════ */

export function handleUnclearFallback(state: ConversationState): HandlerResult {
  return {
    reply: `Em xin lỗi chưa nắm rõ nhu cầu ạ 😅\n\n` +
      `Anh/chị có thể:\n` +
      `• 📱 Để lại SĐT → team em gọi tư vấn trong 15 phút\n` +
      `• 📞 Gọi hotline: 0348 644 833\n\n` +
      `Hoặc nhắn em lại nhé, em cố gắng hiểu hơn 🙏`,
    next_stage: 'UNCLEAR_FALLBACK',
    quick_replies: [
      { title: '📱 Để SĐT', payload: 'give_phone' },
      { title: '📞 Gọi hotline', payload: 'call_hotline' },
    ],
  };
}

/* ═══════════════════════════════════════════
   Main dispatcher
   ═══════════════════════════════════════════ */

export function dispatchHandler(state: ConversationState): HandlerResult {
  switch (state.stage) {
    case 'INIT':
    case 'PROPERTY_TYPE_ASK':
      return handlePropertyTypeAsk(state);
    case 'DATES_ASK':
      return handleDatesAsk(state);
    case 'MONTHS_ASK':
      return handleMonthsAsk(state);
    case 'CHDV_STARTDATE_ASK':
      return handleChdvStartDateAsk(state);
    case 'GUESTS_ASK':
      return handleGuestsAsk(state);
    case 'BUDGET_ASK':
      return handleBudgetAsk(state);
    case 'AREA_ASK':
      return handleAreaAsk(state);
    case 'CHDV_EXTRAS_ASK':
      return handleChdvExtrasAsk(state);
    case 'SHOW_RESULTS':
      return handleShowResults(state);
    case 'PROPERTY_PICKED':
      return handlePropertyPicked(state);
    case 'SHOW_ROOMS':
      return handleShowRooms(state);
    case 'CONFIRMATION_BEFORE_CLOSE':
      return handleConfirmationBeforeClose(state);
    case 'CLOSING_CONTACT':
      return handleClosingContact(state);
    case 'BOOKING_DRAFT_CREATED':
      return handleBookingDraftCreated(state);
    case 'UNCLEAR_FALLBACK':
      return handleUnclearFallback(state);
    case 'HANDED_OFF':
      return { reply: '', next_stage: 'HANDED_OFF' };
    default:
      return handlePropertyTypeAsk(state);
  }
}

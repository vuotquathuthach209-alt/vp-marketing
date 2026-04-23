import { db, getSetting, setSetting } from '../db';

/**
 * Sprint 8 — Booking Confirmation Flow
 *
 * Manages conversation state for room bookings via Facebook Messenger.
 * States: collecting → quoting → awaiting_transfer → awaiting_confirm → confirmed/rejected
 */

// ---------- Types ----------

export interface BookingConfig {
  hotel_name: string;
  address: string;
  google_maps_link: string;
  hotline: string;
  checkin_time: string;
  checkout_time: string;
  directions: string;
  checkin_process: string;
  deposit_percent: number;
  cancellation_policy: string;
  bank_qr_image_id: number | null;
  room_types: Record<string, {
    name: string;
    price_weekday: number;
    price_weekend: number;
  }>;
}

export interface PendingBooking {
  id: number;
  fb_sender_id: string;
  fb_sender_name: string | null;
  room_type: string | null;
  checkin_date: string | null;
  checkout_date: string | null;
  nights: number;
  guests: number;
  total_price: number;
  deposit_amount: number;
  transfer_image_url: string | null;
  status: string;
  assigned_room: string | null;
  reject_reason: string | null;
  confirmed_at: number | null;
  created_at: number;
  updated_at: number;
}

// ---------- Default config ----------

const DEFAULT_CONFIG: BookingConfig = {
  hotel_name: 'Sonder Airport',
  address: 'B12 Đ. Bạch Đằng, Phường 2, Tân Bình, TP.HCM',
  google_maps_link: 'https://maps.google.com/?q=10.8152176,106.668148',
  hotline: '0986 260 595',
  checkin_time: '14:00',
  checkout_time: '12:00',
  directions: '',
  checkin_process: '',
  deposit_percent: 50,
  cancellation_policy: 'Huỷ trước 24h: mất 50% cọc. Huỷ trong 12h trước check-in: mất 100% cọc.',
  bank_qr_image_id: null,
  room_types: {
    standard: { name: 'Standard', price_weekday: 450000, price_weekend: 550000 },
    deluxe: { name: 'Deluxe', price_weekday: 650000, price_weekend: 750000 },
  },
};

// ---------- Config ----------

export function getBookingConfig(): BookingConfig {
  const raw = getSetting('booking_config');
  if (raw) {
    try {
      return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
    } catch {}
  }
  return { ...DEFAULT_CONFIG };
}

export function saveBookingConfig(cfg: Partial<BookingConfig>): BookingConfig {
  const current = getBookingConfig();
  const merged = { ...current, ...cfg };
  setSetting('booking_config', JSON.stringify(merged));
  return merged;
}

// ---------- Booking CRUD ----------

export function getOrCreateBooking(senderId: string, senderName?: string): PendingBooking {
  // Find active booking (not confirmed/rejected/cancelled)
  const active = db.prepare(
    `SELECT * FROM pending_bookings
     WHERE fb_sender_id = ? AND status NOT IN ('confirmed','rejected','cancelled')
     ORDER BY id DESC LIMIT 1`
  ).get(senderId) as PendingBooking | undefined;

  if (active) return active;

  const now = Date.now();
  const r = db.prepare(
    `INSERT INTO pending_bookings (fb_sender_id, fb_sender_name, status, created_at, updated_at)
     VALUES (?, ?, 'collecting', ?, ?)`
  ).run(senderId, senderName || null, now, now);

  return db.prepare(`SELECT * FROM pending_bookings WHERE id = ?`).get(r.lastInsertRowid) as PendingBooking;
}

function updateBooking(id: number, fields: Record<string, unknown>) {
  const sets = Object.keys(fields).map((k) => `${k} = ?`).join(', ');
  const vals = Object.values(fields);
  db.prepare(`UPDATE pending_bookings SET ${sets}, updated_at = ? WHERE id = ?`).run(...vals, Date.now(), id);
}

export function getPendingBookings(hotelId?: number): PendingBooking[] {
  if (hotelId) {
    return db.prepare(
      `SELECT * FROM pending_bookings WHERE status NOT IN ('confirmed','rejected','cancelled') AND hotel_id = ? ORDER BY id DESC`
    ).all(hotelId) as PendingBooking[];
  }
  return db.prepare(
    `SELECT * FROM pending_bookings WHERE status NOT IN ('confirmed','rejected','cancelled') ORDER BY id DESC`
  ).all() as PendingBooking[];
}

export function getBookingById(id: number): PendingBooking | undefined {
  return db.prepare(`SELECT * FROM pending_bookings WHERE id = ?`).get(id) as PendingBooking | undefined;
}

// ---------- Date parsing ----------

function parseDate(text: string): string | null {
  // Match patterns like 20/4, 20-04, 20/04/2026, ngày 20, 20 tháng 4
  const m1 = text.match(/(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?/);
  if (m1) {
    const day = parseInt(m1[1], 10);
    const month = parseInt(m1[2], 10);
    const year = m1[3] ? (m1[3].length === 2 ? 2000 + parseInt(m1[3], 10) : parseInt(m1[3], 10)) : new Date().getFullYear();
    if (day >= 1 && day <= 31 && month >= 1 && month <= 12) {
      return `${String(day).padStart(2, '0')}/${String(month).padStart(2, '0')}/${year}`;
    }
  }
  const m2 = text.match(/ng[aà]y\s*(\d{1,2})/i);
  if (m2) {
    const day = parseInt(m2[1], 10);
    const now = new Date();
    return `${String(day).padStart(2, '0')}/${String(now.getMonth() + 1).padStart(2, '0')}/${now.getFullYear()}`;
  }
  const m3 = text.match(/(\d{1,2})\s*th[aá]ng\s*(\d{1,2})/i);
  if (m3) {
    const day = parseInt(m3[1], 10);
    const month = parseInt(m3[2], 10);
    const year = new Date().getFullYear();
    return `${String(day).padStart(2, '0')}/${String(month).padStart(2, '0')}/${year}`;
  }
  return null;
}

function parseDates(text: string): { checkin: string | null; checkout: string | null } {
  // Try to find two dates separated by →, -, đến, tới
  const twoDate = text.match(/(\d{1,2}[\/\-]\d{1,2}(?:[\/\-]\d{2,4})?)\s*(?:→|->|–|-|đến|tới)\s*(\d{1,2}[\/\-]\d{1,2}(?:[\/\-]\d{2,4})?)/);
  if (twoDate) {
    return { checkin: parseDate(twoDate[1]), checkout: parseDate(twoDate[2]) };
  }
  // Find all date-like patterns
  const allDates: string[] = [];
  const regex = /\d{1,2}[\/\-]\d{1,2}(?:[\/\-]\d{2,4})?/g;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(text)) !== null) {
    const d = parseDate(m[0]);
    if (d) allDates.push(d);
  }
  if (allDates.length >= 2) return { checkin: allDates[0], checkout: allDates[1] };
  if (allDates.length === 1) return { checkin: allDates[0], checkout: null };
  // Try single date patterns
  const single = parseDate(text);
  return { checkin: single, checkout: null };
}

function parseNights(text: string): number | null {
  const m = text.match(/(\d+)\s*(?:đêm|night|dem)/i);
  return m ? parseInt(m[1], 10) : null;
}

function parseGuests(text: string): number | null {
  const m = text.match(/(\d+)\s*(?:người|khách|guest|ng)/i);
  return m ? parseInt(m[1], 10) : null;
}

function parseRoomType(text: string, config: BookingConfig): string | null {
  const lower = text.toLowerCase();
  for (const [key, rt] of Object.entries(config.room_types)) {
    if (lower.includes(key) || lower.includes(rt.name.toLowerCase())) {
      return key;
    }
  }
  return null;
}

function dateToObj(dateStr: string): Date | null {
  // dateStr = DD/MM/YYYY
  const parts = dateStr.split('/');
  if (parts.length < 3) return null;
  return new Date(parseInt(parts[2], 10), parseInt(parts[1], 10) - 1, parseInt(parts[0], 10));
}

function isWeekend(d: Date): boolean {
  const dow = d.getDay();
  return dow === 0 || dow === 5 || dow === 6; // Fri, Sat, Sun
}

function calculatePrice(roomKey: string, checkin: string, nights: number, config: BookingConfig): number {
  const rt = config.room_types[roomKey];
  if (!rt) return 0;
  const d = dateToObj(checkin);
  if (!d) return rt.price_weekday * nights;
  let total = 0;
  for (let i = 0; i < nights; i++) {
    const day = new Date(d);
    day.setDate(day.getDate() + i);
    total += isWeekend(day) ? rt.price_weekend : rt.price_weekday;
  }
  return total;
}

function addDays(dateStr: string, days: number): string {
  const d = dateToObj(dateStr);
  if (!d) return dateStr;
  d.setDate(d.getDate() + days);
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
}

function diffDays(d1: string, d2: string): number {
  const a = dateToObj(d1);
  const b = dateToObj(d2);
  if (!a || !b) return 1;
  return Math.max(1, Math.round((b.getTime() - a.getTime()) / 86400000));
}

function formatPrice(n: number): string {
  return n.toLocaleString('vi-VN') + '₫';
}

// ---------- Process booking step ----------

// Tin nhắn KHÔNG phải booking info — cần để RAG/AI trả lời tự nhiên
// v24: FIX — tháo anchor $ để match "chào bạn" / "hi em" / "alo ơi"
//            (trước đây /^(chào)$/ chỉ match "chào" 1 từ, "chào bạn" skip → bot stuck)
const NON_BOOKING_PATTERNS: RegExp[] = [
  /\b(mắc|đắt|ma('|'|)c|dat)\s*(quá|thế|v[aậ]y)?\b/i,
  /\b(giảm giá|bớt|discount|khuyến mãi|voucher|sale|rẻ hơn)\b/i,
  /\b(ok|oke|uhm|um|ừ|ờ|vâng|dạ)\s*(thôi|đó|vậy|nhé|nha)?\s*$/i,
  // v24: greeting patterns — anchor ^ only, allow trailing words
  /^(alo|a lô|hello|hi|hey|chào|xin chào|hellu|hi c[aả]|chao)\b/i,
  // v24: standalone greeting with optional name/pronoun
  /^(chào|xin chào|hello|hi)\s+(bạn|em|anh|chị|mình|c[aả]|shop|ad|admin|ơi|ạ)?\s*$/i,
  /\b(còn phòng|hỏi|cho hỏi|xem|thôi không|không đặt nữa|để sau|tính sau|cảm ơn|c[aả]m ơn)\b/i,
  /\b(ở đâu|địa chỉ|đường|map|bản đồ|check.?in|checkout|giờ|mấy giờ|có (gì|chỗ|chi))\b/i,
  /\?$/, // kết thúc bằng dấu ?
];

// v24: PURE GREETING — nếu msg chỉ là chào (không kèm intent booking) → exit ngay
//      để FSM/funnel xử lý greeting đúng persona
const PURE_GREETING_PATTERN = /^(alo|a lô|hello|hi|hey|chào|xin chào|hellu|chao)\s*(bạn|em|anh|chị|mình|cả nhà|shop|ad|admin|ơi|ạ|nhé|nha)*\s*$/i;

function isPureGreeting(msg: string): boolean {
  const trimmed = (msg || '').trim();
  if (trimmed.length > 40) return false;   // too long → không phải greeting thuần
  return PURE_GREETING_PATTERN.test(trimmed);
}

function looksLikeBookingInfo(msg: string, config: BookingConfig): boolean {
  // Có ít nhất 1 trong: số (ngày/tháng), từ khóa phòng, đơn vị ngày đêm
  if (/\d{1,2}\s*[\/\-]\s*\d{1,2}/.test(msg)) return true;   // 20/4
  if (/\b(ngày|hôm|mai|kia|tuần sau|cuối tuần)\b/i.test(msg)) return true;
  if (/\b(\d+)\s*(đêm|ngày|night|đ[eê]m)\b/i.test(msg)) return true;
  if (/\b(\d+)\s*(khách|người|guest|ng)\b/i.test(msg)) return true;
  const roomType = parseRoomType(msg, config);
  if (roomType) return true;
  return false;
}

export function processBookingStep(senderId: string, message: string, senderName?: string): string | null {
  const config = getBookingConfig();
  const msg = message.trim();

  // v24 FIX: pure greeting → exit để FSM/funnel chào khách đúng persona
  //          (Tránh bug khách nhắn "chào bạn" → bot trả "Đã nhận ảnh chuyển khoản")
  if (isPureGreeting(msg)) {
    console.log(`[bookingflow] pure greeting from ${senderId} → skip legacy, hand over to FSM`);
    return null;
  }

  const booking = getOrCreateBooking(senderId, senderName);

  // v24 FIX: TTL check per-status — booking stuck quá lâu → reset để FSM handle
  const STALE_THRESHOLDS_MS: Record<string, number> = {
    collecting: 60 * 60_000,          // 1h
    quoting: 30 * 60_000,             // 30 min
    awaiting_transfer: 6 * 3600_000,  // 6h (user có thể bận đi ngân hàng)
    awaiting_confirm: 24 * 3600_000,  // 24h (lễ tân có time review)
  };
  const threshold = STALE_THRESHOLDS_MS[booking.status];
  if (threshold) {
    const age = Date.now() - (booking.updated_at || booking.created_at || 0);
    if (age > threshold) {
      console.log(`[bookingflow] booking #${booking.id} stale (${Math.round(age/60000)}min at ${booking.status}) → auto-cancel + handover FSM`);
      try {
        updateBooking(booking.id, { status: 'cancelled' });
      } catch {}
      return null;
    }
  }

  switch (booking.status) {
    case 'collecting': {
      // ───── ESCAPE HATCH ─────
      // Nếu tin nhắn không chứa booking info thực sự VÀ khớp pattern non-booking,
      // để RAG/AI xử lý tự nhiên thay vì lặp template.
      const isBookingLike = looksLikeBookingInfo(msg, config);
      const looksNonBooking = NON_BOOKING_PATTERNS.some(p => p.test(msg));
      if (!isBookingLike && looksNonBooking) {
        // Tạm hoãn booking flow — không xoá booking (để quay lại được),
        // nhưng return null để smartReply fallback sang RAG.
        return null;
      }

      // Parse info from message
      const dates = parseDates(msg);
      const nightsVal = parseNights(msg);
      const guestsVal = parseGuests(msg);
      const roomType = parseRoomType(msg, config);

      const updates: Record<string, unknown> = {};
      if (dates.checkin && !booking.checkin_date) updates.checkin_date = dates.checkin;
      if (dates.checkout && !booking.checkout_date) updates.checkout_date = dates.checkout;
      if (nightsVal && booking.nights <= 1) updates.nights = nightsVal;
      if (guestsVal && booking.guests <= 1) updates.guests = guestsVal;
      if (roomType && !booking.room_type) updates.room_type = roomType;

      // Merge
      const b = { ...booking, ...updates };

      // Calculate checkout from nights if not provided
      if (b.checkin_date && !b.checkout_date && (b.nights || nightsVal)) {
        const n = (nightsVal || b.nights || 1);
        updates.checkout_date = addDays(b.checkin_date as string, n);
        updates.nights = n;
        b.checkout_date = updates.checkout_date as string;
        b.nights = n;
      }
      // Calculate nights from two dates
      if (b.checkin_date && b.checkout_date && !nightsVal) {
        const n = diffDays(b.checkin_date, b.checkout_date);
        updates.nights = n;
        b.nights = n;
      }

      if (Object.keys(updates).length > 0) {
        updateBooking(booking.id, updates);
      }

      // Check if we have enough info to quote
      if (b.checkin_date && b.room_type) {
        const nights = b.nights || 1;
        const total = calculatePrice(b.room_type, b.checkin_date, nights, config);
        const deposit = Math.round(total * config.deposit_percent / 100);
        const rt = config.room_types[b.room_type];

        updateBooking(booking.id, {
          total_price: total,
          deposit_amount: deposit,
          nights,
          status: 'quoting',
        });

        // v6 Sprint 7: track booking_created funnel stage
        try {
          const { trackFunnelStage } = require('./conversion-tracker');
          trackFunnelStage({
            stage: 'booking_created',
            senderId: booking.fb_sender_id,
            hotelId: 1,
            bookingId: booking.id,
            revenue: total,
            deposit,
          });
        } catch {}

        // v6 Sprint 8: Smart Upsell — detect + format add-on suggestions
        let upsellLine = '';
        try {
          const { detectUpsells, formatUpsellLine } = require('./upsell-detector');
          const { classifyCustomer } = require('./customer-tier');
          const historyRows = db.prepare(
            `SELECT role, message FROM conversation_memory
             WHERE sender_id = ? ORDER BY id DESC LIMIT 10`
          ).all(booking.fb_sender_id) as any[];
          const history = historyRows.map(r => `${r.role}: ${r.message}`).reverse();
          const tierInfo = classifyCustomer({ senderId: booking.fb_sender_id, hotelId: 1 });
          const opps = detectUpsells({
            senderId: booking.fb_sender_id,
            history,
            nights,
            guests: b.guests,
            room_type: b.room_type || null,
            customer_tier: tierInfo?.tier,
            booking_total_vnd: total,
            hotelId: 1,
          });
          upsellLine = formatUpsellLine(opps);
          if (opps.length > 0) {
            console.log(`[upsell] booking #${booking.id}: ${opps.map((o: any) => o.kind).join(',')}`);
          }
        } catch {}

        return `📋 *BÁO GIÁ ĐẶT PHÒNG*\n\n` +
          `🏨 ${config.hotel_name}\n` +
          `📍 ${config.address}\n\n` +
          `🛏️ Phòng: ${rt?.name || b.room_type}\n` +
          `📅 Check-in: ${b.checkin_date} (${config.checkin_time})\n` +
          `📅 Check-out: ${b.checkout_date || addDays(b.checkin_date, nights)} (${config.checkout_time})\n` +
          `🌙 Số đêm: ${nights}\n` +
          `👥 Số khách: ${b.guests}\n\n` +
          `💰 Tổng: ${formatPrice(total)}\n` +
          `💳 Cọc ${config.deposit_percent}%: ${formatPrice(deposit)}\n\n` +
          `${config.cancellation_policy}\n\n` +
          `Bạn đồng ý đặt phòng? Nhắn "ok" hoặc "đặt" để xác nhận.` +
          upsellLine;
      }

      // Ask for missing info
      const missing: string[] = [];
      if (!b.checkin_date) missing.push('ngày check-in (VD: 20/4)');
      if (!b.room_type) {
        const types = Object.entries(config.room_types)
          .map(([k, v]) => `  • ${v.name}: ${formatPrice(v.price_weekday)}/đêm (cuối tuần ${formatPrice(v.price_weekend)})`)
          .join('\n');
        missing.push(`loại phòng:\n${types}`);
      }

      // v24: Persona fix
      return `🏨 Đặt phòng tại ${config.hotel_name}\n\n` +
        `Em cần thêm thông tin ạ:\n` +
        missing.map((m, i) => `${i + 1}. ${m}`).join('\n') +
        `\n\nAnh/chị nhắn ngày + loại phòng cho em nhé ạ!`;
    }

    case 'quoting': {
      // v24: Escape hatch — khách hỏi chuyện khác → FSM handle
      const looksNonBooking = NON_BOOKING_PATTERNS.some(p => p.test(msg));
      if (looksNonBooking) {
        return null;
      }

      const lower = msg.toLowerCase();
      if (/^(ok|đặt|book|chuyển|đồng ý|xác nhận|được|đặt phòng|yes|có)/.test(lower)) {
        updateBooking(booking.id, { status: 'awaiting_transfer' });

        // v24: Persona fix
        let bankInfo = `✅ Dạ cảm ơn anh/chị ạ! Để hoàn tất đặt phòng, anh/chị vui lòng chuyển khoản:\n\n` +
          `💳 Số tiền cọc: ${formatPrice(booking.deposit_amount)}\n` +
          `📝 Nội dung CK: SONDER ${booking.id}\n\n`;

        if (config.bank_qr_image_id) {
          bankInfo += `Em sẽ gửi mã QR ngân hàng. Sau khi chuyển khoản xong, anh/chị gửi ảnh chụp màn hình cho em nhé ạ!`;
        } else {
          bankInfo += `Sau khi chuyển khoản, anh/chị gửi ảnh chụp màn hình cho em nhé ạ! Hotline: ${config.hotline}`;
        }
        return bankInfo;
      }

      if (/^(không|cancel|huỷ|hủy|thôi|no)/.test(lower)) {
        updateBooking(booking.id, { status: 'cancelled' });
        return `Dạ em đã huỷ đặt phòng ạ. Nếu cần đặt lại, anh/chị nhắn "đặt phòng" bất kỳ lúc nào nhé ạ 😊`;
      }

      // v24: Persona fix
      return `Anh/chị đồng ý đặt phòng với giá ${formatPrice(booking.total_price)} (cọc ${formatPrice(booking.deposit_amount)}) không ạ?\n\n` +
        `Nhắn "ok" để xác nhận, hoặc "huỷ" để huỷ ạ.`;
    }

    case 'awaiting_transfer': {
      // v24 FIX: Escape hatch — nếu khách hỏi chuyện khác → cho RAG/FSM trả lời,
      //          không spam template "đang chờ ảnh chuyển khoản"
      const looksNonBooking = NON_BOOKING_PATTERNS.some(p => p.test(msg));
      if (looksNonBooking || !looksLikeBookingInfo(msg, config)) {
        return null;   // Fall through to FSM
      }
      // v24: Persona fix — "em/anh/chị" thay "Mình/bạn"
      return `⏳ Dạ em đang chờ ảnh chuyển khoản của anh/chị ạ.\n\n` +
        `💳 Cọc: ${formatPrice(booking.deposit_amount)}\n` +
        `📝 Nội dung CK: SONDER ${booking.id}\n\n` +
        `Chuyển xong anh/chị gửi ảnh cho em nhé ạ! Hotline: ${config.hotline}`;
    }

    case 'awaiting_confirm': {
      // v24 FIX: Escape hatch — khách hỏi chuyện khác → cho FSM handle
      const looksNonBooking = NON_BOOKING_PATTERNS.some(p => p.test(msg));
      if (looksNonBooking || !looksLikeBookingInfo(msg, config)) {
        return null;
      }
      // v24: Persona fix
      return `⏳ Dạ em đã nhận ảnh chuyển khoản rồi ạ! Lễ tân đang xác nhận booking #${booking.id}.\n` +
        `Em sẽ thông báo ngay khi xong. Cảm ơn anh/chị đã kiên nhẫn ạ 🙏`;
    }

    case 'confirmed': {
      // v24: Escape + persona
      const looksNonBooking = NON_BOOKING_PATTERNS.some(p => p.test(msg));
      if (looksNonBooking) return null;
      return `✅ Dạ booking #${booking.id} đã được xác nhận rồi ạ!\n\n` +
        `🛏️ Phòng: ${booking.assigned_room || booking.room_type}\n` +
        `📅 Check-in: ${booking.checkin_date} lúc ${config.checkin_time}\n` +
        `📍 ${config.address}\n` +
        `📱 Hotline: ${config.hotline}\n\n` +
        `Hẹn gặp anh/chị ạ 😊`;
    }

    case 'rejected': {
      // v24: Escape + persona
      const looksNonBooking = NON_BOOKING_PATTERNS.some(p => p.test(msg));
      if (looksNonBooking) return null;
      return `❌ Dạ booking #${booking.id} không được xác nhận ạ.\n` +
        (booking.reject_reason ? `Lý do: ${booking.reject_reason}\n` : '') +
        `\nAnh/chị vui lòng liên hệ hotline ${config.hotline} hoặc nhắn "đặt phòng" để thử lại ạ.`;
    }

    default:
      return `Nhắn "đặt phòng" để bắt đầu đặt phòng tại ${config.hotel_name} ạ! 🏨`;
  }
}

// ---------- Transfer image received ----------

export function markTransferReceived(senderId: string, imageUrl?: string): { booking: PendingBooking; reply: string } | null {
  const booking = db.prepare(
    `SELECT * FROM pending_bookings
     WHERE fb_sender_id = ? AND status = 'awaiting_transfer'
     ORDER BY id DESC LIMIT 1`
  ).get(senderId) as PendingBooking | undefined;

  if (!booking) return null;

  const updates: Record<string, unknown> = { status: 'awaiting_confirm' };
  if (imageUrl) updates.transfer_image_url = imageUrl;
  updateBooking(booking.id, updates);

  const updated = db.prepare(`SELECT * FROM pending_bookings WHERE id = ?`).get(booking.id) as PendingBooking;

  // v6 Sprint 7: track deposit funnel stage
  try {
    const { trackFunnelStage } = require('./conversion-tracker');
    trackFunnelStage({
      stage: 'deposit',
      senderId,
      hotelId: 1,
      bookingId: booking.id,
      revenue: booking.total_price,
      deposit: booking.deposit_amount,
    });
  } catch {}

  return {
    booking: updated,
    // v24: Persona fix
    reply: `✅ Dạ em đã nhận ảnh chuyển khoản rồi ạ! Lễ tân đang xác nhận booking #${booking.id}.\nEm sẽ thông báo ngay khi xong. Cảm ơn anh/chị ạ 🙏`,
  };
}

// ---------- Receptionist actions ----------

export function confirmBooking(bookingId: number, roomNumber: string): { reply: string; senderId: string } {
  const booking = getBookingById(bookingId);
  if (!booking) throw new Error(`Booking #${bookingId} không tồn tại`);
  if (booking.status === 'confirmed') throw new Error(`Booking #${bookingId} đã confirmed rồi`);

  const config = getBookingConfig();
  updateBooking(bookingId, {
    status: 'confirmed',
    assigned_room: roomNumber,
    confirmed_at: Date.now(),
  });

  // v6 Sprint 7: track confirmed funnel stage
  try {
    const { trackFunnelStage } = require('./conversion-tracker');
    trackFunnelStage({
      stage: 'confirmed',
      senderId: booking.fb_sender_id,
      hotelId: 1,
      bookingId,
      revenue: booking.total_price,
      deposit: booking.deposit_amount,
    });
  } catch {}

  const reply = `✅ Đặt phòng #${bookingId} đã được XÁC NHẬN!\n\n` +
    `🛏️ Phòng: ${roomNumber}\n` +
    `📅 Check-in: ${booking.checkin_date} lúc ${config.checkin_time}\n` +
    `📅 Check-out: ${booking.checkout_date} lúc ${config.checkout_time}\n` +
    `📍 ${config.hotel_name} — ${config.address}\n` +
    `📱 Hotline: ${config.hotline}\n` +
    (config.google_maps_link ? `🗺️ Bản đồ: ${config.google_maps_link}\n` : '') +
    `\nHẹn gặp bạn! 😊`;

  return { reply, senderId: booking.fb_sender_id };
}

export function rejectBooking(bookingId: number, reason?: string): { reply: string; senderId: string } {
  const booking = getBookingById(bookingId);
  if (!booking) throw new Error(`Booking #${bookingId} không tồn tại`);

  const config = getBookingConfig();
  updateBooking(bookingId, {
    status: 'rejected',
    reject_reason: reason || null,
  });

  const reply = `❌ Xin lỗi, đặt phòng #${bookingId} không thể xác nhận.\n` +
    (reason ? `Lý do: ${reason}\n` : '') +
    `\nVui lòng liên hệ hotline ${config.hotline} để được hỗ trợ. Xin lỗi vì sự bất tiện! 🙏`;

  return { reply, senderId: booking.fb_sender_id };
}

// ---------- Booking intent detection ----------

const BOOKING_KEYWORDS = [
  'đặt phòng', 'book', 'booking', 'muốn ở', 'còn phòng', 'đặt ngay',
  'muốn đặt', 'reserve', 'thuê phòng', 'cần phòng', 'đặt chỗ',
];

export function isBookingIntent(message: string): boolean {
  const lower = message.toLowerCase();
  return BOOKING_KEYWORDS.some((kw) => lower.includes(kw));
}

export function hasActiveBooking(senderId: string): boolean {
  // v24 FIX: Apply TTL at query level — stale bookings không được coi là active.
  //          Tránh bug "Chào bạn" sau 2h → bot trả "Đã nhận ảnh chuyển khoản" (state cũ).
  //
  //  Threshold per-status:
  //    collecting:         1h — chưa cọc, user quên nhanh
  //    quoting:           30min — user nói "ok" trong 30min nếu thực sự muốn
  //    awaiting_transfer:  6h — cho đi ngân hàng
  //    awaiting_confirm:  24h — cho lễ tân review
  const row = db.prepare(
    `SELECT id, status, updated_at, created_at FROM pending_bookings
     WHERE fb_sender_id = ? AND status NOT IN ('confirmed','rejected','cancelled','paused')
     ORDER BY id DESC LIMIT 1`
  ).get(senderId) as any;
  if (!row) return false;

  const STALE_MS: Record<string, number> = {
    collecting: 60 * 60_000,
    quoting: 30 * 60_000,
    awaiting_transfer: 6 * 3600_000,
    awaiting_confirm: 24 * 3600_000,
  };
  const threshold = STALE_MS[row.status];
  if (threshold) {
    const age = Date.now() - (row.updated_at || row.created_at || 0);
    if (age > threshold) {
      // Auto-cancel stale → khách sau này nhắn sẽ như booking mới
      try {
        db.prepare(`UPDATE pending_bookings SET status = 'cancelled', updated_at = ? WHERE id = ?`)
          .run(Date.now(), row.id);
      } catch {}
      return false;
    }
  }
  return true;
}

/**
 * Trả về booking hiện tại (kể cả paused) — dùng cho context của intent-router.
 * Không trigger flow.
 */
export function getActiveBookingInfo(senderId: string): { status: string; slots: Record<string, unknown> } | null {
  const row = db.prepare(
    `SELECT status, checkin_date, room_type, nights, guests FROM pending_bookings
     WHERE fb_sender_id = ? AND status NOT IN ('confirmed','rejected','cancelled')
     ORDER BY id DESC LIMIT 1`
  ).get(senderId) as any;
  if (!row) return null;
  return {
    status: row.status,
    slots: {
      date: row.checkin_date,
      room_type: row.room_type,
      nights: row.nights,
      guests: row.guests,
    },
  };
}

/**
 * Pause booking flow — user rẽ nhánh sang hỏi chuyện khác.
 * State được giữ, nhưng các lượt tiếp theo sẽ KHÔNG tự động vào FSM
 * trừ khi intent-router quyết định resume (is_continuation=true + slot mới).
 */
export function pauseBooking(senderId: string): void {
  db.prepare(
    `UPDATE pending_bookings SET status='paused', updated_at=?
     WHERE fb_sender_id=? AND status IN ('collecting','quoting')`
  ).run(Date.now(), senderId);
}

/**
 * Resume paused booking — khi user quay lại cung cấp booking info mới.
 */
export function resumeBooking(senderId: string): boolean {
  const r = db.prepare(
    `UPDATE pending_bookings SET status='collecting', updated_at=?
     WHERE fb_sender_id=? AND status='paused'`
  ).run(Date.now(), senderId);
  return r.changes > 0;
}

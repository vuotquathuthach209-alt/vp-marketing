/**
 * Smart Upsell Detector
 *
 * Khi booking đến stage "quoting" (đã có báo giá), phát hiện và gợi ý
 * add-on phù hợp dựa trên context của khách.
 *
 * Opportunities:
 *  - Early check-in (trước 14:00)
 *  - Late check-out (sau 12:00)
 *  - Breakfast buffet (nếu hotel có)
 *  - Airport shuttle (nếu khách có keyword "sân bay", "pickup")
 *  - Room upgrade (VIP tier hoặc booking dài ngày)
 *  - Extended stay (booking 1-2 đêm → gợi ý 3 đêm rẻ hơn)
 *
 * Output: { opportunities: [...], suggested_line: "..." }
 *   - Handler append vào reply trong bookingflow quoting stage
 *   - Không push quá nhiều — MAX 2 opportunities mỗi reply
 *
 * Dựa vào: booking (nights, guests, room_type), history (keywords), tier.
 */
import { db } from '../db';

export type UpsellKind =
  | 'early_checkin'
  | 'late_checkout'
  | 'breakfast'
  | 'airport_shuttle'
  | 'room_upgrade'
  | 'extended_stay';

export interface UpsellOpportunity {
  kind: UpsellKind;
  reason: string;         // vì sao đề xuất
  offer_line: string;     // câu gợi ý để bot nói (VN)
  expected_value_vnd: number;
}

interface UpsellContext {
  senderId?: string;
  pageId?: number;
  history: string[];      // last 6 messages
  nights: number;
  guests: number;
  room_type: string | null;
  customer_tier?: string; // 'new'|'returning'|'vip'|...
  booking_total_vnd: number;
}

// Keyword triggers
const AIRPORT_KEYWORDS = /(sân bay|airport|đón|pickup|xe đón|taxi)/i;
const EARLY_CHECKIN_KEYWORDS = /(sáng sớm|early|đến sớm|trước (12|13|14)h|bay (sáng|sớm))/i;
const LATE_CHECKOUT_KEYWORDS = /(trả phòng muộn|late check.?out|ở (thêm|muộn)|bay (chiều|tối))/i;
const BREAKFAST_KEYWORDS = /(ăn sáng|bữa sáng|breakfast|buffet)/i;

function historyMatches(history: string[], re: RegExp): boolean {
  return history.some(h => re.test(h));
}

/**
 * Check nếu khách sạn có breakfast/shuttle config
 */
function hotelHasAddon(hotelId: number, addon: 'breakfast' | 'shuttle'): boolean {
  try {
    const row = db.prepare(
      `SELECT value FROM settings WHERE key = ?`
    ).get(`hotel_${hotelId}_addon_${addon}`) as any;
    return row?.value === 'true' || row?.value === '1';
  } catch { return false; }
}

export function detectUpsells(ctx: UpsellContext & { hotelId: number }): UpsellOpportunity[] {
  const opps: UpsellOpportunity[] = [];
  const history = ctx.history || [];

  // 1. Airport shuttle — trigger khi khách đề cập sân bay
  if (historyMatches(history, AIRPORT_KEYWORDS) && hotelHasAddon(ctx.hotelId, 'shuttle')) {
    opps.push({
      kind: 'airport_shuttle',
      reason: 'khách đề cập đến sân bay',
      offer_line: 'Anh/chị có cần xe đón sân bay không ạ? Bên em có dịch vụ đưa đón, chỉ 200.000đ/chiều (tiết kiệm 30% so với Grab).',
      expected_value_vnd: 200000,
    });
  }

  // 2. Early check-in — trigger keyword hoặc booking 1 đêm
  if (historyMatches(history, EARLY_CHECKIN_KEYWORDS) || (ctx.nights === 1 && Math.random() < 0.5)) {
    opps.push({
      kind: 'early_checkin',
      reason: 'khách đề cập đến/cần nhận phòng sớm',
      offer_line: 'Nếu anh/chị cần check-in sớm trước 14h, bên em có option early check-in (phí 100k) — giúp nghỉ ngơi ngay sau chuyến bay ạ.',
      expected_value_vnd: 100000,
    });
  }

  // 3. Late check-out
  if (historyMatches(history, LATE_CHECKOUT_KEYWORDS)) {
    opps.push({
      kind: 'late_checkout',
      reason: 'khách đề cập trả phòng muộn',
      offer_line: 'Bên em có gói late check-out đến 15h (phụ thu 150k) — tiện anh/chị nghỉ ngơi trước khi bay ạ.',
      expected_value_vnd: 150000,
    });
  }

  // 4. Breakfast — khi hotel có + chưa ai đề cập
  if (hotelHasAddon(ctx.hotelId, 'breakfast') && !historyMatches(history, BREAKFAST_KEYWORDS)) {
    opps.push({
      kind: 'breakfast',
      reason: 'gợi ý add breakfast mặc định',
      offer_line: 'Anh/chị có muốn đặt thêm buffet sáng không ạ? 120.000đ/người, phục vụ 6h30–10h, gồm cà phê + bánh mì + phở + trái cây.',
      expected_value_vnd: 120000 * ctx.guests,
    });
  }

  // 5. Extended stay — nếu đặt 1-2 đêm, gợi ý 3 đêm
  if (ctx.nights === 1 || ctx.nights === 2) {
    opps.push({
      kind: 'extended_stay',
      reason: 'booking ngắn ngày, gợi ý ở lâu hơn',
      offer_line: `Nếu anh/chị ở thêm ${ctx.nights === 1 ? '1-2 đêm' : '1 đêm'}, bên em có thể giảm 10% tổng đơn ạ. Anh/chị có muốn cân nhắc không?`,
      expected_value_vnd: ctx.booking_total_vnd * 0.4,
    });
  }

  // 6. Room upgrade — VIP hoặc booking nhiều đêm
  if ((ctx.customer_tier === 'vip' || ctx.nights >= 3) && ctx.room_type === 'standard') {
    opps.push({
      kind: 'room_upgrade',
      reason: ctx.customer_tier === 'vip' ? 'VIP customer' : 'booking dài ngày',
      offer_line: ctx.customer_tier === 'vip'
        ? 'Cảm ơn anh/chị đã ủng hộ bên em! Em xin tặng upgrade lên phòng Deluxe miễn phí nếu còn trống lúc nhận phòng ạ 💎'
        : 'Vì anh/chị ở dài ngày, bên em có thể upgrade sang Deluxe với phụ thu chỉ 200k/đêm (thường 250k) — phòng rộng + view đẹp hơn ạ.',
      expected_value_vnd: ctx.customer_tier === 'vip' ? 0 : 200000 * ctx.nights,
    });
  }

  // Sắp xếp theo expected value và trả TOP 2
  opps.sort((a, b) => b.expected_value_vnd - a.expected_value_vnd);
  return opps.slice(0, 2);
}

/**
 * Format opportunities thành 1 đoạn text ngắn để append vào bot reply.
 */
export function formatUpsellLine(opps: UpsellOpportunity[]): string {
  if (opps.length === 0) return '';
  return '\n\n' + opps.map(o => `💡 ${o.offer_line}`).join('\n');
}

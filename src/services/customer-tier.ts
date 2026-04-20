/**
 * Customer Segmentation
 *
 * Phân tầng khách để bot biết ai là ai → tone + offer phù hợp:
 *   - new:       lần đầu inbox (0 conversation trước)
 *   - returning: đã chat 1-2 lần
 *   - frequent:  chat 3+ lần nhưng chưa đặt
 *   - vip:       đã đặt >= 2 lần
 *   - dormant:   > 60 ngày không activity
 *
 * Data source: guest_profiles (đã có sẵn từ trước).
 *   - total_conversations, booked_count, last_seen, preferences
 *
 * Tích hợp vào:
 *   - Greeting đầu tiên (tier + lang aware)
 *   - Tone directive bổ sung
 *   - Offer template cho price_objection (VIP được ưu đãi)
 */
import { db } from '../db';

export type Tier = 'new' | 'returning' | 'frequent' | 'vip' | 'dormant';

export interface TierInfo {
  tier: Tier;
  total_conversations: number;
  booked_count: number;
  days_since_last_seen: number;
  first_seen_at: number;
  preferences: Record<string, unknown>;
}

const DORMANT_DAYS = 60;

export function classifyCustomer(opts: {
  senderId?: string;
  hotelId: number;
}): TierInfo | null {
  const { senderId, hotelId } = opts;
  if (!senderId) return null;

  let row: any;
  try {
    row = db.prepare(
      `SELECT total_conversations, booked_count, last_seen, first_seen, preferences
       FROM guest_profiles WHERE hotel_id = ? AND fb_user_id = ?`
    ).get(hotelId, senderId);
  } catch { return null; }
  if (!row) return null;

  const total = row.total_conversations || 0;
  const booked = row.booked_count || 0;
  const lastSeen = row.last_seen || Date.now();
  const firstSeen = row.first_seen || Date.now();
  const daysSince = Math.floor((Date.now() - lastSeen) / (24 * 3600 * 1000));

  let tier: Tier;
  if (booked >= 2) tier = 'vip';
  else if (daysSince >= DORMANT_DAYS) tier = 'dormant';
  else if (total >= 3) tier = 'frequent';
  else if (total >= 1) tier = 'returning';
  else tier = 'new';

  let prefs = {};
  try { prefs = JSON.parse(row.preferences || '{}'); } catch {}

  return {
    tier,
    total_conversations: total,
    booked_count: booked,
    days_since_last_seen: daysSince,
    first_seen_at: firstSeen,
    preferences: prefs,
  };
}

/**
 * Directive thêm vào system prompt dựa trên tier.
 */
export function tierDirective(info: TierInfo, customerName?: string): string {
  const name = customerName ? ` (tên: ${customerName})` : '';
  switch (info.tier) {
    case 'vip':
      return `KHÁCH VIP${name}: đã đặt phòng ${info.booked_count} lần. ` +
        `Hãy chào bằng tên, cảm ơn họ đã quay lại. Gợi ý upgrade phòng miễn phí nếu phù hợp (late check-out, welcome drink). ` +
        `Tông giọng: thân mật + trân trọng.`;
    case 'frequent':
      return `KHÁCH QUEN${name}: đã chat ${info.total_conversations} lần (chưa đặt). ` +
        `Đây là khách tiềm năng — chủ động đề nghị giảm 5-10% để chốt đơn đầu tiên. ` +
        `Tông giọng: thân thiện, ghi nhận sự quan tâm lâu dài của họ.`;
    case 'returning':
      return `KHÁCH CŨ${name}: đã từng chat. Ghi nhận nhẹ ("Chào anh/chị, vui được gặp lại"). ` +
        `Không cần tự giới thiệu lại toàn bộ dịch vụ.`;
    case 'dormant':
      return `KHÁCH LÂU KHÔNG QUAY LẠI${name} (${info.days_since_last_seen} ngày): ` +
        `Chào ấm áp, nhắc nhẹ đã lâu không gặp. Có thể gợi ý ưu đãi để "kéo" lại. ` +
        `KHÔNG hỏi họ đã biết về khách sạn chưa — họ biết rồi.`;
    case 'new':
    default:
      return `KHÁCH MỚI${name}: lần đầu nhắn. Chào đầy đủ, giới thiệu ngắn khách sạn, ` +
        `tôn trọng thời gian — không spam thông tin.`;
  }
}

/**
 * Offer template theo tier — cho objection handler.
 */
export function tierOffer(info: TierInfo): string | null {
  if (info.tier === 'vip') {
    return 'Khách VIP: có thể tặng late check-out miễn phí hoặc nâng cấp phòng nếu trống.';
  }
  if (info.tier === 'frequent') {
    return 'Khách quen nhưng chưa đặt: đề nghị giảm 10% đơn đầu tiên (code WELCOME10).';
  }
  if (info.tier === 'dormant') {
    return 'Khách lâu không quay lại: giảm 5-8% ưu đãi "welcome back".';
  }
  return null;
}

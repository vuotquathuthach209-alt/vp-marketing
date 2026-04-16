import { db } from '../db';
import { generate, TaskType } from './router';
import { buildContext } from './wiki';
import {
  isBookingIntent,
  hasActiveBooking,
  processBookingStep,
  markTransferReceived,
} from './bookingflow';
import { getOtaDbConfig, getOtaRoomTypes, getOtaHotelStats } from './ota-db';

/**
 * Smart Reply Engine — 3 tầng:
 *   1) Instant Rules (0ms, miễn phí) — keyword match → template response
 *   2) Wiki Search (10ms, miễn phí) — tìm trong knowledge base
 *   3) AI Generate (3-15s, tốn quota) — chỉ khi 2 tầng trên không đủ
 *
 * Trả về { reply, tier, latency_ms }
 */

export interface SmartReplyResult {
  reply: string;
  tier: 'rules' | 'wiki' | 'ai';
  latency_ms: number;
}

/* ═══════════════════════════════════════════
   TẦNG 1: INSTANT RULES — Keyword → Template
   ═══════════════════════════════════════════ */

interface Rule {
  keywords: string[];       // Bất kỳ keyword nào match → trigger
  mustHave?: string[];      // Phải có TẤT CẢ từ này (AND logic)
  reply: string;
  priority: number;         // Cao hơn = ưu tiên hơn
}

const RULES: Rule[] = [
  // ── Chào hỏi ──
  {
    keywords: ['hi', 'hello', 'xin chào', 'chào', 'alo', 'hey', 'mình muốn', 'cho mình hỏi', 'cho hỏi'],
    reply: `Chào bạn! 👋 Cảm ơn bạn đã nhắn tin cho Sonder Vietnam.
Mình có thể giúp bạn:
🏨 Tìm phòng khách sạn giá tốt
📍 Tư vấn điểm đến du lịch
💰 Báo giá & khuyến mãi

Bạn cần tư vấn gì ạ?`,
    priority: 1,
  },

  // ── Giá phòng ──
  {
    keywords: ['giá', 'bao nhiêu', 'price', 'phí', 'tiền', 'cost', 'rate', 'vnđ', 'vnd', 'đồng'],
    reply: `💰 Giá phòng tại Sonder:

🏨 *Sonder Airport* ⭐⭐⭐
   Từ 450.000₫/đêm | Gần sân bay TSN

🏨 *Seehome Airport* ⭐⭐⭐⭐
   Từ 550.000₫/đêm | Hồ bơi + Gym + Spa

✅ Cam kết giá tốt nhất — nếu tìm được giá rẻ hơn, Sonder hoàn tiền chênh lệch!
📲 Đặt ngay tại: sondervn.com

Bạn muốn book ngày nào ạ?`,
    priority: 10,
  },

  // ── Địa chỉ / vị trí ──
  {
    keywords: ['địa chỉ', 'ở đâu', 'location', 'chỗ nào', 'đường nào', 'quận', 'vị trí', 'map', 'bản đồ'],
    reply: `📍 Địa chỉ các khách sạn Sonder:

🏨 *Sonder Airport*
   B12 Đ. Bạch Đằng, P.2, Tân Bình, TP.HCM
   🚕 Cách sân bay Tân Sơn Nhất ~5 phút

🏨 *Seehome Airport*
   45 Trường Sơn, P.2, Q.Tân Bình, TP.HCM
   🚕 Ngay trục đường chính ra sân bay

Cả 2 đều rất thuận tiện cho khách transit & công tác!`,
    priority: 10,
  },

  // ── Check-in / Check-out ──
  {
    keywords: ['check-in', 'checkin', 'check in', 'check-out', 'checkout', 'check out', 'nhận phòng', 'trả phòng', 'giờ'],
    reply: `🕐 Giờ nhận/trả phòng:

⬆️ Check-in: 14:00
⬇️ Check-out: 12:00

💡 Cần nhận phòng sớm hoặc trả phòng muộn? Inbox mình để hỗ trợ nhé!`,
    priority: 10,
  },

  // ── Đặt phòng / booking ──
  {
    keywords: ['đặt phòng', 'book', 'booking', 'reserve', 'đặt', 'muốn ở', 'muốn thuê'],
    reply: `📲 Đặt phòng Sonder rất dễ:

1️⃣ Vào sondervn.com
2️⃣ Chọn ngày & khách sạn
3️⃣ Xác nhận trong 30 giây!

✅ Thanh toán tại nơi (không cần trả trước)
✅ Huỷ miễn phí
✅ Hỗ trợ VNPay, MoMo, ZaloPay, Visa

Hoặc nhắn cho mình ngày + số người, mình book giúp ngay!`,
    priority: 10,
  },

  // ── Tiện ích / amenities ──
  {
    keywords: ['tiện ích', 'amenities', 'wifi', 'bể bơi', 'hồ bơi', 'gym', 'spa', 'đỗ xe', 'parking', 'bãi đậu', 'nhà hàng'],
    reply: `🏨 Tiện ích tại Sonder:

*Seehome Airport* ⭐⭐⭐⭐:
✅ Wi-Fi miễn phí | 🏊 Hồ bơi | 💪 Gym
🧖 Spa | 🍽️ Nhà hàng | 🅿️ Bãi đậu xe
🛗 Thang máy | ❄️ Điều hoà | 👨‍💼 Lễ tân 24h

*Sonder Airport* ⭐⭐⭐:
✅ Wi-Fi miễn phí | 🅿️ Bãi đậu xe
❄️ Điều hoà | 👨‍💼 Lễ tân 24h`,
    priority: 8,
  },

  // ── Khuyến mãi / deal ──
  {
    keywords: ['khuyến mãi', 'giảm giá', 'deal', 'voucher', 'mã giảm', 'promotion', 'sale', 'ưu đãi', 'rẻ'],
    reply: `🎉 Ưu đãi đặc biệt từ Sonder:

🔥 Price-match guarantee — tìm được giá rẻ hơn, Sonder hoàn chênh lệch!
💎 Sonder Coins — tích điểm mỗi lần đặt, đổi giảm giá
📱 Đặt sớm qua sondervn.com để được giá tốt nhất

Bạn muốn book ngày nào? Mình check deal cho!`,
    priority: 8,
  },

  // ── Thanh toán ──
  {
    keywords: ['thanh toán', 'payment', 'trả tiền', 'chuyển khoản', 'momo', 'vnpay', 'zalopay', 'visa', 'thẻ'],
    reply: `💳 Phương thức thanh toán:

✅ Thanh toán tại nơi lưu trú (không cần trả trước!)
💚 VNPay | 📱 MoMo | 💙 ZaloPay
💳 Visa / Mastercard

Sonder cam kết minh bạch — không phụ phí ẩn.`,
    priority: 8,
  },

  // ── Huỷ phòng ──
  {
    keywords: ['huỷ', 'hủy', 'cancel', 'hoàn tiền', 'refund'],
    reply: `🔄 Chính sách huỷ phòng Sonder:

✅ Huỷ miễn phí trước ngày check-in
✅ Không charge phí nếu huỷ sớm
📞 Cần huỷ gấp? Liên hệ support@sonder.vn hoặc nhắn cho mình!`,
    priority: 9,
  },

  // ── Liên hệ / hotline ──
  {
    keywords: ['hotline', 'liên hệ', 'contact', 'số điện thoại', 'phone', 'email', 'gọi', 'tổng đài'],
    reply: `📞 Liên hệ Sonder Vietnam:

📧 Email: support@sonder.vn
📱 Hotline: 1800 xxxx (miễn phí)
🌐 Web: sondervn.com
💬 Hoặc nhắn ngay tại đây — mình hỗ trợ 24/7!`,
    priority: 8,
  },

  // ── Cảm ơn ──
  {
    keywords: ['cảm ơn', 'thanks', 'thank', 'ok', 'được rồi', 'cám ơn', 'tks'],
    reply: `Không có gì ạ! 😊 Cảm ơn bạn đã quan tâm đến Sonder Vietnam.
Nếu cần thêm thông tin gì, cứ nhắn mình bất cứ lúc nào nhé! 🏨`,
    priority: 2,
  },

  // ── Hourly booking ──
  {
    keywords: ['thuê giờ', 'theo giờ', 'hourly', 'vài giờ', 'nghỉ trưa', 'nghỉ giờ'],
    reply: `⏰ Sonder hỗ trợ đặt phòng theo giờ!

Phù hợp cho:
🧑‍💻 Nghỉ trưa / làm việc tập trung
✈️ Transit chờ bay
💑 Nghỉ ngơi ngắn

Vào sondervn.com chọn "Đặt theo giờ" hoặc nhắn mình ngày + giờ cần nhé!`,
    priority: 8,
  },
];

function matchRules(message: string): string | null {
  const m = message.toLowerCase().trim();
  // Bỏ dấu để match tốt hơn
  const mNoDiacritics = removeDiacritics(m);

  let bestMatch: Rule | null = null;
  let bestScore = 0;

  for (const rule of RULES) {
    let score = 0;
    for (const kw of rule.keywords) {
      const kwLower = kw.toLowerCase();
      if (m.includes(kwLower) || mNoDiacritics.includes(removeDiacritics(kwLower))) {
        score += rule.priority;
      }
    }
    if (rule.mustHave) {
      const allPresent = rule.mustHave.every(
        (kw) => m.includes(kw.toLowerCase()) || mNoDiacritics.includes(removeDiacritics(kw.toLowerCase()))
      );
      if (!allPresent) score = 0;
    }
    if (score > bestScore) {
      bestScore = score;
      bestMatch = rule;
    }
  }

  return bestMatch ? bestMatch.reply : null;
}

function removeDiacritics(str: string): string {
  return str.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D');
}

/* ═══════════════════════════════════════════
   TẦNG 2: WIKI SEARCH — Knowledge Base
   ═══════════════════════════════════════════ */

function searchWikiDirect(message: string): string | null {
  // Tìm trong knowledge_wiki bằng keyword search đơn giản
  const keywords = message
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 2)
    .slice(0, 5);

  if (keywords.length === 0) return null;

  const allWiki = db
    .prepare(`SELECT title, content FROM knowledge_wiki WHERE content IS NOT NULL AND length(content) > 10`)
    .all() as Array<{ title: string; content: string }>;

  let bestEntry: { title: string; content: string } | null = null;
  let bestScore = 0;

  for (const entry of allWiki) {
    const text = (entry.title + ' ' + entry.content).toLowerCase();
    let score = 0;
    for (const kw of keywords) {
      if (text.includes(kw)) score++;
    }
    // Tỷ lệ match >= 40% keywords → có liên quan
    if (score / keywords.length >= 0.4 && score > bestScore) {
      bestScore = score;
      bestEntry = entry;
    }
  }

  if (!bestEntry) return null;

  // Trích xuất đoạn text liên quan nhất (tối đa 500 ký tự)
  const content = bestEntry.content;
  const firstKeyword = keywords.find((kw) => content.toLowerCase().includes(kw));
  if (firstKeyword) {
    const idx = content.toLowerCase().indexOf(firstKeyword);
    const start = Math.max(0, idx - 100);
    const end = Math.min(content.length, idx + 400);
    let snippet = content.slice(start, end).trim();
    if (start > 0) snippet = '...' + snippet;
    if (end < content.length) snippet += '...';
    return `📋 Thông tin từ Sonder:\n\n${snippet}\n\n💬 Bạn cần biết thêm gì không ạ?`;
  }

  // Trả về 500 ký tự đầu
  return `📋 ${bestEntry.title}:\n\n${content.slice(0, 500)}${content.length > 500 ? '...' : ''}\n\n💬 Bạn cần biết thêm gì không ạ?`;
}

/* ═══════════════════════════════════════════
   TẦNG 3: AI GENERATE — Chỉ khi cần thiết
   ═══════════════════════════════════════════ */

const REPLY_SYSTEM = `Bạn là nhân viên tư vấn của Sonder Vietnam (sondervn.com) — nền tảng đặt phòng khách sạn.
Trả lời tiếng Việt, ngắn gọn 2-4 câu, thân thiện, chuyên nghiệp.
Dựa vào kiến thức doanh nghiệp bên dưới để trả lời CHÍNH XÁC.
Khuyến khích khách vào sondervn.com hoặc inbox để đặt phòng.
KHÔNG tự bịa giá, số liệu. Nếu không biết → "Để mình kiểm tra và báo lại bạn nhé!"
Có thể dùng 1-2 emoji phù hợp.`;

/** Build OTA real-time context (rooms, availability, stats) */
async function buildOtaContext(): Promise<string> {
  if (!getOtaDbConfig()) return '';
  try {
    // Use hotel_id=1 as default (single-tenant for now)
    // TODO: multi-tenant — resolve hotel_id from page
    const [roomTypes, stats] = await Promise.all([
      getOtaRoomTypes(1).catch(() => []),
      getOtaHotelStats(1).catch(() => null),
    ]);

    const parts: string[] = [];
    if (roomTypes.length > 0) {
      parts.push('PHÒNG TRỐNG REAL-TIME:');
      for (const rt of roomTypes) {
        parts.push(`- ${rt.name}: ${rt.base_price.toLocaleString('vi-VN')}₫/đêm | Tối đa ${rt.max_guests} khách | Còn ${rt.available_count}/${rt.room_count} phòng`);
      }
    }
    if (stats) {
      parts.push(`\nTRẠNG THÁI HÔM NAY: ${stats.available_rooms}/${stats.total_rooms} phòng trống | ${stats.inhouse_guests} khách đang ở | Công suất ${stats.occupancy_rate}%`);
    }
    return parts.join('\n');
  } catch {
    return '';
  }
}

async function aiReply(message: string): Promise<string> {
  const [wikiCtx, otaCtx] = await Promise.all([
    buildContext(message),
    buildOtaContext(),
  ]);
  const task: TaskType = message.length > 100 || /[?？]/.test(message) ? 'reply_complex' : 'reply_simple';

  const context = [
    wikiCtx ? `--- KIẾN THỨC ---\n${wikiCtx}\n--- HẾT ---` : '',
    otaCtx ? `--- DỮ LIỆU OTA REAL-TIME ---\n${otaCtx}\n--- HẾT ---` : '',
  ].filter(Boolean).join('\n\n');

  return generate({
    task,
    system: REPLY_SYSTEM,
    user: `${context ? context + '\n\n' : ''}Khách viết: "${message}"\n\nTrả lời ngắn gọn:`,
  });
}

/* ═══════════════════════════════════════════
   MAIN ENTRY POINT
   ═══════════════════════════════════════════ */

/**
 * Smart reply with sender context — booking flow aware.
 * If senderId is provided, checks for active booking or booking intent.
 */
export async function smartReplyWithSender(
  message: string,
  senderId?: string,
  senderName?: string,
  hasImage?: boolean
): Promise<SmartReplyResult> {
  const t0 = Date.now();
  const msg = message.trim();

  if (senderId) {
    // If sender has image and is awaiting transfer → mark transfer received
    if (hasImage) {
      const result = markTransferReceived(senderId);
      if (result) {
        return { reply: result.reply, tier: 'rules', latency_ms: Date.now() - t0 };
      }
    }

    // If sender has active booking → delegate to booking flow
    if (hasActiveBooking(senderId)) {
      const reply = processBookingStep(senderId, msg, senderName);
      return { reply, tier: 'rules', latency_ms: Date.now() - t0 };
    }

    // If message has booking intent → start new booking flow
    if (isBookingIntent(msg)) {
      const reply = processBookingStep(senderId, msg, senderName);
      return { reply, tier: 'rules', latency_ms: Date.now() - t0 };
    }
  }

  // Fall through to standard smart reply
  return smartReply(msg);
}

export async function smartReply(message: string): Promise<SmartReplyResult> {
  const t0 = Date.now();
  const msg = message.trim();

  // Tin nhắn quá ngắn (sticker, emoji, etc.)
  if (msg.length <= 1) {
    return { reply: 'Chào bạn! Bạn cần tư vấn gì về đặt phòng khách sạn ạ? 😊', tier: 'rules', latency_ms: 0 };
  }

  // ── Tầng 1: Instant Rules ──
  const ruleReply = matchRules(msg);
  if (ruleReply) {
    return { reply: ruleReply, tier: 'rules', latency_ms: Date.now() - t0 };
  }

  // ── Tầng 2: Wiki Search ──
  const wikiReply = searchWikiDirect(msg);
  if (wikiReply) {
    return { reply: wikiReply, tier: 'wiki', latency_ms: Date.now() - t0 };
  }

  // ── Tầng 3: AI Generate ──
  try {
    const reply = await aiReply(msg);
    return { reply, tier: 'ai', latency_ms: Date.now() - t0 };
  } catch (e: any) {
    console.error('[smartreply] AI fail:', e.message);
    return {
      reply: `Cảm ơn bạn đã nhắn tin! 😊 Hiện mình đang bận, để mình kiểm tra và phản hồi sớm nhất nhé.\n\n📧 Email: support@sonder.vn\n🌐 Web: sondervn.com`,
      tier: 'rules',
      latency_ms: Date.now() - t0,
    };
  }
}

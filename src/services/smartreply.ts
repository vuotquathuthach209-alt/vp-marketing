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
 *   1) Dynamic FAQ (0ms, miễn phí) — scoring-based match → data-driven response
 *   2) Wiki Search (10ms, miễn phí) — tìm trong knowledge base
 *   3) AI Generate (3-15s, tốn quota) — chỉ khi 2 tầng trên không đủ
 */

export interface SmartReplyResult {
  reply: string;
  tier: 'rules' | 'wiki' | 'ai';
  latency_ms: number;
  images?: Array<{ title: string; subtitle: string; image_url: string }>;
}

/* ═══════════════════════════════════════════
   HELPERS
   ═══════════════════════════════════════════ */

function removeDiacritics(str: string): string {
  return str.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D');
}

/** Count how many keywords match in msg — used for scoring */
function countMatches(msg: string, msgNorm: string, keywords: string[]): number {
  let count = 0;
  for (const kw of keywords) {
    const kwL = kw.toLowerCase();
    if (msg.includes(kwL) || msgNorm.includes(removeDiacritics(kwL))) count++;
  }
  return count;
}

function msgContains(msg: string, msgNorm: string, keywords: string[]): boolean {
  return countMatches(msg, msgNorm, keywords) > 0;
}

/** Get hotel info from cache */
function getHotelCache(hotelId: number) {
  const mktHotel = db.prepare(`SELECT ota_hotel_id, name, config FROM mkt_hotels WHERE id = ?`).get(hotelId) as any;
  const otaId = mktHotel?.ota_hotel_id;
  if (!otaId) return { hotel: mktHotel, rooms: [], hotelCache: null };

  const hotelCache = db.prepare(`SELECT * FROM mkt_hotels_cache WHERE ota_hotel_id = ?`).get(otaId) as any;
  const rooms = db.prepare(`SELECT * FROM mkt_rooms_cache WHERE ota_hotel_id = ? ORDER BY base_price`).all(otaId) as any[];
  return { hotel: mktHotel, rooms, hotelCache };
}

function getRoomImages(hotelId: number) {
  return db.prepare(`SELECT * FROM room_images WHERE hotel_id = ? AND active = 1 ORDER BY display_order`).all(hotelId) as any[];
}

/* ═══════════════════════════════════════════
   TẦNG 1: SCORING-BASED FAQ ENGINE
   ═══════════════════════════════════════════

   Mỗi intent có keywords + priority weight.
   Tính score = số keywords match × weight.
   Intent có score cao nhất thắng → tránh match sai.

   VD: "cho mình hình phòng khách sạn bạch đằng"
     - greeting: "cho" → 0 match (không có "cho" riêng lẻ)
     - images: "hình" + "phòng" → 2 match × 10 = 20 ← THẮNG
     - price: "phòng" → 1 match × 8 = 8
*/

interface FaqResult {
  reply: string;
  images?: Array<{ title: string; subtitle: string; image_url: string }>;
}

interface FaqIntent {
  id: string;
  keywords: string[];
  excludeKeywords?: string[];  // Nếu có từ này → không match
  weight: number;
  minMatches?: number;         // Tối thiểu bao nhiêu keyword phải match (default 1)
  maxMsgLength?: number;       // Chỉ match nếu tin nhắn ngắn hơn
  handler: (msg: string, msgNorm: string, hotelName: string, rooms: any[], hotelCache: any, hotelId: number) => FaqResult;
}

function buildIntents(): FaqIntent[] {
  return [
    // ── Hình ảnh phòng (PRIORITY CAO NHẤT cho image queries) ──
    {
      id: 'room_images',
      keywords: ['hình', 'ảnh', 'photo', 'image', 'xem phòng', 'hình phòng', 'ảnh phòng', 'picture', 'gallery', 'cho xem', 'gửi hình', 'gửi ảnh'],
      weight: 15,
      handler: (msg, msgNorm, hotelName, rooms, hotelCache, hotelId) => {
        const roomImgs = getRoomImages(hotelId);
        if (roomImgs.length > 0) {
          const grouped: Record<string, any[]> = {};
          for (const img of roomImgs) {
            if (!grouped[img.room_type_name]) grouped[img.room_type_name] = [];
            grouped[img.room_type_name].push(img);
          }
          const images = roomImgs.map((img: any) => ({
            title: img.room_type_name,
            subtitle: img.caption || hotelName,
            image_url: img.image_url,
          }));
          const roomList = Object.keys(grouped).map(name => `📸 ${name} (${grouped[name].length} ảnh)`).join('\n');
          return { reply: `📸 Hình ảnh các phòng tại ${hotelName}:\n\n${roomList}\n\nMời bạn xem ảnh bên dưới 👇`, images };
        }
        if (rooms.length > 0) {
          const roomList = rooms.map((r: any) =>
            `🏨 ${r.name}: ${r.base_price?.toLocaleString('vi-VN')}₫/đêm | ${r.max_guests} khách`
          ).join('\n');
          return { reply: `Hiện mình chưa có ảnh phòng online, nhưng đây là các loại phòng tại ${hotelName}:\n\n${roomList}\n\n📲 Xem ảnh chi tiết tại website hoặc nhắn mình để được gửi ảnh trực tiếp!` };
        }
        return { reply: `📸 Để xem hình ảnh phòng tại ${hotelName}, bạn có thể:\n📲 Truy cập website\n💬 Hoặc cho mình biết bạn quan tâm loại phòng nào, mình gửi ảnh cho nhé!` };
      },
    },

    // ── Giá phòng ──
    {
      id: 'price',
      keywords: ['giá', 'bao nhiêu', 'price', 'phí', 'tiền', 'cost', 'rate', 'vnđ', 'vnd', 'đồng'],
      excludeKeywords: ['hình', 'ảnh', 'photo', 'image'],  // Nếu hỏi hình thì không match giá
      weight: 10,
      handler: (msg, msgNorm, hotelName, rooms) => {
        if (rooms.length > 0) {
          const roomList = rooms.map((r: any) => {
            let line = `🏨 *${r.name}*\n   Từ ${r.base_price?.toLocaleString('vi-VN')}₫/đêm | Tối đa ${r.max_guests} khách`;
            if (r.hourly_price) line += ` | Theo giờ: ${r.hourly_price.toLocaleString('vi-VN')}₫`;
            if (r.bed_type) line += ` | ${r.bed_type}`;
            const avail = r.available_count ?? r.room_count;
            if (avail !== undefined) line += `\n   Còn ${avail} phòng trống`;
            return line;
          }).join('\n\n');
          return { reply: `💰 Giá phòng tại ${hotelName}:\n\n${roomList}\n\n✅ Giá tốt nhất khi đặt trực tiếp!\n📲 Bạn muốn đặt phòng nào ạ?` };
        }
        return { reply: `💰 Để xem giá phòng mới nhất tại ${hotelName}, bạn vui lòng:\n📲 Truy cập website hoặc nhắn ngày check-in, mình báo giá ngay!` };
      },
    },

    // ── Loại phòng (hỏi "phòng" nhưng không hỏi giá/hình) ──
    {
      id: 'room_types',
      keywords: ['phòng', 'room', 'loại phòng', 'các phòng', 'phòng nào', 'có phòng'],
      excludeKeywords: ['hình', 'ảnh', 'giá', 'bao nhiêu', 'đặt', 'book', 'check', 'huỷ', 'hủy'],
      weight: 6,
      handler: (msg, msgNorm, hotelName, rooms) => {
        if (rooms.length > 0) {
          const roomList = rooms.map((r: any) => {
            let line = `🏨 ${r.name} — ${r.base_price?.toLocaleString('vi-VN')}₫/đêm`;
            if (r.max_guests) line += ` | ${r.max_guests} khách`;
            if (r.bed_type) line += ` | ${r.bed_type}`;
            return line;
          }).join('\n');
          return { reply: `🏨 Các loại phòng tại ${hotelName}:\n\n${roomList}\n\nBạn muốn xem chi tiết phòng nào? Gõ "giá phòng" hoặc "hình phòng" nhé!` };
        }
        return { reply: `🏨 ${hotelName} có nhiều loại phòng phù hợp. Nhắn mình ngày check-in để báo phòng trống nhé!` };
      },
    },

    // ── Check-in / Check-out ──
    {
      id: 'checkin',
      keywords: ['check-in', 'checkin', 'check in', 'check-out', 'checkout', 'check out', 'nhận phòng', 'trả phòng', 'giờ nhận', 'giờ trả'],
      weight: 12,
      handler: (msg, msgNorm, hotelName, rooms, hotelCache) => {
        const checkIn = hotelCache?.check_in_time || '14:00';
        const checkOut = hotelCache?.check_out_time || '12:00';
        if (msgContains(msg, msgNorm, ['sớm', 'early', 'trước'])) {
          return { reply: `⏰ Giờ nhận phòng tiêu chuẩn: ${checkIn}\n\n💡 ${hotelName} hỗ trợ nhận phòng sớm tùy tình trạng phòng trống.\n• Trước 2 giờ: +30% giá phòng\n• Trước 4 giờ: +50% giá phòng\n\nBạn muốn check-in sớm lúc mấy giờ?` };
        }
        if (msgContains(msg, msgNorm, ['muộn', 'trễ', 'late'])) {
          return { reply: `⏰ Giờ trả phòng tiêu chuẩn: ${checkOut}\n\n💡 ${hotelName} hỗ trợ trả phòng muộn:\n• Muộn 2 giờ: +30%\n• Muộn 4 giờ: +50%\n• Sau 18:00: tính thêm 1 đêm\n\nBạn cần trả muộn đến mấy giờ ạ?` };
        }
        return { reply: `🕐 Giờ nhận/trả phòng tại ${hotelName}:\n\n⬆️ Check-in: ${checkIn}\n⬇️ Check-out: ${checkOut}\n\n💡 Cần nhận sớm hoặc trả muộn? Inbox mình nhé!` };
      },
    },

    // ── Địa chỉ ──
    {
      id: 'location',
      keywords: ['địa chỉ', 'ở đâu', 'location', 'chỗ nào', 'đường nào', 'quận', 'vị trí', 'map', 'bản đồ', 'đường đi', 'chỉ đường'],
      weight: 10,
      handler: (msg, msgNorm, hotelName, rooms, hotelCache) => {
        if (hotelCache) {
          const parts = [hotelCache.address, hotelCache.district, hotelCache.city].filter(Boolean);
          return { reply: `📍 Địa chỉ ${hotelName}:\n\n🏨 ${parts.join(', ') || 'Liên hệ để biết'}\n${hotelCache.phone ? `📞 ${hotelCache.phone}` : ''}\n\nBạn cần chỉ đường không ạ?` };
        }
        return { reply: `📍 Vui lòng liên hệ ${hotelName} để biết địa chỉ chi tiết ạ!` };
      },
    },

    // ── Tiện ích ──
    {
      id: 'amenities',
      keywords: ['tiện ích', 'amenities', 'wifi', 'bể bơi', 'hồ bơi', 'gym', 'spa', 'đỗ xe', 'parking', 'bãi đậu', 'nhà hàng', 'có gì', 'dịch vụ'],
      weight: 8,
      handler: (msg, msgNorm, hotelName, rooms, hotelCache) => {
        if (hotelCache?.amenities) {
          let amenities: string[] = [];
          try {
            const parsed = typeof hotelCache.amenities === 'string' ? JSON.parse(hotelCache.amenities) : hotelCache.amenities;
            amenities = Array.isArray(parsed) ? parsed : Object.keys(parsed).filter(k => parsed[k]);
          } catch {}
          if (amenities.length > 0) {
            const emojiMap: Record<string, string> = {
              'wifi': '📶', 'pool': '🏊', 'gym': '💪', 'spa': '🧖', 'parking': '🅿️',
              'restaurant': '🍽️', 'elevator': '🛗', 'ac': '❄️', 'reception': '👨‍💼',
              'laundry': '👔', 'bar': '🍸', 'garden': '🌿',
            };
            const formatted = amenities.map(a => {
              const key = a.toLowerCase().replace(/\s+/g, '');
              const emoji = Object.entries(emojiMap).find(([k]) => key.includes(k))?.[1] || '✅';
              return `${emoji} ${a}`;
            }).join('\n');
            return { reply: `🏨 Tiện ích tại ${hotelName}:\n\n${formatted}` };
          }
        }
        return { reply: `🏨 ${hotelName} có đầy đủ tiện nghi. Liên hệ mình để biết chi tiết nhé!` };
      },
    },

    // ── Đặt phòng ──
    {
      id: 'booking',
      keywords: ['đặt phòng', 'book', 'booking', 'reserve', 'muốn ở', 'muốn thuê', 'đặt ngay'],
      weight: 10,
      handler: (msg, msgNorm, hotelName) => ({
        reply: `📲 Đặt phòng ${hotelName} rất dễ:\n\n1️⃣ Nhắn cho mình: ngày check-in, số đêm, số khách\n2️⃣ Mình báo giá & phòng trống\n3️⃣ Xác nhận trong 30 giây!\n\n✅ Thanh toán tại nơi\n✅ Huỷ miễn phí\n\nBạn muốn đặt ngày nào ạ?`,
      }),
    },

    // ── Khuyến mãi ──
    {
      id: 'promo',
      keywords: ['khuyến mãi', 'giảm giá', 'deal', 'voucher', 'mã giảm', 'promotion', 'sale', 'ưu đãi', 'rẻ'],
      weight: 8,
      handler: (msg, msgNorm, hotelName) => ({
        reply: `🎉 Ưu đãi từ ${hotelName}:\n\n🔥 Giá tốt nhất khi đặt trực tiếp!\n💎 Ưu đãi riêng cho khách quen\n📱 Inbox ngày check-in để mình check deal cho bạn!`,
      }),
    },

    // ── Thanh toán ──
    {
      id: 'payment',
      keywords: ['thanh toán', 'payment', 'trả tiền', 'chuyển khoản', 'momo', 'vnpay', 'visa', 'thẻ', 'banking'],
      weight: 10,
      handler: (msg, msgNorm, hotelName) => ({
        reply: `💳 Phương thức thanh toán tại ${hotelName}:\n\n✅ Thanh toán tại nơi lưu trú\n💚 Chuyển khoản ngân hàng\n💳 Visa / Mastercard\n📱 VNPay, MoMo\n\nKhông phụ phí ẩn.`,
      }),
    },

    // ── Huỷ phòng ──
    {
      id: 'cancel',
      keywords: ['huỷ', 'hủy', 'cancel', 'hoàn tiền', 'refund'],
      weight: 12,
      handler: (msg, msgNorm, hotelName) => ({
        reply: `🔄 Chính sách huỷ phòng ${hotelName}:\n\n✅ Huỷ miễn phí trước ngày check-in\n✅ Không charge phí nếu huỷ sớm\n\nCần huỷ? Nhắn mình mã booking!`,
      }),
    },

    // ── Liên hệ ──
    {
      id: 'contact',
      keywords: ['hotline', 'liên hệ', 'contact', 'số điện thoại', 'phone', 'email', 'gọi', 'tổng đài'],
      weight: 8,
      handler: (msg, msgNorm, hotelName, rooms, hotelCache) => ({
        reply: `📞 Liên hệ ${hotelName}:\n\n${hotelCache?.phone ? `📱 Hotline: ${hotelCache.phone}\n` : ''}💬 Nhắn tin ngay tại đây — hỗ trợ 24/7!`,
      }),
    },

    // ── Thuê giờ ──
    {
      id: 'hourly',
      keywords: ['thuê giờ', 'theo giờ', 'hourly', 'vài giờ', 'nghỉ trưa', 'nghỉ giờ'],
      weight: 10,
      handler: (msg, msgNorm, hotelName, rooms) => {
        const hourlyRooms = rooms.filter((r: any) => r.hourly_price);
        if (hourlyRooms.length > 0) {
          const list = hourlyRooms.map((r: any) => `⏰ ${r.name}: ${r.hourly_price.toLocaleString('vi-VN')}₫/giờ`).join('\n');
          return { reply: `⏰ Đặt phòng theo giờ tại ${hotelName}:\n\n${list}\n\nNhắn mình ngày + giờ cần nhé!` };
        }
        return { reply: `⏰ ${hotelName} hỗ trợ đặt phòng theo giờ! Nhắn mình ngày + giờ cần nhé!` };
      },
    },

    // ── Thú cưng ──
    {
      id: 'pet',
      keywords: ['thú cưng', 'pet', 'chó', 'mèo', 'dog', 'cat'],
      weight: 10,
      handler: (msg, msgNorm, hotelName) => ({
        reply: `🐾 Chính sách thú cưng tại ${hotelName}:\n\nVui lòng liên hệ trực tiếp vì mỗi loại phòng có quy định riêng ạ.\n\nBạn dự định mang theo thú cưng gì?`,
      }),
    },

    // ── Review ──
    {
      id: 'review',
      keywords: ['review', 'đánh giá', 'feedback', 'rating', 'nhận xét'],
      weight: 8,
      handler: (msg, msgNorm, hotelName, rooms, hotelCache) => ({
        reply: `⭐ ${hotelName}${hotelCache?.star_rating ? ` (${hotelCache.star_rating} sao)` : ''}:\n\nXem đánh giá từ khách hàng trên Google Maps hoặc Booking.com.\n💬 Bạn đã từng ở đây chưa?`,
      }),
    },

    // ── Chào hỏi (PRIORITY THẤP NHẤT — chỉ match tin ngắn) ──
    {
      id: 'greeting',
      keywords: ['hi', 'hello', 'xin chào', 'chào bạn', 'chào', 'alo', 'hey'],
      weight: 2,
      maxMsgLength: 25,  // Chỉ match tin ngắn như "chào", "hi", "alo"
      handler: (msg, msgNorm, hotelName) => ({
        reply: `Chào bạn! 👋 Cảm ơn bạn đã nhắn tin cho ${hotelName}.\nMình có thể giúp bạn:\n🏨 Xem phòng & giá (gõ "giá phòng")\n📸 Xem hình phòng (gõ "hình phòng")\n📍 Địa chỉ & tiện ích\n💰 Đặt phòng nhanh\n\nBạn cần tư vấn gì ạ?`,
      }),
    },

    // ── Cảm ơn (PRIORITY THẤP) ──
    {
      id: 'thanks',
      keywords: ['cảm ơn', 'thanks', 'thank', 'cám ơn', 'tks'],
      weight: 2,
      maxMsgLength: 30,
      handler: (msg, msgNorm, hotelName) => ({
        reply: `Không có gì ạ! 😊 Cảm ơn bạn đã quan tâm đến ${hotelName}.\nNếu cần thêm thông tin, cứ nhắn mình nhé! 🏨`,
      }),
    },
  ];
}

/* ═══════════════════════════════════════════
   SCORING ENGINE — chọn intent tốt nhất
   ═══════════════════════════════════════════ */

function matchDynamicFaq(message: string, hotelId: number = 1): FaqResult | null {
  const msg = message.toLowerCase().trim();
  const msgNorm = removeDiacritics(msg);

  if (msg.length <= 1) return null; // Sticker, emoji

  const { hotel, rooms, hotelCache } = getHotelCache(hotelId);
  const hotelName = hotel?.name || 'Khách sạn';

  const intents = buildIntents();
  let bestIntent: FaqIntent | null = null;
  let bestScore = 0;

  for (const intent of intents) {
    // Skip if message too long for this intent
    if (intent.maxMsgLength && msg.length > intent.maxMsgLength) continue;

    // Count keyword matches
    const matches = countMatches(msg, msgNorm, intent.keywords);
    if (matches === 0) continue;
    if (intent.minMatches && matches < intent.minMatches) continue;

    // Check exclude keywords — nếu có từ loại trừ thì giảm score mạnh
    let excludePenalty = 0;
    if (intent.excludeKeywords) {
      excludePenalty = countMatches(msg, msgNorm, intent.excludeKeywords) * 10;
    }

    const score = matches * intent.weight - excludePenalty;

    if (score > bestScore) {
      bestScore = score;
      bestIntent = intent;
    }
  }

  if (!bestIntent || bestScore <= 0) return null;

  return bestIntent.handler(msg, msgNorm, hotelName, rooms, hotelCache, hotelId);
}

/* ═══════════════════════════════════════════
   TẦNG 2: WIKI SEARCH — Knowledge Base
   ═══════════════════════════════════════════ */

function searchWikiDirect(message: string): string | null {
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
    if (score / keywords.length >= 0.4 && score > bestScore) {
      bestScore = score;
      bestEntry = entry;
    }
  }

  if (!bestEntry) return null;

  const content = bestEntry.content;
  const firstKeyword = keywords.find((kw) => content.toLowerCase().includes(kw));
  if (firstKeyword) {
    const idx = content.toLowerCase().indexOf(firstKeyword);
    const start = Math.max(0, idx - 100);
    const end = Math.min(content.length, idx + 400);
    let snippet = content.slice(start, end).trim();
    if (start > 0) snippet = '...' + snippet;
    if (end < content.length) snippet += '...';
    return `📋 Thông tin từ ${bestEntry.title}:\n\n${snippet}\n\n💬 Bạn cần biết thêm gì không ạ?`;
  }

  return `📋 ${bestEntry.title}:\n\n${content.slice(0, 500)}${content.length > 500 ? '...' : ''}\n\n💬 Bạn cần biết thêm gì không ạ?`;
}

/* ═══════════════════════════════════════════
   TẦNG 3: AI GENERATE — Chỉ khi cần thiết
   ═══════════════════════════════════════════ */

const REPLY_SYSTEM = `Bạn là nhân viên tư vấn khách sạn chuyên nghiệp.
Trả lời tiếng Việt, ngắn gọn 2-4 câu, thân thiện, chuyên nghiệp.
Dựa vào kiến thức doanh nghiệp bên dưới để trả lời CHÍNH XÁC.
Khuyến khích khách inbox hoặc gọi hotline để đặt phòng.
KHÔNG tự bịa giá, số liệu. Nếu không biết → "Để mình kiểm tra và báo lại bạn nhé!"
Có thể dùng 1-2 emoji phù hợp.`;

async function buildOtaContext(hotelId: number = 1): Promise<string> {
  if (!getOtaDbConfig()) return '';
  try {
    const mktHotel = db.prepare(`SELECT ota_hotel_id FROM mkt_hotels WHERE id = ?`).get(hotelId) as any;
    const otaId = mktHotel?.ota_hotel_id;
    if (!otaId) return '';

    const [roomTypes, stats] = await Promise.all([
      getOtaRoomTypes(otaId).catch(() => []),
      getOtaHotelStats(otaId).catch(() => null),
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

async function aiReply(message: string, hotelId: number = 1): Promise<string> {
  const [wikiCtx, otaCtx] = await Promise.all([
    buildContext(message),
    buildOtaContext(hotelId),
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

export async function smartReplyWithSender(
  message: string,
  senderId?: string,
  senderName?: string,
  hasImage?: boolean,
  hotelId?: number
): Promise<SmartReplyResult> {
  const t0 = Date.now();
  const msg = message.trim();
  const hid = hotelId || 1;

  if (senderId) {
    if (hasImage) {
      const result = markTransferReceived(senderId);
      if (result) {
        return { reply: result.reply, tier: 'rules', latency_ms: Date.now() - t0 };
      }
    }
    if (hasActiveBooking(senderId)) {
      const reply = processBookingStep(senderId, msg, senderName);
      return { reply, tier: 'rules', latency_ms: Date.now() - t0 };
    }
    if (isBookingIntent(msg)) {
      const reply = processBookingStep(senderId, msg, senderName);
      return { reply, tier: 'rules', latency_ms: Date.now() - t0 };
    }
  }

  return smartReply(msg, hid);
}

export async function smartReply(message: string, hotelId: number = 1): Promise<SmartReplyResult> {
  const t0 = Date.now();
  const msg = message.trim();

  if (msg.length <= 1) {
    return { reply: 'Chào bạn! Bạn cần tư vấn gì về đặt phòng khách sạn ạ? 😊', tier: 'rules', latency_ms: 0 };
  }

  // ── Tầng 1: Dynamic FAQ (scoring) ──
  const faqResult = matchDynamicFaq(msg, hotelId);
  if (faqResult) {
    return { reply: faqResult.reply, tier: 'rules', latency_ms: Date.now() - t0, images: faqResult.images };
  }

  // ── Tầng 2: Wiki Search ──
  const wikiReply = searchWikiDirect(msg);
  if (wikiReply) {
    return { reply: wikiReply, tier: 'wiki', latency_ms: Date.now() - t0 };
  }

  // ── Tầng 3: AI Generate ──
  try {
    const reply = await aiReply(msg, hotelId);
    return { reply, tier: 'ai', latency_ms: Date.now() - t0 };
  } catch (e: any) {
    console.error('[smartreply] AI fail:', e.message);
    return {
      reply: `Cảm ơn bạn đã nhắn tin! 😊 Hiện mình đang bận, để mình kiểm tra và phản hồi sớm nhất nhé.`,
      tier: 'rules',
      latency_ms: Date.now() - t0,
    };
  }
}

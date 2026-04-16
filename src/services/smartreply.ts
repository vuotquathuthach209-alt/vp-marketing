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
 * Smart Reply Engine v3 — Context-Aware Chatbot
 *
 * ARCHITECTURE:
 *   1) Conversation Memory — lưu lịch sử chat, đọc ngữ cảnh
 *   2) Intent Detection — dùng Gemma (nhẹ, nhanh) phân tích ý định
 *   3) Dynamic FAQ — trả lời từ data cache (0ms)
 *   4) Lightweight AI — Gemma/Groq cho câu hỏi cần hiểu ngữ cảnh (~500ms)
 *   5) Full AI — Claude/Gemini cho câu hỏi phức tạp (3-15s)
 *
 * FLOW:
 *   Greeting → Giới thiệu chi nhánh → Khách chọn → Q&A theo context
 */

export interface SmartReplyResult {
  reply: string;
  tier: 'rules' | 'wiki' | 'ai' | 'ai_light';
  latency_ms: number;
  intent?: string;
  images?: Array<{ title: string; subtitle: string; image_url: string }>;
}

/* ═══════════════════════════════════════════
   CONVERSATION MEMORY
   ═══════════════════════════════════════════ */

const MAX_HISTORY = 8; // Giữ 8 tin gần nhất cho context

function saveMessage(senderId: string, pageId: number, role: 'user' | 'bot', message: string, intent?: string) {
  try {
    db.prepare(
      `INSERT INTO conversation_memory (sender_id, page_id, role, message, intent, created_at) VALUES (?, ?, ?, ?, ?, ?)`
    ).run(senderId, pageId, role, message.slice(0, 500), intent || null, Date.now());

    // Cleanup: giữ tối đa 20 tin mỗi sender
    db.prepare(
      `DELETE FROM conversation_memory WHERE sender_id = ? AND id NOT IN (
        SELECT id FROM conversation_memory WHERE sender_id = ? ORDER BY created_at DESC LIMIT 20
      )`
    ).run(senderId, senderId);
  } catch {}
}

function getConversationHistory(senderId: string): Array<{ role: string; message: string; intent: string | null }> {
  try {
    return db.prepare(
      `SELECT role, message, intent FROM conversation_memory
       WHERE sender_id = ? ORDER BY created_at DESC LIMIT ?`
    ).all(senderId, MAX_HISTORY).reverse() as any[];
  } catch {
    return [];
  }
}

function getLastBotIntent(senderId: string): string | null {
  try {
    const row = db.prepare(
      `SELECT intent FROM conversation_memory WHERE sender_id = ? AND role = 'bot' AND intent IS NOT NULL
       ORDER BY created_at DESC LIMIT 1`
    ).get(senderId) as any;
    return row?.intent || null;
  } catch {
    return null;
  }
}

function isFirstMessage(senderId: string): boolean {
  try {
    const row = db.prepare(
      `SELECT COUNT(*) as cnt FROM conversation_memory WHERE sender_id = ?`
    ).get(senderId) as any;
    return (row?.cnt || 0) <= 1; // 0 or 1 (just saved current)
  } catch {
    return true;
  }
}

/* ═══════════════════════════════════════════
   HELPERS
   ═══════════════════════════════════════════ */

function removeDiacritics(str: string): string {
  return str.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D');
}

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

/** Get all hotel branches (for greeting) */
function getAllBranches(): Array<{ id: number; name: string; address?: string; phone?: string }> {
  try {
    const hotels = db.prepare(
      `SELECT h.id, h.name, h.ota_hotel_id FROM mkt_hotels h WHERE h.status = 'active' ORDER BY h.id`
    ).all() as any[];

    return hotels.map((h: any) => {
      let address = '', phone = '';
      if (h.ota_hotel_id) {
        const cache = db.prepare(`SELECT address, district, city, phone FROM mkt_hotels_cache WHERE ota_hotel_id = ?`).get(h.ota_hotel_id) as any;
        if (cache) {
          address = [cache.address, cache.district, cache.city].filter(Boolean).join(', ');
          phone = cache.phone || '';
        }
      }
      return { id: h.id, name: h.name, address, phone };
    });
  } catch {
    return [];
  }
}

/* ═══════════════════════════════════════════
   INTENT DETECTION — Phân loại ý định nhanh
   ═══════════════════════════════════════════ */

type Intent = 'greeting' | 'price' | 'rooms' | 'room_images' | 'booking' | 'checkin' |
  'check_dates' | 'location' | 'amenities' | 'payment' | 'cancel' | 'promo' | 'hourly' | 'contact' |
  'pet' | 'review' | 'thanks' | 'branch_select' | 'unknown';

interface IntentRule {
  intent: Intent;
  keywords: string[];
  excludeKeywords?: string[];
  weight: number;
  maxMsgLength?: number;
}

const INTENT_RULES: IntentRule[] = [
  { intent: 'room_images', keywords: ['hình', 'ảnh', 'photo', 'image', 'xem phòng', 'hình phòng', 'ảnh phòng', 'picture', 'gallery', 'cho xem', 'gửi hình', 'gửi ảnh'], weight: 15 },
  { intent: 'cancel', keywords: ['huỷ', 'hủy', 'cancel', 'hoàn tiền', 'refund'], weight: 12 },
  { intent: 'booking', keywords: ['đặt phòng', 'book', 'booking', 'reserve', 'muốn ở', 'muốn thuê', 'đặt ngay'], weight: 10 },
  { intent: 'price', keywords: ['giá', 'bao nhiêu', 'price', 'phí', 'tiền', 'cost', 'rate', 'vnđ', 'vnd', 'xem giá'], excludeKeywords: ['hình', 'ảnh'], weight: 10 },
  { intent: 'rooms', keywords: ['phòng', 'room', 'loại phòng', 'các phòng', 'có phòng', 'phòng nào', 'còn phòng'], excludeKeywords: ['hình', 'ảnh', 'đặt', 'huỷ', 'hủy'], weight: 10 },
  { intent: 'location', keywords: ['địa chỉ', 'ở đâu', 'location', 'chỗ nào', 'đường nào', 'quận', 'vị trí', 'map', 'bản đồ'], weight: 10 },
  { intent: 'payment', keywords: ['thanh toán', 'payment', 'trả tiền', 'chuyển khoản', 'momo', 'vnpay', 'visa', 'thẻ'], weight: 10 },
  { intent: 'hourly', keywords: ['thuê giờ', 'theo giờ', 'hourly', 'vài giờ', 'nghỉ trưa'], weight: 10 },
  { intent: 'pet', keywords: ['thú cưng', 'pet', 'chó', 'mèo'], weight: 10 },
  { intent: 'checkin', keywords: ['giờ nhận', 'giờ trả', 'giờ check', 'mấy giờ', 'sớm', 'muộn'], weight: 9 },
  { intent: 'promo', keywords: ['khuyến mãi', 'giảm giá', 'deal', 'voucher', 'ưu đãi', 'rẻ'], weight: 8 },
  { intent: 'amenities', keywords: ['tiện ích', 'amenities', 'wifi', 'hồ bơi', 'gym', 'spa', 'đỗ xe', 'parking', 'có gì', 'dịch vụ'], weight: 8 },
  { intent: 'contact', keywords: ['hotline', 'liên hệ', 'contact', 'số điện thoại', 'phone', 'email', 'gọi'], weight: 8 },
  { intent: 'review', keywords: ['review', 'đánh giá', 'feedback', 'rating'], weight: 8 },
  { intent: 'thanks', keywords: ['cảm ơn', 'thanks', 'thank', 'cám ơn', 'tks', 'ok'], weight: 2, maxMsgLength: 30 },
  { intent: 'greeting', keywords: ['hi', 'hello', 'xin chào', 'chào bạn', 'chào', 'alo', 'hey'], weight: 2, maxMsgLength: 30 },
];

/** Detect if message contains dates like 17/05, 2025-05-17, ngày 17, etc. */
function containsDate(msg: string): boolean {
  return /\d{1,2}[\/\-\.]\d{1,2}/.test(msg) || /ngày\s*\d{1,2}/.test(msg) || /\d{1,2}\s*tháng\s*\d{1,2}/.test(msg);
}

function detectIntent(msg: string): { intent: Intent; score: number } {
  const msgL = msg.toLowerCase().trim();
  const msgNorm = removeDiacritics(msgL);

  // Date detection takes priority — if message has dates + "check" or "phòng", it's about availability
  if (containsDate(msgL)) {
    const hasCheckKeywords = countMatches(msgL, msgNorm, ['check', 'phòng', 'room', 'ngày', 'đêm', 'ở', 'thuê', 'out', 'in']);
    if (hasCheckKeywords > 0) {
      return { intent: 'check_dates', score: 20 };
    }
  }

  let bestIntent: Intent = 'unknown';
  let bestScore = 0;

  for (const rule of INTENT_RULES) {
    if (rule.maxMsgLength && msgL.length > rule.maxMsgLength) continue;

    const matches = countMatches(msgL, msgNorm, rule.keywords);
    if (matches === 0) continue;

    let penalty = 0;
    if (rule.excludeKeywords) {
      penalty = countMatches(msgL, msgNorm, rule.excludeKeywords) * 10;
    }

    const score = matches * rule.weight - penalty;
    if (score > bestScore) {
      bestScore = score;
      bestIntent = rule.intent;
    }
  }

  // Detect branch selection: "1", "2", "chi nhánh 1", "bạch đằng", etc.
  if (bestIntent === 'unknown' && msgL.length < 50) {
    const branches = getAllBranches();
    for (let i = 0; i < branches.length; i++) {
      const num = String(i + 1);
      const nameL = branches[i].name.toLowerCase();
      if (msgL === num || msgL.includes(nameL) || removeDiacritics(msgL).includes(removeDiacritics(nameL))) {
        return { intent: 'branch_select', score: 20 };
      }
    }
  }

  return { intent: bestIntent, score: bestScore };
}

/* ═══════════════════════════════════════════
   FAQ HANDLERS — Data-driven responses
   ═══════════════════════════════════════════ */

interface FaqResult {
  reply: string;
  intent: Intent;
  images?: Array<{ title: string; subtitle: string; image_url: string }>;
}

function handleGreeting(hotelName: string, senderName?: string): FaqResult {
  const branches = getAllBranches();
  const greeting = senderName ? `Chào ${senderName}! 👋` : 'Chào bạn! 👋';

  if (branches.length > 1) {
    const branchList = branches.map((b, i) =>
      `${i + 1}️⃣ *${b.name}*${b.address ? `\n   📍 ${b.address}` : ''}${b.phone ? ` | 📞 ${b.phone}` : ''}`
    ).join('\n\n');

    return {
      reply: `${greeting} Cảm ơn bạn đã liên hệ!\n\nChúng mình hiện có ${branches.length} chi nhánh:\n\n${branchList}\n\n👉 Bạn muốn tìm hiểu chi nhánh nào? Gõ số (1, 2...) hoặc tên chi nhánh nhé!`,
      intent: 'greeting',
    };
  }

  return {
    reply: `${greeting} Cảm ơn bạn đã nhắn tin cho ${hotelName}!\n\nMình có thể giúp bạn:\n💰 Xem giá phòng\n📸 Xem hình phòng\n📅 Đặt phòng nhanh\n📍 Địa chỉ & tiện ích\n⏰ Check-in / Check-out\n\nBạn cần tư vấn gì ạ?`,
    intent: 'greeting',
  };
}

/** Fetch rooms from OTA real-time (when cache is empty) */
async function fetchRoomsRealtime(hotelId: number): Promise<any[]> {
  try {
    const mktHotel = db.prepare(`SELECT ota_hotel_id FROM mkt_hotels WHERE id = ?`).get(hotelId) as any;
    const otaId = mktHotel?.ota_hotel_id;
    if (!otaId || !getOtaDbConfig()) return [];
    const roomTypes = await getOtaRoomTypes(otaId);
    return roomTypes.map(rt => ({
      name: rt.name,
      base_price: rt.base_price,
      hourly_price: rt.hourly_price,
      max_guests: rt.max_guests,
      bed_type: rt.bed_type,
      room_count: rt.room_count,
      available_count: rt.available_count,
    }));
  } catch { return []; }
}

async function handleFaq(intent: Intent, msg: string, hotelId: number, senderName?: string): Promise<FaqResult | null> {
  const msgL = msg.toLowerCase().trim();
  const msgNorm = removeDiacritics(msgL);
  const { hotel, rooms: cachedRooms, hotelCache } = getHotelCache(hotelId);
  const hotelName = hotel?.name || 'Khách sạn';

  // Nếu cache trống → fetch real-time từ OTA
  let rooms = cachedRooms;
  if (rooms.length === 0 && ['price', 'rooms', 'room_images', 'branch_select', 'hourly', 'check_dates'].includes(intent)) {
    rooms = await fetchRoomsRealtime(hotelId);
  }

  switch (intent) {
    case 'greeting':
      return handleGreeting(hotelName, senderName);

    case 'branch_select': {
      const branches = getAllBranches();
      for (let i = 0; i < branches.length; i++) {
        const num = String(i + 1);
        const nameL = branches[i].name.toLowerCase();
        if (msgL === num || msgL.includes(nameL) || removeDiacritics(msgL).includes(removeDiacritics(nameL))) {
          const b = branches[i];
          let bRooms = getHotelCache(b.id).rooms;
          if (bRooms.length === 0) bRooms = await fetchRoomsRealtime(b.id);
          let roomInfo = '';
          if (bRooms.length > 0) {
            roomInfo = '\n\n💰 Các loại phòng:\n' + bRooms.map((r: any) =>
              `• ${r.name} — ${r.base_price?.toLocaleString('vi-VN')}₫/đêm (${r.max_guests} khách)`
            ).join('\n');
          }
          return {
            reply: `🏨 ${b.name}\n${b.address ? `📍 ${b.address}\n` : ''}${b.phone ? `📞 ${b.phone}\n` : ''}${roomInfo}\n\nBạn muốn:\n💰 Xem giá chi tiết → gõ "giá"\n📸 Xem hình phòng → gõ "hình"\n📅 Đặt phòng → gõ "đặt phòng"\n\nHoặc hỏi bất kỳ thông tin nào nhé!`,
            intent: 'branch_select',
          };
        }
      }
      return null;
    }

    // ── Khách gửi ngày check-in/out → check phòng trống ──
    case 'check_dates': {
      if (rooms.length > 0) {
        const roomList = rooms.map((r: any) => {
          const avail = r.available_count ?? r.room_count ?? '?';
          return `🏨 ${r.name} — ${r.base_price?.toLocaleString('vi-VN')}₫/đêm | Còn ${avail} phòng`;
        }).join('\n');
        return {
          reply: `📅 Phòng trống tại ${hotelName}:\n\n${roomList}\n\n✅ Bạn muốn đặt phòng nào? Nhắn tên phòng hoặc gõ "đặt phòng" nhé!`,
          intent: 'check_dates',
        };
      }
      return null; // Fall through to AI
    }

    case 'room_images': {
      const roomImgs = getRoomImages(hotelId);
      if (roomImgs.length > 0) {
        const grouped: Record<string, any[]> = {};
        for (const img of roomImgs) {
          if (!grouped[img.room_type_name]) grouped[img.room_type_name] = [];
          grouped[img.room_type_name].push(img);
        }
        const images = roomImgs.map((img: any) => ({
          title: img.room_type_name, subtitle: img.caption || hotelName, image_url: img.image_url,
        }));
        const roomList = Object.keys(grouped).map(name => `📸 ${name} (${grouped[name].length} ảnh)`).join('\n');
        return { reply: `📸 Hình ảnh phòng tại ${hotelName}:\n\n${roomList}\n\nMời bạn xem 👇`, intent: 'room_images', images };
      }
      if (rooms.length > 0) {
        const roomList = rooms.map((r: any) => `🏨 ${r.name}: ${r.base_price?.toLocaleString('vi-VN')}₫/đêm`).join('\n');
        return { reply: `Các loại phòng tại ${hotelName}:\n\n${roomList}\n\n📲 Liên hệ mình để được gửi ảnh trực tiếp!`, intent: 'room_images' };
      }
      return { reply: `📸 Cho mình biết bạn quan tâm loại phòng nào, mình gửi ảnh cho nhé!`, intent: 'room_images' };
    }

    case 'price': {
      if (rooms.length > 0) {
        const roomList = rooms.map((r: any) => {
          let line = `💰 ${r.name} — ${r.base_price?.toLocaleString('vi-VN')}₫/đêm`;
          if (r.hourly_price) line += ` | Giờ: ${r.hourly_price.toLocaleString('vi-VN')}₫`;
          if (r.max_guests) line += ` | ${r.max_guests} khách`;
          const avail = r.available_count ?? r.room_count;
          if (avail !== undefined && avail > 0) line += ` | Còn ${avail} phòng`;
          return line;
        }).join('\n');
        return { reply: `💰 Bảng giá ${hotelName}:\n\n${roomList}\n\n✅ Giá tốt nhất khi đặt trực tiếp!\nBạn muốn đặt phòng nào ạ?`, intent: 'price' };
      }
      return { reply: `💰 Nhắn mình ngày check-in, mình báo giá phòng mới nhất nhé!`, intent: 'price' };
    }

    case 'rooms': {
      if (rooms.length > 0) {
        const roomList = rooms.map((r: any) => {
          let line = `🏨 ${r.name} — ${r.base_price?.toLocaleString('vi-VN')}₫/đêm | ${r.max_guests} khách`;
          if (r.bed_type) line += ` | ${r.bed_type}`;
          return line;
        }).join('\n');
        return { reply: `🏨 Các loại phòng tại ${hotelName}:\n\n${roomList}\n\nGõ "giá" xem chi tiết hoặc "hình" xem ảnh phòng!`, intent: 'rooms' };
      }
      return { reply: `🏨 Nhắn mình ngày check-in để kiểm tra phòng trống nhé!`, intent: 'rooms' };
    }

    case 'checkin': {
      const checkIn = hotelCache?.check_in_time || '14:00';
      const checkOut = hotelCache?.check_out_time || '12:00';
      if (msgContains(msgL, msgNorm, ['sớm', 'early', 'trước'])) {
        return { reply: `⏰ Check-in tiêu chuẩn: ${checkIn}\n\nNhận sớm tùy phòng trống:\n• Trước 2h: +30%\n• Trước 4h: +50%\n\nBạn muốn check-in lúc mấy giờ?`, intent: 'checkin' };
      }
      if (msgContains(msgL, msgNorm, ['muộn', 'trễ', 'late'])) {
        return { reply: `⏰ Check-out tiêu chuẩn: ${checkOut}\n\nTrả muộn:\n• +2h: +30%\n• +4h: +50%\n• Sau 18:00: +1 đêm\n\nBạn cần trả muộn đến mấy giờ?`, intent: 'checkin' };
      }
      return { reply: `🕐 ${hotelName}:\n⬆️ Check-in: ${checkIn}\n⬇️ Check-out: ${checkOut}\n\nCần nhận sớm/trả muộn? Nhắn mình nhé!`, intent: 'checkin' };
    }

    case 'location': {
      if (hotelCache) {
        const parts = [hotelCache.address, hotelCache.district, hotelCache.city].filter(Boolean);
        return { reply: `📍 ${hotelName}:\n🏨 ${parts.join(', ') || 'Liên hệ mình nhé'}\n${hotelCache.phone ? `📞 ${hotelCache.phone}` : ''}\n\nBạn cần chỉ đường không ạ?`, intent: 'location' };
      }
      return { reply: `📍 Liên hệ mình để biết địa chỉ ${hotelName} nhé!`, intent: 'location' };
    }

    case 'amenities': {
      if (hotelCache?.amenities) {
        let amenities: string[] = [];
        try {
          const parsed = typeof hotelCache.amenities === 'string' ? JSON.parse(hotelCache.amenities) : hotelCache.amenities;
          amenities = Array.isArray(parsed) ? parsed : Object.keys(parsed).filter(k => parsed[k]);
        } catch {}
        if (amenities.length > 0) {
          const emojiMap: Record<string, string> = { 'wifi': '📶', 'pool': '🏊', 'gym': '💪', 'spa': '🧖', 'parking': '🅿️', 'restaurant': '🍽️', 'elevator': '🛗', 'ac': '❄️', 'reception': '👨‍💼' };
          const formatted = amenities.slice(0, 10).map(a => {
            const key = a.toLowerCase().replace(/\s+/g, '');
            const emoji = Object.entries(emojiMap).find(([k]) => key.includes(k))?.[1] || '✅';
            return `${emoji} ${a}`;
          }).join('\n');
          return { reply: `🏨 Tiện ích ${hotelName}:\n\n${formatted}`, intent: 'amenities' };
        }
      }
      return { reply: `🏨 ${hotelName} có đầy đủ tiện nghi. Hỏi cụ thể mình nhé!`, intent: 'amenities' };
    }

    case 'booking':
      return { reply: `📲 Đặt phòng ${hotelName}:\n\n1️⃣ Cho mình biết: ngày check-in, số đêm, số khách\n2️⃣ Mình báo giá & phòng trống\n3️⃣ Xác nhận 30 giây!\n\n✅ Thanh toán tại nơi • Huỷ miễn phí\n\nBạn muốn đặt ngày nào?`, intent: 'booking' };

    case 'payment':
      return { reply: `💳 Thanh toán ${hotelName}:\n\n✅ Tại nơi lưu trú\n💚 Chuyển khoản\n💳 Visa / Mastercard\n📱 VNPay, MoMo\n\nKhông phụ phí ẩn.`, intent: 'payment' };

    case 'cancel':
      return { reply: `🔄 Huỷ phòng ${hotelName}:\n\n✅ Huỷ miễn phí trước ngày check-in\n\nCần huỷ? Nhắn mã booking!`, intent: 'cancel' };

    case 'promo':
      return { reply: `🎉 ${hotelName}:\n\n🔥 Giá tốt nhất khi đặt trực tiếp!\n💎 Ưu đãi riêng cho khách quen\n\nInbox ngày check-in, mình check deal!`, intent: 'promo' };

    case 'contact': {
      const phone = hotelCache?.phone || '';
      return { reply: `📞 ${hotelName}:\n${phone ? `📱 ${phone}\n` : ''}💬 Nhắn tại đây — hỗ trợ 24/7!`, intent: 'contact' };
    }

    case 'hourly': {
      const hourlyRooms = rooms.filter((r: any) => r.hourly_price);
      if (hourlyRooms.length > 0) {
        const list = hourlyRooms.map((r: any) => `⏰ ${r.name}: ${r.hourly_price.toLocaleString('vi-VN')}₫/giờ`).join('\n');
        return { reply: `⏰ Theo giờ tại ${hotelName}:\n\n${list}\n\nNhắn ngày + giờ cần nhé!`, intent: 'hourly' };
      }
      return { reply: `⏰ ${hotelName} hỗ trợ theo giờ! Nhắn ngày + giờ cần nhé!`, intent: 'hourly' };
    }

    case 'pet':
      return { reply: `🐾 Thú cưng tại ${hotelName}: Liên hệ mình để hỏi chính sách cụ thể cho loại phòng bạn chọn ạ.`, intent: 'pet' };

    case 'review':
      return { reply: `⭐ ${hotelName}${hotelCache?.star_rating ? ` (${hotelCache.star_rating} sao)` : ''}: Xem đánh giá trên Google Maps hoặc Booking.com nhé!`, intent: 'review' };

    case 'thanks':
      return { reply: `Không có gì ạ! 😊 Cần thêm gì cứ nhắn mình nhé! 🏨`, intent: 'thanks' };

    default:
      return null;
  }
}

/* ═══════════════════════════════════════════
   TẦNG 2: WIKI SEARCH
   ═══════════════════════════════════════════ */

function searchWikiDirect(message: string): string | null {
  const keywords = message.toLowerCase().split(/\s+/).filter((w) => w.length > 2).slice(0, 5);
  if (keywords.length === 0) return null;

  const allWiki = db
    .prepare(`SELECT title, content FROM knowledge_wiki WHERE content IS NOT NULL AND length(content) > 10`)
    .all() as Array<{ title: string; content: string }>;

  let bestEntry: { title: string; content: string } | null = null;
  let bestScore = 0;

  for (const entry of allWiki) {
    const text = (entry.title + ' ' + entry.content).toLowerCase();
    let score = 0;
    for (const kw of keywords) { if (text.includes(kw)) score++; }
    if (score / keywords.length >= 0.5 && score > bestScore) {  // Tăng threshold từ 0.4 → 0.5
      bestScore = score;
      bestEntry = entry;
    }
  }

  if (!bestEntry) return null;
  const content = bestEntry.content;
  return `📋 ${bestEntry.title}:\n\n${content.slice(0, 400)}${content.length > 400 ? '...' : ''}\n\n💬 Bạn cần biết thêm gì?`;
}

/* ═══════════════════════════════════════════
   TẦNG 3: AI — Context-Aware (Lightweight + Full)
   ═══════════════════════════════════════════ */

const REPLY_SYSTEM = `Bạn là nhân viên tư vấn khách sạn chuyên nghiệp tại Việt Nam.
QUY TẮC:
- Trả lời tiếng Việt, ngắn gọn 2-5 câu, thân thiện
- Đọc LỊCH SỬ HỘI THOẠI để hiểu ngữ cảnh — KHÔNG hỏi lại thông tin khách đã nói
- Dựa vào DỮ LIỆU KHÁCH SẠN bên dưới để trả lời CHÍNH XÁC
- KHÔNG tự bịa giá, số liệu
- Nếu không biết → "Để mình kiểm tra và báo lại bạn nhé!"
- Dùng 1-2 emoji phù hợp
- Cuối câu luôn gợi ý bước tiếp theo cho khách`;

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
      parts.push('PHÒNG:');
      for (const rt of roomTypes) {
        parts.push(`- ${rt.name}: ${rt.base_price.toLocaleString('vi-VN')}₫/đêm | ${rt.max_guests} khách | Còn ${rt.available_count}/${rt.room_count}`);
      }
    }
    if (stats) {
      parts.push(`TRẠNG THÁI: ${stats.available_rooms}/${stats.total_rooms} trống | ${stats.occupancy_rate}% công suất`);
    }
    return parts.join('\n');
  } catch { return ''; }
}

function buildConversationContext(history: Array<{ role: string; message: string }>): string {
  if (history.length === 0) return '';
  const lines = history.map(h => `${h.role === 'user' ? 'Khách' : 'Bot'}: ${h.message}`);
  return `--- LỊCH SỬ HỘI THOẠI ---\n${lines.join('\n')}\n--- HẾT ---`;
}

async function aiReplyWithContext(
  message: string,
  history: Array<{ role: string; message: string }>,
  hotelId: number = 1,
  lightweight: boolean = false
): Promise<string> {
  const [wikiCtx, otaCtx] = await Promise.all([
    buildContext(message),
    buildOtaContext(hotelId),
  ]);

  const convoCtx = buildConversationContext(history);

  // Lightweight = dùng reply_simple (Gemma/Groq, ~500ms)
  // Full = dùng reply_complex (Claude/Gemini, 3-15s)
  const task: TaskType = lightweight ? 'reply_simple' : 'reply_complex';

  const contextParts = [
    convoCtx,
    wikiCtx ? `--- KIẾN THỨC ---\n${wikiCtx}\n--- HẾT ---` : '',
    otaCtx ? `--- DỮ LIỆU KHÁCH SẠN ---\n${otaCtx}\n--- HẾT ---` : '',
  ].filter(Boolean).join('\n\n');

  return generate({
    task,
    system: REPLY_SYSTEM,
    user: `${contextParts}\n\nKhách viết: "${message}"\n\nTrả lời ngắn gọn, đúng ngữ cảnh:`,
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
  hotelId?: number,
  pageId?: number
): Promise<SmartReplyResult> {
  const t0 = Date.now();
  const msg = message.trim();
  const hid = hotelId || 1;
  const pid = pageId || 0;

  // Save user message to memory
  if (senderId) {
    saveMessage(senderId, pid, 'user', msg);
  }

  // Booking flow (highest priority)
  if (senderId) {
    if (hasImage) {
      const result = markTransferReceived(senderId);
      if (result) {
        saveMessage(senderId, pid, 'bot', result.reply, 'transfer');
        return { reply: result.reply, tier: 'rules', latency_ms: Date.now() - t0, intent: 'transfer' };
      }
    }
    if (hasActiveBooking(senderId)) {
      const reply = processBookingStep(senderId, msg, senderName);
      saveMessage(senderId, pid, 'bot', reply, 'booking');
      return { reply, tier: 'rules', latency_ms: Date.now() - t0, intent: 'booking' };
    }
    if (isBookingIntent(msg)) {
      const reply = processBookingStep(senderId, msg, senderName);
      saveMessage(senderId, pid, 'bot', reply, 'booking');
      return { reply, tier: 'rules', latency_ms: Date.now() - t0, intent: 'booking' };
    }
  }

  return smartReply(msg, hid, senderId, senderName, pid);
}

export async function smartReply(
  message: string,
  hotelId: number = 1,
  senderId?: string,
  senderName?: string,
  pageId?: number
): Promise<SmartReplyResult> {
  const t0 = Date.now();
  const msg = message.trim();

  if (msg.length <= 1) {
    const reply = 'Chào bạn! Bạn cần tư vấn gì ạ? 😊';
    if (senderId) saveMessage(senderId, pageId || 0, 'bot', reply, 'greeting');
    return { reply, tier: 'rules', latency_ms: 0, intent: 'greeting' };
  }

  // Get conversation history for context
  const history = senderId ? getConversationHistory(senderId) : [];
  const isFirst = senderId ? isFirstMessage(senderId) : true;

  // ── Detect intent ──
  const { intent, score } = detectIntent(msg);

  // ── First message → always show greeting with branches ──
  if (isFirst && (intent === 'greeting' || intent === 'unknown')) {
    const hotelRow = db.prepare(`SELECT name FROM mkt_hotels WHERE id = ?`).get(hotelId) as any;
    const hName = hotelRow?.name || 'Khách sạn';
    const result = handleGreeting(hName, senderName);
    if (senderId) saveMessage(senderId, pageId || 0, 'bot', result.reply, 'greeting');
    return { reply: result.reply, tier: 'rules', latency_ms: Date.now() - t0, intent: 'greeting' };
  }

  // ── FAQ match (score > 0) → instant response ──
  if (intent !== 'unknown' && score > 0) {
    const faqResult = await handleFaq(intent, msg, hotelId, senderName);
    if (faqResult) {
      if (senderId) saveMessage(senderId, pageId || 0, 'bot', faqResult.reply, faqResult.intent);
      return {
        reply: faqResult.reply,
        tier: 'rules',
        latency_ms: Date.now() - t0,
        intent: faqResult.intent,
        images: faqResult.images,
      };
    }
  }

  // ── Wiki search ──
  const wikiReply = searchWikiDirect(msg);
  if (wikiReply) {
    if (senderId) saveMessage(senderId, pageId || 0, 'bot', wikiReply, 'wiki');
    return { reply: wikiReply, tier: 'wiki', latency_ms: Date.now() - t0, intent: 'wiki' };
  }

  // ── AI with context ──
  // Short/simple questions → Lightweight AI (Gemma/Groq, ~500ms)
  // Long/complex questions → Full AI (Claude/Gemini, 3-15s)
  try {
    // Dùng lightweight AI cho hầu hết chat (nhanh ~300ms)
    // Chỉ dùng full AI cho câu dài > 150 ký tự
    const isSimple = msg.length < 150;
    const reply = await aiReplyWithContext(msg, history, hotelId, isSimple);
    const tier = isSimple ? 'ai_light' : 'ai';
    if (senderId) saveMessage(senderId, pageId || 0, 'bot', reply, 'ai');
    return { reply, tier: tier as any, latency_ms: Date.now() - t0, intent: 'ai' };
  } catch (e: any) {
    console.error('[smartreply] AI fail:', e.message);
    const fallback = `Cảm ơn bạn! 😊 Mình sẽ kiểm tra và phản hồi sớm nhất nhé.`;
    if (senderId) saveMessage(senderId, pageId || 0, 'bot', fallback, 'error');
    return { reply: fallback, tier: 'rules', latency_ms: Date.now() - t0, intent: 'error' };
  }
}

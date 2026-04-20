import { db } from '../db';
import { generate } from './router';
import { buildContext } from './wiki';
import {
  isBookingIntent,
  hasActiveBooking,
  processBookingStep,
  markTransferReceived,
} from './bookingflow';
import { getOtaDbConfig, getOtaRoomTypes, getOtaHotelStats } from './ota-db';
import { notifyAll } from './telegram';
import { lookupLearned, recordQA } from './learning';

/**
 * Smart Reply Engine v4 — RAG + AI Intent Classification + Structured Output
 *
 * ARCHITECTURE (6 IMPROVEMENTS):
 *   1) RAG — AI chỉ trả lời dựa trên context thực (OTA DB + wiki), KHÔNG hallucinate
 *   2) FSM narrow-scope system prompts — mỗi state có prompt riêng, hẹp
 *   3) AI Intent Classifier — chạy TRƯỚC generation (Gemma/Flash, temp 0.2, JSON output)
 *   4) Structured JSON + confidence — validate output, reject hallucination markers
 *   5) Few-shot examples — bao gồm negative examples để bot học từ chối đúng cách
 *   6) Temperature thấp 0.2-0.3 — nhất quán, giảm bịa
 *
 * FALLBACK FLOW:
 *   Confidence thấp hoặc >3 turns không chốt booking → xin số điện thoại →
 *   lưu customer_contacts + notify staff via Telegram → friendly closing
 */

export interface SmartReplyResult {
  reply: string;
  tier: 'rules' | 'wiki' | 'ai' | 'ai_light' | 'phone_capture' | 'closing' | 'learned';
  latency_ms: number;
  intent?: string;
  confidence?: number;
  images?: Array<{ title: string; subtitle: string; image_url: string }>;
}

/* ═══════════════════════════════════════════
   CONVERSATION MEMORY
   ═══════════════════════════════════════════ */

const MAX_HISTORY = 8;

function saveMessage(senderId: string, pageId: number, role: 'user' | 'bot', message: string, intent?: string) {
  try {
    db.prepare(
      `INSERT INTO conversation_memory (sender_id, page_id, role, message, intent, created_at) VALUES (?, ?, ?, ?, ?, ?)`
    ).run(senderId, pageId, role, message.slice(0, 500), intent || null, Date.now());
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
  } catch { return []; }
}

function countUserTurns(senderId: string): number {
  try {
    const row = db.prepare(
      `SELECT COUNT(*) as cnt FROM conversation_memory WHERE sender_id = ? AND role = 'user'`
    ).get(senderId) as any;
    return row?.cnt || 0;
  } catch { return 0; }
}

function hasBookingProgress(senderId: string): boolean {
  try {
    const row = db.prepare(
      `SELECT COUNT(*) as cnt FROM conversation_memory WHERE sender_id = ?
       AND intent IN ('booking', 'transfer', 'check_dates')`
    ).get(senderId) as any;
    return (row?.cnt || 0) > 0;
  } catch { return false; }
}

function isFirstMessage(senderId: string): boolean {
  try {
    const row = db.prepare(
      `SELECT COUNT(*) as cnt FROM conversation_memory WHERE sender_id = ?`
    ).get(senderId) as any;
    return (row?.cnt || 0) <= 1;
  } catch { return true; }
}

function alreadyCapturedPhone(senderId: string): boolean {
  try {
    const row = db.prepare(
      `SELECT id FROM customer_contacts WHERE sender_id = ? LIMIT 1`
    ).get(senderId) as any;
    return !!row;
  } catch { return false; }
}

/* ═══════════════════════════════════════════
   HELPERS
   ═══════════════════════════════════════════ */

function removeDiacritics(str: string): string {
  return str.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D');
}

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
  } catch { return []; }
}

async function fetchRoomsRealtime(hotelId: number): Promise<any[]> {
  try {
    const mktHotel = db.prepare(`SELECT ota_hotel_id FROM mkt_hotels WHERE id = ?`).get(hotelId) as any;
    const otaId = mktHotel?.ota_hotel_id;
    if (!otaId || !getOtaDbConfig()) return [];
    const roomTypes = await getOtaRoomTypes(otaId);
    return roomTypes.map(rt => ({
      name: rt.name, base_price: rt.base_price, hourly_price: rt.hourly_price,
      max_guests: rt.max_guests, bed_type: rt.bed_type,
      room_count: rt.room_count, available_count: rt.available_count,
    }));
  } catch { return []; }
}

/* ═══════════════════════════════════════════
   PHONE CAPTURE
   ═══════════════════════════════════════════ */

// Vietnamese phone: 10-11 digits, starts with 0 or +84, allows spaces/dots/dashes
const PHONE_REGEX = /(?:\+?84|0)[\s.\-]?\d{2,3}[\s.\-]?\d{3,4}[\s.\-]?\d{3,4}/g;

function extractPhone(msg: string): string | null {
  const matches = msg.match(PHONE_REGEX);
  if (!matches) return null;
  for (const m of matches) {
    const digits = m.replace(/\D/g, '');
    if (digits.length >= 9 && digits.length <= 12) {
      return digits.startsWith('84') ? '0' + digits.slice(2) : digits;
    }
  }
  return null;
}

async function capturePhone(
  senderId: string, senderName: string | undefined, phone: string,
  lastMessage: string, lastIntent: string | null,
  history: Array<{ role: string; message: string }>,
  pageId: number, hotelId: number,
): Promise<void> {
  try {
    db.prepare(
      `INSERT INTO customer_contacts
       (sender_id, sender_name, phone, page_id, hotel_id, last_intent, last_message, context, notified_staff, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`
    ).run(
      senderId, senderName || null, phone, pageId, hotelId,
      lastIntent || null, lastMessage.slice(0, 500),
      JSON.stringify(history.slice(-6)), Date.now(),
    );

    // Persist phone vào guest profile
    try {
      const { upsertGuest } = require('./guest-memory');
      upsertGuest(hotelId, senderId, { phone, name: senderName });
    } catch {}

    const hotel = db.prepare(`SELECT name FROM mkt_hotels WHERE id = ?`).get(hotelId) as any;
    const hName = hotel?.name || 'Khach san';
    const msg = [
      `🔔 *KHÁCH MỚI CẦN HỖ TRỢ* — ${hName}`,
      `👤 ${senderName || 'Khách'}  |  📞 *${phone}*`,
      `💬 "${lastMessage.slice(0, 200)}"`,
      lastIntent ? `🎯 Intent: ${lastIntent}` : '',
      `⏰ ${new Date().toLocaleString('vi-VN')}`,
    ].filter(Boolean).join('\n');

    notifyAll(msg).catch(() => {});

    db.prepare(`UPDATE customer_contacts SET notified_staff = 1 WHERE sender_id = ? AND phone = ?`).run(senderId, phone);
  } catch (e: any) {
    console.error('[smartreply] capturePhone failed:', e.message);
  }
}

function requestPhoneReply(senderName?: string): string {
  const name = senderName ? ` ${senderName}` : '';
  return `Cảm ơn${name} đã quan tâm ạ! 💚\n\nĐể team tư vấn hỗ trợ nhanh & chính xác nhất — đặc biệt về giá tốt, phòng trống và ưu đãi riêng — bạn cho mình xin *số điện thoại* nhé? Bên mình sẽ gọi lại trong vài phút thôi ạ. 📞`;
}

// Phát hiện phản hồi tiêu cực / khó hiểu / bức xúc từ khách
// → Trigger xin SĐT NGAY (không đợi 3 lượt)
const NEGATIVE_MARKERS = [
  // confusion / unclear
  'ủa', 'hả', 'gì vậy', 'gì thế', 'không hiểu', 'khong hieu', 'hiểu chết liền',
  'nói gì', 'là sao', 'sao vậy', 'sao thế', 'chả hiểu',
  // dissatisfaction
  'chán', 'tệ', 'dở', 'kém', 'thất vọng', 'bực', 'bức xúc',
  'không ổn', 'khong on', 'không hài lòng', 'khong hai long',
  'không đúng', 'khong dung', 'sai rồi', 'sai roi',
  // giving up
  'thôi', 'bỏ qua', 'khỏi', 'không cần', 'khong can',
  'mệt', 'phiền', 'rắc rối',
  // robotic / bot complaint
  'máy móc', 'như máy', 'bot', 'robot', 'trả lời tự động',
  'không trả lời được', 'tự động',
];

function isNegativeResponse(msg: string): boolean {
  const m = msg.toLowerCase().trim();
  if (m.length === 0 || m.length > 80) return false;
  const n = removeDiacritics(m);
  for (const marker of NEGATIVE_MARKERS) {
    if (m.includes(marker) || n.includes(removeDiacritics(marker))) return true;
  }
  return false;
}

function friendlyClosing(senderName?: string): string {
  const name = senderName ? ` ${senderName}` : ' bạn';
  return `Cảm ơn${name} đã tin tưởng tụi mình nhé! 💚\nMong sớm được đón${name} tại khách sạn. Chúc${name} một ngày thật nhiều năng lượng và niềm vui! ☀️✨`;
}

/* ═══════════════════════════════════════════
   AI INTENT CLASSIFIER (Bước 1 — chạy TRƯỚC)
   ═══════════════════════════════════════════ */

type Intent =
  | 'greeting' | 'price' | 'rooms' | 'room_images' | 'booking' | 'checkin'
  | 'check_dates' | 'location' | 'amenities' | 'payment' | 'cancel' | 'promo'
  | 'hourly' | 'contact' | 'pet' | 'review' | 'thanks' | 'branch_select'
  | 'phone_provided' | 'complaint' | 'unknown';

interface IntentResult {
  intent: Intent;
  confidence: number;         // 0..1
  entities: {
    dates?: string;
    guests?: number;
    room_type?: string;
    branch?: string;
    phone?: string;
  };
  emotion: 'neutral' | 'positive' | 'frustrated' | 'urgent';
  reasoning?: string;
}

const INTENT_CLASSIFIER_SYSTEM = `Bạn là bộ phân loại ý định (intent classifier) cho chatbot khách sạn Việt Nam.
NHIỆM VỤ: Đọc tin nhắn khách + lịch sử chat, xuất JSON DUY NHẤT (không giải thích thêm).

INTENTS (chọn đúng 1):
- greeting: chào hỏi đầu tiên
- price: hỏi giá, bao nhiêu tiền
- rooms: hỏi có loại phòng gì, còn phòng không
- room_images: xin hình/ảnh phòng
- booking: muốn đặt phòng, đặt ngay
- check_dates: khách báo ngày check-in/out cụ thể
- checkin: hỏi giờ nhận/trả phòng
- location: hỏi địa chỉ, ở đâu
- amenities: hỏi tiện ích (wifi, hồ bơi, đỗ xe...)
- payment: hỏi thanh toán
- cancel: hủy phòng, hoàn tiền
- promo: hỏi khuyến mãi, giảm giá
- hourly: thuê theo giờ
- contact: hỏi hotline, SĐT
- pet: mang thú cưng
- review: đánh giá
- branch_select: khách chọn chi nhánh (gõ "1", "2", tên chi nhánh)
- phone_provided: khách CUNG CẤP số điện thoại của họ
- thanks: cảm ơn, ok
- complaint: phàn nàn, bức xúc
- unknown: không rõ

FORMAT OUTPUT (JSON only, no markdown):
{"intent":"<tên>","confidence":<0..1>,"entities":{"dates":"<string|null>","guests":<number|null>,"room_type":"<string|null>","phone":"<string|null>"},"emotion":"<neutral|positive|frustrated|urgent>"}

QUY TẮC:
- confidence >= 0.8 khi chắc chắn
- confidence 0.5-0.79 khi có vài khả năng
- confidence < 0.5 khi mơ hồ → trả unknown
- NẾU tin nhắn có số điện thoại VN (0xxx hoặc +84) → intent = "phone_provided"
- NẾU khách viết "bức xúc", "tệ", "chán", "không hài lòng" → complaint
- emotion="frustrated" CHỈ khi khách THỰC SỰ bức xúc/tức giận (than phiền, mắng, chửi, "tệ quá", "quá kém", "không hài lòng", "mất thời gian", dùng nhiều "!"). TUYỆT ĐỐI KHÔNG gán frustrated cho câu hỏi thông tin trung tính chỉ vì có chữ "không" cuối câu — "không" cuối câu trong tiếng Việt chỉ là trợ từ nghi vấn ("có wifi không", "có hồ bơi không" = neutral, KHÔNG phải frustrated).
- Câu hỏi ngắn gọn, lịch sự, hỏi xin thông tin → emotion="neutral"

FEW-SHOT EXAMPLES:

Input: "giá phòng bao nhiêu vậy"
Output: {"intent":"price","confidence":0.95,"entities":{},"emotion":"neutral"}

Input: "khách sạn có wifi không"
Output: {"intent":"amenities","confidence":0.92,"entities":{},"emotion":"neutral"}

Input: "bên mình có hồ bơi không ạ"
Output: {"intent":"amenities","confidence":0.93,"entities":{},"emotion":"neutral"}

Input: "có chỗ đậu xe ô tô không"
Output: {"intent":"amenities","confidence":0.9,"entities":{},"emotion":"neutral"}

Input: "cho xem hình phòng deluxe với"
Output: {"intent":"room_images","confidence":0.92,"entities":{"room_type":"deluxe"},"emotion":"neutral"}

Input: "0987654321"
Output: {"intent":"phone_provided","confidence":0.99,"entities":{"phone":"0987654321"},"emotion":"neutral"}

Input: "17/5 check-in 2 người ở 2 đêm"
Output: {"intent":"check_dates","confidence":0.95,"entities":{"dates":"17/5","guests":2},"emotion":"neutral"}

Input: "chào bạn"
Output: {"intent":"greeting","confidence":0.98,"entities":{},"emotion":"positive"}

Input: "1"
Output: {"intent":"branch_select","confidence":0.85,"entities":{"branch":"1"},"emotion":"neutral"}

NEGATIVE EXAMPLES (đừng bịa):

Input: "ủa gì vậy"
Output: {"intent":"unknown","confidence":0.3,"entities":{},"emotion":"neutral"}

Input: "hôm qua tôi đặt rồi mà không ai gọi lại"
Output: {"intent":"complaint","confidence":0.88,"entities":{},"emotion":"frustrated"}

Input: "asdfgh"
Output: {"intent":"unknown","confidence":0.1,"entities":{},"emotion":"neutral"}`;

async function classifyIntent(
  message: string,
  history: Array<{ role: string; message: string }>,
): Promise<IntentResult> {
  const histText = history.slice(-4).map(h => `${h.role === 'user' ? 'Khách' : 'Bot'}: ${h.message}`).join('\n');
  const userPrompt = `${histText ? `Lịch sử:\n${histText}\n\n` : ''}Tin nhắn hiện tại: "${message}"\n\nJSON:`;

  try {
    const raw = await generate({ task: 'intent_gateway', system: INTENT_CLASSIFIER_SYSTEM, user: userPrompt });
    // Extract JSON
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) throw new Error('no json');
    const parsed = JSON.parse(m[0]);
    const intent: Intent = parsed.intent || 'unknown';
    const confidence = Math.max(0, Math.min(1, Number(parsed.confidence) || 0));
    return {
      intent,
      confidence,
      entities: parsed.entities || {},
      emotion: parsed.emotion || 'neutral',
      reasoning: parsed.reasoning,
    };
  } catch {
    // Fallback: keyword-based quick classify
    return keywordFallbackClassify(message);
  }
}

function keywordFallbackClassify(msg: string): IntentResult {
  const m = msg.toLowerCase().trim();
  const n = removeDiacritics(m);
  const phone = extractPhone(msg);
  if (phone) return { intent: 'phone_provided', confidence: 0.95, entities: { phone }, emotion: 'neutral' };

  const has = (kws: string[]) => kws.some(k => m.includes(k) || n.includes(removeDiacritics(k)));

  if (/\d{1,2}[\/\-\.]\d{1,2}/.test(m)) return { intent: 'check_dates', confidence: 0.7, entities: { dates: m.match(/\d{1,2}[\/\-\.]\d{1,2}/)?.[0] }, emotion: 'neutral' };
  if (has(['hình', 'ảnh', 'photo', 'xem phòng'])) return { intent: 'room_images', confidence: 0.8, entities: {}, emotion: 'neutral' };
  if (has(['giá', 'bao nhiêu', 'price'])) return { intent: 'price', confidence: 0.8, entities: {}, emotion: 'neutral' };
  if (has(['đặt phòng', 'book', 'đặt ngay'])) return { intent: 'booking', confidence: 0.8, entities: {}, emotion: 'neutral' };
  if (has(['hủy', 'huỷ', 'cancel', 'refund'])) return { intent: 'cancel', confidence: 0.8, entities: {}, emotion: 'frustrated' };
  if (has(['địa chỉ', 'ở đâu', 'location'])) return { intent: 'location', confidence: 0.8, entities: {}, emotion: 'neutral' };
  if (has(['wifi', 'hồ bơi', 'gym', 'tiện ích', 'parking'])) return { intent: 'amenities', confidence: 0.75, entities: {}, emotion: 'neutral' };
  if (has(['thanh toán', 'chuyển khoản', 'momo', 'vnpay'])) return { intent: 'payment', confidence: 0.8, entities: {}, emotion: 'neutral' };
  if (has(['khuyến mãi', 'giảm giá', 'deal', 'voucher'])) return { intent: 'promo', confidence: 0.75, entities: {}, emotion: 'neutral' };
  if (has(['theo giờ', 'thuê giờ', 'hourly'])) return { intent: 'hourly', confidence: 0.8, entities: {}, emotion: 'neutral' };
  if (has(['phòng', 'room'])) return { intent: 'rooms', confidence: 0.6, entities: {}, emotion: 'neutral' };
  if (m.length < 20 && has(['hi', 'hello', 'chào', 'alo'])) return { intent: 'greeting', confidence: 0.85, entities: {}, emotion: 'positive' };
  if (m.length < 15 && has(['cảm ơn', 'thanks', 'cám ơn', 'ok'])) return { intent: 'thanks', confidence: 0.8, entities: {}, emotion: 'positive' };
  if (/^\d{1,2}$/.test(m)) return { intent: 'branch_select', confidence: 0.7, entities: { branch: m }, emotion: 'neutral' };
  return { intent: 'unknown', confidence: 0.2, entities: {}, emotion: 'neutral' };
}

/* ═══════════════════════════════════════════
   DETERMINISTIC HANDLERS (FSM narrow-scope)
   Dùng dữ liệu tính sẵn — KHÔNG gọi AI
   ═══════════════════════════════════════════ */

interface HandlerResult {
  reply: string;
  intent: Intent;
  images?: Array<{ title: string; subtitle: string; image_url: string }>;
}

function handleGreeting(hotelName: string, senderName?: string): HandlerResult {
  const branches = getAllBranches();
  const greeting = senderName ? `Chào ${senderName}! 👋` : 'Chào bạn! 👋';
  if (branches.length > 1) {
    const branchList = branches.map((b, i) =>
      `${i + 1}️⃣ *${b.name}*${b.address ? `\n   📍 ${b.address}` : ''}${b.phone ? ` | 📞 ${b.phone}` : ''}`
    ).join('\n\n');
    return {
      reply: `${greeting} Cảm ơn bạn đã liên hệ!\n\nTụi mình hiện có ${branches.length} chi nhánh:\n\n${branchList}\n\n👉 Bạn muốn tìm hiểu chi nhánh nào? Gõ số (1, 2...) hoặc tên chi nhánh nhé!`,
      intent: 'greeting',
    };
  }
  return {
    reply: `${greeting} Cảm ơn bạn đã nhắn tin cho ${hotelName}!\n\nMình có thể giúp bạn:\n💰 Xem giá phòng\n📸 Xem hình phòng\n📅 Đặt phòng nhanh\n📍 Địa chỉ & tiện ích\n⏰ Check-in / Check-out\n\nBạn cần tư vấn gì ạ?`,
    intent: 'greeting',
  };
}

async function handleDeterministic(
  result: IntentResult, msg: string, hotelId: number, senderName?: string,
): Promise<HandlerResult | null> {
  const { intent, entities } = result;
  const msgL = msg.toLowerCase().trim();
  const msgNorm = removeDiacritics(msgL);
  const { hotel, rooms: cachedRooms, hotelCache } = getHotelCache(hotelId);
  let hotelName = hotel?.name || 'Khách sạn';

  let rooms = cachedRooms;
  if (rooms.length === 0 && ['price', 'rooms', 'room_images', 'branch_select', 'hourly', 'check_dates'].includes(intent)) {
    rooms = await fetchRoomsRealtime(hotelId);
  }

  // v7 Phase 3: Ưu tiên hotel_knowledge (AI-synthesized) nếu có
  // Chỉ override khi hotel_knowledge cho hotel_id này TỒN TẠI
  let kbUsed = false;
  try {
    const { hasKnowledge, getProfile, getRooms } = require('./hotel-knowledge');
    if (hasKnowledge(hotelId)) {
      const prof = getProfile(hotelId);
      const kbRooms = getRooms(hotelId);
      if (prof?.name_canonical) hotelName = prof.name_canonical;
      if (kbRooms && kbRooms.length > 0) {
        rooms = kbRooms.map((r: any) => ({
          name: r.display_name_vi,
          base_price: r.price_weekday,
          hourly_price: r.price_hourly,
          max_guests: r.max_guests,
          bed_type: r.bed_config,
        }));
        kbUsed = true;
      }
    }
  } catch {}
  if (kbUsed) console.log(`[smartreply] using hotel_knowledge for #${hotelId}: ${rooms.length} rooms`);

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
            reply: `🏨 ${b.name}\n${b.address ? `📍 ${b.address}\n` : ''}${b.phone ? `📞 ${b.phone}\n` : ''}${roomInfo}\n\nBạn muốn:\n💰 Xem giá chi tiết → gõ "giá"\n📸 Xem hình phòng → gõ "hình"\n📅 Đặt phòng → gõ "đặt phòng"`,
            intent: 'branch_select',
          };
        }
      }
      return null;
    }

    case 'check_dates': {
      if (rooms.length > 0) {
        const roomList = rooms.map((r: any) => {
          const avail = r.available_count ?? r.room_count ?? '?';
          return `🏨 ${r.name} — ${r.base_price?.toLocaleString('vi-VN')}₫/đêm | Còn ${avail} phòng`;
        }).join('\n');
        return {
          reply: `📅 Phòng trống tại ${hotelName}${entities.dates ? ` (${entities.dates})` : ''}:\n\n${roomList}\n\n✅ Bạn muốn đặt phòng nào? Nhắn tên phòng hoặc gõ "đặt phòng" nhé!`,
          intent: 'check_dates',
        };
      }
      return null;
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
      return null;
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
      return null;
    }

    case 'checkin': {
      let checkIn = hotelCache?.check_in_time || '14:00';
      let checkOut = hotelCache?.check_out_time || '12:00';
      try {
        const { getPolicies } = require('./hotel-knowledge');
        const p = getPolicies(hotelId);
        if (p?.checkin_time) checkIn = p.checkin_time;
        if (p?.checkout_time) checkOut = p.checkout_time;
      } catch {}
      if (msgL.includes('sớm') || msgNorm.includes('som') || msgL.includes('early')) {
        return { reply: `⏰ Check-in tiêu chuẩn: ${checkIn}\n\nNhận sớm tùy phòng trống:\n• Trước 2h: +30%\n• Trước 4h: +50%\n\nBạn muốn check-in lúc mấy giờ?`, intent: 'checkin' };
      }
      if (msgL.includes('muộn') || msgNorm.includes('muon') || msgL.includes('trễ') || msgL.includes('late')) {
        return { reply: `⏰ Check-out tiêu chuẩn: ${checkOut}\n\nTrả muộn:\n• +2h: +30%\n• +4h: +50%\n• Sau 18:00: +1 đêm`, intent: 'checkin' };
      }
      return { reply: `🕐 ${hotelName}:\n⬆️ Check-in: ${checkIn}\n⬇️ Check-out: ${checkOut}\n\nCần nhận sớm/trả muộn? Nhắn mình nhé!`, intent: 'checkin' };
    }

    case 'location': {
      // v7: Ưu tiên hotel_knowledge
      try {
        const { hasKnowledge, getProfile } = require('./hotel-knowledge');
        if (hasKnowledge(hotelId)) {
          const p = getProfile(hotelId);
          const parts = [p.address, p.district, p.city].filter(Boolean);
          return { reply: `📍 ${hotelName}:\n🏨 ${parts.join(', ') || 'Liên hệ mình nhé'}\n${p.phone ? `📞 ${p.phone}` : ''}\n\nBạn cần chỉ đường không ạ?`, intent: 'location' };
        }
      } catch {}
      if (hotelCache) {
        const parts = [hotelCache.address, hotelCache.district, hotelCache.city].filter(Boolean);
        return { reply: `📍 ${hotelName}:\n🏨 ${parts.join(', ') || 'Liên hệ mình nhé'}\n${hotelCache.phone ? `📞 ${hotelCache.phone}` : ''}\n\nBạn cần chỉ đường không ạ?`, intent: 'location' };
      }
      return null;
    }

    case 'amenities': {
      // v7: Ưu tiên hotel_amenities (AI-synthesized)
      try {
        const { hasKnowledge, getAmenities } = require('./hotel-knowledge');
        if (hasKnowledge(hotelId)) {
          const am = getAmenities(hotelId);
          if (am.length > 0) {
            const emojiMap: Record<string, string> = { wifi: '📶', pool: '🏊', gym: '💪', spa: '🧖', parking: '🅿️', restaurant: '🍽️', elevator: '🛗', ac: '❄️', bathroom: '🚿', kitchen: '🍳', breakfast: '🥐', laundry: '🧺', reception: '🛎️' };
            const formatted = am.slice(0, 12).map((a: any) => {
              const key = (a.name_vi + ' ' + (a.name_en || '') + ' ' + a.category).toLowerCase().replace(/\s+/g, '');
              const emoji = Object.entries(emojiMap).find(([k]) => key.includes(k))?.[1] || '✅';
              return `${emoji} ${a.name_vi}${a.free === 0 ? ' (có phí)' : ''}${a.hours ? ` · ${a.hours}` : ''}`;
            }).join('\n');
            return { reply: `🏨 Tiện ích ${hotelName}:\n\n${formatted}`, intent: 'amenities' };
          }
        }
      } catch {}
      // Fallback legacy
      if (hotelCache?.amenities) {
        let amenities: string[] = [];
        try {
          const parsed = typeof hotelCache.amenities === 'string' ? JSON.parse(hotelCache.amenities) : hotelCache.amenities;
          amenities = Array.isArray(parsed) ? parsed : Object.keys(parsed).filter(k => parsed[k]);
        } catch {}
        if (amenities.length > 0) {
          const emojiMap: Record<string, string> = { wifi: '📶', pool: '🏊', gym: '💪', spa: '🧖', parking: '🅿️', restaurant: '🍽️', elevator: '🛗', ac: '❄️' };
          const formatted = amenities.slice(0, 10).map(a => {
            const key = a.toLowerCase().replace(/\s+/g, '');
            const emoji = Object.entries(emojiMap).find(([k]) => key.includes(k))?.[1] || '✅';
            return `${emoji} ${a}`;
          }).join('\n');
          return { reply: `🏨 Tiện ích ${hotelName}:\n\n${formatted}`, intent: 'amenities' };
        }
      }
      return null;
    }

    case 'booking':
      return { reply: `📲 Đặt phòng ${hotelName}:\n\n1️⃣ Cho mình biết: ngày check-in, số đêm, số khách\n2️⃣ Mình báo giá & phòng trống\n3️⃣ Xác nhận 30 giây!\n\n✅ Thanh toán tại nơi • Huỷ miễn phí\n\nBạn muốn đặt ngày nào?`, intent: 'booking' };

    case 'payment':
      return { reply: `💳 Thanh toán ${hotelName}:\n\n✅ Tại nơi lưu trú\n💚 Chuyển khoản\n💳 Visa / Mastercard\n📱 VNPay, MoMo\n\nKhông phụ phí ẩn.`, intent: 'payment' };

    case 'cancel':
      return { reply: `🔄 Huỷ phòng ${hotelName}:\n\n✅ Huỷ miễn phí trước ngày check-in\n\nCần huỷ? Nhắn mã booking giúp mình nhé!`, intent: 'cancel' };

    case 'promo':
      return { reply: `🎉 ${hotelName}:\n\n🔥 Giá tốt nhất khi đặt trực tiếp!\n💎 Ưu đãi riêng cho khách quen\n\nInbox ngày check-in, mình check deal ngay!`, intent: 'promo' };

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
   RAG AI — Chỉ dùng cho câu hỏi phức tạp, BẮT BUỘC có context
   ═══════════════════════════════════════════ */

const RAG_SYSTEM = `Bạn là nhân viên tư vấn khách sạn Việt Nam. Giọng thân thiện, như hai người bạn nói chuyện.

QUY TẮC TUYỆT ĐỐI (vi phạm = sai):
1. CHỈ trả lời dựa trên NGỮ CẢNH được cung cấp bên dưới. KHÔNG suy diễn.
2. Nếu NGỮ CẢNH không có thông tin → trả lời CHÍNH XÁC: "Để mình kiểm tra và báo lại bạn nhé!"
3. KHÔNG bịa giá, số liệu, tiện ích, địa chỉ.
4. KHÔNG dùng các cụm: "theo tôi biết", "có lẽ", "khoảng chừng", "mình nghĩ là".
5. Trả lời ngắn gọn 2-4 câu, tiếng Việt tự nhiên, 1-2 emoji.
6. Đọc LỊCH SỬ HỘI THOẠI — KHÔNG hỏi lại thứ khách đã nói.
7. Cuối câu gợi ý bước tiếp theo (xem giá / xem hình / đặt phòng).`;

const HALLUCINATION_MARKERS = [
  'theo tôi biết', 'theo mình biết', 'có lẽ', 'có thể là',
  'khoảng chừng', 'tôi nghĩ là', 'mình nghĩ là', 'chắc là',
  'tôi đoán', 'mình đoán', 'hình như',
];

// Parse numeric prices mentioned in bot reply (VND pattern: "500.000₫", "1,200,000 đ", "500k", "1.5tr")
function extractPricesVND(text: string): number[] {
  const out: number[] = [];
  // Pattern 1: digits with thousand separators + đ/₫/đồng
  const re1 = /(\d[\d\.,]{2,})\s*(?:₫|đ|đồng|vnd)/gi;
  let m: RegExpExecArray | null;
  while ((m = re1.exec(text)) !== null) {
    const n = parseInt(m[1].replace(/[.,]/g, ''), 10);
    if (n >= 50_000 && n <= 50_000_000) out.push(n);
  }
  // Pattern 2: "500k", "1.5tr"
  const re2 = /(\d+(?:[.,]\d+)?)\s*(k|tr|triệu)/gi;
  while ((m = re2.exec(text)) !== null) {
    const base = parseFloat(m[1].replace(',', '.'));
    const mult = m[2].toLowerCase() === 'k' ? 1_000 : 1_000_000;
    const n = Math.round(base * mult);
    if (n >= 50_000 && n <= 50_000_000) out.push(n);
  }
  return out;
}

function validateResponse(
  reply: string,
  opts?: { validPrices?: number[] },
): { valid: boolean; reason?: string } {
  if (!reply || reply.trim().length < 5) return { valid: false, reason: 'empty' };
  const low = reply.toLowerCase();
  for (const marker of HALLUCINATION_MARKERS) {
    if (low.includes(marker)) return { valid: false, reason: `hallucination: "${marker}"` };
  }
  if (reply.length > 1200) return { valid: false, reason: 'too_long' };

  // Price cross-check: any VND amount in reply must exist in OTA rooms data.
  // Allow ±5% tolerance (rounding in AI output).
  if (opts?.validPrices && opts.validPrices.length > 0) {
    const quoted = extractPricesVND(reply);
    for (const q of quoted) {
      const matched = opts.validPrices.some((p) => Math.abs(q - p) / p <= 0.05);
      if (!matched) {
        return { valid: false, reason: `price_hallucination: ${q.toLocaleString('vi-VN')}₫ not in rooms` };
      }
    }
  }
  return { valid: true };
}

async function buildOtaContext(hotelId: number): Promise<string> {
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
    if (stats) parts.push(`TRẠNG THÁI: ${stats.available_rooms}/${stats.total_rooms} trống | ${stats.occupancy_rate}% công suất`);
    return parts.join('\n');
  } catch { return ''; }
}

async function ragReply(
  message: string,
  history: Array<{ role: string; message: string }>,
  hotelId: number,
  senderId?: string,
): Promise<string | null> {
  const [wikiCtx, otaCtx] = await Promise.all([buildContext(message, hotelId), buildOtaContext(hotelId)]);

  // STRICT RAG: nếu không có context → không gọi AI
  if (!wikiCtx && !otaCtx) return null;

  const convoCtx = history.length > 0
    ? `--- LỊCH SỬ HỘI THOẠI ---\n${history.map(h => `${h.role === 'user' ? 'Khách' : 'Bot'}: ${h.message}`).join('\n')}\n--- HẾT ---`
    : '';

  // Guest memory — "cá nhân hóa" khách quen
  let guestCtx = '';
  if (senderId) {
    try {
      const { getGuestMemorySnippet } = require('./guest-memory');
      guestCtx = getGuestMemorySnippet(hotelId, senderId);
    } catch {}
  }

  const contextParts = [
    guestCtx,
    convoCtx,
    wikiCtx ? `--- KIẾN THỨC ---\n${wikiCtx}\n--- HẾT ---` : '',
    otaCtx ? `--- DỮ LIỆU KHÁCH SẠN ---\n${otaCtx}\n--- HẾT ---` : '',
  ].filter(Boolean).join('\n\n');

  // Industry-specific system prompt (unlock vertical expansion)
  let systemPrompt = RAG_SYSTEM;

  // v6 Sprint 3: inject tone + recall hint từ dispatcher (nếu có)
  if (senderId) {
    const extra = _systemSuffixes.get(senderId);
    if (extra) {
      systemPrompt += '\n\n' + extra;
      _systemSuffixes.delete(senderId);
    }
  }
  // v7: inject Hotel Knowledge summary nếu đã synthesize
  try {
    const { hasKnowledge, getProfile, getRooms, getAmenities } = require('./hotel-knowledge');
    if (hasKnowledge(hotelId)) {
      const prof = getProfile(hotelId);
      const rooms = getRooms(hotelId);
      const amenities = getAmenities(hotelId);
      const kbChunk = [
        `--- HOTEL KNOWLEDGE (AI-synthesized) ---`,
        `Tên: ${prof.name_canonical} | ${prof.city || ''} ${prof.district || ''}`,
        prof.ai_summary_vi ? `Tóm tắt: ${prof.ai_summary_vi}` : '',
        prof.usp_top3?.length ? `USP: ${prof.usp_top3.join(' | ')}` : '',
        rooms.length ? `Phòng: ${rooms.map((r: any) => `${r.display_name_vi} — ${r.price_weekday.toLocaleString('vi-VN')}đ/đêm`).join('; ')}` : '',
        amenities.length ? `Tiện nghi: ${amenities.map((a: any) => a.name_vi).join(', ')}` : '',
        `--- HẾT ---`,
      ].filter(Boolean).join('\n');
      systemPrompt += '\n\n' + kbChunk;
    }
  } catch {}
  try {
    const hotelRow = db.prepare(`SELECT industry FROM mkt_hotels WHERE id = ?`).get(hotelId) as any;
    const industryId = hotelRow?.industry || 'hotel';
    if (industryId && industryId !== 'hotel') {
      const { getIndustryTemplate } = require('./industry');
      const tpl = getIndustryTemplate(industryId);
      if (tpl?.system_prompt) {
        systemPrompt = tpl.system_prompt + '\n\n' + RAG_SYSTEM;
      }
    }
  } catch {}

  // v5: Qwen local (Ollama) là main generator — free, ~7.5 tok/s trên VPS.
  // Fallback tự động sang Gemini nếu Ollama offline (cấu hình trong FALLBACK chain).
  const raw = await generate({
    task: 'reply_qwen',
    system: systemPrompt,
    user: `${contextParts}\n\nKhách viết: "${message}"\n\nTrả lời ngắn, chỉ dựa trên ngữ cảnh trên:`,
  });

  // Build valid price whitelist from current OTA rooms (base_price + hourly_price)
  const { rooms } = getHotelCache(hotelId);
  const validPrices: number[] = [];
  for (const r of rooms) {
    if (r.base_price) validPrices.push(r.base_price);
    if (r.hourly_price) validPrices.push(r.hourly_price);
  }

  const v = validateResponse(raw, { validPrices });
  if (!v.valid) {
    console.warn(`[smartreply] reply validation failed: ${v.reason}`);
    return null;
  }
  return raw.trim();
}

/* ═══════════════════════════════════════════
   MAIN ENTRY
   ═══════════════════════════════════════════ */

export async function smartReplyWithSender(
  message: string,
  senderId?: string,
  senderName?: string,
  hasImage?: boolean,
  hotelId?: number,
  pageId?: number,
): Promise<SmartReplyResult> {
  const t0 = Date.now();
  const msg = message.trim();
  const hid = hotelId || 1;
  const pid = pageId || 0;

  if (senderId) saveMessage(senderId, pid, 'user', msg);

  // ─── Kill switch check ───
  try {
    const { isBotPaused } = require('./bot-control');
    const p = isBotPaused(hid);
    if (p.paused) {
      return { reply: '', tier: 'rules', latency_ms: Date.now() - t0, intent: 'bot_paused' };
    }
  } catch {}

  // Upsert guest profile cho cá nhân hóa
  if (senderId) {
    try {
      const { upsertGuest } = require('./guest-memory');
      upsertGuest(hid, senderId, { name: senderName });
    } catch {}
  }

  // Transfer proof image luôn ưu tiên tuyệt đối
  if (senderId && hasImage) {
    const result = markTransferReceived(senderId);
    if (result) {
      saveMessage(senderId, pid, 'bot', result.reply, 'transfer');
      return { reply: result.reply, tier: 'rules', latency_ms: Date.now() - t0, intent: 'transfer' };
    }
  }

  // ─── v6: Intent-First Orchestrator (behind feature flag) ───
  // Flag: mkt_hotels.features.new_router = true
  let useNewRouter = false;
  try {
    const row = db.prepare(`SELECT features FROM mkt_hotels WHERE id = ?`).get(hid) as any;
    const f = row?.features ? JSON.parse(row.features || '{}') : {};
    useNewRouter = !!f.new_router;
  } catch {}

  if (useNewRouter && senderId) {
    return await dispatchV6({ msg, hid, pid, senderId, senderName, t0 });
  }

  // ─── Legacy path (booking flow priority) ───
  if (senderId) {
    if (hasActiveBooking(senderId)) {
      const reply = processBookingStep(senderId, msg, senderName);
      if (reply) {
        saveMessage(senderId, pid, 'bot', reply, 'booking');
        return { reply, tier: 'rules', latency_ms: Date.now() - t0, intent: 'booking' };
      }
    }
    if (isBookingIntent(msg)) {
      const reply = processBookingStep(senderId, msg, senderName);
      if (reply) {
        saveMessage(senderId, pid, 'bot', reply, 'booking');
        return { reply, tier: 'rules', latency_ms: Date.now() - t0, intent: 'booking' };
      }
    }
  }

  return smartReply(msg, hid, senderId, senderName, pid);
}

/**
 * Sender-scoped system prompt injection (1-shot, consumed by ragReply).
 * Dispatcher set trước khi gọi smartReply; ragReply đọc + xóa.
 */
const _systemSuffixes = new Map<string, string>();
export function setSystemSuffix(senderId: string, _pageId: number, suffix: string) {
  _systemSuffixes.set(senderId, suffix);
}

/**
 * v6 dispatcher — gọi intent-router → quyết định handler → generate reply.
 */
async function dispatchV6(ctx: {
  msg: string;
  hid: number;
  pid: number;
  senderId: string;
  senderName?: string;
  t0: number;
}): Promise<SmartReplyResult> {
  const { msg, hid, pid, senderId, senderName, t0 } = ctx;

  const { classifyTurn, decideHandler } = require('./intent-router');
  const { fastReply, handleObjection, handleHandoff, priceFilterReply } = require('./reply-handlers');
  const { pauseBooking, resumeBooking, getActiveBookingInfo } = require('./bookingflow');
  const { ensureDiverse } = require('./anti-repeat');
  const { indexUserMessage, recall, formatRecallHint } = require('./memory-recall');
  const { toneFor, hasComplaintHistory } = require('./tone-adapter');
  const { updateAndCheck: updateHandoffTracker } = require('./auto-handoff');
  const { resolveUserLanguage, languageDirective, LANG_LABELS } = require('./language-detector');
  const { classifyCustomer, tierDirective, tierOffer } = require('./customer-tier');

  // Index user message async (no await — background)
  indexUserMessage({ senderId, pageId: pid, message: msg }).catch(() => {});

  // Fetch history 6 last turns
  const historyRows = db.prepare(
    `SELECT role, message FROM conversation_memory
     WHERE sender_id = ? AND page_id = ? ORDER BY id DESC LIMIT 6`
  ).all(senderId, pid) as any[];
  const historyTail = historyRows.reverse().map(r => `${r.role === 'user' ? 'Khách' : 'Bot'}: ${r.message}`);

  const bookingInfo = getActiveBookingInfo(senderId);

  // [1] Classify intent + recall parallel
  const [router, recallHit] = await Promise.all([
    classifyTurn({ message: msg, historyTail, bookingState: bookingInfo?.status }),
    recall({ senderId, pageId: pid, message: msg }),
  ]);

  // [2] Decide handler
  const handler = decideHandler(router, !!bookingInfo);

  // [2.5] Auto-handoff safety net
  const handoffDecision = updateHandoffTracker({
    senderId, pageId: pid, ro: router, bookingCreated: !!bookingInfo,
  });

  // [2.6] Tone directive
  const tone = toneFor(router.emotion, {
    hasComplaintHistory: hasComplaintHistory(historyTail),
  });

  // [2.7] Language detection
  const langInfo = resolveUserLanguage({ senderId, hotelId: hid, message: msg });

  // [2.8] Customer tier classification
  const tierInfo = classifyCustomer({ senderId, hotelId: hid });

  console.log(`[v6] intent=${router.intent} conf=${router.confidence.toFixed(2)} handler=${handler} src=${router.source} tone=${tone.label} lang=${langInfo.lang} tier=${tierInfo?.tier || 'unknown'}${recallHit ? ' recall='+recallHit.similarity : ''}${handoffDecision.trigger ? ' AUTO_HANDOFF='+handoffDecision.reason : ''}${bookingInfo ? ' bk=' + bookingInfo.status : ''}`);

  // Log intent to events
  try {
    const { trackEvent } = require('./events');
    trackEvent({ event: 'intent_classified', hotelId: hid, meta: { intent: router.intent, handler, confidence: router.confidence, source: router.source } });
  } catch {}

  // v6 Sprint 7: Funnel qualified stage
  try {
    if (router.intent === 'booking_action' || router.intent === 'booking_info') {
      const { trackFunnelStage } = require('./conversion-tracker');
      trackFunnelStage({ stage: 'qualified', senderId, hotelId: hid, pageId: pid });
    }
  } catch {}

  // [3] Route
  let reply = '';
  let intentLabel = router.intent;
  let skipSave = false; // smartReply đã tự lưu rồi

  // Auto-handoff ưu tiên cao — override handler trừ khi user đang đặt phòng active
  if (handoffDecision.trigger && handler !== 'booking_fsm') {
    try {
      const { trackEvent } = require('./events');
      trackEvent({ event: 'auto_handoff_triggered', hotelId: hid, meta: { reason: handoffDecision.reason, intent: router.intent } });
    } catch {}
    reply = await handleHandoff({ hotelId: hid, senderId, senderName, message: msg, history: historyTail });
    intentLabel = 'auto_handoff';
  } else if (handler === 'booking_fsm') {
    // Resume paused booking nếu cần
    if (bookingInfo?.status === 'paused') resumeBooking(senderId);
    const r = processBookingStep(senderId, msg, senderName);
    if (r) {
      reply = r;
      intentLabel = 'booking';
    } else {
      // FSM nhường → fallback RAG (smartReply tự lưu)
      const suffix = [
        tone.directive,
        recallHit ? formatRecallHint(recallHit) : '',
        languageDirective(langInfo.lang),
        tierInfo ? tierDirective(tierInfo, senderName) : '',
      ].filter(Boolean).join('\n\n');
      if (suffix) setSystemSuffix(senderId, pid, suffix);
      const out = await smartReply(msg, hid, senderId, senderName, pid);
      reply = out.reply;
      intentLabel = 'rag_fallback';
      skipSave = true;
    }
  } else if (handler === 'objection_handler') {
    // Pause booking nếu đang active
    if (bookingInfo && bookingInfo.status !== 'paused') pauseBooking(senderId);
    const tierOfferHint = tierInfo ? tierOffer(tierInfo) : null;
    const objToneDirective = [
      tone.directive,
      languageDirective(langInfo.lang),
      tierInfo ? tierDirective(tierInfo, senderName) : '',
      tierOfferHint ? `ƯU ĐÃI CÓ THỂ ÁP DỤNG: ${tierOfferHint}` : '',
    ].filter(Boolean).join('\n\n');
    reply = await handleObjection({
      ro: router,
      message: msg,
      hotelId: hid,
      history: historyTail,
      toneDirective: objToneDirective,
      recallHint: recallHit ? formatRecallHint(recallHit) : undefined,
    });
    intentLabel = 'price_objection';
  } else if (handler === 'fast_reply') {
    if (bookingInfo && bookingInfo.status !== 'paused') pauseBooking(senderId);
    reply = fastReply(router, msg, langInfo.lang);
    intentLabel = router.intent;
  } else if (handler === 'handoff') {
    if (bookingInfo && bookingInfo.status !== 'paused') pauseBooking(senderId);
    reply = await handleHandoff({ hotelId: hid, senderId, senderName, message: msg, history: historyTail });
    intentLabel = 'handoff';
  } else {
    // rag_pipeline (default)
    if (bookingInfo && bookingInfo.status !== 'paused' && router.intent !== 'booking_action' && router.intent !== 'booking_info') {
      pauseBooking(senderId);
    }

    // v7: Multi-hotel recommender — cho intent location_q / price_q có signal location
    if (router.intent === 'location_q' || router.intent === 'price_q') {
      try {
        const { recommend } = require('./hotel-recommender');
        const rec = recommend({ message: msg, slots: router.slots, historyTail });
        if (rec && rec.type !== 'no_knowledge') {
          reply = rec.reply;
          intentLabel = rec.type === 'recommended' ? 'hotel_rec' : 'hotel_no_match';
          try {
            const { trackEvent } = require('./events');
            trackEvent({
              event: 'hotel_recommend',
              hotelId: hid,
              meta: { type: rec.type, count: rec.hotels?.length || 0, ...rec.meta },
            });
          } catch {}
        }
      } catch (e: any) {
        console.warn('[recommender] fail:', e?.message);
      }
    }

    // Price-limit filter shortcut: khi intent=price_q + có price_limit, trả lời nhanh từ DB
    if (!reply && router.intent === 'price_q' && router.slots.price_limit) {
      try {
        // v7: Ưu tiên hotel_knowledge (AI-synthesized), fallback mkt_rooms_cache
        const { hasKnowledge, getRooms } = require('./hotel-knowledge');
        let rooms: any[];
        if (hasKnowledge(hid)) {
          const kbRooms = getRooms(hid);
          rooms = kbRooms.map((r: any) => ({
            name: r.display_name_vi,
            base_price: r.price_weekday,
            hourly_price: r.price_hourly,
          }));
        } else {
          rooms = getHotelCache(hid).rooms as any;
        }
        const shortcut = priceFilterReply(router.slots.price_limit, rooms);
        if (shortcut) {
          reply = shortcut;
          intentLabel = 'price_filter';
        }
      } catch {}
    }
    if (!reply) {
      const suffix = [
        tone.directive,
        recallHit ? formatRecallHint(recallHit) : '',
        languageDirective(langInfo.lang),
        tierInfo ? tierDirective(tierInfo, senderName) : '',
      ].filter(Boolean).join('\n\n');
      if (suffix) setSystemSuffix(senderId, pid, suffix);
      const out = await smartReply(msg, hid, senderId, senderName, pid);
      reply = out.reply;
      intentLabel = 'rag';
      skipSave = true;
    }
  }

  // ─── Anti-repetition filter (trừ booking/handoff/empty) ───
  if (reply && senderId && !['booking', 'handoff', 'bot_paused'].includes(intentLabel)) {
    try {
      const diverse = await ensureDiverse({
        reply,
        senderId,
        pageId: pid,
        intent: intentLabel,
        userMessage: msg,
      });
      if (diverse.wasRephrased) {
        console.log(`[v6] anti-repeat: rephrased (sim=${diverse.similarity?.toFixed(2)})`);
        reply = diverse.reply;
      }
    } catch {}
  }

  // ─── Next-step planner: chủ động gắn CTA (trừ booking/handoff/auto_handoff) ───
  if (reply && !['booking', 'booking_info', 'booking_action', 'handoff', 'auto_handoff', 'bot_paused', 'transfer'].includes(intentLabel)) {
    try {
      const { appendNextStep } = require('./next-step-planner');
      reply = appendNextStep({ reply, ro: router, bookingState: bookingInfo?.status, historyTail });
    } catch {}
  }

  if (reply && !skipSave) saveMessage(senderId, pid, 'bot', reply, intentLabel);
  return { reply, tier: 'rules', latency_ms: Date.now() - t0, intent: intentLabel };
}

export async function smartReply(
  message: string,
  hotelId: number = 1,
  senderId?: string,
  senderName?: string,
  pageId?: number,
): Promise<SmartReplyResult> {
  const t0 = Date.now();
  const msg = message.trim();
  const pid = pageId || 0;

  if (msg.length <= 1) {
    const reply = 'Chào bạn! Bạn cần tư vấn gì ạ? 😊';
    if (senderId) saveMessage(senderId, pid, 'bot', reply, 'greeting');
    return { reply, tier: 'rules', latency_ms: 0, intent: 'greeting' };
  }

  const history = senderId ? getConversationHistory(senderId) : [];
  const isFirst = senderId ? isFirstMessage(senderId) : true;

  // ─── STEP 1: AI INTENT CLASSIFICATION ───
  const classified = await classifyIntent(msg, history);
  const { intent, confidence, entities, emotion } = classified;

  // ─── STEP 2: PHONE CAPTURED? ───
  if (intent === 'phone_provided' && entities.phone && senderId) {
    const lastIntent = history.filter(h => h.role === 'bot').pop()?.message || null;
    await capturePhone(senderId, senderName, entities.phone, msg, lastIntent as any, history, pid, hotelId);
    const reply = `Cảm ơn bạn đã để lại số điện thoại! 🙏\nBên mình sẽ liên hệ trong vài phút nữa với giá tốt nhất cho bạn ạ. 💚\n\n${friendlyClosing(senderName)}`;
    saveMessage(senderId, pid, 'bot', reply, 'phone_captured');
    return { reply, tier: 'phone_capture', latency_ms: Date.now() - t0, intent: 'phone_captured', confidence };
  }

  // ─── STEP 3: FIRST MESSAGE → GREETING ───
  if (isFirst && (intent === 'greeting' || intent === 'unknown' || confidence < 0.5)) {
    const hotelRow = db.prepare(`SELECT name FROM mkt_hotels WHERE id = ?`).get(hotelId) as any;
    const hName = hotelRow?.name || 'Khách sạn';
    const result = handleGreeting(hName, senderName);
    if (senderId) saveMessage(senderId, pid, 'bot', result.reply, 'greeting');
    return { reply: result.reply, tier: 'rules', latency_ms: Date.now() - t0, intent: 'greeting', confidence };
  }

  // ─── STEP 4: DETERMINISTIC HANDLER (thuật toán tính sẵn) ───
  if (intent !== 'unknown' && confidence >= 0.6) {
    const handled = await handleDeterministic(classified, msg, hotelId, senderName);
    if (handled) {
      // Auto-attach 1 preview image per room type for visual-relevant intents
      let images = handled.images;
      const VISUAL_INTENTS: Intent[] = ['price', 'rooms', 'check_dates', 'branch_select'];
      if (!images && VISUAL_INTENTS.includes(handled.intent)) {
        const roomImgs = getRoomImages(hotelId);
        if (roomImgs.length > 0) {
          const byType = new Map<string, any>();
          for (const img of roomImgs) {
            if (!byType.has(img.room_type_name)) byType.set(img.room_type_name, img);
          }
          const preview = [...byType.values()].slice(0, 4);
          if (preview.length > 0) {
            images = preview.map((img: any) => ({
              title: img.room_type_name,
              subtitle: img.caption || '',
              image_url: img.image_url,
            }));
          }
        }
      }
      if (senderId) saveMessage(senderId, pid, 'bot', handled.reply, handled.intent);
      return {
        reply: handled.reply, tier: 'rules', latency_ms: Date.now() - t0,
        intent: handled.intent, confidence, images,
      };
    }
  }

  // ─── STEP 5: PHẢN HỒI TIÊU CỰC / KHÓ HIỂU / BỨC XÚC → XIN SĐT NGAY ───
  // Không đợi 3 lượt — bất cứ khi nào khách có dấu hiệu tiêu cực là chuyển người thật
  // Guard: câu hỏi thông tin có trợ từ "không?" / "nào?" cuối câu KHÔNG phải tiêu cực
  // (vd "có wifi không?" — Gemini hay nhầm thành frustrated)
  const trimmed = msg.trim().toLowerCase();
  const isInfoQuestion = /(không\??|nào\??|ạ\??|vậy\??|thế\??)\s*$/.test(trimmed) && msg.length < 100;

  const isNegative =
    !isInfoQuestion && (
      intent === 'complaint' ||
      (emotion === 'frustrated' && isNegativeResponse(msg)) ||  // cần đồng thuận 2 tín hiệu
      isNegativeResponse(msg)
    );

  if (isNegative && senderId && !alreadyCapturedPhone(senderId)) {
    // Chọn giọng điệu theo mức độ
    let reply: string;
    if (intent === 'complaint' || emotion === 'frustrated') {
      // Bức xúc thật sự → xin lỗi chân thành
      reply = `Mình thành thật xin lỗi vì trải nghiệm chưa tốt này ạ. 🙏\nĐể quản lý trực tiếp gọi bạn xử lý nhanh nhất, bạn cho mình xin *số điện thoại* nhé? Bên mình cam kết phản hồi trong 5 phút ạ. 📞`;
    } else {
      // Khó hiểu / bot không hiểu được → chuyển người thật nhẹ nhàng
      reply = `Xin lỗi bạn, có vẻ mình chưa hiểu ý bạn đúng ạ. 🙏\nĐể được tư vấn chính xác và nhanh nhất, bạn cho mình xin *số điện thoại* nhé? Team CSKH sẽ gọi lại bạn trong vài phút thôi. 📞💚`;
    }
    saveMessage(senderId, pid, 'bot', reply, 'negative_phone_request');
    return { reply, tier: 'phone_capture', latency_ms: Date.now() - t0, intent: 'negative', confidence };
  }

  // ─── STEP 5.5: LEARNED CACHE LOOKUP (fast path, no LLM) ───
  try {
    const learned = await lookupLearned(msg, hotelId);
    if (learned) {
      console.log(`[smartreply] learned cache hit sim=${learned.similarity.toFixed(3)} hits=${learned.hits}`);
      if (senderId) saveMessage(senderId, pid, 'bot', learned.answer, 'learned');
      return {
        reply: learned.answer,
        tier: 'learned',
        latency_ms: Date.now() - t0,
        intent: learned.intent || 'learned',
        confidence: Math.min(0.99, learned.similarity),
      };
    }
  } catch (e: any) {
    console.warn('[smartreply] learned lookup failed:', e.message);
  }

  // ─── STEP 6: RAG AI (chỉ khi có context thực) ───
  try {
    let aiReply = await ragReply(msg, history, hotelId, senderId);
    if (aiReply) {
      // ─── STEP 6.5: AGENT TOOLS (post-reply dispatch) ───
      try {
        const { runAgentTools, isToolsEnabled } = require('./agent-tools');
        if (isToolsEnabled(hotelId)) {
          const hotelRow = db.prepare(`SELECT industry FROM mkt_hotels WHERE id = ?`).get(hotelId) as any;
          const industry = hotelRow?.industry || 'hotel';
          const toolOut = await runAgentTools({
            hotelId, senderId, senderName, industry,
            message: msg, draftReply: aiReply, history,
          });
          if (toolOut.appended) aiReply = aiReply + toolOut.appended;
        }
      } catch (e: any) { console.warn('[smartreply] agent tools failed:', e?.message); }

      if (senderId) saveMessage(senderId, pid, 'bot', aiReply, 'ai_rag');
      // Fire-and-forget: record for future learned cache
      recordQA(msg, aiReply, 'ai_rag', hotelId).catch((e) =>
        console.warn('[smartreply] recordQA failed:', e.message)
      );
      return { reply: aiReply, tier: 'ai', latency_ms: Date.now() - t0, intent: 'ai', confidence };
    }
  } catch (e: any) {
    console.warn('[smartreply] RAG failed:', e.message);
  }

  // ─── STEP 7: FALLBACK — XIN SĐT ───
  // Nếu chat đã >= 3 lượt mà không chốt được → xin SĐT
  const userTurns = senderId ? countUserTurns(senderId) : 0;
  const hasProgress = senderId ? hasBookingProgress(senderId) : false;
  const alreadyHasPhone = senderId ? alreadyCapturedPhone(senderId) : false;

  if (senderId && userTurns >= 3 && !hasProgress && !alreadyHasPhone) {
    const reply = requestPhoneReply(senderName);
    saveMessage(senderId, pid, 'bot', reply, 'request_phone');
    return { reply, tier: 'phone_capture', latency_ms: Date.now() - t0, intent: 'request_phone', confidence };
  }

  // ─── STEP 8: SOFT FALLBACK ───
  const fallback = alreadyHasPhone
    ? `Mình đã ghi nhận rồi ạ! Team sẽ gọi bạn sớm nhất. 💚\n\n${friendlyClosing(senderName)}`
    : `Cảm ơn bạn! 😊 Để tư vấn chính xác nhất, bạn cho mình biết:\n• Ngày check-in bạn muốn?\n• Mấy khách, mấy đêm?\n\nHoặc gõ "giá" / "hình" / "đặt phòng" để mình hỗ trợ ngay nhé!`;
  if (senderId) saveMessage(senderId, pid, 'bot', fallback, 'fallback');
  return {
    reply: fallback,
    tier: alreadyHasPhone ? 'closing' : 'rules',
    latency_ms: Date.now() - t0,
    intent: 'fallback',
    confidence,
  };
}

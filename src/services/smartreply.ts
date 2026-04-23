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
// v10 Đợt 1: bỏ lookupLearned (qa_training_cache đã đảm nhiệm). Giữ recordQA cho migration.
import { recordQA } from './learning';

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

function saveMessage(senderId: string, pageId: number, role: 'user' | 'bot', message: string, intent?: string): number | null {
  try {
    const r = db.prepare(
      `INSERT INTO conversation_memory (sender_id, page_id, role, message, intent, created_at) VALUES (?, ?, ?, ?, ?, ?)`
    ).run(senderId, pageId, role, message.slice(0, 500), intent || null, Date.now());
    db.prepare(
      `DELETE FROM conversation_memory WHERE sender_id = ? AND id NOT IN (
        SELECT id FROM conversation_memory WHERE sender_id = ? ORDER BY created_at DESC LIMIT 20
      )`
    ).run(senderId, senderId);
    return r.lastInsertRowid as number;
  } catch { return null; }
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

/**
 * Lấy hotels "siblings" trong cùng brand network với mktHotelId.
 * Siblings = các mkt_hotels khác có:
 *   1. config.brand_network = <same brand> (explicit), HOẶC
 *   2. slug có cùng prefix (fallback heuristic)
 *   3. product_group = desiredGroup (vd current là monthly_apartment, want nightly_stay)
 *
 * Returns: array of { hotel_id (mkt), name, property_type_label, district, group, min_price }
 */
function getBrandSiblings(mktHotelId: number, desiredGroup: 'monthly_apartment' | 'nightly_stay' | null = null): Array<{
  mkt_hotel_id: number;
  hotel_id: number;
  name: string;
  property_type_label?: string;
  district?: string;
  group?: string;
  min_price?: number;
}> {
  try {
    // Get current hotel's brand network
    const current = db.prepare(`SELECT id, slug, config FROM mkt_hotels WHERE id = ?`).get(mktHotelId) as any;
    if (!current) return [];
    let brandGroup: string | null = null;
    try {
      const cfg = current.config ? JSON.parse(current.config) : {};
      brandGroup = cfg.brand_network || cfg.brand || null;
    } catch {}
    // Fallback: slug prefix (vd "sonder*" và "sonder-airport")
    const slugPrefix = current.slug?.split('-')[0] || '';

    // Query all other mkt_hotels
    const others = db.prepare(`SELECT id, slug, name, ota_hotel_id, config FROM mkt_hotels WHERE id != ? AND status = 'active'`)
      .all(mktHotelId) as any[];

    const siblings: any[] = [];
    for (const o of others) {
      let oBrandGroup: string | null = null;
      try {
        const cfg = o.config ? JSON.parse(o.config) : {};
        oBrandGroup = cfg.brand_network || cfg.brand || null;
      } catch {}

      const match = brandGroup && oBrandGroup === brandGroup;
      const slugMatch = slugPrefix && o.slug?.startsWith(slugPrefix + '-');
      if (!match && !slugMatch) continue;

      // Check product_group via hotel_profile
      const prof = o.ota_hotel_id
        ? db.prepare(`SELECT hotel_id, name_canonical, property_type, district, product_group FROM hotel_profile WHERE hotel_id = ?`).get(o.ota_hotel_id) as any
        : null;
      if (desiredGroup && prof && prof.product_group !== desiredGroup) continue;

      // Compute min_price from rooms
      let minPrice: number | undefined;
      if (o.ota_hotel_id) {
        const r = db.prepare(`SELECT MIN(base_price) AS mp FROM mkt_rooms_cache WHERE ota_hotel_id = ?`).get(o.ota_hotel_id) as any;
        minPrice = r?.mp || undefined;
      }

      const typeMap: Record<string, string> = {
        hotel: 'khách sạn', apartment: 'căn hộ dịch vụ', homestay: 'homestay', villa: 'villa', resort: 'resort',
      };

      siblings.push({
        mkt_hotel_id: o.id,
        hotel_id: o.ota_hotel_id,
        name: prof?.name_canonical || o.name,
        property_type_label: prof?.property_type ? typeMap[prof.property_type] || prof.property_type : undefined,
        district: prof?.district,
        group: prof?.product_group,
        min_price: minPrice,
      });
    }
    return siblings;
  } catch (e) {
    return [];
  }
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
  | 'property_type_select' | 'phone_provided' | 'complaint' | 'unknown';

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

/**
 * Liệt kê tất cả properties trong brand network, group theo property_type.
 * Sonder = OTA platform → bot cần cho khách chọn loại hình TRƯỚC.
 */
function getNetworkPropertyTypes(hotelId: number): {
  hotel: Array<{ name: string; district?: string; min_price?: number }>;
  apartment: Array<{ name: string; district?: string; min_price?: number }>;
  homestay: Array<{ name: string; district?: string; min_price?: number }>;
  villa: Array<{ name: string; district?: string; min_price?: number }>;
} {
  const result = { hotel: [] as any[], apartment: [] as any[], homestay: [] as any[], villa: [] as any[] };
  try {
    const siblings = getBrandSiblings(hotelId, null);
    // Include current hotel too
    const { hotel: currentMkt } = getHotelCache(hotelId);
    const currentProf = currentMkt?.ota_hotel_id
      ? db.prepare(`SELECT hotel_id, name_canonical, property_type, district FROM hotel_profile WHERE hotel_id = ?`).get(currentMkt.ota_hotel_id) as any
      : null;
    const currentMinPrice = currentMkt?.ota_hotel_id
      ? (db.prepare(`SELECT MIN(base_price) AS mp FROM mkt_rooms_cache WHERE ota_hotel_id = ?`).get(currentMkt.ota_hotel_id) as any)?.mp
      : undefined;

    const allProps = [
      ...(currentProf ? [{
        name: currentProf.name_canonical, property_type: currentProf.property_type,
        district: currentProf.district, min_price: currentMinPrice,
      }] : []),
      ...siblings.map(s => ({
        name: s.name,
        property_type: s.property_type_label === 'căn hộ dịch vụ' ? 'apartment'
          : s.property_type_label === 'homestay' ? 'homestay'
          : s.property_type_label === 'villa' ? 'villa'
          : 'hotel',
        district: s.district, min_price: s.min_price,
      })),
    ];

    for (const p of allProps) {
      const bucket = p.property_type === 'apartment' ? 'apartment'
        : p.property_type === 'homestay' ? 'homestay'
        : p.property_type === 'villa' ? 'villa'
        : 'hotel';
      result[bucket].push({ name: p.name, district: p.district, min_price: p.min_price });
    }
  } catch {}
  return result;
}

function handleGreeting(hotelName: string, senderName?: string, hotelId?: number): HandlerResult {
  const greeting = senderName ? `Chào ${senderName}! 👋` : 'Chào anh/chị! 👋';

  // Marketplace mode (Sonder platform): hỏi loại hình TRƯỚC
  if (hotelId) {
    const types = getNetworkPropertyTypes(hotelId);
    const hasHotel = types.hotel.length > 0;
    const hasApartment = types.apartment.length > 0;
    const hasHomestay = types.homestay.length > 0;
    const hasVilla = types.villa.length > 0;
    const totalTypes = [hasHotel, hasApartment, hasHomestay, hasVilla].filter(Boolean).length;

    if (totalTypes >= 2) {
      const options: string[] = [];
      if (hasHotel) options.push(`🏨 **Khách sạn** (${types.hotel.length} chỗ) — thuê đêm, tiện nghi chuẩn sao`);
      if (hasHomestay) options.push(`🏡 **Homestay** (${types.homestay.length} chỗ) — ấm cúng, giá tốt`);
      if (hasVilla) options.push(`🏖 **Villa** (${types.villa.length} chỗ) — rộng rãi, phù hợp nhóm/gia đình`);
      if (hasApartment) options.push(`🏢 **Căn hộ dịch vụ (CHDV)** (${types.apartment.length} chỗ) — thuê dài, có bếp + máy giặt`);

      return {
        reply: `${greeting} Em là trợ lý tư vấn của **Sonder** — nền tảng đặt phòng trực tuyến.\n\n` +
          `Anh/chị muốn thuê loại nào ạ?\n\n` +
          options.join('\n') + `\n\n` +
          `Cho em biết loại hình + ngày check-in + số khách, em tư vấn chỗ phù hợp nhất ạ! 🙌`,
        intent: 'greeting',
      };
    }
  }

  const branches = getAllBranches();
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

/**
 * Handler khi khách trả lời loại hình (hotel/homestay/villa/apartment).
 * List properties của loại đó + gợi ý bước tiếp theo.
 */
function handlePropertyTypeSelect(
  hotelId: number,
  selectedType: 'hotel' | 'homestay' | 'villa' | 'apartment',
): HandlerResult {
  const types = getNetworkPropertyTypes(hotelId);
  const props = types[selectedType];
  const labelMap = { hotel: 'Khách sạn', homestay: 'Homestay', villa: 'Villa', apartment: 'Căn hộ dịch vụ' };
  const emojiMap = { hotel: '🏨', homestay: '🏡', villa: '🏖', apartment: '🏢' };
  const unitMap = { hotel: '/đêm', homestay: '/đêm', villa: '/đêm', apartment: '/tháng' };

  if (props.length === 0) {
    // Không có → offer type khác
    const available = Object.entries(types).filter(([k, v]) => v.length > 0).map(([k]) => labelMap[k as keyof typeof labelMap]);
    return {
      reply: `Dạ hiện bên em chưa có ${labelMap[selectedType]} trống anh/chị ơi 😔\n\n` +
        `Hiện có: ${available.join(', ')}. Anh/chị muốn xem loại nào ạ?`,
      intent: 'property_type_select',
    };
  }

  const list = props.slice(0, 10).map((p, i) => {
    const priceStr = p.min_price ? ` — từ ${p.min_price.toLocaleString('vi-VN')}₫${unitMap[selectedType]}` : '';
    const locStr = p.district ? ` (${p.district})` : '';
    return `${i + 1}. **${p.name}**${locStr}${priceStr}`;
  }).join('\n');

  return {
    reply: `${emojiMap[selectedType]} **${labelMap[selectedType]}** — Sonder network có ${props.length} chỗ:\n\n${list}\n\n` +
      `Anh/chị quan tâm chỗ nào? Cho em biết ngày check-in + số khách, em check giá và phòng trống ạ!`,
    intent: 'property_type_select',
  };
}

/**
 * Detect property type from user message.
 * Returns the selected type hoặc null nếu không detect được.
 */
function detectPropertyType(msgNorm: string): 'hotel' | 'homestay' | 'villa' | 'apartment' | null {
  if (/\b(khach san|ks|hotel)\b/.test(msgNorm)) return 'hotel';
  if (/\b(homestay|home stay|nha dan|b&b)\b/.test(msgNorm)) return 'homestay';
  if (/\b(villa|biet thu)\b/.test(msgNorm)) return 'villa';
  if (/\b(chdv|can ho|apartment|serviced)\b/.test(msgNorm)) return 'apartment';
  return null;
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
  let kbUsed = false;
  let propertyTypeLabel = '';
  let rentalUnit: 'tháng' | 'đêm' = 'đêm';  // default
  let productGroup: 'monthly_apartment' | 'nightly_stay' = 'nightly_stay';
  try {
    const { hasKnowledge, getProfile, getRooms } = require('./hotel-knowledge');
    const { classifyProduct } = require('./product-taxonomy');
    if (hasKnowledge(hotelId)) {
      const prof = getProfile(hotelId);
      const kbRooms = getRooms(hotelId);
      if (prof?.name_canonical) hotelName = prof.name_canonical;
      if (prof?.property_type) {
        const classification = classifyProduct(prof.property_type);
        propertyTypeLabel = classification.label_vi;
        rentalUnit = classification.rental_unit;
        productGroup = classification.group;
      }
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
  if (kbUsed) console.log(`[smartreply] using kb #${hotelId}: ${rooms.length} rooms, group=${productGroup}, unit=/${rentalUnit}`);
  const hotelNameWithType = propertyTypeLabel ? `${propertyTypeLabel} ${hotelName}` : hotelName;

  // ═══════════════════════════════════════════════════════════
  // Marketplace intercept: detect property type in user message
  // (Sonder = nền tảng OTA → ưu tiên hỏi loại hình TRƯỚC)
  // ═══════════════════════════════════════════════════════════
  const detectedType = detectPropertyType(msgNorm);
  if (detectedType && ['rooms', 'price', 'hourly', 'amenities', 'greeting', 'unclear'].includes(intent)) {
    // User explicitly chose property type → show listing for that type
    const types = getNetworkPropertyTypes(hotelId);
    const totalProps = types.hotel.length + types.homestay.length + types.villa.length + types.apartment.length;
    if (totalProps > 0) {
      return handlePropertyTypeSelect(hotelId, detectedType);
    }
  }

  switch (intent) {
    case 'greeting':
      return handleGreeting(hotelName, senderName, hotelId);

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
      // v7.3: Ưu tiên scraped monthly price từ web SSR
      try {
        const { getProfile } = require('./hotel-knowledge');
        const prof = getProfile(hotelId);
        if (prof && productGroup === 'monthly_apartment' && prof.monthly_price_from) {
          const priceRange = prof.monthly_price_to
            ? `${prof.monthly_price_from.toLocaleString('vi-VN')}đ - ${prof.monthly_price_to.toLocaleString('vi-VN')}đ/tháng`
            : `từ ${prof.monthly_price_from.toLocaleString('vi-VN')}đ/tháng`;

          const services: string[] = [];
          if (prof.full_kitchen) services.push('bếp đầy đủ');
          if (prof.washing_machine) services.push('máy giặt riêng');
          if (prof.utilities_included) services.push('điện nước bao trọn');
          services.push('wifi');

          const stay = prof.min_stay_months ? `📅 Tối thiểu ${prof.min_stay_months} tháng` : '';
          const dep = prof.deposit_months ? `💳 Cọc ${prof.deposit_months} tháng` : '';
          const extras = [stay, dep].filter(Boolean).join(' · ');

          return {
            reply: `💰 Giá thuê tháng **${hotelNameWithType}**:\n\n💰 ${priceRange}\n\n📦 Đã bao gồm: ${services.join(', ')}${extras ? '\n' + extras : ''}\n\nAnh/chị cần thuê từ tháng nào ạ?`,
            intent: 'price',
          };
        }
      } catch {}

      // Fallback to room-based pricing
      if (rooms.length > 0) {
        const unit = rentalUnit;
        const roomList = rooms.map((r: any) => {
          let priceStr: string;
          if (productGroup === 'monthly_apartment' && r.base_price < 1_000_000) {
            priceStr = `~${(r.base_price * 8 / 1_000_000).toFixed(1)} triệu/tháng (liên hệ báo giá)`;
          } else {
            priceStr = `${r.base_price?.toLocaleString('vi-VN')}₫/${unit}`;
          }
          let line = `💰 ${r.name} — ${priceStr}`;
          if (r.hourly_price && productGroup === 'nightly_stay') line += ` | Giờ: ${r.hourly_price.toLocaleString('vi-VN')}₫`;
          if (r.max_guests) line += ` | ${r.max_guests} khách`;
          return line;
        }).join('\n');
        const header = productGroup === 'monthly_apartment'
          ? `💰 Bảng giá thuê tháng ${hotelNameWithType}`
          : `💰 Bảng giá ${hotelName}`;
        return { reply: `${header}:\n\n${roomList}\n\nAnh/chị cần tư vấn thêm gì không ạ?`, intent: 'price' };
      }
      return null;
    }

    case 'rooms': {
      if (rooms.length > 0) {
        const unit = rentalUnit;
        const roomList = rooms.map((r: any) => {
          let line = `🏨 ${r.name} — ${r.base_price?.toLocaleString('vi-VN')}₫/${unit} | ${r.max_guests} khách`;
          if (r.bed_type) line += ` | ${r.bed_type}`;
          return line;
        }).join('\n');

        // Marketplace append: mention sibling hotels with opposite product_group
        const otherGroup = productGroup === 'monthly_apartment' ? 'nightly_stay' : 'monthly_apartment';
        const otherSiblings = getBrandSiblings(hotelId, otherGroup);
        let siblingNote = '';
        if (otherSiblings.length > 0) {
          const sLabel = otherGroup === 'nightly_stay' ? 'thuê đêm' : 'thuê tháng';
          const sNames = otherSiblings.slice(0, 2).map(s => `**${s.name}** (${s.property_type_label || 'property'}${s.district ? ', ' + s.district : ''})`).join(', ');
          siblingNote = `\n\n💡 Nếu anh/chị cần ${sLabel}, bên em còn có ${sNames} — báo em biết em tư vấn nhé!`;
        }

        return { reply: `🏨 Các loại phòng tại ${hotelNameWithType}:\n\n${roomList}\n\nGõ "giá" xem chi tiết hoặc "hình" xem ảnh phòng!${siblingNote}`, intent: 'rooms' };
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
      // v7: Ưu tiên hotel_amenities (AI-synthesized) + merge included_services cho apartment
      try {
        const { hasKnowledge, getAmenities } = require('./hotel-knowledge');
        const { classifyProduct: _cp } = require('./product-taxonomy');
        if (hasKnowledge(hotelId)) {
          const am = getAmenities(hotelId);
          const { getProfile } = require('./hotel-knowledge');
          const _prof = getProfile(hotelId);
          const _class = _prof?.property_type ? _cp(_prof.property_type) : null;
          const existingNames = am.map((a: any) => (a.name_vi || '').toLowerCase());

          // Merge taxonomy's included_services (bếp, máy giặt, điện nước...) cho monthly apartment
          const merged: Array<{ name_vi: string; category: string; free: number; hours?: string }> = [...am];
          if (_class?.group === 'monthly_apartment' && _class.included_services) {
            for (const svc of _class.included_services) {
              if (!existingNames.some((n: string) => n.includes(svc.toLowerCase().split(' ')[0]))) {
                merged.push({ name_vi: svc, category: 'package', free: 1 });
              }
            }
          }

          if (merged.length > 0) {
            const emojiMap: Record<string, string> = { wifi: '📶', pool: '🏊', gym: '💪', spa: '🧖', parking: '🅿️', restaurant: '🍽️', elevator: '🛗', ac: '❄️', bathroom: '🚿', kitchen: '🍳', bếp: '🍳', breakfast: '🥐', laundry: '🧺', giặt: '🧺', reception: '🛎️', điện: '⚡', nước: '💧', dọn: '🧹' };
            const formatted = merged.slice(0, 14).map((a: any) => {
              const key = (a.name_vi + ' ' + (a.name_en || '') + ' ' + a.category).toLowerCase().replace(/\s+/g, '');
              const emoji = Object.entries(emojiMap).find(([k]) => key.includes(k))?.[1] || '✅';
              return `${emoji} ${a.name_vi}${a.free === 0 ? ' (có phí)' : ''}${a.hours ? ` · ${a.hours}` : ''}`;
            }).join('\n');
            const note = _class?.group === 'monthly_apartment' ? '\n\n💡 Thuê tháng đã bao gồm trọn gói tiện ích trên.' : '';
            return { reply: `🏨 Tiện ích ${hotelName}:\n\n${formatted}${note}`, intent: 'amenities' };
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
      // Current hotel không có hourly → cross-sell sibling hotel có hourly/nightly
      const siblings = getBrandSiblings(hotelId, 'nightly_stay');
      if (siblings.length > 0) {
        const s = siblings[0];
        const priceHint = s.min_price ? ` từ ${s.min_price.toLocaleString('vi-VN')}₫/đêm` : '';
        return {
          reply: `⏰ Dạ ${hotelNameWithType} cho thuê theo tháng, chưa có gói theo giờ ạ.\n\n` +
            `Nếu anh/chị cần nghỉ ngắn, bên em có **${s.name}** — ${s.property_type_label || 'khách sạn'} ${s.district ? 'tại ' + s.district : ''}${priceHint}.\n\n` +
            `Anh/chị muốn em gửi thêm thông tin hoặc đặt phòng luôn không ạ?`,
          intent: 'hourly',
        };
      }
      return {
        reply: `⏰ Dạ ${hotelNameWithType} cho thuê theo tháng ạ. Chưa có gói thuê giờ hoặc theo đêm.\n\nAnh/chị có muốn em tư vấn thuê tháng không ạ?`,
        intent: 'hourly',
      };
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
  // 3-tier query: Wiki (T3) + OTA facts (T1) + Semantic RAG (T2)
  const [wikiCtx, otaCtx, semanticHits] = await Promise.all([
    buildContext(message, hotelId),
    buildOtaContext(hotelId),
    // Tier 2: semantic search — only if message looks "vague" (trigger semantic)
    (async () => {
      try {
        const { semanticSearch } = require('./knowledge-sync');
        // Get hotel_profile.hotel_id từ mkt_hotels.id
        const { resolveKnowledgeHotelId } = require('./hotel-knowledge');
        const hpId = resolveKnowledgeHotelId(hotelId);
        if (!hpId) return [];
        return await semanticSearch(message, { hotelIds: [hpId], topK: 3, minScore: 0.45 });
      } catch { return []; }
    })(),
  ]);

  // Build semantic context block
  const semanticCtx = semanticHits.length
    ? '--- TRI THỨC LIÊN QUAN (semantic) ---\n' +
      semanticHits.map((h: any) => `[${h.chunk_type}] ${h.chunk_text} (score ${(h.score * 100).toFixed(0)}%)`).join('\n') +
      '\n--- HẾT ---'
    : '';

  // STRICT RAG: nếu không có context → không gọi AI
  if (!wikiCtx && !otaCtx && !semanticCtx) return null;

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
    semanticCtx,
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
  // v10 Đợt 2.2: inject brand_voice instructions vào system prompt
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

      // v10 Đợt 2.2: Brand voice instructions (friendly by default cho Sonder)
      const brandVoice = prof.brand_voice || 'friendly';
      const voiceBlock = brandVoice === 'formal'
        ? 'GIỌNG ĐIỆU: Chuyên nghiệp, trang trọng, dùng "quý khách". Không emoji.'
        : brandVoice === 'luxury'
        ? 'GIỌNG ĐIỆU: Sang trọng, tinh tế, nhấn mạnh trải nghiệm cao cấp. Tối đa 1 emoji.'
        : 'GIỌNG ĐIỆU: Thân thiện, ấm áp, dùng "anh/chị", "ạ", "nhé" tự nhiên. Có thể thêm 1-2 emoji phù hợp (✨🌿💚📌).';
      systemPrompt += '\n\n--- BRAND VOICE ---\n' + voiceBlock;
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

  // v8: Smart Cascade — Gemini Flash → Pro → ChatGPT → Qwen local (no Claude).
  // Mỗi hop fallback tự động nếu tầng trước hết quota / lỗi 5xx.
  const { smartCascade } = require('./smart-cascade');
  const { rememberLLMInfo } = require('./llm-info-store');
  let raw: string;
  try {
    const cascadeResult = await smartCascade({
      system: systemPrompt,
      user: `${contextParts}\n\nKhách viết: "${message}"\n\nTrả lời ngắn, chỉ dựa trên ngữ cảnh trên:`,
      maxTokens: 800,
      temperature: 0.5,
    });
    raw = cascadeResult.text;
    rememberLLMInfo(senderId, {
      provider: cascadeResult.provider,
      model: cascadeResult.model,
      tokens_in: cascadeResult.tokens_in,
      tokens_out: cascadeResult.tokens_out,
      latency_ms: cascadeResult.latency_ms,
      hops: cascadeResult.hops,
    });
    if (cascadeResult.hops > 0) {
      console.log(`[ragReply] cascade used hops=${cascadeResult.hops} final=${cascadeResult.provider}`);
    }
  } catch (e: any) {
    console.warn('[ragReply] cascade exhausted:', e?.message);
    // Last-resort fallback to legacy router (Qwen via FALLBACK chain)
    raw = await generate({
      task: 'reply_qwen',
      system: systemPrompt,
      user: `${contextParts}\n\nKhách viết: "${message}"\n\nTrả lời ngắn, chỉ dựa trên ngữ cảnh trên:`,
    });
  }

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
  imageUrl?: string,   // v14 Phase 3: ảnh biên lai từ webhook
): Promise<SmartReplyResult> {
  const t0 = Date.now();
  const msg = message.trim();
  const hid = hotelId || 1;
  const pid = pageId || 0;

  if (senderId) {
    saveMessage(senderId, pid, 'user', msg);
    // v18: Detect reply to proactive outreach
    try {
      const { markOutreachReplied } = require('./proactive-outreach');
      markOutreachReplied(senderId);
    } catch {}
  }

  // ─── Kill switch check ───
  try {
    const { isBotPaused } = require('./bot-control');
    const p = isBotPaused(hid);
    if (p.paused) {
      return { reply: '', tier: 'rules', latency_ms: Date.now() - t0, intent: 'bot_paused' };
    }
  } catch {}

  // ─── NEW FUNNEL FSM (feature flag USE_NEW_FUNNEL) ───
  // Spec: docs/BOT-SALES-FUNNEL-PLAN.md (v1.1)
  // Gate before legacy dispatchV6 — nếu enabled, FSM handle full conversation
  try {
    const { isFunnelEnabled } = require('./conversation-fsm');
    if (isFunnelEnabled() && senderId) {
      const { processFunnelMessage } = require('./funnel-dispatcher');
      const fr = await processFunnelMessage(senderId, hid, msg, { imageUrl });
      if (fr.handed_off) {
        return { reply: '', tier: 'rules', latency_ms: Date.now() - t0, intent: 'handed_off' };
      }
      if (fr.reply) {
        const memId = saveMessage(senderId, pid, 'bot', fr.reply, fr.intent);
        // v13: Log reply outcome cho feedback loop
        try {
          const { logBotReply } = require('./reply-outcome-logger');
          logBotReply({
            hotelId: hid,
            senderId,
            userMessage: msg,
            botReply: fr.reply,
            intent: fr.intent,
            stage: fr.stage,
            replySource: fr.intent || 'funnel_unknown',
            llmProvider: fr.meta?.gemini ? 'gemini' : undefined,
            latencyMs: Date.now() - t0,
            conversationMemoryId: typeof memId === 'number' ? memId : undefined,
          });
        } catch (e: any) { console.warn('[smartreply] logBotReply fail:', e?.message); }
        return {
          reply: fr.reply,
          tier: 'rules',
          latency_ms: Date.now() - t0,
          intent: fr.intent,
          confidence: 0.95,
        } as SmartReplyResult;
      }
      // If FSM returns empty reply, fall through to legacy (edge cases)
    }
  } catch (e: any) {
    console.warn('[smartreply] FSM error, falling back:', e?.message);
  }

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

  // v7.3+: Block legacy booking FSM cho monthly_apartment
  // Đảm bảo khách apartment KHÔNG bị rơi vào flow thuê đêm
  try {
    const { getProfile } = require('./hotel-knowledge');
    const prof = getProfile(hid);
    if (prof?.product_group === 'long_term_apartment') {
      // Clear any pending booking FSM state (legacy config)
      const { hasActiveBooking, pauseBooking } = require('./bookingflow');
      if (senderId && hasActiveBooking(senderId)) {
        pauseBooking(senderId);
        console.log(`[smartreply] paused legacy booking FSM for apartment hotel #${hid}`);
      }
    }
  } catch {}

  // v7.3: Smart rental intent matching (thuê tháng vs đêm)
  // Bot biết hotel này thuộc nhóm gì → reply phù hợp
  try {
    const { detectRentalIntent, classifyProduct, formatPriceWithUnit } = require('./product-taxonomy');
    const { getProfile, getRooms } = require('./hotel-knowledge');
    const userIntent = detectRentalIntent(msg);
    const prof = getProfile(hid);

    if (userIntent !== 'unknown' && prof?.property_type) {
      const classification = classifyProduct(prof.property_type);
      const rooms = getRooms(hid);
      const minPrice = rooms.length > 0 ? Math.min(...rooms.map((r: any) => r.price_weekday || Infinity).filter((p: any) => p !== Infinity)) : 0;

      // User wants MONTHLY + hotel is monthly_apartment → match!
      if (userIntent === 'monthly' && classification.group === 'monthly_apartment') {
        // Priority: scraped monthly_price_from/to (real from web SSR)
        let priceDisplay: string;
        if (prof.monthly_price_from && prof.monthly_price_to) {
          priceDisplay = `**${prof.monthly_price_from.toLocaleString('vi-VN')}đ - ${prof.monthly_price_to.toLocaleString('vi-VN')}đ/tháng**`;
        } else if (prof.monthly_price_from) {
          priceDisplay = `**từ ${prof.monthly_price_from.toLocaleString('vi-VN')}đ/tháng**`;
        } else if (minPrice && minPrice < 1_000_000) {
          // Fallback estimation x8 (if scraper missed)
          const est = minPrice * 8;
          priceDisplay = `~${(est / 1_000_000).toFixed(1)} triệu/tháng (liên hệ báo giá chính xác)`;
        } else {
          priceDisplay = 'Vui lòng inbox để em báo giá chính xác';
        }

        // Use scraped services if available
        const scrapedServices: string[] = [];
        if (prof.full_kitchen) scrapedServices.push('Bếp đầy đủ');
        if (prof.washing_machine) scrapedServices.push('Máy giặt riêng');
        if (prof.utilities_included) scrapedServices.push('Điện nước bao trọn');
        if (prof.scraped_data?.accepts_sonder_escrow) scrapedServices.push('Chấp nhận Sonder Escrow');
        const services = scrapedServices.length > 0
          ? scrapedServices.join(' + ')
          : (classification.included_services || []).join(' + ');

        const stay = prof.min_stay_months ? `\n📅 Thuê tối thiểu: ${prof.min_stay_months} tháng` : '';
        const deposit = prof.deposit_months ? `\n💳 Cọc: ${prof.deposit_months} tháng` : '';

        const reply = `Dạ đúng rồi ạ! Bên em là **${classification.label_vi} ${prof.name_canonical}** thuê theo THÁNG 😊\n\n` +
          `💰 Giá: ${priceDisplay}\n` +
          `📦 Đã bao gồm: ${services}${stay}${deposit}\n` +
          `📍 ${[prof.address, prof.district, prof.city].filter(Boolean).filter((v: any, i: number, a: any[]) => a.indexOf(v) === i).join(', ')}\n\n` +
          `Anh/chị cần thuê từ tháng nào ạ?`;
        if (senderId) saveMessage(senderId, pid, 'bot', reply, 'monthly_match');
        return { reply, tier: 'rules', latency_ms: Date.now() - t0, intent: 'monthly_match' };
      }

      // User wants MONTHLY + hotel is nightly_stay → honest mismatch
      if (userIntent === 'monthly' && classification.group === 'nightly_stay') {
        const reply = `Dạ bên em là **${classification.label_vi} ${prof.name_canonical}** thuê theo ĐÊM (giống khách sạn), không có gói thuê tháng ạ 🙏\n\n` +
          `Nếu anh/chị cần căn hộ thuê tháng, em có thể giới thiệu hệ thống **Căn hộ dịch vụ** của bên em — có bếp, máy giặt, điện nước bao trọn. Anh/chị muốn tham khảo không ạ?`;
        if (senderId) saveMessage(senderId, pid, 'bot', reply, 'mismatch_monthly');
        return { reply, tier: 'rules', latency_ms: Date.now() - t0, intent: 'mismatch_monthly' };
      }

      // User wants NIGHTLY + hotel is monthly_apartment → honest mismatch
      if (userIntent === 'nightly' && classification.group === 'monthly_apartment') {
        const reply = `Dạ bên em là **${classification.label_vi} ${prof.name_canonical}** cho thuê theo THÁNG (1 tháng trở lên), không phải thuê đêm ạ 🙏\n\n` +
          `Nếu anh/chị cần khách sạn thuê đêm, em có thể giới thiệu hệ thống **Khách sạn/Homestay** của bên em. Anh/chị muốn tham khảo không ạ?`;
        if (senderId) saveMessage(senderId, pid, 'bot', reply, 'mismatch_nightly');
        return { reply, tier: 'rules', latency_ms: Date.now() - t0, intent: 'mismatch_nightly' };
      }

      // User wants HOURLY
      if (userIntent === 'hourly') {
        // Apartment → không support thuê giờ
        if (classification.group === 'monthly_apartment') {
          const reply = `Dạ bên em là **${classification.label_vi} ${prof.name_canonical}** cho thuê theo THÁNG ạ 🙏\n\n` +
            `Chưa có gói thuê theo giờ. Nếu anh/chị cần nghỉ ngắn (theo giờ hoặc theo đêm), em có thể giới thiệu Khách sạn/Homestay khác trong hệ thống Sonder nhé.`;
          if (senderId) saveMessage(senderId, pid, 'bot', reply, 'mismatch_hourly_apt');
          return { reply, tier: 'rules', latency_ms: Date.now() - t0, intent: 'mismatch_hourly_apt' };
        }
        // Hotel/homestay có thể có hourly option
        const hourlyRoom = rooms.find((r: any) => r.price_hourly && r.price_hourly > 0);
        if (hourlyRoom) {
          const reply = `Dạ có ạ! **${prof.name_canonical}** có gói thuê theo giờ:\n\n` +
            `⏰ ${hourlyRoom.display_name_vi}: ${hourlyRoom.price_hourly.toLocaleString('vi-VN')}đ/giờ\n\n` +
            `Anh/chị định thuê từ giờ nào và bao lâu ạ?`;
          if (senderId) saveMessage(senderId, pid, 'bot', reply, 'hourly_match');
          return { reply, tier: 'rules', latency_ms: Date.now() - t0, intent: 'hourly_match' };
        }
        // Hotel không có hourly price
        const reply = `Dạ bên em là **${classification.label_vi} ${prof.name_canonical}** cho thuê theo đêm ạ, hiện chưa có gói thuê theo giờ 🙏\n\n` +
          `Anh/chị định ở mấy đêm để em tư vấn phòng phù hợp ạ?`;
        if (senderId) saveMessage(senderId, pid, 'bot', reply, 'mismatch_hourly_nightly');
        return { reply, tier: 'rules', latency_ms: Date.now() - t0, intent: 'mismatch_hourly_nightly' };
      }
    }
  } catch (e) { console.warn('[taxonomy] fail:', (e as any)?.message); }

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

  // [0] Phase 3: analyze last bot reply (feedback signal) — fire-and-forget
  try {
    const { analyzeFollowUp } = require('./qa-feedback-tracker');
    analyzeFollowUp({ senderId, message: msg, hotelId: hid }).catch((e: any) =>
      console.warn('[qa-feedback] analyze fail:', e?.message)
    );
  } catch {}

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

  // [2.9] Smart QA cache — chỉ match cho LLM-handler paths (rag, objection).
  // Không short-circuit booking_fsm (stateful), fast_reply (đã nhanh), handoff (one-off).
  let qaCacheHit: { qa_cache_id: number; cached_response: string; confidence: number; tier: string } | null = null;
  if (!bookingInfo && !handoffDecision.trigger && (handler === 'rag_pipeline' || handler === 'objection_handler')) {
    try {
      const { matchIntent } = require('./intent-matcher');
      const m = await matchIntent({ hotelId: hid, customerMessage: msg });
      if (m.should_use_cached && m.cached_response) {
        console.log(`[v6] qa_cache HIT tier=${m.tier} conf=${m.confidence} id=${m.qa_cache_id}`);
        db.prepare(`UPDATE qa_training_cache SET hits_count = hits_count + 1, last_hit_at = ? WHERE id = ?`)
          .run(Date.now(), m.qa_cache_id);
        qaCacheHit = { qa_cache_id: m.qa_cache_id, cached_response: m.cached_response, confidence: m.confidence, tier: m.tier };
        // Phase 3: nhớ để đánh giá feedback từ user turn tiếp theo
        try {
          const { rememberLastReply } = require('./qa-feedback-tracker');
          rememberLastReply(senderId, {
            qa_cache_id: m.qa_cache_id,
            bot_reply: m.cached_response,
            user_question: msg,
            hotel_id: hid,
            is_cached_hit: true,
          });
        } catch {}
        try {
          const { trackEvent } = require('./events');
          trackEvent({ event: 'qa_cache_hit', hotelId: hid, meta: { id: m.qa_cache_id, confidence: m.confidence, tier: m.tier } });
        } catch {}
      } else if (m.matched) {
        console.log(`[v6] qa_cache NEAR-MISS tier=${m.tier} conf=${m.confidence} (not used — tier=${m.tier} or below threshold)`);
      }
    } catch (e: any) { console.warn('[v6] cache check fail:', e?.message); }
  }

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
    // Cache hit short-circuit
    if (qaCacheHit) {
      reply = qaCacheHit.cached_response;
      intentLabel = 'qa_cached';
    } else {
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
        senderId,  // v8: cho llm-info-store track provider
      });
      intentLabel = 'price_objection';
    }
  } else if (handler === 'fast_reply') {
    if (bookingInfo && bookingInfo.status !== 'paused') pauseBooking(senderId);
    // Marketplace intercept: nếu intent là greeting/small_talk → dùng marketplace greeting
    // list 4 loại hình (hotel/homestay/villa/CHDV) nếu network có multi-type
    const isGreetingMsg = /^(ch[àa]o|hi|hello|hey|alo|a l[ôo])\b/i.test(msg.trim()) || msg.trim().length <= 15;
    if (isGreetingMsg && ['greeting', 'small_talk'].includes(router.intent)) {
      const hotelRow = db.prepare(`SELECT name FROM mkt_hotels WHERE id = ?`).get(hid) as any;
      const mpResult = handleGreeting(hotelRow?.name || 'Sonder', senderName, hid);
      reply = mpResult.reply;
      intentLabel = 'greeting';
    } else {
      reply = fastReply(router, msg, langInfo.lang);
      intentLabel = router.intent;
    }
  } else if (handler === 'handoff') {
    if (bookingInfo && bookingInfo.status !== 'paused') pauseBooking(senderId);
    reply = await handleHandoff({ hotelId: hid, senderId, senderName, message: msg, history: historyTail });
    intentLabel = 'handoff';
  } else {
    // rag_pipeline (default)
    if (bookingInfo && bookingInfo.status !== 'paused' && router.intent !== 'booking_action' && router.intent !== 'booking_info') {
      pauseBooking(senderId);
    }

    // Cache hit short-circuit (skip recommender/RAG)
    if (qaCacheHit) {
      reply = qaCacheHit.cached_response;
      intentLabel = 'qa_cached';
    }

    // v7: Multi-hotel recommender
    // Fire cho: location_q, price_q, HOẶC khi msg chứa property_type keyword
    let shouldRecommend = router.intent === 'location_q' || router.intent === 'price_q';
    if (!shouldRecommend) {
      try {
        const { detectTypeFromMessage } = require('./property-type-meta');
        if (detectTypeFromMessage(msg)) shouldRecommend = true;
      } catch {}
    }
    if (!reply && shouldRecommend) {
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
      // v10 FIX: preserve real intent từ smartReply thay vì hardcode 'rag'.
      // Trước đây: phone-capture template bị save vào qa_training_cache vì
      // label là 'rag' → admin duyệt nhầm → bot trả template forever.
      // Map intent thực → label save:
      const realIntent = (out.intent || 'rag').toLowerCase();
      if (['negative', 'phone_captured', 'greeting', 'transfer', 'bot_paused', 'learned'].includes(realIntent)) {
        intentLabel = realIntent;   // KHÔNG nằm trong LLM_PRODUCED → skip save
      } else {
        intentLabel = 'rag';        // pure LLM-gen → OK save
      }
      skipSave = true;
    }
  }

  // ─── Smart QA cache: save LLM-produced replies for admin review (tier=pending) ───
  // Skip nếu: cache hit (đã có), booking/handoff/fast templates, empty reply
  // v8 Phase 1b: đọc provider thực tế từ llm-info-store (từ smartCascade)
  // v10 FIX: KHÔNG save phone-capture / greeting / transfer / learned replies
  //   (chúng là template hoặc đã được cache bởi system khác)
  const LLM_PRODUCED = ['rag', 'rag_fallback', 'price_objection', 'hotel_rec', 'price_filter'];
  const SKIP_SAVE_INTENTS = ['negative', 'phone_captured', 'phone_capture', 'greeting', 'transfer', 'bot_paused', 'learned', 'auto_handoff', 'handoff', 'booking', 'qa_cached'];

  // Extra guard: nếu reply chứa phone-capture template keywords → skip
  const isPhoneCapture = reply && /xin.*\*?số điện thoại\*?|Team CSKH sẽ gọi|CSKH sẽ gọi lại|cho mình xin.*số/i.test(reply);
  const isGreetingLike = reply && /^Dạ em chào|^Chào anh\/chị|^Em chào|^Dạ em đây|^Em có thể giúp/i.test(reply);

  if (reply && LLM_PRODUCED.includes(intentLabel) && !qaCacheHit
      && !SKIP_SAVE_INTENTS.includes(intentLabel)
      && !isPhoneCapture && !isGreetingLike) {
    try {
      const { saveNewQA } = require('./intent-matcher');
      const { consumeLLMInfo } = require('./llm-info-store');
      const llmInfo = consumeLLMInfo(senderId);
      // Fire-and-forget — không block reply
      saveNewQA({
        hotelId: hid,
        question: msg,
        response: reply,
        provider: llmInfo?.provider || 'gemini_flash',
        model: llmInfo?.model,
        tokens: llmInfo?.tokens_out || 0,
        intentCategory: router.intent,
        contextTags: [
          handler,
          router.emotion ? `emotion_${router.emotion}` : '',
          langInfo.lang !== 'vi' ? `lang_${langInfo.lang}` : '',
          llmInfo?.hops ? `cascade_hops_${llmInfo.hops}` : '',
        ].filter(Boolean),
      }).then((res: any) => {
        if (res?.is_new) {
          console.log(`[v6] qa_cache saved id=${res.qa_cache_id} tier=pending intent=${router.intent} provider=${llmInfo?.provider || 'unknown'}`);
        }
        // Phase 3: remember kể cả pending entries (để đánh giá feedback)
        if (res?.qa_cache_id) {
          try {
            const { rememberLastReply } = require('./qa-feedback-tracker');
            rememberLastReply(senderId, {
              qa_cache_id: res.qa_cache_id,
              bot_reply: reply,
              user_question: msg,
              hotel_id: hid,
              is_cached_hit: false,
            });
          } catch {}
        }
      }).catch((e: any) => console.warn('[v6] saveNewQA fail:', e?.message));
    } catch {}
  }

  // ─── Anti-repetition filter (trừ booking/handoff/empty/qa_cached) ───
  // qa_cached: admin đã duyệt nguyên văn → không rephrase để giữ intent đã train
  if (reply && senderId && !['booking', 'handoff', 'bot_paused', 'qa_cached'].includes(intentLabel)) {
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

  // ─── Next-step planner: chủ động gắn CTA (trừ booking/handoff/auto_handoff/qa_cached) ───
  if (reply && !['booking', 'booking_info', 'booking_action', 'handoff', 'auto_handoff', 'bot_paused', 'transfer', 'qa_cached'].includes(intentLabel)) {
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
    const result = handleGreeting(hName, senderName, hotelId);
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
  // v10 FIX: Yêu cầu ≥ 2 tín hiệu đồng thuận để tránh false positive.
  //   Trước đây: chỉ cần intent=complaint là fire → Gemini misclassify friendly
  //   question như "còn phòng không bạn" là complaint → bot xin SĐT sai context.
  //   Nay: complaint phải đi kèm negative markers HOẶC emotion=frustrated.
  const trimmed = msg.trim().toLowerCase();
  // Mở rộng pattern câu hỏi thông tin (thêm bạn/ad/nhé/shop/ơi cuối câu):
  const isInfoQuestion =
    /(không\??|khong\??|nào\??|nao\??|ạ\??|vậy\??|thế\??|mấy\??|bao nhiêu\??|gì\??|\?)\s*(bạn|ad|admin|shop|nhé|ạ|ơi)?\s*\??\s*$/
      .test(trimmed) && msg.length < 150;

  const hasNegativeMarker = isNegativeResponse(msg);

  const isNegative =
    !isInfoQuestion && (
      // Complaint: cần BOTH intent=complaint AND negative markers (2 signals)
      (intent === 'complaint' && hasNegativeMarker) ||
      // Frustrated emotion: cần đi kèm negative markers
      (emotion === 'frustrated' && hasNegativeMarker) ||
      // Pure negative markers: chỉ trigger cho câu SHORT (< 50 chars) — tránh match trong câu dài
      (hasNegativeMarker && msg.length < 50)
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

  // ─── STEP 5.5: LEARNED CACHE LOOKUP (DEPRECATED v10 Đợt 1) ───
  // dispatchV6 đã check qa_training_cache (admin-curated) trước khi gọi smartReply,
  // nên lookupLearned ở đây là lookup thứ 2 → tốn CPU + có thể trả lời trùng.
  // Giữ recordQA bên dưới để pipeline migration đẩy dần dữ liệu sang qa_training_cache.

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

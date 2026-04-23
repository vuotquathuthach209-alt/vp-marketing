/**
 * Funnel Dispatcher — entry point cho FSM bot flow.
 *
 * Gọi từ smartreply hoặc webhook Zalo/FB:
 *   processFunnelMessage(senderId, hotelId, msg, opts)
 *     → { reply, quick_replies?, cards?, intent, stage }
 *
 * Flow:
 *   1. Load/init state
 *   2. Extract slots từ msg
 *   3. Merge slots → state
 *   4. Handle special payloads (quick reply postback)
 *   5. Record turn + check fallback
 *   6. decideNextStage → handler → return reply
 */

import {
  getState, initState, saveState, mergeSlots, decideNextStage,
  shouldFallback, recordTurn, markHandedOff,
  ConversationState, Stage, BookingSlots,
} from './conversation-fsm';
import { extractAllSlots, countExtracted, ExtractedSlots } from './slot-extractor';
import { dispatchHandler, HandlerResult } from './funnel-handlers';
import { db } from '../db';

/* ═══════════════════════════════════════════
   Helpers cho capability check + slot diff
   ═══════════════════════════════════════════ */

const PROP_LABEL_DISPATCHER: Record<string, string> = {
  hotel: 'Khách sạn',
  homestay: 'Homestay',
  villa: 'Villa',
  apartment: 'Căn hộ dịch vụ (CHDV)',
  resort: 'Resort',
  guesthouse: 'Guesthouse',
  hostel: 'Hostel',
};

const PROP_EMOJI_DISPATCHER: Record<string, string> = {
  hotel: '🏨', homestay: '🏡', villa: '🏖', apartment: '🏢',
  resort: '🌴', guesthouse: '🛏', hostel: '🎒',
};

let availableTypesCache: { types: string[]; at: number } | null = null;
function getAvailablePropertyTypes(): string[] {
  // Cache 60s — avoid DB hit per request
  if (availableTypesCache && (Date.now() - availableTypesCache.at) < 60_000) {
    return availableTypesCache.types;
  }
  try {
    const rows = db.prepare(`
      SELECT DISTINCT property_type FROM hotel_profile hp
      WHERE property_type IS NOT NULL
        AND EXISTS (SELECT 1 FROM mkt_hotels mh WHERE mh.ota_hotel_id = hp.hotel_id AND mh.status = 'active')
    `).all() as any[];
    const types = rows.map(r => r.property_type).filter(Boolean);
    availableTypesCache = { types, at: Date.now() };
    return types;
  } catch {
    return ['hotel', 'homestay', 'villa', 'apartment'];  // fallback
  }
}

/** Compare slot objects → return keys newly filled. */
function diffSlots(before: BookingSlots, after: BookingSlots): Partial<BookingSlots> {
  const out: any = {};
  for (const key of Object.keys(after) as (keyof BookingSlots)[]) {
    if (after[key] !== undefined && before[key] === undefined) {
      out[key] = after[key];
    }
  }
  return out;
}

/**
 * Build generic answer cho topic phổ biến — liệt kê tất cả hotels thay vì clarify ngay.
 * Return null nếu không có generic answer cho topic đó.
 */
function buildGenericAnswer(subCategory: string, msg: string): string | null {
  try {
    const hotels = db.prepare(
      `SELECT hp.hotel_id, hp.name_canonical, hp.property_type, hp.district, hp.star_rating,
              hp.monthly_price_from, hp.scraped_data
       FROM hotel_profile hp
       WHERE EXISTS (SELECT 1 FROM mkt_hotels mh WHERE mh.ota_hotel_id = hp.hotel_id AND mh.status = 'active')`
    ).all() as any[];

    if (!hotels.length) return null;

    switch (subCategory) {
      case 'price': {
        const lines = hotels.map(h => {
          const room = db.prepare(`SELECT MIN(price_weekday) as min_p FROM hotel_room_catalog WHERE hotel_id = ?`).get(h.hotel_id) as any;
          const monthly = h.monthly_price_from ? `${(h.monthly_price_from / 1_000_000).toFixed(1)}tr/tháng` : '';
          const nightly = room?.min_p ? `${(room.min_p / 1000).toFixed(0)}k/đêm` : '';
          const emoji = h.property_type === 'apartment' ? '🏢' : h.property_type === 'homestay' ? '🏡' : '🏨';
          return `${emoji} **${h.name_canonical}** (${h.district || '?'}) — ${nightly || monthly || 'giá liên hệ'}`;
        });
        return `💰 Bảng giá các chỗ ở Sonder:\n\n${lines.join('\n')}\n\n👉 Anh/chị xem chỗ nào phù hợp để em tư vấn chi tiết?`;
      }

      case 'wifi':
      case 'amenity': {
        if (/wifi/i.test(msg)) {
          return `✅ Tất cả chỗ ở Sonder đều có **Wifi tốc độ cao miễn phí** ạ.\n\nAnh/chị muốn em tư vấn chỗ cụ thể nào?`;
        }
        return null;
      }

      case 'checkin_time':
      case 'checkout': {
        return `⏰ Giờ check-in / check-out chuẩn Sonder:\n• Check-in: **14:00**\n• Check-out: **12:00**\n\nCheck-in sớm (trước 12:00): có thể miễn phí nếu phòng trống, hoặc phụ phí 30-50%.\n\nAnh/chị cần chỗ nào cụ thể để em check lịch trống?`;
      }

      case 'pet': {
        const lines = hotels.map(h => {
          try {
            const sd = JSON.parse(h.scraped_data || '{}');
            const petInfo = sd.content_sections?.pet_policy || '(liên hệ)';
            return `• ${h.name_canonical}: ${petInfo}`;
          } catch {
            return `• ${h.name_canonical}: (liên hệ)`;
          }
        });
        return `🐾 Chính sách thú cưng:\n\n${lines.join('\n')}\n\nAnh/chị cần thêm thông tin gì không?`;
      }

      case 'availability': {
        return `📅 Em check được phòng trống ngay nếu anh/chị cho em biết:\n• Ngày check-in + số đêm\n• Số khách\n• Khu vực muốn ở (Tân Bình / Q1 / ...)\n\nVd: "25/5 2 đêm 2 người gần sân bay"`;
      }

      case 'location': {
        const byDistrict: Record<string, string[]> = {};
        hotels.forEach(h => {
          const d = h.district || 'Khác';
          if (!byDistrict[d]) byDistrict[d] = [];
          byDistrict[d].push(h.name_canonical);
        });
        const lines = Object.entries(byDistrict).map(([d, names]) => `📍 **${d}**: ${names.join(', ')}`);
        return `Sonder có chỗ ở các khu vực:\n\n${lines.join('\n')}\n\nAnh/chị muốn ở khu nào ạ?`;
      }

      case 'room_type': {
        const types = [...new Set(hotels.map(h => h.property_type))];
        const labels: Record<string, string> = { hotel: '🏨 Khách sạn', homestay: '🏡 Homestay', villa: '🏖 Villa', apartment: '🏢 Căn hộ dịch vụ' };
        const lines = types.map(t => labels[t as string] || t).filter(Boolean);
        return `Sonder có các loại hình:\n\n${lines.join('\n')}\n\nAnh/chị thích loại nào ạ?`;
      }

      default:
        return null;
    }
  } catch (e) {
    return null;
  }
}

/**
 * Detect if message is "content question" — hỏi info about facility, không phải booking intent.
 * Ví dụ: "bên mình có wifi không", "gần có bánh mì ngon không", "có cho thú cưng không"
 */
function detectContentQuestion(msg: string): boolean {
  const lower = msg.toLowerCase().trim();
  if (lower.length < 8) return false;

  // Strong booking intent → NOT content
  if (/\b(đặt|book|giữ phòng|chốt|tạo đơn|lên lịch)\b/i.test(lower)) return false;

  // Name + phone contact form → NOT content
  if (/\b(0\d{9}|\+?84\d{9})\b/.test(lower)) return false;

  // Content question patterns
  const contentPatterns = [
    // Amenities / features
    /\b(có|sẵn|hỗ trợ)\s+\w+\s+(không|kh\b)/i,
    // Dining / food
    /\b(gần|có).*(bánh mì|quán|nhà hàng|ăn|cafe|cà phê|phở|cơm|đồ ăn|street food)/i,
    // Transport
    /\b(đưa đón|shuttle|taxi|grab|xe bus|metro)\b/i,
    // Safety/services
    /\b(smoke alarm|cctv|camera|bảo vệ|safety|an toàn|emergency)\b/i,
    // Pet
    /\b(thú cưng|chó|mèo|pet)\b/i,
    // Accessibility
    /\b(wheelchair|xe lăn|khuyết tật|thang máy|elevator)\b/i,
    // Wellness
    /\b(spa|gym|pool|hồ bơi|massage|sauna)\b/i,
    // Family
    /\b(trẻ em|kids|gia đình|gia dinh|cribs|giường trẻ)\b/i,
    // Business
    /\b(business|họp|meeting room|printer)\b/i,
    // Review/rating question
    /\b(review|đánh giá|rating|khách nói|feedback)\b/i,
    // Promo
    /\b(deal|ưu đãi|khuyến mãi|sale|promotion)\b/i,
    // Sustainability
    /\b(eco|môi trường|sustainability|xanh|tiết kiệm điện)\b/i,
    // Generic "what about" patterns
    /\b(như thế nào|ra sao|thế nào|là gì|có gì)\b/i,
  ];

  return contentPatterns.some(re => re.test(lower));
}

/**
 * Format unified query result (from knowledge-sync) into friendly bot reply.
 */
function formatRagAnswer(qr: { tier: string; answer_snippets: string[]; confidence: number }): string {
  if (!qr.answer_snippets?.length) return '';

  // Take top 2 snippets, clean up
  const snippets = qr.answer_snippets.slice(0, 2).map(s => {
    // Remove [Hotel] prefix nếu có, keep content
    return s.replace(/^\[[^\]]+\]\s*/, '').replace(/^\[\w+\]\s*/, '').trim();
  });

  if (snippets.length === 1) {
    return `${snippets[0]}\n\n💬 Anh/chị muốn em tư vấn thêm gì không ạ?`;
  }

  return `Dạ em tìm được thông tin này ạ:\n\n` +
    snippets.map((s, i) => `${i + 1}. ${s}`).join('\n\n') +
    `\n\n💬 Anh/chị muốn em tư vấn đặt phòng luôn không ạ?`;
}

/** Build inline ack string từ newSlots (cho capability redirect use). */
function buildAckString(newSlots: any): string {
  if (!newSlots) return '';
  const parts: string[] = [];
  if (newSlots.area_normalized) parts.push(newSlots.area_normalized);
  if (newSlots.guests_adults) parts.push(`${newSlots.guests_adults} khách`);
  if (newSlots.budget_max !== undefined) {
    const tier = newSlots.budget_max >= 1_000_000
      ? `${(newSlots.budget_max / 1_000_000).toFixed(1)}tr`
      : `${Math.round(newSlots.budget_max / 1000)}k`;
    parts.push(`≤${tier}`);
  }
  if (newSlots.checkin_date && newSlots.checkin_date !== 'flexible') parts.push(newSlots.checkin_date);
  if (parts.length === 0) return '';
  return `Dạ em note ${parts.join(' + ')} rồi ạ 👍. `;
}

export interface FunnelResponse {
  reply: string;
  quick_replies?: Array<{ title: string; payload?: string }>;
  cards?: Array<any>;
  images?: string[];
  intent: string;
  stage: Stage;
  handed_off?: boolean;
  booking_created?: boolean;
  meta?: Record<string, any>;
}

/**
 * Parse payloads từ quick reply button clicks.
 * Format: "property_type_hotel", "guests_2", "budget_n_low", etc.
 */
function parsePayload(payload: string, state: ConversationState): ExtractedSlots {
  const out: ExtractedSlots = {};

  if (payload.startsWith('property_type_')) {
    const type = payload.replace('property_type_', '');
    if (['hotel', 'homestay', 'villa', 'apartment', 'resort', 'guesthouse', 'hostel'].includes(type)) {
      out.property_type = type as any;
    }
  } else if (payload === 'guests_1' || payload === 'guests_2' || payload === 'guests_3') {
    out.guests = { adults: parseInt(payload.replace('guests_', ''), 10) };
  } else if (payload === 'guests_4plus') {
    out.guests = { adults: 4 };
  } else if (payload.startsWith('months_')) {
    out.months = parseInt(payload.replace('months_', ''), 10);
  } else if (payload === 'dates_today') {
    out.dates = { checkin_date: new Date().toISOString().slice(0, 10) };
  } else if (payload === 'dates_tomorrow') {
    const d = new Date(); d.setDate(d.getDate() + 1);
    out.dates = { checkin_date: d.toISOString().slice(0, 10) };
  } else if (payload === 'dates_weekend') {
    const d = new Date();
    const dow = d.getDay();
    const toSat = dow === 6 ? 7 : (6 - dow);
    d.setDate(d.getDate() + toSat);
    const checkIn = d.toISOString().slice(0, 10);
    d.setDate(d.getDate() + 2);
    out.dates = { checkin_date: checkIn, checkout_date: d.toISOString().slice(0, 10), nights: 2 };
  } else if (payload === 'dates_nextweek') {
    const d = new Date(); d.setDate(d.getDate() + 7);
    out.dates = { checkin_date: d.toISOString().slice(0, 10) };
  } else if (payload.startsWith('budget_n_')) {
    const tier = payload.replace('budget_n_', '');
    if (tier === 'low') out.budget = { max: 500_000, per: 'night' };
    else if (tier === 'mid') out.budget = { min: 500_000, max: 1_000_000, per: 'night' };
    else if (tier === 'high') out.budget = { min: 1_000_000, max: 2_000_000, per: 'night' };
    else if (tier === 'premium') out.budget = { min: 2_000_000, per: 'night' };
  } else if (payload.startsWith('budget_m_')) {
    const tier = payload.replace('budget_m_', '');
    if (tier === 'low') out.budget = { max: 5_000_000, per: 'month' };
    else if (tier === 'mid') out.budget = { min: 5_000_000, max: 10_000_000, per: 'month' };
    else if (tier === 'high') out.budget = { min: 10_000_000, max: 20_000_000, per: 'month' };
    else if (tier === 'premium') out.budget = { min: 20_000_000, per: 'month' };
  } else if (payload.startsWith('budget_h_')) {
    const tier = payload.replace('budget_h_', '');
    if (tier === 'low') out.budget = { max: 200_000, per: 'hour' };
    else if (tier === 'mid') out.budget = { min: 200_000, max: 400_000, per: 'hour' };
    else if (tier === 'high') out.budget = { min: 400_000, per: 'hour' };
  } else if (payload === 'budget_any') {
    out.budget = { no_filter: true };
  } else if (payload === 'area_any') {
    out.area = { area: 'any', normalized: 'any', type: 'city', city: 'Ho Chi Minh' };
  } else if (payload === 'area_q1') {
    out.area = { area: 'Q1', normalized: 'Q1', type: 'district', city: 'Ho Chi Minh', district: 'Q1' };
  } else if (payload === 'area_airport') {
    out.area = { area: 'sân bay TSN', normalized: 'Sân bay Tân Sơn Nhất', type: 'landmark', city: 'Ho Chi Minh', district: 'Tân Bình' };
  } else if (payload === 'area_binhthanh') {
    out.area = { area: 'Bình Thạnh', normalized: 'Bình Thạnh', type: 'district', city: 'Ho Chi Minh', district: 'Bình Thạnh' };
  } else if (payload === 'area_tanbinh') {
    out.area = { area: 'Tân Bình', normalized: 'Tân Bình', type: 'district', city: 'Ho Chi Minh', district: 'Tân Bình' };
  }

  return out;
}

/**
 * Main entry.
 */
export async function processFunnelMessage(
  senderId: string,
  hotelId: number,
  msg: string,
  opts: { payload?: string; language?: string; imageUrl?: string } = {},
): Promise<FunnelResponse> {
  // v14 Phase 3: Image upload → check if khách đang trong stage cọc → OCR pipeline
  if (opts.imageUrl) {
    try {
      // Check có hold booking active không
      const { handleDepositReceipt } = require('./deposit-handler');
      const hasActiveBooking = db.prepare(
        `SELECT id FROM sync_bookings WHERE hotel_id = ? AND sender_id = ? AND status = 'hold' AND expires_at > ? LIMIT 1`
      ).get(hotelId, senderId, Date.now()) as any;

      if (hasActiveBooking) {
        console.log(`[funnel] image received for sender=${senderId} with active booking #${hasActiveBooking.id} → OCR pipeline`);
        const r = await handleDepositReceipt({
          hotel_id: hotelId,
          sender_id: senderId,
          image_url: opts.imageUrl,
          booking_id: hasActiveBooking.id,
        });
        return {
          reply: r.reply,
          intent: `deposit_${r.status}`,
          stage: r.status === 'matched' ? 'BOOKING_DRAFT_CREATED' : 'CONFIRMATION_BEFORE_CLOSE',
          meta: { ocr_status: r.status, booking_id: r.booking_id, ocr_receipt_id: r.ocr_receipt_id },
        };
      }
      // Nếu không có active booking, ảnh không dùng → fall through xử lý bình thường
    } catch (e: any) {
      console.warn('[funnel] deposit handler fail:', e?.message);
    }
  }

  // 0. Gemini Intent Classifier — smart analyze ý định khách TRƯỚC khi enter FSM.
  //    Replaces regex detectContentQuestion với AI classification.
  let geminiIntent: any = null;
  try {
    const { analyzeIntent, geminiSlotsToExtracted } = require('./gemini-intent-classifier');
    const prevState = getState(senderId);
    geminiIntent = await analyzeIntent(msg, { hasPrevContext: !!prevState });
    if (geminiIntent) {
      console.log(`[gemini-intent] ${geminiIntent.primary_intent}/${geminiIntent.sub_category || '-'} conf=${geminiIntent.confidence} kb=${geminiIntent.in_knowledge_base} clarify=${geminiIntent.needs_clarification}`);
    }
  } catch (e: any) { console.warn('[funnel] Gemini intent fail:', e?.message); }

  // ROUTE 0.5: BARE HOTEL NAME — nếu msg chỉ là tên khách sạn (hoặc gần như vậy)
  //            → show hotel overview trực tiếp, không RAG snippet.
  //            Trigger khi: msg < 40 chars AND match hotel_profile.name_canonical (fuzzy).
  if (msg.trim().length < 40 && msg.trim().length >= 4) {
    try {
      const msgNorm = msg.trim().toLowerCase();
      const hotels = db.prepare(
        `SELECT hp.hotel_id, hp.name_canonical, hp.district, hp.city, hp.phone, hp.star_rating,
                hp.property_type, hp.ai_summary_vi
         FROM hotel_profile hp
         WHERE EXISTS (SELECT 1 FROM mkt_hotels mh WHERE mh.ota_hotel_id = hp.hotel_id AND mh.status = 'active')`
      ).all() as any[];
      // Find best match: full-name substring match
      const matched = hotels.find(h => {
        const nameNorm = (h.name_canonical || '').toLowerCase();
        // Msg is contained in name OR name is contained in msg (covers both "Seehome" and "Seehome Airport HCM")
        return (nameNorm.includes(msgNorm) || msgNorm.includes(nameNorm)) && nameNorm.length >= 4;
      });
      if (matched) {
        const rooms = db.prepare(`SELECT display_name_vi, max_guests, price_weekday FROM hotel_room_catalog WHERE hotel_id = ? ORDER BY price_weekday LIMIT 5`).all(matched.hotel_id) as any[];
        const stars = matched.star_rating ? ' ' + '⭐'.repeat(matched.star_rating) : '';
        const emoji = matched.property_type === 'apartment' ? '🏢' : matched.property_type === 'homestay' ? '🏡' : '🏨';
        const addr = [matched.district, matched.city].filter(Boolean).join(', ');
        const roomList = rooms.length
          ? rooms.map(r => `• ${r.display_name_vi} (${r.max_guests} khách) — ${r.price_weekday ? (r.price_weekday / 1000).toFixed(0) + 'k/đêm' : 'liên hệ'}`).join('\n')
          : '';
        return {
          reply: `${emoji} **${matched.name_canonical}**${stars}\n` +
            (addr ? `📍 ${addr}\n` : '') +
            (matched.phone ? `📞 ${matched.phone}\n` : '') +
            (matched.ai_summary_vi ? `\n${matched.ai_summary_vi}\n` : '') +
            (roomList ? `\n**Các loại phòng:**\n${roomList}\n` : '') +
            `\nAnh/chị quan tâm phòng nào? Cho em biết ngày + số khách em check lịch trống nhé 🙌`,
          intent: 'hotel_overview_direct',
          stage: 'INIT',
          meta: { gemini: geminiIntent, hotel_id: matched.hotel_id, match: 'bare_name' },
        };
      }
    } catch (e: any) { console.warn('[funnel] bare hotel name check fail:', e?.message); }
  }

  // ROUTE 1: Try answer GENERIC FIRST — nếu info_question về topic chung
  //          (price, wifi, checkin_time, pet, ...) → trả lời overview
  //          cho toàn bộ active hotels thay vì clarify ngay.
  if (geminiIntent?.primary_intent === 'info_question' && geminiIntent.sub_category && geminiIntent.in_knowledge_base) {
    const genericAnswer = buildGenericAnswer(geminiIntent.sub_category, msg);
    if (genericAnswer) {
      return {
        reply: genericAnswer,
        intent: `generic_${geminiIntent.sub_category}`,
        stage: 'INIT',
        meta: { gemini: geminiIntent },
      };
    }
  }

  // ROUTE 2: RAG semantic search (Tier 2/3) — tìm đúng chunk text
  if (geminiIntent?.primary_intent === 'info_question' && geminiIntent.in_knowledge_base && geminiIntent.confidence >= 0.5) {
    try {
      const { unifiedQuery } = require('./knowledge-sync');
      const qr = await unifiedQuery(msg);
      if (qr.tier !== 'none' && qr.confidence >= 0.4 && qr.answer_snippets?.length) {
        return {
          reply: formatRagAnswer(qr),
          intent: `rag_${qr.tier}_${geminiIntent.sub_category || 'info'}`,
          stage: 'INIT',
          meta: { tier: qr.tier, confidence: qr.confidence, gemini: geminiIntent },
        };
      }
    } catch (e: any) { console.warn('[funnel] RAG fail:', e?.message); }
  }

  // ROUTE 2.5: Image request — move BEFORE clarify (khách xin "ảnh phòng" thì cứ show, đừng hỏi lại)
  //            Detect qua a) Gemini primary_intent, b) regex fallback (KHÔNG dùng \b vì Vietnamese diacritics).
  const isImageReq = geminiIntent?.primary_intent === 'image_request'
    || /(ảnh|hình|photo|picture|xem phòng|xem nhà|hình ảnh)/i.test(msg);
  if (isImageReq) {
    try {
      // Nếu có property_name → show images từ hotel đó
      const propName = geminiIntent?.extracted_slots?.property_name;
      let imagesRows: any[];
      if (propName) {
        imagesRows = db.prepare(
          `SELECT ri.image_url, ri.caption, ri.room_type_name, hp.name_canonical
           FROM room_images ri
           JOIN hotel_profile hp ON hp.hotel_id = ri.hotel_id
           WHERE ri.active = 1 AND LOWER(hp.name_canonical) LIKE LOWER(?)
           ORDER BY ri.display_order, ri.id LIMIT 6`
        ).all(`%${propName}%`) as any[];
      } else {
        imagesRows = db.prepare(
          `SELECT ri.image_url, ri.caption, ri.room_type_name, hp.name_canonical
           FROM room_images ri
           LEFT JOIN hotel_profile hp ON hp.hotel_id = ri.hotel_id
           WHERE ri.active = 1
           ORDER BY ri.display_order, ri.id LIMIT 6`
        ).all() as any[];
      }
      if (imagesRows.length) {
        const imageUrls = imagesRows.map((i: any) => i.image_url).filter(Boolean);
        const list = imagesRows.map((i: any, idx: number) => `${idx + 1}. ${i.room_type_name || 'Phòng'} @ ${i.name_canonical || '?'}`).join('\n');
        return {
          reply: `Dạ ảnh phòng${propName ? ` của ${propName}` : ' các chỗ Sonder'} đây ạ:\n\n${list}\n\nAnh/chị thích loại nào để em tư vấn chi tiết? 💬`,
          images: imageUrls,
          intent: 'image_response',
          stage: 'INIT',
          meta: { gemini: geminiIntent },
        };
      }
    } catch (e: any) { console.warn('[funnel] image route fail:', e?.message); }
  }

  // ROUTE 3: Clarification (chỉ khi thực sự mơ hồ, sub_category không xác định)
  if (geminiIntent?.needs_clarification && geminiIntent.clarification_question && !geminiIntent.sub_category) {
    return {
      reply: geminiIntent.clarification_question,
      intent: `gemini_clarify_${geminiIntent.sub_category || 'unclear'}`,
      stage: 'INIT',
      meta: { gemini: geminiIntent },
    };
  }

  // ROUTE 3: Info question NHƯNG KHÔNG trong knowledge base → honest reply
  if (geminiIntent?.primary_intent === 'info_question' && !geminiIntent.in_knowledge_base && geminiIntent.confidence >= 0.7) {
    return {
      reply: `Dạ em xin lỗi, thông tin đó em chưa có trong hệ thống ạ 🙏\n\n` +
        `Anh/chị để lại SĐT, team em sẽ gọi tư vấn trực tiếp trong 15 phút.\n` +
        `Hoặc gọi hotline: 0348 644 833`,
      intent: `info_not_in_kb_${geminiIntent.sub_category || 'unknown'}`,
      stage: 'INIT',
      meta: { gemini: geminiIntent },
    };
  }

  // ROUTE 3.5: Specific hotel name mentioned → show hotel overview + rooms
  if (geminiIntent?.extracted_slots?.property_name) {
    try {
      const name = geminiIntent.extracted_slots.property_name;
      const hotel = db.prepare(
        `SELECT hp.hotel_id, hp.name_canonical, hp.district, hp.city, hp.phone, hp.star_rating,
                hp.property_type, hp.ai_summary_vi
         FROM hotel_profile hp
         WHERE EXISTS (SELECT 1 FROM mkt_hotels mh WHERE mh.ota_hotel_id = hp.hotel_id AND mh.status = 'active')
           AND LOWER(hp.name_canonical) LIKE LOWER(?)
         LIMIT 1`
      ).get(`%${name}%`) as any;
      if (hotel) {
        const rooms = db.prepare(`SELECT display_name_vi, max_guests, price_weekday FROM hotel_room_catalog WHERE hotel_id = ? ORDER BY price_weekday LIMIT 5`).all(hotel.hotel_id) as any[];
        const stars = hotel.star_rating ? ' ' + '⭐'.repeat(hotel.star_rating) : '';
        const emoji = hotel.property_type === 'apartment' ? '🏢' : hotel.property_type === 'homestay' ? '🏡' : '🏨';
        const addr = [hotel.district, hotel.city].filter(Boolean).join(', ');
        const roomList = rooms.length
          ? rooms.map(r => `• ${r.display_name_vi} (${r.max_guests} khách) — ${r.price_weekday ? (r.price_weekday / 1000).toFixed(0) + 'k/đêm' : 'liên hệ'}`).join('\n')
          : '';
        return {
          reply: `${emoji} **${hotel.name_canonical}**${stars}\n` +
            (addr ? `📍 ${addr}\n` : '') +
            (hotel.phone ? `📞 ${hotel.phone}\n` : '') +
            (hotel.ai_summary_vi ? `\n${hotel.ai_summary_vi}\n` : '') +
            (roomList ? `\n**Các loại phòng:**\n${roomList}\n` : '') +
            `\nAnh/chị quan tâm phòng nào? Cho em biết ngày + số khách em check lịch trống nhé 🙌`,
          intent: 'hotel_overview',
          stage: 'INIT',
          meta: { gemini: geminiIntent, hotel_id: hotel.hotel_id },
        };
      }
    } catch (e: any) { console.warn('[funnel] hotel name lookup fail:', e?.message); }
  }

  // ROUTE 5: Contact info — detect qua 2 nguồn:
  //   a) Gemini classify primary_intent = contact_info
  //   b) Hoặc deterministic: message chứa phone VN + ít thông tin khác
  const detectPhone = msg.match(/(?:\+?84|0)(3|5|7|8|9)\d{8}/);
  const isPhoneFirstMsg = !!detectPhone && !geminiIntent?.extracted_slots?.property_type;
  const isContactInfo = !!((geminiIntent?.primary_intent === 'contact_info' && geminiIntent.extracted_slots?.phone)
    || (isPhoneFirstMsg && msg.length < 80));

  if (isContactInfo) {
    const phone = geminiIntent?.extracted_slots?.phone || detectPhone?.[0] || '';
    const nameRaw = msg.replace(phone, '').replace(/[+\-\s,:.]/g, ' ').trim();
    const name = geminiIntent?.extracted_slots?.name ||
      (nameRaw.length > 1 && nameRaw.length < 50 ? nameRaw : '');
    try {
      // Save to pending contact — canonical schema from db.ts (sender_name, hotel_id NOT NULL)
      db.prepare(
        `INSERT INTO customer_contacts (sender_id, sender_name, phone, page_id, hotel_id, last_intent, last_message, created_at)
         VALUES (?, ?, ?, 0, ?, 'direct_contact', ?, ?)`
      ).run(senderId, name || null, phone, hotelId || 1, msg.slice(0, 200), Date.now());
      // Telegram notify
      try {
        const { notifyAll } = require('./telegram');
        notifyAll(`📱 *Lead mới qua OA*\n• Tên: ${name || '(chưa rõ)'}\n• SĐT: \`${phone}\`\n• Sender: \`${senderId}\`\n_Gọi trong 15 phút!_`).catch(() => {});
      } catch {}
      return {
        reply: `Dạ em đã ghi nhận thông tin:\n${name ? '• Tên: ' + name + '\n' : ''}• SĐT: ${phone}\n\n📞 Team em sẽ gọi trong 15 phút để tư vấn chi tiết ạ. Cảm ơn anh/chị! 🙏`,
        intent: 'contact_captured',
        stage: 'INIT',
        meta: { gemini: geminiIntent },
      };
    } catch (e: any) { console.warn('[funnel] contact_info save fail:', e?.message); }
  }

  // ROUTE 6: Farewell → thank you, end gracefully
  if (geminiIntent?.primary_intent === 'farewell') {
    return {
      reply: `Dạ cảm ơn anh/chị ạ! 🙏 Có gì cứ nhắn em bất cứ lúc nào nhé! Chúc anh/chị một ngày tốt lành 🌸`,
      intent: 'farewell',
      stage: 'INIT',
    };
  }

  // Fallback: detectContentQuestion (regex) nếu Gemini không trigger route
  const isContentQuestion = !geminiIntent && detectContentQuestion(msg);
  if (isContentQuestion) {
    try {
      const { unifiedQuery } = require('./knowledge-sync');
      const qr = await unifiedQuery(msg);
      if (qr.tier !== 'none' && qr.confidence >= 0.5 && qr.answer_snippets?.length) {
        return {
          reply: formatRagAnswer(qr),
          intent: `rag_${qr.tier}`,
          stage: 'INIT',
          meta: { tier: qr.tier, confidence: qr.confidence },
        };
      }
    } catch (e: any) { console.warn('[funnel] RAG short-circuit fail:', e?.message); }
  }

  // 0.5. RESET detection — user gõ greeting/restart phrase AFTER stuck state
  //      → reset state để bắt đầu lại flow fresh.
  const isGreetingOrReset = /^(chào|hello|hi|hey|alo|a\s*l[ôo]|bắt đầu|start|reset)/i.test(msg.trim());

  // 1. Load/init state
  let state = getState(senderId);
  const isNewConversation = !state;

  // If stuck in UNCLEAR_FALLBACK or HANDED_OFF and user sends greeting → reset
  if (state && isGreetingOrReset &&
      (state.stage === 'UNCLEAR_FALLBACK' || state.same_stage_count >= 2)) {
    console.log(`[funnel] reset detected: stage=${state.stage}, user greeting → fresh INIT`);
    const { resetState: resetFsm } = require('./conversation-fsm');
    resetFsm(senderId);
    state = initState(senderId, hotelId, opts.language || 'vi');
  }
  if (!state) {
    state = initState(senderId, hotelId, opts.language || 'vi');

    // Returning customer recognition (Level 1 + 2)
    try {
      const { getCustomerProfile, prefillSlotsFromMemory } = require('./customer-memory');
      const profile = getCustomerProfile(senderId);
      if (profile && profile.customer_tier !== 'new') {
        // Prefill slots từ past preferences
        const prefilled = prefillSlotsFromMemory(profile);
        Object.assign(state.slots, prefilled);
        // Tag state với customer profile (cho handler dùng)
        (state as any)._customer_profile = profile;
        console.log(`[funnel] returning customer: ${senderId} tier=${profile.customer_tier} bookings=${profile.confirmed_bookings}`);
      }
    } catch (e: any) { console.warn('[funnel] memory lookup fail:', e?.message); }
  }

  // If handed off, don't auto-reply
  if (state.handed_off) {
    return {
      reply: '',
      intent: 'handed_off',
      stage: 'HANDED_OFF',
      handed_off: true,
    };
  }

  // 2. Extract slots (deterministic + payload + Gemini multi-slot fallback)
  let extracted: ExtractedSlots = {};
  if (opts.payload) {
    extracted = parsePayload(opts.payload, state);
  } else {
    extracted = extractAllSlots(msg);
    // Merge slots từ Gemini intent classifier (nếu có)
    if (geminiIntent?.extracted_slots) {
      try {
        const { geminiSlotsToExtracted } = require('./gemini-intent-classifier');
        const geminiSlots = geminiSlotsToExtracted(geminiIntent.extracted_slots);
        const { mergeExtractedSlots } = require('./multi-slot-gemini');
        extracted = mergeExtractedSlots(extracted, geminiSlots);
      } catch {}
    }
    // Fallback: if deterministic extracted 0-1 slots AND msg is long → try Gemini
    const detCount = countExtracted(extracted);
    if (detCount <= 1 && msg.length >= 15 && msg.length <= 500) {
      try {
        const { extractSlotsGemini, mergeExtractedSlots } = require('./multi-slot-gemini');
        const geminiSlots = await extractSlotsGemini(msg);
        if (geminiSlots) {
          extracted = mergeExtractedSlots(extracted, geminiSlots);
          const newCount = countExtracted(extracted);
          if (newCount > detCount) {
            console.log(`[funnel] multi-slot Gemini: ${detCount} → ${newCount} slots from "${msg.slice(0, 60)}"`);
          }
        }
      } catch (e: any) {
        console.warn('[funnel] multi-slot Gemini fail:', e?.message);
      }
    }
    // Text-based pick: "lấy số 2", "chọn 1", "cái đầu"
    if (state.stage === 'SHOW_RESULTS' && state.slots.shown_property_ids?.length) {
      const pickN = msg.match(/(?:chọn|lấy|số|số thứ|thứ)\s*(\d+)/i) || msg.match(/^\s*(\d+)\s*$/);
      let pickedIdx: number | null = null;
      if (pickN) {
        pickedIdx = parseInt(pickN[1], 10) - 1;
      } else if (/\b(đầu|thứ nhất|first|cái 1|option 1|số một)\b/i.test(msg)) {
        pickedIdx = 0;
      } else if (/\bthứ hai\b|\bsố hai\b/i.test(msg)) {
        pickedIdx = 1;
      }
      if (pickedIdx !== null && pickedIdx >= 0 && pickedIdx < state.slots.shown_property_ids.length) {
        state.slots.selected_property_id = state.slots.shown_property_ids[pickedIdx];
        state.last_bot_stage = state.stage;
        state.stage = 'PROPERTY_PICKED' as any;  // Force transition
        console.log(`[funnel] text-pick: property_id=${state.slots.selected_property_id} (idx=${pickedIdx})`);
      }
    }
    // Text-based room pick khi PROPERTY_PICKED (vd "standard", "deluxe", "family")
    if (state.stage === 'PROPERTY_PICKED' && state.slots.selected_property_id) {
      const rooms = db.prepare(
        `SELECT id, display_name_vi FROM hotel_room_catalog WHERE hotel_id = ? ORDER BY price_weekday`
      ).all(state.slots.selected_property_id) as any[];
      const lower = msg.toLowerCase();
      let picked: any = null;
      // Try exact name match
      for (const r of rooms) {
        const name = String(r.display_name_vi || '').toLowerCase();
        if (name.includes(lower) || lower.includes(name.split(' ')[0])) {
          picked = r;
          break;
        }
      }
      // Auto-pick nếu chỉ có 1 room AND user nói "đặt/book/ok/yes/chọn"
      if (!picked && rooms.length === 1 && /\b(đặt|book|ok|yes|chọn|đi|đúng|luôn)\b/i.test(msg)) {
        picked = rooms[0];
      }
      if (picked) {
        state.slots.selected_room_id = picked.id;
        state.last_bot_stage = state.stage;
        state.stage = 'SHOW_ROOMS' as any;
        console.log(`[funnel] text-pick room: ${picked.display_name_vi} (id=${picked.id})`);
      }
    }

    // "đúng rồi" / "đặt luôn" trong SHOW_ROOMS → CONFIRMATION
    if (state.stage === 'SHOW_ROOMS' && /\b(đặt|book|ok|yes|đúng|luôn|confirm)\b/i.test(msg)) {
      state.last_bot_stage = state.stage;
      state.stage = 'CONFIRMATION_BEFORE_CLOSE' as any;
    }
    // "đúng" trong CONFIRMATION → CLOSING_CONTACT
    if (state.stage === 'CONFIRMATION_BEFORE_CLOSE' && /\b(đúng|ok|yes|confirm|đặt luôn|xác nhận)\b/i.test(msg)) {
      state.last_bot_stage = state.stage;
      state.stage = 'CLOSING_CONTACT' as any;
    }
    // Text-based confirmation "đúng rồi", "ok đặt luôn"
    if (state.stage === 'CONFIRMATION_BEFORE_CLOSE' && /đúng|ok|đặt luôn|yes|xác nhận/i.test(msg)) {
      state.last_bot_stage = state.stage;
      state.stage = 'CLOSING_CONTACT' as any;
    }
    // Text-based "đặt ngay/đặt phòng" in SHOW_ROOMS
    if (state.stage === 'SHOW_ROOMS' && /đặt|book|chọn phòng này/i.test(msg)) {
      state.last_bot_stage = state.stage;
      state.stage = 'CONFIRMATION_BEFORE_CLOSE' as any;
    }
  }

  // 2b. Handle special intents từ quick reply postback không phải slot
  if (opts.payload === 'ask_phone' || opts.payload === 'give_phone') {
    state.stage = 'UNCLEAR_FALLBACK';
  } else if (opts.payload === 'confirm_yes') {
    // proceed to CLOSING_CONTACT
    state.stage = 'CONFIRMATION_BEFORE_CLOSE';
  } else if (opts.payload === 'confirm_edit') {
    // back to SHOW_RESULTS
    state.stage = 'SHOW_RESULTS';
    state.slots.selected_property_id = undefined;
    state.slots.selected_room_id = undefined;
  } else if (opts.payload?.startsWith('pick_property_')) {
    state.slots.selected_property_id = parseInt(opts.payload.replace('pick_property_', ''), 10);
  } else if (opts.payload?.startsWith('pick_room_')) {
    state.slots.selected_room_id = parseInt(opts.payload.replace('pick_room_', ''), 10);
  } else if (opts.payload === 'confirm_book') {
    // from SHOW_ROOMS → CONFIRMATION_BEFORE_CLOSE
    state.stage = 'SHOW_ROOMS';
  } else if (opts.payload === 'back_results') {
    state.stage = 'SHOW_RESULTS';
    state.slots.selected_property_id = undefined;
    state.slots.selected_room_id = undefined;
  } else if (opts.payload === 'adjust_budget') {
    state.slots.budget_min = undefined;
    state.slots.budget_max = undefined;
    state.slots.budget_no_filter = undefined;
    state.stage = 'BUDGET_ASK';
  } else if (opts.payload === 'adjust_area') {
    state.slots.area = undefined;
    state.slots.area_normalized = undefined;
    state.slots.area_type = undefined;
    state.stage = 'AREA_ASK';
  }

  // ─── HONEST CAPABILITY CHECK ───
  // Nếu user request property_type KHÔNG tồn tại trong network → KHÔNG giả vờ có.
  // Redirect sang các type available thay vì đi tiếp flow rồi fail SHOW_RESULTS.
  if (extracted.property_type) {
    const available = getAvailablePropertyTypes();
    if (!available.includes(extracted.property_type)) {
      const requestedLabel = PROP_LABEL_DISPATCHER[extracted.property_type] || extracted.property_type;
      const altList = available.map(t => PROP_LABEL_DISPATCHER[t] || t).join(', ');

      // Track repeat: nếu user hỏi cùng type 2 lần → escalate
      state.same_stage_count = state.stage === 'PROPERTY_TYPE_ASK'
        ? (state.same_stage_count || 0) + 1
        : 0;

      // Keep other extracted slots (area, dates, etc) — chỉ drop property_type
      const origPropType = extracted.property_type;
      extracted.property_type = undefined;

      // Merge remaining slots
      const slotsBeforeMerge = { ...state.slots };
      state = mergeSlots(state, extracted);
      (state as any)._newSlots = diffSlots(slotsBeforeMerge, state.slots);

      state.slots.property_type = undefined;
      state.stage = 'PROPERTY_TYPE_ASK' as any;
      state.last_user_msg = msg.slice(0, 500);
      state.turn_count = (state.turn_count || 0) + 1;

      // Build ack cho slots khác (area, budget, etc)
      const ackForOtherSlots = buildAckString((state as any)._newSlots);

      let reply: string;

      // Escalate sau 2 lần hỏi cùng loại không có
      if (state.same_stage_count >= 2) {
        state.stage = 'UNCLEAR_FALLBACK' as any;
        saveState(state);
        reply = `Dạ em hiểu anh/chị đang tìm ${requestedLabel} cụ thể ạ 🙏\n\n` +
          `Hiện bên em chưa có, nhưng em có thể:\n` +
          `📱 Xin SĐT anh/chị, team sẽ liên hệ trong 15 phút tư vấn chỗ phù hợp nhất\n` +
          `📞 Hoặc anh/chị gọi hotline: 0348 644 833`;
        return {
          reply, intent: 'funnel_capability_escalate', stage: 'UNCLEAR_FALLBACK',
          quick_replies: [
            { title: '📱 Để SĐT', payload: 'give_phone' },
            { title: '🏢 Xem CHDV', payload: `property_type_apartment` },
            { title: '🏡 Xem Homestay', payload: `property_type_homestay` },
          ],
        };
      }

      saveState(state);
      reply = `${ackForOtherSlots}Dạ em xin lỗi, hiện bên em chưa có ${requestedLabel} riêng biệt ạ 😔\n\n` +
        `Bên em có: *${altList}* — các chỗ này đều chất lượng tốt${state.slots.area_normalized ? ' tại ' + state.slots.area_normalized : ''}.\n\n` +
        `Anh/chị muốn em tư vấn loại nào ạ?`;
      return {
        reply,
        intent: 'funnel_capability_redirect',
        stage: 'PROPERTY_TYPE_ASK',
        quick_replies: available.map(t => ({
          title: `${PROP_EMOJI_DISPATCHER[t] || '🏠'} ${PROP_LABEL_DISPATCHER[t] || t}`,
          payload: `property_type_${t}`,
        })),
      };
    }
  }

  // 3. Merge extracted into state
  const extractedCount = countExtracted(extracted);
  const stageBeforeMerge = state.stage;
  const slotsBeforeMerge = { ...state.slots };  // snapshot cho slot-diff ack
  state = mergeSlots(state, extracted);
  // Preserve explicit stage overrides from step 2b (text-based pick/confirm)
  const stageWasForced = state.stage !== stageBeforeMerge;
  // Store newly-filled slots trong state (temp field, không persist) cho handler dùng làm ack
  (state as any)._newSlots = diffSlots(slotsBeforeMerge, state.slots);

  // 4. Record turn + check fallback
  state = recordTurn(state, extractedCount, msg);
  if (shouldFallback(state, extractedCount, msg)) {
    state.stage = 'UNCLEAR_FALLBACK';
  }

  // 5. Decide next stage (skip-ahead logic) — ONLY if we didn't force a stage
  if (!stageWasForced) {
    const nextStage = decideNextStage(state);
    // Fix #2: Record same_stage_count BEFORE transition
    const { recordStageRepeat, applyStuckEscapeHatch } = require('./conversation-fsm');
    recordStageRepeat(state, nextStage);
    // Allow transition from UNCLEAR_FALLBACK if user provided new slots (escape!)
    const canExitUnclear = state.stage === 'UNCLEAR_FALLBACK' && extractedCount > 0;
    if (state.stage !== nextStage && (state.stage !== 'UNCLEAR_FALLBACK' || canExitUnclear)) {
      // v13: Log stage transition cho funnel analytics
      try {
        const fromStage = state.stage;
        db.prepare(
          `INSERT INTO funnel_stage_transitions
           (hotel_id, sender_id, from_stage, to_stage, trigger_intent, trigger_msg,
            slots_snapshot, same_stage_count, transition_type, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          hotelId, senderId, fromStage, nextStage,
          geminiIntent?.primary_intent || null,
          (msg || '').slice(0, 200),
          JSON.stringify(state.slots || {}),
          state.same_stage_count || 0,
          canExitUnclear ? 'reset' : 'forward',
          Date.now(),
        );
      } catch (e: any) { console.warn('[funnel] transition log fail:', e?.message); }

      state.last_bot_stage = state.stage;
      state.stage = nextStage;
      // Reset same_stage_count khi thoát UNCLEAR_FALLBACK
      if (canExitUnclear) {
        state.same_stage_count = 0;
        console.log(`[funnel] exit UNCLEAR_FALLBACK → ${nextStage} (extracted ${extractedCount} slots)`);
      }
    }
    // Fix #5 (same module): Stuck escape hatch
    if ((state.same_stage_count || 0) >= 2 && state.turns_since_extract >= 2) {
      const esc = applyStuckEscapeHatch(state);
      if (esc.applied) {
        console.log(`[funnel] stuck escape: ${state.stage} → ${esc.note}`);
        // Re-decide next stage với slot default mới
        const newStage = decideNextStage(state);
        if (newStage !== state.stage) {
          state.last_bot_stage = state.stage;
          state.stage = newStage;
          state.same_stage_count = 0;
        }
      }
    }
  } else {
    console.log(`[funnel] stage forced: ${stageBeforeMerge} → ${state.stage}`);
    state.same_stage_count = 0;  // explicit transition resets counter
  }

  // 6. Special: BOOKING_DRAFT_CREATED needs side-effect
  if (state.stage === 'BOOKING_DRAFT_CREATED' && state.slots.phone) {
    await createBookingDraft(state);
  }

  // 7. Run handler
  const result: HandlerResult = dispatchHandler(state);
  state.stage = result.next_stage;

  // Returning customer: prepend greeting vào reply đầu tiên
  if (isNewConversation && (state as any)._customer_profile) {
    try {
      const { buildReturningGreeting, buildReturningSuggestion } = require('./customer-memory');
      const profile = (state as any)._customer_profile;
      const greeting = buildReturningGreeting(profile);
      const suggestion = buildReturningSuggestion(profile);
      if (greeting && result.reply) {
        const prefix = [greeting, suggestion].filter(Boolean).join('\n\n');
        result.reply = prefix + '\n\n' + result.reply;
      }
    } catch {}
  }

  // 8. Save state
  saveState(state);

  return {
    reply: result.reply,
    quick_replies: result.quick_replies,
    cards: result.cards,
    images: result.images,
    intent: `funnel_${state.stage.toLowerCase()}`,
    stage: state.stage,
    booking_created: state.stage === 'BOOKING_DRAFT_CREATED',
    meta: result.meta,
  };
}

/**
 * Side-effect: tạo pending_booking row + notify Telegram hotel team.
 */
async function createBookingDraft(state: ConversationState): Promise<void> {
  const s = state.slots;
  try {
    const now = Date.now();
    // Use new table 'bot_booking_drafts' to avoid conflict với existing pending_bookings schema
    db.exec(`CREATE TABLE IF NOT EXISTS bot_booking_drafts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sender_id TEXT,
      hotel_id INTEGER,
      room_id INTEGER,
      property_type TEXT,
      rental_mode TEXT,
      checkin_date TEXT,
      checkout_date TEXT,
      nights INTEGER,
      months INTEGER,
      guests_adults INTEGER,
      guests_children INTEGER,
      budget_min INTEGER,
      budget_max INTEGER,
      area TEXT,
      phone TEXT,
      name TEXT,
      email TEXT,
      slots_json TEXT,
      status TEXT DEFAULT 'new',
      created_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_bot_booking_drafts_status ON bot_booking_drafts(status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_bot_booking_drafts_sender ON bot_booking_drafts(sender_id);`);

    db.prepare(
      `INSERT INTO bot_booking_drafts (
        sender_id, hotel_id, room_id, property_type, rental_mode,
        checkin_date, checkout_date, nights, months,
        guests_adults, guests_children, budget_min, budget_max, area,
        phone, name, email, slots_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      state.sender_id,
      s.selected_property_id || state.hotel_id,
      s.selected_room_id || null,
      s.property_type || null,
      s.rental_mode || null,
      s.checkin_date || null,
      s.checkout_date || null,
      s.nights || null,
      s.months || null,
      s.guests_adults || null,
      s.guests_children || null,
      s.budget_min || null,
      s.budget_max || null,
      s.area_normalized || s.area || null,
      s.phone || null,
      s.name || null,
      s.email || null,
      JSON.stringify(s),
      now,
    );

    // Rebuild customer memory (async, don't block)
    try {
      const { rebuildCustomerProfile } = require('./customer-memory');
      rebuildCustomerProfile(state.sender_id);
    } catch {}

    // Enhanced Telegram notify — rich format + hotel-specific routing
    try {
      // Resolve hotel info
      const hotel = s.selected_property_id
        ? db.prepare(`SELECT name_canonical, phone, district, city FROM hotel_profile WHERE hotel_id = ?`).get(s.selected_property_id) as any
        : null;
      const room = s.selected_room_id
        ? db.prepare(`SELECT display_name_vi, price_weekday FROM hotel_room_catalog WHERE id = ?`).get(s.selected_room_id) as any
        : null;

      // Compute total
      const isLong = s.rental_mode === 'long_term';
      const pricePerUnit = room?.price_weekday || s.budget_max || 0;
      const qty = isLong ? (s.months || 1) : (s.nights || 1);
      const totalEst = isLong ? pricePerUnit * 30 * qty : pricePerUnit * qty;

      // Channel detection
      const channel = state.sender_id.startsWith('zalo:') ? '💬 Zalo'
        : state.sender_id.match(/^\d{10,}$/) ? '📘 Facebook'
        : '🌐 Web';

      // Rich Markdown format
      const lines: string[] = [
        `🎯 *NEW BOOKING LEAD* ${channel}`,
        ``,
        `👤 *${s.name || '(chưa có tên)'}*  📞 \`${s.phone || '?'}\``,
        ``,
        `🏨 *Chỗ đặt*: ${hotel?.name_canonical || '(chưa chọn)'}`,
      ];
      if (hotel?.district) lines.push(`📍 ${hotel.district}${hotel.city ? ', ' + hotel.city : ''}`);
      if (room) lines.push(`🛏 *Loại*: ${room.display_name_vi}`);

      if (isLong) {
        lines.push(`📅 *Thuê*: ${s.months || '?'} tháng`);
        if (s.checkin_date) lines.push(`📆 Dọn vào: ${s.checkin_date}`);
      } else {
        if (s.checkin_date) {
          lines.push(`📅 *Check-in*: ${s.checkin_date}${s.checkout_date ? ' → ' + s.checkout_date : ''}${s.nights ? ` (${s.nights} đêm)` : ''}`);
        }
      }

      lines.push(`👥 *Khách*: ${s.guests_adults || '?'}${s.guests_children ? ` + ${s.guests_children} trẻ em` : ''}`);

      if (pricePerUnit > 0) {
        const unit = isLong ? 'tháng' : 'đêm';
        lines.push(`💰 *Giá*: ${pricePerUnit.toLocaleString('vi-VN')}₫/${unit}`);
        if (totalEst > pricePerUnit) {
          lines.push(`💵 *Tổng tạm*: *${totalEst.toLocaleString('vi-VN')}₫*`);
        }
      } else if (s.budget_max) {
        lines.push(`💰 *Budget*: ≤ ${s.budget_max.toLocaleString('vi-VN')}₫`);
      }

      if (s.area_normalized) lines.push(`🔍 *Tìm ở*: ${s.area_normalized}`);

      lines.push(``);
      lines.push(`⏰ *Call trong 15 phút* để chốt!`);
      lines.push(`_Sender_: \`${state.sender_id}\``);
      lines.push(`_Admin_: app.sondervn.com/funnel`);

      const summary = lines.join('\n');

      // Route: hotel-specific Telegram group if configured, else global
      // Find page_id cho hotel (từ pages table or use first active)
      try {
        if (s.selected_property_id) {
          const page = db.prepare(
            `SELECT p.id FROM pages p JOIN mkt_hotels mh ON mh.id = p.hotel_id WHERE mh.ota_hotel_id = ? LIMIT 1`
          ).get(s.selected_property_id) as any;
          if (page?.id) {
            const { notifyHotelOrGlobal } = require('./hotel-telegram');
            await notifyHotelOrGlobal(page.id, summary);
          } else {
            const { notifyAll } = require('./telegram');
            notifyAll(summary).catch(() => {});
          }
        } else {
          const { notifyAll } = require('./telegram');
          notifyAll(summary).catch(() => {});
        }
      } catch (e: any) {
        console.warn('[funnel] telegram notify fail:', e?.message);
      }

      // Email notify (if SMTP configured)
      try {
        const { sendBookingLeadEmail } = require('./email-notify');
        if (sendBookingLeadEmail) {
          sendBookingLeadEmail({
            name: s.name, phone: s.phone, email: s.email,
            hotel_name: hotel?.name_canonical,
            room_name: room?.display_name_vi,
            checkin: s.checkin_date, checkout: s.checkout_date,
            nights: s.nights, months: s.months,
            guests: s.guests_adults, total: totalEst,
            sender_id: state.sender_id,
          }).catch(() => {});
        }
      } catch {}
    } catch (e: any) {
      console.warn('[funnel] notify fail:', e?.message);
    }
  } catch (e: any) {
    console.error('[funnel] createBookingDraft fail:', e?.message);
  }
}

/**
 * Admin trigger: takeover conversation (pause bot).
 */
export function takeoverConversation(senderId: string): boolean {
  try {
    markHandedOff(senderId);
    return true;
  } catch {
    return false;
  }
}

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
  ConversationState, Stage,
} from './conversation-fsm';
import { extractAllSlots, countExtracted, ExtractedSlots } from './slot-extractor';
import { dispatchHandler, HandlerResult } from './funnel-handlers';
import { db } from '../db';

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
  opts: { payload?: string; language?: string } = {},
): Promise<FunnelResponse> {
  // 1. Load/init state
  let state = getState(senderId);
  if (!state) {
    state = initState(senderId, hotelId, opts.language || 'vi');
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

  // 3. Merge extracted into state
  const extractedCount = countExtracted(extracted);
  const stageBeforeMerge = state.stage;
  state = mergeSlots(state, extracted);
  // Preserve explicit stage overrides from step 2b (text-based pick/confirm)
  const stageWasForced = state.stage !== stageBeforeMerge;

  // 4. Record turn + check fallback
  state = recordTurn(state, extractedCount, msg);
  if (shouldFallback(state, extractedCount, msg)) {
    state.stage = 'UNCLEAR_FALLBACK';
  }

  // 5. Decide next stage (skip-ahead logic) — ONLY if we didn't force a stage
  if (!stageWasForced) {
    const nextStage = decideNextStage(state);
    if (state.stage !== nextStage && state.stage !== 'UNCLEAR_FALLBACK') {
      state.last_bot_stage = state.stage;
      state.stage = nextStage;
    }
  } else {
    console.log(`[funnel] stage forced: ${stageBeforeMerge} → ${state.stage}`);
  }

  // 6. Special: BOOKING_DRAFT_CREATED needs side-effect
  if (state.stage === 'BOOKING_DRAFT_CREATED' && state.slots.phone) {
    await createBookingDraft(state);
  }

  // 7. Run handler
  const result: HandlerResult = dispatchHandler(state);
  state.stage = result.next_stage;

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

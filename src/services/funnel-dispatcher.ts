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

  // 2. Extract slots (deterministic + payload)
  let extracted: ExtractedSlots = {};
  if (opts.payload) {
    extracted = parsePayload(opts.payload, state);
  } else {
    extracted = extractAllSlots(msg);
    // Text-based pick: "lấy số 2", "chọn 1", "cái đầu"
    if (state.stage === 'SHOW_RESULTS' && state.slots.shown_property_ids?.length) {
      const pickN = msg.match(/(?:chọn|lấy|số|số thứ|thứ)\s*(\d+)/i) || msg.match(/^(\d+)$/);
      if (pickN) {
        const idx = parseInt(pickN[1], 10) - 1;
        const pid = state.slots.shown_property_ids[idx];
        if (pid) state.slots.selected_property_id = pid;
      } else if (/\b(đầu|thứ nhất|first|cái 1)\b/i.test(msg)) {
        state.slots.selected_property_id = state.slots.shown_property_ids[0];
      }
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
  state = mergeSlots(state, extracted);

  // 4. Record turn + check fallback
  state = recordTurn(state, extractedCount, msg);
  if (shouldFallback(state, extractedCount, msg)) {
    state.stage = 'UNCLEAR_FALLBACK';
  }

  // 5. Decide next stage (skip-ahead logic)
  const nextStage = decideNextStage(state);
  if (state.stage !== nextStage && state.stage !== 'UNCLEAR_FALLBACK') {
    state.last_bot_stage = state.stage;
    state.stage = nextStage;
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

    // Notify Telegram
    try {
      const { notifyAll } = require('./telegram');
      const summary = [
        `🎯 **NEW BOOKING LEAD**`,
        `• Tên: ${s.name || '?'}`,
        `• SĐT: ${s.phone || '?'}`,
        `• Loại: ${s.property_type || '?'}`,
        `• Chỗ: ${s.selected_property_id || '?'}`,
        s.checkin_date ? `• Ngày: ${s.checkin_date}${s.checkout_date ? ' → ' + s.checkout_date : ''}${s.nights ? ' (' + s.nights + ' đêm)' : ''}` : null,
        s.months ? `• Thuê ${s.months} tháng` : null,
        `• Khách: ${s.guests_adults || '?'}${s.guests_children ? ' + ' + s.guests_children + ' bé' : ''}`,
        s.budget_max ? `• Budget: ${s.budget_max.toLocaleString('vi-VN')}₫` : null,
        `• Sender: ${state.sender_id}`,
      ].filter(Boolean).join('\n');
      notifyAll(summary).catch(() => {});
    } catch {}
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

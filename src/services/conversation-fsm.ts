/**
 * Conversation FSM — state machine cho bot sales funnel.
 *
 * Spec: docs/BOT-SALES-FUNNEL-PLAN.md (v1.1)
 *
 * 15 states:
 *   INIT → PROPERTY_TYPE_ASK → [DATES_ASK | MONTHS_ASK] → GUESTS_ASK →
 *   BUDGET_ASK → AREA_ASK → [CHDV_EXTRAS_ASK] → SHOW_RESULTS →
 *   PROPERTY_PICKED → SHOW_ROOMS → CONFIRMATION_BEFORE_CLOSE →
 *   CLOSING_CONTACT → BOOKING_DRAFT_CREATED
 *
 *   UNCLEAR_FALLBACK (fallback) → HANDED_OFF (terminal)
 *
 * API:
 *   getState(senderId) → current state or null
 *   saveState(senderId, update) → UPSERT
 *   recordTurn(senderId, extracted) → update turns_since_extract counter
 *   shouldFallback(state) → true nếu cần chuyển UNCLEAR_FALLBACK
 *   resetState(senderId) → delete state row
 */

import { db } from '../db';
import { ExtractedSlots, countExtracted } from './slot-extractor';

/* ═══════════════════════════════════════════
   Schema
   ═══════════════════════════════════════════ */

db.exec(`
CREATE TABLE IF NOT EXISTS bot_conversation_state (
  sender_id TEXT PRIMARY KEY,
  hotel_id INTEGER NOT NULL,
  stage TEXT NOT NULL DEFAULT 'INIT',
  slots TEXT NOT NULL DEFAULT '{}',
  turns_since_extract INTEGER DEFAULT 0,
  turn_count INTEGER DEFAULT 0,
  language TEXT DEFAULT 'vi',
  handed_off INTEGER DEFAULT 0,
  last_bot_stage TEXT,
  last_user_msg TEXT,
  history_summary TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bot_state_updated ON bot_conversation_state(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_bot_state_handed_off ON bot_conversation_state(handed_off) WHERE handed_off = 1;
`);

/* ═══════════════════════════════════════════
   Types
   ═══════════════════════════════════════════ */

export type Stage =
  | 'INIT'
  | 'PROPERTY_TYPE_ASK'
  | 'DATES_ASK'                    // short-term
  | 'MONTHS_ASK'                   // long-term (CHDV)
  | 'CHDV_STARTDATE_ASK'           // long-term
  | 'GUESTS_ASK'
  | 'BUDGET_ASK'
  | 'AREA_ASK'
  | 'CHDV_EXTRAS_ASK'              // long-term extras (deposit/utilities)
  | 'SHOW_RESULTS'
  | 'PROPERTY_PICKED'
  | 'SHOW_ROOMS'
  | 'CONFIRMATION_BEFORE_CLOSE'    // repeat summary, ask confirm
  | 'CLOSING_CONTACT'              // xin SĐT + tên
  | 'BOOKING_DRAFT_CREATED'        // terminal success
  | 'UNCLEAR_FALLBACK'             // 2 turns no extract → xin SĐT
  | 'HANDED_OFF';                  // terminal — bot pause

export interface BookingSlots {
  // Category
  property_type?: 'hotel' | 'homestay' | 'villa' | 'apartment' | 'resort' | 'guesthouse' | 'hostel';
  rental_mode?: 'short_term' | 'long_term';
  rental_sub_mode?: 'hourly' | 'nightly' | 'monthly';

  // Location
  area?: string;                   // raw user text
  area_normalized?: string;        // canonical name
  area_type?: 'district' | 'landmark' | 'city';
  city?: string;

  // Time — short-term
  checkin_date?: string;           // ISO YYYY-MM-DD
  checkout_date?: string;
  nights?: number;
  checkin_time?: string;           // HH:MM (for hourly)

  // Time — long-term
  months?: number;
  start_month?: string;            // "2026-05"

  // Pax
  guests_adults?: number;
  guests_children?: number;

  // Budget
  budget_min?: number;
  budget_max?: number;
  budget_per?: 'night' | 'month' | 'hour';
  budget_no_filter?: boolean;

  // CHDV extras (long-term only)
  utilities_included?: boolean;
  full_kitchen?: boolean;
  washing_machine?: boolean;

  // Selection
  shown_property_ids?: number[];
  selected_property_id?: number;
  selected_room_id?: number;

  // Contact
  phone?: string;
  name?: string;
  email?: string;
}

export interface ConversationState {
  sender_id: string;
  hotel_id: number;
  stage: Stage;
  slots: BookingSlots;
  turns_since_extract: number;
  turn_count: number;
  language: string;
  handed_off: boolean;
  last_bot_stage?: Stage;
  last_user_msg?: string;
  history_summary?: string;
  created_at: number;
  updated_at: number;
}

/* ═══════════════════════════════════════════
   CRUD
   ═══════════════════════════════════════════ */

export function getState(senderId: string): ConversationState | null {
  const row = db.prepare(
    `SELECT * FROM bot_conversation_state WHERE sender_id = ?`
  ).get(senderId) as any;
  if (!row) return null;
  try {
    return {
      sender_id: row.sender_id,
      hotel_id: row.hotel_id,
      stage: row.stage,
      slots: JSON.parse(row.slots || '{}'),
      turns_since_extract: row.turns_since_extract || 0,
      turn_count: row.turn_count || 0,
      language: row.language || 'vi',
      handed_off: !!row.handed_off,
      last_bot_stage: row.last_bot_stage,
      last_user_msg: row.last_user_msg,
      history_summary: row.history_summary,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  } catch (e) {
    console.error('[fsm] getState parse error:', e);
    return null;
  }
}

export function initState(senderId: string, hotelId: number, language = 'vi'): ConversationState {
  const now = Date.now();
  const row: ConversationState = {
    sender_id: senderId,
    hotel_id: hotelId,
    stage: 'INIT',
    slots: {},
    turns_since_extract: 0,
    turn_count: 0,
    language,
    handed_off: false,
    created_at: now,
    updated_at: now,
  };
  db.prepare(
    `INSERT OR REPLACE INTO bot_conversation_state
     (sender_id, hotel_id, stage, slots, turns_since_extract, turn_count, language, handed_off, created_at, updated_at)
     VALUES (?, ?, 'INIT', '{}', 0, 0, ?, 0, ?, ?)`
  ).run(senderId, hotelId, language, now, now);
  return row;
}

export function saveState(state: ConversationState): void {
  state.updated_at = Date.now();
  db.prepare(
    `UPDATE bot_conversation_state SET
      hotel_id = ?, stage = ?, slots = ?, turns_since_extract = ?, turn_count = ?,
      language = ?, handed_off = ?, last_bot_stage = ?, last_user_msg = ?,
      history_summary = ?, updated_at = ?
     WHERE sender_id = ?`
  ).run(
    state.hotel_id, state.stage, JSON.stringify(state.slots),
    state.turns_since_extract, state.turn_count,
    state.language, state.handed_off ? 1 : 0,
    state.last_bot_stage || null, state.last_user_msg || null,
    state.history_summary || null, state.updated_at,
    state.sender_id,
  );
}

export function resetState(senderId: string): void {
  db.prepare(`DELETE FROM bot_conversation_state WHERE sender_id = ?`).run(senderId);
}

export function markHandedOff(senderId: string): void {
  db.prepare(`UPDATE bot_conversation_state SET handed_off = 1, stage = 'HANDED_OFF', updated_at = ? WHERE sender_id = ?`)
    .run(Date.now(), senderId);
}

export function resumeBot(senderId: string): void {
  db.prepare(`UPDATE bot_conversation_state SET handed_off = 0, updated_at = ? WHERE sender_id = ?`)
    .run(Date.now(), senderId);
}

/* ═══════════════════════════════════════════
   Slot merge logic
   ═══════════════════════════════════════════ */

/**
 * Merge extracted slots vào state.slots, giữ preservation (không overwrite null).
 * Flatten từ ExtractedSlots format sang BookingSlots format.
 */
export function mergeSlots(state: ConversationState, extracted: ExtractedSlots): ConversationState {
  const s = { ...state.slots };

  if (extracted.property_type) {
    s.property_type = extracted.property_type as BookingSlots['property_type'];
    // Derive rental_mode
    s.rental_mode = extracted.property_type === 'apartment' ? 'long_term' : 'short_term';
  }

  if (extracted.area) {
    s.area = extracted.area.area;
    s.area_normalized = extracted.area.normalized;
    s.area_type = extracted.area.type;
    s.city = extracted.area.city;
  }

  if (extracted.dates) {
    if (extracted.dates.checkin_date) s.checkin_date = extracted.dates.checkin_date;
    if (extracted.dates.checkout_date) s.checkout_date = extracted.dates.checkout_date;
    if (extracted.dates.nights) s.nights = extracted.dates.nights;
  }

  if (extracted.guests) {
    if (extracted.guests.adults !== undefined) s.guests_adults = extracted.guests.adults;
    if (extracted.guests.children !== undefined) s.guests_children = extracted.guests.children;
  }

  if (extracted.budget) {
    if (extracted.budget.min !== undefined) s.budget_min = extracted.budget.min;
    if (extracted.budget.max !== undefined) s.budget_max = extracted.budget.max;
    if (extracted.budget.per) s.budget_per = extracted.budget.per;
    if (extracted.budget.no_filter) s.budget_no_filter = true;
  }

  if (extracted.phone) s.phone = extracted.phone;
  if (extracted.name) s.name = extracted.name;
  if (extracted.email) s.email = extracted.email;
  if (extracted.months) {
    s.months = extracted.months;
    s.rental_sub_mode = 'monthly';
  }
  if (extracted.rental_sub_mode) s.rental_sub_mode = extracted.rental_sub_mode;
  if (extracted.checkin_time) s.checkin_time = extracted.checkin_time;

  return { ...state, slots: s };
}

/* ═══════════════════════════════════════════
   Transition logic
   ═══════════════════════════════════════════ */

/**
 * Decide next stage based on current stage + slots filled.
 * "Skip ahead" nếu slots tương lai đã có.
 */
export function decideNextStage(state: ConversationState): Stage {
  const { stage, slots } = state;
  const isLong = slots.rental_mode === 'long_term' || slots.property_type === 'apartment';

  // Priority 1: handed_off is terminal
  if (state.handed_off) return 'HANDED_OFF';

  // Priority 2: booking draft = terminal success
  if (stage === 'BOOKING_DRAFT_CREATED') return 'BOOKING_DRAFT_CREATED';

  // Priority 3: if SHOW_RESULTS onwards, follow linear pipe
  // Note: dispatcher may force explicit transitions (pick, confirm_yes, etc.)
  if (stage === 'CONFIRMATION_BEFORE_CLOSE') {
    return slots.phone ? 'BOOKING_DRAFT_CREATED' : 'CONFIRMATION_BEFORE_CLOSE';
  }
  if (stage === 'CLOSING_CONTACT') {
    return slots.phone && slots.name ? 'BOOKING_DRAFT_CREATED' : 'CLOSING_CONTACT';
  }
  if (stage === 'SHOW_ROOMS') {
    return slots.selected_room_id ? 'SHOW_ROOMS' : 'PROPERTY_PICKED';
  }
  if (stage === 'PROPERTY_PICKED') {
    return slots.selected_room_id ? 'SHOW_ROOMS' : 'PROPERTY_PICKED';
  }
  if (stage === 'SHOW_RESULTS') {
    return slots.selected_property_id ? 'PROPERTY_PICKED' : 'SHOW_RESULTS';
  }

  // Priority 4: Collecting slots (before SHOW_RESULTS)
  // Order: property_type → dates/months → guests → budget → area → [chdv_extras] → show
  if (!slots.property_type) return 'PROPERTY_TYPE_ASK';

  if (isLong) {
    if (!slots.months) return 'MONTHS_ASK';
    if (!slots.start_month && !slots.checkin_date) return 'CHDV_STARTDATE_ASK';
  } else {
    if (!slots.checkin_date && !slots.nights) return 'DATES_ASK';
  }

  if (!slots.guests_adults) return 'GUESTS_ASK';
  if (slots.budget_min === undefined && slots.budget_max === undefined && !slots.budget_no_filter) return 'BUDGET_ASK';
  if (!slots.area_normalized && slots.area_type !== 'city' && !slots.budget_no_filter) return 'AREA_ASK';

  if (isLong) {
    // Optional for long-term: ask extras once
    if (slots.utilities_included === undefined && slots.full_kitchen === undefined && slots.washing_machine === undefined && stage !== 'CHDV_EXTRAS_ASK') {
      return 'CHDV_EXTRAS_ASK';
    }
  }

  return 'SHOW_RESULTS';
}

/* ═══════════════════════════════════════════
   Fallback trigger
   ═══════════════════════════════════════════ */

/**
 * Should we trigger UNCLEAR_FALLBACK?
 * - 2 consecutive turns with no slot extracted AND not in result/close/etc states
 * - Or user explicitly says "bot không hiểu"
 */
export function shouldFallback(state: ConversationState, extractedCount: number, userMsg: string): boolean {
  if (state.handed_off) return false;
  if (['SHOW_RESULTS', 'PROPERTY_PICKED', 'SHOW_ROOMS', 'CONFIRMATION_BEFORE_CLOSE', 'CLOSING_CONTACT', 'BOOKING_DRAFT_CREATED', 'HANDED_OFF'].includes(state.stage)) {
    return false;
  }

  // Explicit frustration
  const lower = userMsg.toLowerCase();
  if (/bot\s+(không hiểu|ngu|rồ|tệ)|nói chuyện người|speak to human|nhân viên thật/i.test(lower)) {
    return true;
  }

  // 2 turns no extract
  return state.turns_since_extract >= 2 && extractedCount === 0;
}

/**
 * Record turn: update turns_since_extract + turn_count.
 */
export function recordTurn(state: ConversationState, extractedCount: number, userMsg: string): ConversationState {
  state.turn_count = (state.turn_count || 0) + 1;
  if (extractedCount === 0) {
    state.turns_since_extract = (state.turns_since_extract || 0) + 1;
  } else {
    state.turns_since_extract = 0;
  }
  state.last_user_msg = userMsg.slice(0, 500);
  return state;
}

/* ═══════════════════════════════════════════
   Feature flag
   ═══════════════════════════════════════════ */

export function isFunnelEnabled(): boolean {
  return process.env.USE_NEW_FUNNEL === 'true' || process.env.USE_NEW_FUNNEL === '1';
}

/* ═══════════════════════════════════════════
   Stats (admin dashboard)
   ═══════════════════════════════════════════ */

export function getFsmStats(): Record<string, any> {
  const total = (db.prepare(`SELECT COUNT(*) as n FROM bot_conversation_state`).get() as any).n;
  const handedOff = (db.prepare(`SELECT COUNT(*) as n FROM bot_conversation_state WHERE handed_off = 1`).get() as any).n;
  const stageBreakdown = db.prepare(
    `SELECT stage, COUNT(*) as n FROM bot_conversation_state GROUP BY stage ORDER BY n DESC`
  ).all();
  const activeLast24h = (db.prepare(
    `SELECT COUNT(*) as n FROM bot_conversation_state WHERE updated_at > ?`
  ).get(Date.now() - 24 * 3600000) as any).n;
  const bookingsCreated = (db.prepare(
    `SELECT COUNT(*) as n FROM bot_conversation_state WHERE stage = 'BOOKING_DRAFT_CREATED'`
  ).get() as any).n;

  return {
    total_conversations: total,
    handed_off: handedOff,
    bookings_created: bookingsCreated,
    active_last_24h: activeLast24h,
    conversion_rate: total > 0 ? Math.round((bookingsCreated / total) * 1000) / 10 : 0,
    handoff_rate: total > 0 ? Math.round((handedOff / total) * 1000) / 10 : 0,
    stage_breakdown: stageBreakdown,
  };
}

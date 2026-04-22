/**
 * Customer Memory — long-term preferences + tier tracking per sender.
 *
 * Sources:
 *   - bot_conversation_state: past conversations
 *   - bot_booking_drafts: past bookings (confirmed/paid)
 *   - customer_memory: computed aggregates (preferences, tier, LTV)
 *
 * Usage:
 *   - getCustomerProfile(senderId) → preferences + tier
 *   - Level 1: recognize returning via sender_id
 *   - Level 2: auto-fill past preferences into new conversation
 *   - Level 3 (future): auto-greet with personalized message
 */

import { db } from '../db';

/* ═══════════════════════════════════════════
   Schema
   ═══════════════════════════════════════════ */

db.exec(`
CREATE TABLE IF NOT EXISTS customer_memory (
  sender_id TEXT PRIMARY KEY,
  hotel_id INTEGER,
  name TEXT,
  phone TEXT,
  email TEXT,
  total_conversations INTEGER DEFAULT 0,
  total_bookings INTEGER DEFAULT 0,
  confirmed_bookings INTEGER DEFAULT 0,
  last_property_id INTEGER,
  last_property_type TEXT,
  last_area TEXT,
  last_budget INTEGER,
  last_guests INTEGER,
  last_nights INTEGER,
  typical_guests INTEGER,
  typical_budget INTEGER,
  favorite_district TEXT,
  favorite_property_type TEXT,
  customer_tier TEXT DEFAULT 'new',          -- new | returning | regular | vip
  lifetime_value INTEGER DEFAULT 0,
  first_seen_at INTEGER,
  last_seen_at INTEGER,
  updated_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_cm_phone ON customer_memory(phone);
CREATE INDEX IF NOT EXISTS idx_cm_tier ON customer_memory(customer_tier, last_seen_at);
`);

/* ═══════════════════════════════════════════
   Types
   ═══════════════════════════════════════════ */

export interface CustomerProfile {
  sender_id: string;
  name?: string;
  phone?: string;
  total_conversations: number;
  total_bookings: number;
  confirmed_bookings: number;
  last_property_id?: number;
  last_property_type?: string;
  last_area?: string;
  last_budget?: number;
  last_guests?: number;
  typical_guests?: number;
  favorite_district?: string;
  favorite_property_type?: string;
  customer_tier: 'new' | 'returning' | 'regular' | 'vip';
  lifetime_value: number;
  days_since_last_visit?: number;
}

/* ═══════════════════════════════════════════
   Core ops
   ═══════════════════════════════════════════ */

/** Get cached profile; null nếu chưa có */
export function getCustomerProfile(senderId: string): CustomerProfile | null {
  try {
    const row = db.prepare(`SELECT * FROM customer_memory WHERE sender_id = ?`).get(senderId) as any;
    if (!row) return null;
    const daysSince = row.last_seen_at
      ? Math.floor((Date.now() - row.last_seen_at) / 86400000)
      : undefined;
    return {
      sender_id: row.sender_id,
      name: row.name,
      phone: row.phone,
      total_conversations: row.total_conversations || 0,
      total_bookings: row.total_bookings || 0,
      confirmed_bookings: row.confirmed_bookings || 0,
      last_property_id: row.last_property_id,
      last_property_type: row.last_property_type,
      last_area: row.last_area,
      last_budget: row.last_budget,
      last_guests: row.last_guests,
      typical_guests: row.typical_guests,
      favorite_district: row.favorite_district,
      favorite_property_type: row.favorite_property_type,
      customer_tier: row.customer_tier || 'new',
      lifetime_value: row.lifetime_value || 0,
      days_since_last_visit: daysSince,
    };
  } catch (e: any) {
    console.warn('[customer-memory] get fail:', e?.message);
    return null;
  }
}

/** Recompute profile từ past conversations + bookings. Run on demand hoặc cron daily. */
export function rebuildCustomerProfile(senderId: string): void {
  try {
    // Aggregate past conversations
    const convAgg = db.prepare(
      `SELECT COUNT(*) as n_conv, MIN(created_at) as first_at, MAX(updated_at) as last_at
       FROM bot_conversation_state WHERE sender_id = ?`
    ).get(senderId) as any;

    // Aggregate past bookings
    const bookAgg = db.prepare(
      `SELECT COUNT(*) as total, SUM(CASE WHEN status IN ('confirmed','paid') THEN 1 ELSE 0 END) as confirmed,
              MAX(created_at) as last_booking_at
       FROM bot_booking_drafts WHERE sender_id = ?`
    ).get(senderId) as any;

    // Most recent booking details
    const lastBooking = db.prepare(
      `SELECT * FROM bot_booking_drafts WHERE sender_id = ? ORDER BY created_at DESC LIMIT 1`
    ).get(senderId) as any;

    // Typical preferences (mode of guests, most frequent area/type)
    const prefs = db.prepare(
      `SELECT property_type, area, guests_adults FROM bot_booking_drafts WHERE sender_id = ?`
    ).all(senderId) as any[];

    // Compute mode
    function mode<T>(arr: T[]): T | undefined {
      if (!arr.length) return undefined;
      const freq = new Map<any, number>();
      for (const v of arr) if (v != null) freq.set(v, (freq.get(v) || 0) + 1);
      let best: T | undefined, bestN = 0;
      for (const [v, n] of freq) if (n > bestN) { best = v; bestN = n; }
      return best;
    }
    const favType = mode(prefs.map(p => p.property_type));
    const favArea = mode(prefs.map(p => p.area));
    const typicalGuests = mode(prefs.map(p => p.guests_adults));

    // LTV (lifetime value) — sum of confirmed booking totals (rough)
    const ltvRow = db.prepare(
      `SELECT SUM(COALESCE(budget_max, 500000)) as ltv FROM bot_booking_drafts
       WHERE sender_id = ? AND status IN ('confirmed','paid')`
    ).get(senderId) as any;
    const ltv = ltvRow?.ltv || 0;

    // Tier logic
    const confirmed = bookAgg?.confirmed || 0;
    const tier = confirmed >= 5 ? 'vip' : confirmed >= 2 ? 'regular' : confirmed >= 1 ? 'returning' : (convAgg?.n_conv > 1 ? 'returning' : 'new');

    // Guest profile name/phone (latest booking)
    const name = lastBooking?.name;
    const phone = lastBooking?.phone;
    const email = lastBooking?.email;

    const now = Date.now();
    db.prepare(
      `INSERT INTO customer_memory (
        sender_id, hotel_id, name, phone, email,
        total_conversations, total_bookings, confirmed_bookings,
        last_property_id, last_property_type, last_area, last_budget, last_guests, last_nights,
        typical_guests, favorite_district, favorite_property_type,
        customer_tier, lifetime_value, first_seen_at, last_seen_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(sender_id) DO UPDATE SET
        name = COALESCE(excluded.name, name),
        phone = COALESCE(excluded.phone, phone),
        email = COALESCE(excluded.email, email),
        total_conversations = excluded.total_conversations,
        total_bookings = excluded.total_bookings,
        confirmed_bookings = excluded.confirmed_bookings,
        last_property_id = COALESCE(excluded.last_property_id, last_property_id),
        last_property_type = COALESCE(excluded.last_property_type, last_property_type),
        last_area = COALESCE(excluded.last_area, last_area),
        last_budget = COALESCE(excluded.last_budget, last_budget),
        last_guests = COALESCE(excluded.last_guests, last_guests),
        last_nights = COALESCE(excluded.last_nights, last_nights),
        typical_guests = COALESCE(excluded.typical_guests, typical_guests),
        favorite_district = COALESCE(excluded.favorite_district, favorite_district),
        favorite_property_type = COALESCE(excluded.favorite_property_type, favorite_property_type),
        customer_tier = excluded.customer_tier,
        lifetime_value = excluded.lifetime_value,
        last_seen_at = excluded.last_seen_at,
        updated_at = excluded.updated_at`
    ).run(
      senderId,
      lastBooking?.hotel_id || null,
      name || null, phone || null, email || null,
      convAgg?.n_conv || 0, bookAgg?.total || 0, confirmed,
      lastBooking?.hotel_id || null,
      lastBooking?.property_type || null,
      lastBooking?.area || null,
      lastBooking?.budget_max || null,
      lastBooking?.guests_adults || null,
      lastBooking?.nights || null,
      typicalGuests || null,
      favArea || null,
      favType || null,
      tier, ltv,
      convAgg?.first_at || now,
      convAgg?.last_at || now,
      now,
    );
  } catch (e: any) {
    console.warn('[customer-memory] rebuild fail:', e?.message);
  }
}

/**
 * Compute personalized greeting cho returning customer.
 * Returns null nếu user 'new' hoặc chưa đủ data.
 */
export function buildReturningGreeting(profile: CustomerProfile | null): string | null {
  if (!profile || profile.customer_tier === 'new') return null;

  const name = profile.name ? profile.name : 'anh/chị';

  if (profile.customer_tier === 'vip') {
    return `🌟 *Chào anh/chị ${name}!* VIP customer (${profile.confirmed_bookings} đơn đã book). Em tiên ưu xử lý ạ!`;
  }
  if (profile.customer_tier === 'regular') {
    return `✨ Chào lại ${name}! Bạn đã book ${profile.confirmed_bookings} lần với bên em, rất vui được phục vụ tiếp ạ 🙌`;
  }
  if (profile.customer_tier === 'returning') {
    const daysStr = profile.days_since_last_visit !== undefined && profile.days_since_last_visit > 0
      ? ` — em nhớ bạn ghé bên em ${profile.days_since_last_visit} ngày trước`
      : '';
    return `👋 Chào mừng ${name} trở lại${daysStr}!`;
  }
  return null;
}

/**
 * Auto-fill slots từ past preferences (cho khách quen, tránh hỏi lại).
 * Chỉ fill nếu confident — dựa vào typical + most recent.
 */
export function prefillSlotsFromMemory(profile: CustomerProfile | null): Partial<{
  property_type: string;
  area: string;
  guests_adults: number;
  budget_max: number;
  name: string;
  phone: string;
}> {
  if (!profile || profile.customer_tier === 'new') return {};
  const out: any = {};
  // Prefill name + phone (luôn)
  if (profile.name) out.name = profile.name;
  if (profile.phone) out.phone = profile.phone;
  // Prefill preferences chỉ nếu user regular/vip (đủ data pattern)
  if (profile.customer_tier === 'regular' || profile.customer_tier === 'vip') {
    if (profile.favorite_property_type) out.property_type = profile.favorite_property_type;
    if (profile.favorite_district) out.area = profile.favorite_district;
    if (profile.typical_guests) out.guests_adults = profile.typical_guests;
  }
  return out;
}

/** Suggest question cho returning customer: "Vẫn cần Seehome Airport như lần trước không ạ?" */
export function buildReturningSuggestion(profile: CustomerProfile | null): string | null {
  if (!profile || !profile.last_property_id) return null;
  if (profile.customer_tier === 'new') return null;
  try {
    const prop = db.prepare(`SELECT name_canonical FROM hotel_profile WHERE hotel_id = ?`).get(profile.last_property_id) as any;
    if (!prop) return null;
    const who = profile.confirmed_bookings >= 2 ? 'Lần này vẫn' : 'Lần trước';
    return `${who} cần **${prop.name_canonical}** như cũ, hay anh/chị muốn chỗ khác ạ?`;
  } catch { return null; }
}

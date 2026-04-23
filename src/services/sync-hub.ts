/**
 * Sync Hub Service — v14.
 *
 * Event broker giữa 2 team:
 *   - OTA Web team (push availability, poll bookings)
 *   - VP MKT Bot (query availability, push bookings)
 *
 * HMAC-SHA256 signed requests.
 * All operations audit logged vào sync_events_log.
 */

import crypto from 'crypto';
import { db } from '../db';

/* ═══════════════════════════════════════════
   HMAC AUTH
   ═══════════════════════════════════════════ */

export interface ApiKey {
  id: number;
  key_id: string;
  secret: string;
  team_name: string;
  permissions: string[];
  active: number;
}

export function getApiKey(keyId: string): ApiKey | null {
  const row = db.prepare(
    `SELECT * FROM sync_api_keys WHERE key_id = ? AND active = 1`
  ).get(keyId) as any;
  if (!row) return null;
  try {
    row.permissions = JSON.parse(row.permissions);
  } catch { row.permissions = []; }
  return row;
}

/** Verify HMAC SHA256 signature. Signature format: `sha256=<hex>`. */
export function verifyHmac(rawBody: string, signature: string, secret: string): boolean {
  if (!signature || !signature.startsWith('sha256=')) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const received = signature.slice(7);
  if (expected.length !== received.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(received, 'hex'));
  } catch { return false; }
}

/** Check permission. Returns true if key has the perm. */
export function hasPermission(key: ApiKey, perm: string): boolean {
  return key.permissions.includes(perm) || key.permissions.includes('*');
}

/** Track API key usage. */
export function trackKeyUsage(keyId: string): void {
  try {
    db.prepare(
      `UPDATE sync_api_keys SET last_used_at = ?, request_count = request_count + 1 WHERE key_id = ?`
    ).run(Date.now(), keyId);
  } catch {}
}

/** Generate new API key + secret for a team. One-time setup. */
export function provisionApiKey(keyId: string, teamName: string, permissions: string[]): { key_id: string; secret: string } {
  const secret = crypto.randomBytes(32).toString('hex');  // 64 chars
  db.prepare(
    `INSERT OR REPLACE INTO sync_api_keys
     (key_id, secret, team_name, permissions, active, created_at)
     VALUES (?, ?, ?, ?, 1, ?)`
  ).run(keyId, secret, teamName, JSON.stringify(permissions), Date.now());
  return { key_id: keyId, secret };
}

/* ═══════════════════════════════════════════
   EVENT LOG
   ═══════════════════════════════════════════ */

export interface EventLogInput {
  event_type: string;
  direction?: 'inbound' | 'outbound';
  actor?: string;
  hotel_id?: number;
  payload?: any;
  hmac_verified?: boolean;
  http_status?: number;
  error?: string;
  duration_ms?: number;
}

export function logEvent(input: EventLogInput): void {
  try {
    db.prepare(
      `INSERT INTO sync_events_log
       (event_type, direction, actor, hotel_id, payload_json,
        hmac_verified, http_status, error, duration_ms, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      input.event_type,
      input.direction || null,
      input.actor || null,
      input.hotel_id || null,
      input.payload ? JSON.stringify(input.payload).slice(0, 10000) : null,
      input.hmac_verified ? 1 : 0,
      input.http_status || null,
      input.error ? String(input.error).slice(0, 500) : null,
      input.duration_ms || null,
      Date.now(),
    );
  } catch (e: any) {
    console.warn('[sync-hub] log event fail:', e?.message);
  }
}

/* ═══════════════════════════════════════════
   AVAILABILITY OPERATIONS
   ═══════════════════════════════════════════ */

export interface AvailabilityUpdate {
  hotel_id: number;
  room_type_code: string;
  date_str: string;
  total_rooms: number;
  available_rooms: number;
  base_price?: number;
  stop_sell?: boolean;
  source?: string;
}

export function upsertAvailability(input: AvailabilityUpdate): void {
  db.prepare(
    `INSERT INTO sync_availability
     (hotel_id, room_type_code, date_str, total_rooms, available_rooms, base_price, stop_sell, source, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(hotel_id, room_type_code, date_str) DO UPDATE SET
       total_rooms = excluded.total_rooms,
       available_rooms = excluded.available_rooms,
       base_price = COALESCE(excluded.base_price, sync_availability.base_price),
       stop_sell = excluded.stop_sell,
       source = excluded.source,
       updated_at = excluded.updated_at`
  ).run(
    input.hotel_id, input.room_type_code, input.date_str,
    input.total_rooms, input.available_rooms,
    input.base_price || null, input.stop_sell ? 1 : 0,
    input.source || 'ota', Date.now(),
  );
}

export function getAvailability(hotelId: number, dateStr: string, roomTypeCode?: string): any[] {
  const sql = roomTypeCode
    ? `SELECT * FROM sync_availability WHERE hotel_id = ? AND date_str = ? AND room_type_code = ?`
    : `SELECT * FROM sync_availability WHERE hotel_id = ? AND date_str = ? ORDER BY available_rooms DESC`;
  const params: any[] = roomTypeCode ? [hotelId, dateStr, roomTypeCode] : [hotelId, dateStr];
  return db.prepare(sql).all(...params) as any[];
}

/** Batch check: có phòng nào còn ở dateStr không (cho bất kỳ hotel nào)? */
export function getAnyAvailable(dateStr: string): Array<{ hotel_id: number; total_available: number; min_price: number }> {
  return db.prepare(
    `SELECT hotel_id,
            SUM(available_rooms) as total_available,
            MIN(CASE WHEN base_price > 0 THEN base_price END) as min_price
     FROM sync_availability
     WHERE date_str = ? AND stop_sell = 0
     GROUP BY hotel_id
     HAVING total_available > 0
     ORDER BY min_price ASC`
  ).all(dateStr) as any[];
}

/** Tìm ngày gần nhất còn phòng cho hotel này. */
export function findNextAvailableDate(hotelId: number, afterDate: string, maxSearchDays: number = 14): string | null {
  const row = db.prepare(
    `SELECT date_str FROM sync_availability
     WHERE hotel_id = ? AND date_str > ? AND available_rooms > 0 AND stop_sell = 0
     ORDER BY date_str ASC
     LIMIT 1`
  ).get(hotelId, afterDate) as any;
  return row?.date_str || null;
}

/** Decrement availability khi có booking confirmed. */
export function decrementAvailability(hotelId: number, roomTypeCode: string, dateStr: string, count: number = 1): boolean {
  const r = db.prepare(
    `UPDATE sync_availability
     SET available_rooms = MAX(0, available_rooms - ?), updated_at = ?
     WHERE hotel_id = ? AND room_type_code = ? AND date_str = ?
       AND available_rooms >= ?`
  ).run(count, Date.now(), hotelId, roomTypeCode, dateStr, count);
  return r.changes > 0;
}

/* ═══════════════════════════════════════════
   BOOKING OPERATIONS
   ═══════════════════════════════════════════ */

export interface BookingInput {
  hotel_id: number;
  source: 'bot' | 'ota' | 'walk_in';
  source_ref?: string;
  room_type_code: string;
  checkin_date: string;
  checkout_date: string;
  nights: number;
  guests?: number;
  total_price?: number;
  deposit_amount?: number;
  customer_name?: string;
  customer_phone?: string;
  sender_id?: string;
  created_by?: string;
  notes?: string;
}

/** Create a 'hold' booking (15min timeout). */
export function createHoldBooking(input: BookingInput): { id: number; expires_at: number } {
  const now = Date.now();
  const expiresAt = now + 15 * 60_000;
  const r = db.prepare(
    `INSERT INTO sync_bookings
     (hotel_id, source, source_ref, room_type_code, checkin_date, checkout_date,
      nights, guests, total_price, deposit_amount,
      customer_name, customer_phone, sender_id, created_by, notes,
      status, expires_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'hold', ?, ?, ?)`
  ).run(
    input.hotel_id, input.source, input.source_ref || null,
    input.room_type_code, input.checkin_date, input.checkout_date,
    input.nights, input.guests || 2,
    input.total_price || null, input.deposit_amount || null,
    input.customer_name || null, input.customer_phone || null,
    input.sender_id || null, input.created_by || input.source,
    input.notes || null,
    expiresAt, now, now,
  );
  return { id: r.lastInsertRowid as number, expires_at: expiresAt };
}

/** Confirm a booking → decrement availability automatically. */
export function confirmBooking(bookingId: number, opts: { deposit_proof_url?: string } = {}): boolean {
  const booking = db.prepare(`SELECT * FROM sync_bookings WHERE id = ?`).get(bookingId) as any;
  if (!booking) return false;
  if (booking.status !== 'hold') return false;

  const now = Date.now();
  db.prepare(
    `UPDATE sync_bookings SET status = 'confirmed',
      deposit_paid = 1, deposit_proof_url = ?, updated_at = ?
     WHERE id = ?`
  ).run(opts.deposit_proof_url || null, now, bookingId);

  // Decrement availability for each night
  const nights = booking.nights || 1;
  const checkin = new Date(booking.checkin_date);
  for (let i = 0; i < nights; i++) {
    const d = new Date(checkin.getTime() + i * 24 * 3600_000);
    const dateStr = d.toISOString().slice(0, 10);
    decrementAvailability(booking.hotel_id, booking.room_type_code, dateStr, 1);
  }

  // v18: Mark outreach conversion + v16 broadcast conversion
  try {
    const { markOutreachConverted } = require('./proactive-outreach');
    if (booking.sender_id) markOutreachConverted(booking.sender_id, bookingId);
    const { recordConversion } = require('./broadcast-sender');
    recordConversion({ sender_id: booking.sender_id, customer_phone: booking.customer_phone, booking_id: bookingId });
  } catch {}

  return true;
}

/** List bookings chưa được OTA/PMS sync (cho OTA team poll). */
export function getPendingPmsSync(since: number, limit: number = 50): any[] {
  return db.prepare(
    `SELECT * FROM sync_bookings
     WHERE status IN ('confirmed', 'cancelled')
       AND (synced_to_pms_at IS NULL OR synced_to_pms_at < updated_at)
       AND updated_at > ?
     ORDER BY updated_at ASC
     LIMIT ?`
  ).all(since, limit) as any[];
}

/** OTA team confirm đã note vào PMS. */
export function markSynced(bookingId: number, pmsBookingId: string): boolean {
  const r = db.prepare(
    `UPDATE sync_bookings SET synced_to_pms_at = ?, pms_booking_id = ?, status = CASE WHEN status = 'confirmed' THEN 'synced' ELSE status END, updated_at = ? WHERE id = ?`
  ).run(Date.now(), pmsBookingId, Date.now(), bookingId);
  return r.changes > 0;
}

/** Cleanup expired holds — chạy cron mỗi phút. */
export function cleanupExpiredHolds(): number {
  const r = db.prepare(
    `UPDATE sync_bookings SET status = 'cancelled', updated_at = ?, notes = COALESCE(notes || ' | ', '') || 'auto-cancelled: hold expired'
     WHERE status = 'hold' AND expires_at < ?`
  ).run(Date.now(), Date.now());
  return r.changes;
}

/* ═══════════════════════════════════════════
   STATS
   ═══════════════════════════════════════════ */

export function getSyncStats(): any {
  const avail = db.prepare(`SELECT COUNT(*) as n, MAX(updated_at) as latest FROM sync_availability`).get() as any;
  const bookings = db.prepare(`SELECT status, COUNT(*) as n FROM sync_bookings GROUP BY status`).all() as any[];
  const events24h = db.prepare(`SELECT event_type, COUNT(*) as n FROM sync_events_log WHERE created_at > ? GROUP BY event_type`).all(Date.now() - 24 * 3600_000) as any[];
  const keys = db.prepare(`SELECT key_id, team_name, last_used_at, request_count FROM sync_api_keys WHERE active = 1`).all() as any[];

  return {
    availability: {
      rows: avail.n,
      latest_update: avail.latest ? new Date(avail.latest).toISOString() : null,
      staleness_minutes: avail.latest ? Math.round((Date.now() - avail.latest) / 60_000) : null,
    },
    bookings: Object.fromEntries(bookings.map((b: any) => [b.status, b.n])),
    events_24h: Object.fromEntries(events24h.map((e: any) => [e.event_type, e.n])),
    api_keys: keys,
  };
}

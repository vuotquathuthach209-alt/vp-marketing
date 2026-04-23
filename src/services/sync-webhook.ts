/**
 * Sync Webhook Receiver — handle inbound events từ OTA.
 *
 * Endpoints (mount trong routes/sync-hub.ts):
 *   POST /api/sync/webhook/booking     — OTA push booking_created / booking_cancelled
 *   POST /api/sync/webhook/availability — OTA push room stop_sell / price change
 *   POST /api/sync/webhook/payment      — OTA push payment_confirmed
 *
 * Authentication: HMAC-SHA256 via X-Signature header (shared secret với OTA team).
 * Dedup: X-Event-Id header — nếu đã process rồi → skip, trả 200 OK.
 *
 * Flow:
 *   1. Verify HMAC → reject 401 nếu sai.
 *   2. Check event_id trong sync_webhook_inbound → skip nếu đã processed.
 *   3. INSERT raw payload vào sync_webhook_inbound (audit).
 *   4. Dispatch tới handler theo event_type.
 *   5. Handler transform payload → canonical schema → UPSERT.
 *   6. Update availability cache nếu cần.
 *   7. Mark processed=1.
 *
 * Idempotency: cả event_id dedup lẫn handler-level (UPSERT with ON CONFLICT).
 */

import { db } from '../db';
import { verifyHmac, logEvent } from './sync-hub';
import { resolveConflict } from './sync-conflict-resolver';

export type WebhookEventType =
  | 'booking_created'
  | 'booking_cancelled'
  | 'booking_updated'
  | 'payment_confirmed'
  | 'availability_changed'
  | 'stop_sell';

export interface WebhookPayload {
  event_id: string;         // UUID hoặc unique id — cho dedup
  event_type: WebhookEventType;
  source: string;           // 'ota' | 'booking.com' | 'agoda' | 'walk_in'
  hotel_id: number;         // OTA hotel_id
  timestamp: number;
  data: any;                // event-specific body
}

export interface WebhookResult {
  ok: boolean;
  deduped?: boolean;
  inbound_id?: number;
  applied?: any;
  error?: string;
}

/**
 * Main entry — called by routes/sync-hub.ts.
 */
export async function receiveWebhook(
  rawBody: string,
  signature: string,
  secret: string,
): Promise<WebhookResult> {
  // 1. HMAC verify
  if (!verifyHmac(rawBody, signature, secret)) {
    logEvent({ event_type: 'webhook_hmac_fail', direction: 'inbound', hmac_verified: false, error: 'invalid signature' });
    return { ok: false, error: 'invalid_signature' };
  }

  let payload: WebhookPayload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return { ok: false, error: 'invalid_json' };
  }

  if (!payload.event_id || !payload.event_type) {
    return { ok: false, error: 'missing event_id or event_type' };
  }

  // 2. Dedup
  const existing = db.prepare(
    `SELECT id, processed FROM sync_webhook_inbound WHERE event_id = ?`
  ).get(payload.event_id) as any;
  if (existing) {
    if (existing.processed) {
      return { ok: true, deduped: true, inbound_id: existing.id };
    }
    // Exists but not processed → retry processing
  }

  // 3. Persist raw payload
  const inboundId = existing?.id || Number((db.prepare(
    `INSERT INTO sync_webhook_inbound
     (event_id, event_type, source, hotel_id, payload_json, hmac_verified, received_at)
     VALUES (?, ?, ?, ?, ?, 1, ?)`
  ).run(
    payload.event_id,
    payload.event_type,
    payload.source || 'ota',
    payload.hotel_id || null,
    rawBody.slice(0, 50_000),
    Date.now(),
  ).lastInsertRowid));

  // 4. Dispatch
  try {
    const applied = await dispatch(payload);
    db.prepare(
      `UPDATE sync_webhook_inbound SET processed = 1, processed_at = ? WHERE id = ?`
    ).run(Date.now(), inboundId);

    logEvent({
      event_type: `webhook_${payload.event_type}`,
      direction: 'inbound',
      actor: payload.source,
      hotel_id: payload.hotel_id,
      payload: { event_id: payload.event_id, applied: !!applied },
      hmac_verified: true,
      http_status: 200,
    });

    return { ok: true, inbound_id: inboundId, applied };
  } catch (e: any) {
    db.prepare(
      `UPDATE sync_webhook_inbound SET error = ? WHERE id = ?`
    ).run(String(e?.message || 'unknown').slice(0, 500), inboundId);
    console.error(`[webhook] dispatch fail event=${payload.event_type}:`, e?.message);
    return { ok: false, inbound_id: inboundId, error: e?.message };
  }
}

/* ═══════════════════════════════════════════
   DISPATCH → HANDLERS
   ═══════════════════════════════════════════ */

async function dispatch(p: WebhookPayload): Promise<any> {
  switch (p.event_type) {
    case 'booking_created': return handleBookingCreated(p);
    case 'booking_cancelled': return handleBookingCancelled(p);
    case 'booking_updated': return handleBookingUpdated(p);
    case 'payment_confirmed': return handlePaymentConfirmed(p);
    case 'availability_changed': return handleAvailabilityChanged(p);
    case 'stop_sell': return handleStopSell(p);
    default:
      throw new Error(`unsupported event_type: ${p.event_type}`);
  }
}

/* ═══════════════════════════════════════════
   HANDLER: booking_created
   OTA có booking mới (từ channel khác: website/Booking.com/Agoda/walk-in)
   → sync vào sync_bookings + decrement sync_availability
   ═══════════════════════════════════════════ */

function handleBookingCreated(p: WebhookPayload): any {
  const d = p.data || {};
  const existing = d.ota_booking_id
    ? db.prepare(`SELECT id FROM sync_bookings WHERE pms_booking_id = ?`).get(String(d.ota_booking_id)) as any
    : null;

  if (existing) {
    // Already have this booking — nothing to do
    return { result: 'already_exists', booking_id: existing.id };
  }

  const now = Date.now();
  const r = db.prepare(
    `INSERT INTO sync_bookings
     (hotel_id, source, source_ref, room_type_code, checkin_date, checkout_date, nights, guests,
      total_price, customer_name, customer_phone, status, pms_booking_id,
      synced_to_pms_at, created_at, updated_at, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'confirmed', ?, ?, ?, ?, ?)`
  ).run(
    p.hotel_id,
    p.source || 'ota',
    d.channel || null,
    d.room_type_code || 'standard',
    d.checkin_date,
    d.checkout_date,
    d.nights || 1,
    d.guests || 2,
    d.total_price || null,
    d.guest_name || null,
    d.guest_phone || null,
    String(d.ota_booking_id || ''),
    now,           // synced_to_pms_at = now (OTA is source of truth)
    now, now,
    `webhook event=${p.event_id}`,
  );

  // Decrement availability for each night
  try {
    const { decrementAvailability } = require('./sync-hub');
    const checkin = new Date(d.checkin_date);
    for (let i = 0; i < (d.nights || 1); i++) {
      const dt = new Date(checkin.getTime() + i * 24 * 3600_000);
      decrementAvailability(p.hotel_id, d.room_type_code || 'standard', dt.toISOString().slice(0, 10), 1);
    }
  } catch {}

  return { result: 'created', booking_id: r.lastInsertRowid };
}

/* ═══════════════════════════════════════════
   HANDLER: booking_cancelled
   ═══════════════════════════════════════════ */

function handleBookingCancelled(p: WebhookPayload): any {
  const d = p.data || {};
  const existing = d.ota_booking_id
    ? db.prepare(`SELECT * FROM sync_bookings WHERE pms_booking_id = ?`).get(String(d.ota_booking_id)) as any
    : null;

  if (!existing) return { result: 'not_found' };

  // Cancel rule: first-cancel-wins
  db.prepare(
    `UPDATE sync_bookings SET status = 'cancelled', updated_at = ?, notes = COALESCE(notes, '') || ? WHERE id = ?`
  ).run(Date.now(), ` | cancelled via webhook ${p.event_id}`, existing.id);

  // Restore availability
  try {
    const nights = existing.nights || 1;
    const checkin = new Date(existing.checkin_date);
    for (let i = 0; i < nights; i++) {
      const dt = new Date(checkin.getTime() + i * 24 * 3600_000);
      const dateStr = dt.toISOString().slice(0, 10);
      db.prepare(
        `UPDATE sync_availability SET available_rooms = available_rooms + 1, updated_at = ?
         WHERE hotel_id = ? AND room_type_code = ? AND date_str = ?`
      ).run(Date.now(), existing.hotel_id, existing.room_type_code, dateStr);
    }
  } catch {}

  return { result: 'cancelled', booking_id: existing.id };
}

function handleBookingUpdated(p: WebhookPayload): any {
  const d = p.data || {};
  const existing = d.ota_booking_id
    ? db.prepare(`SELECT * FROM sync_bookings WHERE pms_booking_id = ?`).get(String(d.ota_booking_id)) as any
    : null;
  if (!existing) return { result: 'not_found' };

  // Apply conflict resolver for each field change
  const fields: Array<keyof typeof d> = ['checkin_date', 'checkout_date', 'total_price', 'guest_name', 'guest_phone'];
  const updates: any = {};
  for (const f of fields) {
    if (d[f] !== undefined && d[f] !== existing[f]) {
      const resolved = resolveConflict('booking', String(existing.id), String(f), existing[f], d[f]);
      if (resolved.winner === 'ota') updates[f] = d[f];
    }
  }

  if (Object.keys(updates).length === 0) return { result: 'no_changes' };

  const sets = Object.keys(updates).map(k => `${k} = ?`).join(', ');
  const vals = [...Object.values(updates), Date.now(), existing.id];
  db.prepare(`UPDATE sync_bookings SET ${sets}, updated_at = ? WHERE id = ?`).run(...vals);

  return { result: 'updated', booking_id: existing.id, fields: Object.keys(updates) };
}

function handlePaymentConfirmed(p: WebhookPayload): any {
  const d = p.data || {};
  if (!d.ota_booking_id) return { result: 'missing_ota_booking_id' };

  const r = db.prepare(
    `UPDATE sync_bookings
     SET deposit_paid = 1,
         status = CASE WHEN status = 'hold' THEN 'confirmed' ELSE status END,
         updated_at = ?
     WHERE pms_booking_id = ?`
  ).run(Date.now(), String(d.ota_booking_id));

  return { result: r.changes > 0 ? 'confirmed' : 'not_found' };
}

function handleAvailabilityChanged(p: WebhookPayload): any {
  const d = p.data || {};
  if (!d.date_str || !d.room_type_code || d.available_rooms === undefined) {
    return { result: 'invalid_payload' };
  }
  try {
    const { upsertAvailability } = require('./sync-hub');
    upsertAvailability({
      hotel_id: p.hotel_id,
      room_type_code: d.room_type_code,
      date_str: d.date_str,
      total_rooms: d.total_rooms || 0,
      available_rooms: d.available_rooms,
      base_price: d.base_price,
      stop_sell: !!d.stop_sell,
      source: p.source || 'ota',
    });
  } catch (e: any) {
    throw new Error(`upsert availability fail: ${e?.message}`);
  }
  return { result: 'updated' };
}

function handleStopSell(p: WebhookPayload): any {
  const d = p.data || {};
  if (!d.room_type_code || !d.from_date || !d.to_date) {
    return { result: 'invalid_payload' };
  }
  const from = new Date(d.from_date);
  const to = new Date(d.to_date);
  let count = 0;
  for (let t = from.getTime(); t <= to.getTime(); t += 86400_000) {
    const dateStr = new Date(t).toISOString().slice(0, 10);
    db.prepare(
      `UPDATE sync_availability SET stop_sell = 1, updated_at = ?
       WHERE hotel_id = ? AND room_type_code = ? AND date_str = ?`
    ).run(Date.now(), p.hotel_id, d.room_type_code, dateStr);
    count++;
  }
  return { result: 'stop_sell', dates_affected: count };
}

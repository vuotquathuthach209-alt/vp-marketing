/**
 * Revenue Attribution Tracker.
 *
 * Khi booking confirmed:
 *   1. Record revenue_events row
 *   2. Scan last 7d touches cho sender_id:
 *        - bot_reply_outcomes.reply_source
 *        - reply_assignments.variant_id
 *        - audience_memberships.audience_id
 *        - broadcast_sends.campaign_id
 *        - scheduled_outreach.id
 *        - promotion_usage.promotion_id
 *   3. Insert attribution_links với linear attribution (weight = 1/N)
 *   4. Update customer_ltv cache
 */

import { db } from '../db';

export interface TouchPoint {
  touch_type: 'reply_source' | 'variant' | 'audience' | 'campaign' | 'outreach' | 'promo';
  touch_id: string;
  touch_value: string;
  touched_at: number;
}

const ATTRIBUTION_WINDOW_DAYS = 7;

/** Scan all touches cho sender trong attribution window. */
function scanTouches(senderId: string, phone: string | null, bookingId: number, checkinAt: number): TouchPoint[] {
  const since = checkinAt - ATTRIBUTION_WINDOW_DAYS * 24 * 3600_000;
  const touches: TouchPoint[] = [];

  // 1. Reply sources from outcomes
  try {
    const outcomes = db.prepare(
      `SELECT reply_source, created_at FROM bot_reply_outcomes
       WHERE sender_id = ? AND created_at > ? AND created_at <= ?
       ORDER BY created_at`
    ).all(senderId, since, checkinAt) as any[];
    const seen = new Set<string>();
    for (const o of outcomes) {
      if (!o.reply_source || seen.has(o.reply_source)) continue;
      seen.add(o.reply_source);
      touches.push({
        touch_type: 'reply_source',
        touch_id: o.reply_source,
        touch_value: o.reply_source,
        touched_at: o.created_at,
      });
    }
  } catch {}

  // 2. A/B variants
  try {
    const variants = db.prepare(
      `SELECT ra.variant_id, rt.variant_name, rt.template_key, ra.assigned_at
       FROM reply_assignments ra
       JOIN reply_templates rt ON rt.id = ra.variant_id
       WHERE ra.sender_id = ? AND ra.assigned_at > ? AND ra.assigned_at <= ?`
    ).all(senderId, since, checkinAt) as any[];
    for (const v of variants) {
      touches.push({
        touch_type: 'variant',
        touch_id: String(v.variant_id),
        touch_value: `${v.template_key}/${v.variant_name}`,
        touched_at: v.assigned_at,
      });
    }
  } catch {}

  // 3. Audience memberships (if customer belongs when booking happened)
  try {
    const audiences = db.prepare(
      `SELECT audience_id, added_at FROM audience_memberships
       WHERE (sender_id = ? OR customer_phone = ?)
       ORDER BY added_at DESC LIMIT 5`
    ).all(senderId, phone || '') as any[];
    for (const a of audiences) {
      const info = db.prepare(`SELECT audience_name FROM marketing_audiences WHERE id = ?`).get(a.audience_id) as any;
      if (!info) continue;
      touches.push({
        touch_type: 'audience',
        touch_id: String(a.audience_id),
        touch_value: info.audience_name,
        touched_at: a.added_at,
      });
    }
  } catch {}

  // 4. Broadcast campaigns received
  try {
    const sends = db.prepare(
      `SELECT bs.campaign_id, bs.sent_at, bc.name as campaign_name
       FROM broadcast_sends bs
       JOIN broadcast_campaigns bc ON bc.id = bs.campaign_id
       WHERE (bs.sender_id = ? OR bs.customer_phone = ?)
         AND bs.sent_at > ? AND bs.sent_at <= ?
         AND bs.status IN ('sent', 'delivered', 'opened', 'clicked', 'converted')`
    ).all(senderId, phone || '', since, checkinAt) as any[];
    for (const s of sends) {
      touches.push({
        touch_type: 'campaign',
        touch_id: String(s.campaign_id),
        touch_value: s.campaign_name,
        touched_at: s.sent_at,
      });
    }
  } catch {}

  // 5. Proactive outreach received
  try {
    const outreach = db.prepare(
      `SELECT id, trigger_type, sent_at FROM scheduled_outreach
       WHERE sender_id = ? AND sent_at > ? AND sent_at <= ?
         AND status IN ('sent', 'replied', 'converted')`
    ).all(senderId, since, checkinAt) as any[];
    for (const o of outreach) {
      touches.push({
        touch_type: 'outreach',
        touch_id: String(o.id),
        touch_value: o.trigger_type,
        touched_at: o.sent_at || Date.now(),
      });
    }
  } catch {}

  // 6. Promo codes applied
  try {
    const promos = db.prepare(
      `SELECT promotion_id, promotion_code, discount_applied_vnd, created_at
       FROM promotion_usage
       WHERE (sender_id = ? OR customer_phone = ?) AND booking_id = ?`
    ).all(senderId, phone || '', bookingId) as any[];
    for (const p of promos) {
      touches.push({
        touch_type: 'promo',
        touch_id: p.promotion_code,
        touch_value: p.promotion_code,
        touched_at: p.created_at,
      });
    }
  } catch {}

  return touches;
}

/** Record attribution for a confirmed booking (multi-touch linear). */
export function recordBookingAttribution(bookingId: number): {
  revenue_recorded: boolean;
  touches: number;
  amount_vnd: number;
} {
  const booking = db.prepare(`SELECT * FROM sync_bookings WHERE id = ?`).get(bookingId) as any;
  if (!booking) return { revenue_recorded: false, touches: 0, amount_vnd: 0 };
  if (booking.status !== 'confirmed' && booking.status !== 'synced' && booking.status !== 'checked_out') {
    return { revenue_recorded: false, touches: 0, amount_vnd: 0 };
  }

  const now = Date.now();
  const amount = booking.total_price || booking.deposit_amount || 0;

  // Check duplicate
  const existingRev = db.prepare(
    `SELECT id FROM revenue_events WHERE booking_id = ? AND event_type = 'booking_confirmed' LIMIT 1`
  ).get(bookingId) as any;

  if (!existingRev) {
    // Record revenue event
    db.prepare(
      `INSERT INTO revenue_events
       (hotel_id, event_type, booking_id, sender_id, customer_phone,
        amount_vnd, margin_vnd, occurred_at, created_at)
       VALUES (?, 'booking_confirmed', ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      booking.hotel_id,
      bookingId,
      booking.sender_id || null,
      booking.customer_phone || null,
      amount,
      Math.round(amount * 0.3),   // Simple: 30% margin estimate
      booking.updated_at || now,
      now,
    );
  }

  // Scan touches
  const touches = scanTouches(
    booking.sender_id || '',
    booking.customer_phone,
    bookingId,
    booking.updated_at || now,
  );

  // Linear attribution: weight = 1/N
  const weight = touches.length > 0 ? +(1 / touches.length).toFixed(4) : 1;

  for (const t of touches) {
    // Dedup: same (booking, touch_type, touch_id) not re-insert
    const dup = db.prepare(
      `SELECT id FROM attribution_links WHERE booking_id = ? AND touch_type = ? AND touch_id = ?`
    ).get(bookingId, t.touch_type, t.touch_id) as any;
    if (dup) continue;
    db.prepare(
      `INSERT INTO attribution_links
       (booking_id, sender_id, touch_type, touch_id, touch_value,
        weight, attribution_model, touched_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'linear', ?, ?)`
    ).run(
      bookingId, booking.sender_id || null,
      t.touch_type, t.touch_id, t.touch_value,
      weight, t.touched_at, now,
    );
  }

  // Update customer LTV
  if (booking.sender_id) {
    updateCustomerLTV(booking.sender_id, booking.customer_phone, booking.hotel_id);
  }

  return {
    revenue_recorded: !existingRev,
    touches: touches.length,
    amount_vnd: amount,
  };
}

/** Recompute + cache LTV for a customer. */
export function updateCustomerLTV(senderId: string, phone: string | null, hotelId: number): void {
  const row = db.prepare(
    `SELECT COUNT(*) as bookings,
            SUM(amount_vnd) as total,
            MIN(occurred_at) as first_at,
            MAX(occurred_at) as last_at
     FROM revenue_events
     WHERE (sender_id = ? OR customer_phone = ?) AND event_type = 'booking_confirmed'`
  ).get(senderId, phone || '') as any;

  const total = row?.total || 0;
  const bookings = row?.bookings || 0;
  const aov = bookings > 0 ? Math.round(total / bookings) : 0;

  // Simple predicted LTV: historical × (1 + retention_multiplier based on tier)
  const memory = db.prepare(`SELECT customer_tier, name FROM customer_memory WHERE sender_id = ?`).get(senderId) as any;
  const tier = memory?.customer_tier || (bookings >= 6 ? 'vip' : bookings >= 3 ? 'regular' : bookings >= 1 ? 'returning' : 'new');
  const retentionMult: Record<string, number> = {
    new: 0.5,     // 50% chance of repeat
    returning: 1.2,
    regular: 2.0,
    vip: 3.5,
  };
  const predicted = Math.round(total * (retentionMult[tier] || 0.5));

  db.prepare(
    `INSERT INTO customer_ltv
     (sender_id, customer_phone, customer_name, hotel_id,
      total_bookings, confirmed_bookings, total_revenue_vnd, avg_order_value_vnd,
      first_booking_at, last_booking_at, predicted_ltv_vnd, customer_tier, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(sender_id) DO UPDATE SET
       customer_phone = COALESCE(excluded.customer_phone, customer_phone),
       customer_name = COALESCE(excluded.customer_name, customer_name),
       total_bookings = excluded.total_bookings,
       confirmed_bookings = excluded.confirmed_bookings,
       total_revenue_vnd = excluded.total_revenue_vnd,
       avg_order_value_vnd = excluded.avg_order_value_vnd,
       first_booking_at = COALESCE(customer_ltv.first_booking_at, excluded.first_booking_at),
       last_booking_at = excluded.last_booking_at,
       predicted_ltv_vnd = excluded.predicted_ltv_vnd,
       customer_tier = excluded.customer_tier,
       updated_at = excluded.updated_at`
  ).run(
    senderId, phone || null, memory?.name || null, hotelId,
    bookings, bookings, total, aov,
    row?.first_at || null, row?.last_at || null,
    predicted, tier, Date.now(),
  );
}

/* ═══════════════════════════════════════════
   REPORTING QUERIES
   ═══════════════════════════════════════════ */

export interface AttributionReport {
  touch_type: string;
  touch_value: string;
  touch_id: string;
  bookings_attributed: number;
  total_revenue_vnd: number;
  attributed_revenue_vnd: number;   // Sum of (revenue × weight)
  avg_weight: number;
}

/** Top revenue by touch_type (e.g. 'reply_source', 'audience'). */
export function attributionByType(touchType: string, opts: { days?: number; hotelId?: number } = {}): AttributionReport[] {
  const days = opts.days || 30;
  const since = Date.now() - days * 24 * 3600_000;
  const hotelFilter = opts.hotelId ? 'AND re.hotel_id = ?' : '';
  const params: any[] = [touchType, since];
  if (opts.hotelId) params.push(opts.hotelId);

  const rows = db.prepare(
    `SELECT al.touch_type, al.touch_id, al.touch_value,
            COUNT(DISTINCT al.booking_id) as bookings_attributed,
            SUM(re.amount_vnd) as total_revenue_vnd,
            SUM(re.amount_vnd * al.weight) as attributed_revenue_vnd,
            AVG(al.weight) as avg_weight
     FROM attribution_links al
     JOIN revenue_events re ON re.booking_id = al.booking_id
     WHERE al.touch_type = ? AND re.occurred_at > ? ${hotelFilter}
     GROUP BY al.touch_type, al.touch_id
     ORDER BY attributed_revenue_vnd DESC
     LIMIT 20`
  ).all(...params) as any[];

  return rows.map(r => ({
    touch_type: r.touch_type,
    touch_value: r.touch_value,
    touch_id: r.touch_id,
    bookings_attributed: r.bookings_attributed,
    total_revenue_vnd: r.total_revenue_vnd || 0,
    attributed_revenue_vnd: Math.round(r.attributed_revenue_vnd || 0),
    avg_weight: +((r.avg_weight || 0) as number).toFixed(3),
  }));
}

/** Top customers by LTV. */
export function topCustomersByLTV(limit: number = 20): any[] {
  return db.prepare(
    `SELECT sender_id, customer_name, customer_phone, customer_tier,
            confirmed_bookings, total_revenue_vnd, avg_order_value_vnd, predicted_ltv_vnd
     FROM customer_ltv
     ORDER BY total_revenue_vnd DESC
     LIMIT ?`
  ).all(limit) as any[];
}

/** Totals for dashboard. */
export function getRevenueTotals(days: number = 30, hotelId?: number): any {
  const since = Date.now() - days * 24 * 3600_000;
  const hotelFilter = hotelId ? 'AND hotel_id = ?' : '';
  const params: any[] = [since];
  if (hotelId) params.push(hotelId);

  const revenue = db.prepare(
    `SELECT COUNT(*) as bookings,
            COALESCE(SUM(amount_vnd), 0) as total_revenue_vnd,
            COALESCE(AVG(amount_vnd), 0) as avg_order_value,
            COALESCE(SUM(margin_vnd), 0) as total_margin_vnd
     FROM revenue_events
     WHERE event_type = 'booking_confirmed' AND occurred_at > ? ${hotelFilter}`
  ).get(...params) as any;

  const byDay = db.prepare(
    `SELECT DATE(occurred_at/1000, 'unixepoch', '+7 hours') as date,
            COUNT(*) as bookings,
            COALESCE(SUM(amount_vnd), 0) as revenue_vnd
     FROM revenue_events
     WHERE event_type = 'booking_confirmed' AND occurred_at > ? ${hotelFilter}
     GROUP BY date
     ORDER BY date DESC LIMIT 30`
  ).all(...params) as any[];

  return {
    period_days: days,
    bookings: revenue.bookings || 0,
    total_revenue_vnd: revenue.total_revenue_vnd || 0,
    avg_order_value_vnd: Math.round(revenue.avg_order_value || 0),
    total_margin_vnd: revenue.total_margin_vnd || 0,
    daily: byDay,
  };
}

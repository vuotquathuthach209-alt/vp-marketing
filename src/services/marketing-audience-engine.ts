/**
 * Marketing Audience Engine.
 *
 * 2 refresh modes:
 *   1. sql_rule — run SELECT trả về sender_id + phone + metadata → INSERT memberships
 *   2. custom_fn — predefined filter function (hardcoded for built-in audiences)
 *
 * Cron daily → refresh all active audiences.
 * Real-time audiences (abandoned_cart) have refresh_interval_min = 60.
 */

import { db } from '../db';

export interface RefreshResult {
  audience_id: number;
  audience_name: string;
  members_before: number;
  members_after: number;
  added: number;
  removed: number;
  duration_ms: number;
  error?: string;
}

/** Built-in audience filters — hardcoded SQL for performance. */
export const BUILTIN_AUDIENCES: Record<string, { sql: string; description: string; params: (hotelId: number) => any[] }> = {
  /** Khách gần đây nhắn (last 30d) nhưng CHƯA book */
  new_leads_no_booking: {
    description: 'Khách đã inbox 7-30 ngày, chưa đặt phòng',
    sql: `
      SELECT DISTINCT cm.sender_id,
             cc.phone as customer_phone,
             cc.sender_name as customer_name,
             ? as hotel_id,
             json_object('last_seen_at', MAX(cm.created_at), 'message_count', COUNT(*)) as metadata
      FROM conversation_memory cm
      LEFT JOIN customer_contacts cc ON cc.sender_id = cm.sender_id
      LEFT JOIN sync_bookings sb ON sb.sender_id = cm.sender_id AND sb.status IN ('confirmed','synced','checked_in','checked_out')
      WHERE cm.role = 'user'
        AND cm.created_at >= ?
        AND cm.created_at <= ?
        AND sb.id IS NULL
      GROUP BY cm.sender_id
      HAVING COUNT(*) >= 2
    `,
    params: (hotelId: number) => [hotelId, Date.now() - 30 * 24 * 3600_000, Date.now() - 2 * 24 * 3600_000],
  },

  /** Khách đã book hold nhưng expire — abandoned cart */
  abandoned_cart_2h: {
    description: 'Khách đã tạo booking hold nhưng để hết hạn (không cọc)',
    sql: `
      SELECT sb.sender_id,
             sb.customer_phone,
             sb.customer_name,
             sb.hotel_id,
             json_object('booking_id', sb.id, 'checkin_date', sb.checkin_date, 'total_price', sb.total_price,
                         'expires_at', sb.expires_at) as metadata
      FROM sync_bookings sb
      WHERE sb.status = 'cancelled'
        AND sb.notes LIKE '%auto-cancelled: hold expired%'
        AND sb.expires_at >= ?
        AND sb.expires_at <= ?
        AND sb.sender_id IS NOT NULL
    `,
    params: (_hotelId: number) => [Date.now() - 24 * 3600_000, Date.now() - 60 * 60_000],
  },

  /** VIP inactive 30d */
  vip_inactive_30d: {
    description: 'Khách VIP (6+ booking) không đặt 30+ ngày qua',
    sql: `
      SELECT cm.sender_id,
             cm.phone as customer_phone,
             cm.name as customer_name,
             ? as hotel_id,
             json_object('tier', cm.customer_tier, 'ltv_vnd', cm.lifetime_value,
                         'bookings', cm.confirmed_bookings, 'last_seen_at', cm.last_seen_at) as metadata
      FROM customer_memory cm
      WHERE cm.customer_tier = 'vip'
        AND cm.last_seen_at < ?
    `,
    params: (hotelId: number) => [hotelId, Date.now() - 30 * 24 * 3600_000],
  },

  /** Regular returners — khách có 3-5 booking + last 15-60d */
  regular_returners: {
    description: 'Khách quen (3-5 booking), chuẩn bị có dịp đặt tiếp',
    sql: `
      SELECT cm.sender_id,
             cm.phone as customer_phone,
             cm.name as customer_name,
             ? as hotel_id,
             json_object('tier', cm.customer_tier, 'bookings', cm.confirmed_bookings,
                         'last_seen_at', cm.last_seen_at) as metadata
      FROM customer_memory cm
      WHERE cm.customer_tier IN ('regular', 'returning')
        AND cm.last_seen_at BETWEEN ? AND ?
    `,
    params: (hotelId: number) => [hotelId, Date.now() - 60 * 24 * 3600_000, Date.now() - 15 * 24 * 3600_000],
  },

  /** Churned — 90+ days inactive */
  churned_customers: {
    description: 'Khách đã dừng (90+ ngày), cần winback',
    sql: `
      SELECT cm.sender_id,
             cm.phone as customer_phone,
             cm.name as customer_name,
             ? as hotel_id,
             json_object('tier', cm.customer_tier, 'bookings', cm.confirmed_bookings,
                         'last_seen_at', cm.last_seen_at,
                         'days_inactive', (? - cm.last_seen_at)/86400000) as metadata
      FROM customer_memory cm
      WHERE cm.customer_tier IN ('regular', 'returning', 'vip')
        AND cm.last_seen_at < ?
    `,
    params: (hotelId: number) => [hotelId, Date.now(), Date.now() - 90 * 24 * 3600_000],
  },

  /** High-intent khách đã để SĐT nhưng chưa book */
  high_intent_no_book: {
    description: 'Khách đã để SĐT (contact_captured) nhưng chưa confirm booking',
    sql: `
      SELECT cc.sender_id,
             cc.phone as customer_phone,
             cc.sender_name as customer_name,
             cc.hotel_id,
             json_object('captured_at', cc.created_at,
                         'source', cc.last_intent) as metadata
      FROM customer_contacts cc
      LEFT JOIN sync_bookings sb ON sb.sender_id = cc.sender_id AND sb.status IN ('confirmed','synced','checked_in','checked_out')
      WHERE cc.created_at >= ?
        AND sb.id IS NULL
        AND cc.phone IS NOT NULL
    `,
    params: (_hotelId: number) => [Date.now() - 14 * 24 * 3600_000],
  },

  /** Peak date leads — khách hỏi peak date nhưng hết phòng */
  peak_date_leads: {
    description: 'Khách đã hỏi peak date (30/4, lễ) nhưng không book được',
    sql: `
      SELECT DISTINCT cm.sender_id,
             cc.phone as customer_phone,
             cc.sender_name as customer_name,
             ? as hotel_id,
             json_object('asked_at', MAX(cm.created_at), 'dates_asked', GROUP_CONCAT(DISTINCT substr(cm.message, 1, 50))) as metadata
      FROM conversation_memory cm
      LEFT JOIN customer_contacts cc ON cc.sender_id = cm.sender_id
      WHERE cm.role = 'user'
        AND cm.created_at >= ?
        AND (
          cm.message LIKE '%30/4%' OR cm.message LIKE '%30-4%' OR cm.message LIKE '%30 tháng 4%'
          OR cm.message LIKE '%2/9%' OR cm.message LIKE '%lễ%' OR cm.message LIKE '%tết%'
          OR cm.message LIKE '%1/5%' OR cm.message LIKE '%1-5%'
        )
      GROUP BY cm.sender_id
    `,
    params: (hotelId: number) => [hotelId, Date.now() - 30 * 24 * 3600_000],
  },

  /** Birthday this month — cần guest_profiles có DOB */
  birthday_this_month: {
    description: 'Khách có sinh nhật tháng này (áp dụng promo BIRTHDAY)',
    sql: `
      SELECT gp.fb_user_id as sender_id,
             gp.phone as customer_phone,
             gp.name as customer_name,
             gp.hotel_id,
             json_object('tier', COALESCE(cm.customer_tier, 'new')) as metadata
      FROM guest_profiles gp
      LEFT JOIN customer_memory cm ON cm.sender_id = gp.fb_user_id
      WHERE json_extract(gp.preferences, '$.dob') IS NOT NULL
        AND CAST(strftime('%m', json_extract(gp.preferences, '$.dob'), 'unixepoch') AS INTEGER) = CAST(strftime('%m', 'now') AS INTEGER)
    `,
    params: (_hotelId: number) => [],
  },
};

/** Refresh membership for 1 audience. Replace all members with fresh query. */
export function refreshAudience(audienceId: number): RefreshResult {
  const t0 = Date.now();
  const audience = db.prepare(`SELECT * FROM marketing_audiences WHERE id = ?`).get(audienceId) as any;
  if (!audience) return { audience_id: audienceId, audience_name: 'unknown', members_before: 0, members_after: 0, added: 0, removed: 0, duration_ms: 0, error: 'not found' };

  const result: RefreshResult = {
    audience_id: audienceId,
    audience_name: audience.audience_name,
    members_before: audience.member_count || 0,
    members_after: 0,
    added: 0,
    removed: 0,
    duration_ms: 0,
  };

  try {
    let rows: any[] = [];

    if (audience.filter_type === 'sql_rule') {
      // Try built-in first, else use custom sql_query
      const builtin = BUILTIN_AUDIENCES[audience.audience_name];
      if (builtin) {
        rows = db.prepare(builtin.sql).all(...builtin.params(audience.hotel_id || 1)) as any[];
      } else if (audience.sql_query) {
        rows = db.prepare(audience.sql_query).all() as any[];
      } else {
        throw new Error('no SQL defined for sql_rule audience');
      }
    } else if (audience.filter_type === 'manual') {
      // Skip auto-refresh for manual audiences
      result.members_after = result.members_before;
      result.duration_ms = Date.now() - t0;
      return result;
    }

    // Replace memberships atomically
    const tx = db.transaction((newRows: any[]) => {
      db.prepare(`DELETE FROM audience_memberships WHERE audience_id = ?`).run(audienceId);

      const insertStmt = db.prepare(
        `INSERT OR IGNORE INTO audience_memberships
         (audience_id, sender_id, customer_phone, customer_name, hotel_id, metadata, added_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      );
      const now = Date.now();
      for (const row of newRows) {
        if (!row.sender_id && !row.customer_phone) continue;
        insertStmt.run(
          audienceId,
          row.sender_id || null,
          row.customer_phone || null,
          row.customer_name || null,
          row.hotel_id || audience.hotel_id || 0,
          row.metadata || null,
          now,
        );
      }
    });
    tx(rows);

    result.members_after = rows.length;
    result.added = Math.max(0, result.members_after - result.members_before);
    result.removed = Math.max(0, result.members_before - result.members_after);
    result.duration_ms = Date.now() - t0;

    db.prepare(
      `UPDATE marketing_audiences
       SET member_count = ?, last_refreshed_at = ?, last_refresh_duration_ms = ?, updated_at = ?
       WHERE id = ?`
    ).run(result.members_after, Date.now(), result.duration_ms, Date.now(), audienceId);
  } catch (e: any) {
    result.error = e?.message || 'unknown';
    result.duration_ms = Date.now() - t0;
    console.warn(`[audience-engine] refresh fail #${audienceId} ${audience.audience_name}:`, result.error);
  }

  return result;
}

/** Refresh all active audiences respecting refresh_interval_min. */
export function refreshAllAudiences(force: boolean = false): RefreshResult[] {
  const now = Date.now();
  const results: RefreshResult[] = [];

  const audiences = db.prepare(
    `SELECT * FROM marketing_audiences WHERE active = 1`
  ).all() as any[];

  for (const a of audiences) {
    const intervalMs = (a.refresh_interval_min || 1440) * 60_000;
    if (!force && a.last_refreshed_at && (now - a.last_refreshed_at) < intervalMs) {
      continue;  // Too soon
    }
    results.push(refreshAudience(a.id));
  }

  const ok = results.filter(r => !r.error).length;
  if (results.length > 0) {
    console.log(`[audience-engine] refreshed ${ok}/${results.length} audiences`);
  }
  return results;
}

/** Get members of an audience (for admin preview or campaign send). */
export function getAudienceMembers(audienceId: number, limit: number = 1000): any[] {
  return db.prepare(
    `SELECT * FROM audience_memberships WHERE audience_id = ? ORDER BY id LIMIT ?`
  ).all(audienceId, limit) as any[];
}

/** Which audiences does a customer belong to? (for real-time personalization) */
export function evaluateCustomerForAudiences(senderId: string): any[] {
  return db.prepare(
    `SELECT ma.id, ma.audience_name, ma.display_name, am.metadata
     FROM audience_memberships am
     JOIN marketing_audiences ma ON ma.id = am.audience_id
     WHERE am.sender_id = ? AND ma.active = 1`
  ).all(senderId) as any[];
}

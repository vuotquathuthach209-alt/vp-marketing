/**
 * Conversion Funnel Tracker
 *
 * Đo ROI thực sự của bot: từ inbox đến booking đã thanh toán.
 *
 * 5 stage funnel:
 *   1. inbox_received    — khách nhắn lần đầu
 *   2. qualified_lead    — khách thể hiện ý định book (booking_action intent)
 *   3. booking_created   — FSM tạo pending_booking
 *   4. deposit_received  — khách chuyển cọc
 *   5. confirmed         — lễ tân xác nhận
 *
 * Event name trong `events` table:
 *   - funnel_inbox, funnel_qualified, funnel_booking_created, funnel_deposit, funnel_confirmed
 *
 * Revenue attribution:
 *   - Lưu thêm total_price + deposit_amount vào meta
 *   - Query tổng doanh thu từ bot trong N ngày qua
 */
import { db } from '../db';
import { trackEvent } from './events';

export type FunnelStage =
  | 'inbox'
  | 'qualified'
  | 'booking_created'
  | 'deposit'
  | 'confirmed';

const EVENT_PREFIX = 'funnel_';

/**
 * Track 1 stage của funnel cho 1 sender.
 * Idempotent mỗi stage mỗi sender mỗi conversation — chỉ log lần đầu đạt stage đó.
 */
export function trackFunnelStage(opts: {
  stage: FunnelStage;
  senderId?: string;
  hotelId: number;
  bookingId?: number;
  pageId?: number;
  revenue?: number;   // VND
  deposit?: number;   // VND
  metadata?: Record<string, unknown>;
}): void {
  const { stage, senderId, hotelId, bookingId, pageId, revenue, deposit, metadata } = opts;
  const eventName = EVENT_PREFIX + stage;

  // Dedup: check nếu đã có event này cùng (sender+booking) trong 30 ngày
  // senderId lưu trong meta.sender_id (events.user_id là INTEGER, không chứa FB PSID)
  if (senderId) {
    const since = Date.now() - 30 * 24 * 3600 * 1000;
    const existing = db.prepare(
      `SELECT id FROM events
       WHERE event_name = ? AND json_extract(meta, '$.sender_id') = ? AND ts >= ?
       ${bookingId ? "AND json_extract(meta, '$.booking_id') = ?" : ''}
       LIMIT 1`
    );
    const row = bookingId
      ? existing.get(eventName, senderId, since, bookingId)
      : existing.get(eventName, senderId, since);
    if (row) return; // đã log rồi, skip
  }

  const meta = {
    ...(metadata || {}),
    sender_id: senderId,
    booking_id: bookingId,
    page_id: pageId,
    revenue_vnd: revenue,
    deposit_vnd: deposit,
  };

  try {
    trackEvent({
      event: eventName,
      hotelId,
      meta,
    });
  } catch (e: any) {
    console.warn('[funnel] track failed:', e?.message);
  }
}

/**
 * Compute funnel stats for dashboard.
 */
export interface FunnelStats {
  days: number;
  stages: Array<{
    stage: FunnelStage;
    count: number;
    conversion_pct: number;  // từ stage trước
    total_pct: number;       // từ stage đầu
  }>;
  revenue: {
    total_deposit_vnd: number;
    total_booking_vnd: number;
    avg_booking_vnd: number;
  };
}

const STAGES: FunnelStage[] = ['inbox', 'qualified', 'booking_created', 'deposit', 'confirmed'];

export function getFunnelStats(hotelId: number | null, days = 30): FunnelStats {
  const since = Date.now() - days * 24 * 3600 * 1000;
  const hotelFilter = hotelId ? 'AND hotel_id = ?' : '';
  const params: any[] = hotelId ? [since, hotelId] : [since];

  const counts: Record<FunnelStage, number> = {
    inbox: 0, qualified: 0, booking_created: 0, deposit: 0, confirmed: 0,
  };
  const revenueAgg: Record<string, number> = { deposit: 0, booking: 0 };
  let bookingCount = 0;

  for (const stage of STAGES) {
    const row = db.prepare(
      `SELECT COUNT(DISTINCT COALESCE(json_extract(meta, '$.sender_id'), ip)) as n,
              SUM(CAST(json_extract(meta, '$.revenue_vnd') AS REAL)) as rev,
              SUM(CAST(json_extract(meta, '$.deposit_vnd') AS REAL)) as dep
       FROM events WHERE event_name = ? AND ts >= ? ${hotelFilter}`
    ).get(EVENT_PREFIX + stage, ...params) as any;
    counts[stage] = row?.n || 0;
    if (stage === 'deposit') revenueAgg.deposit = row?.dep || 0;
    if (stage === 'booking_created') {
      revenueAgg.booking = row?.rev || 0;
      bookingCount = row?.n || 0;
    }
  }

  const first = counts.inbox || 1;
  const stages = STAGES.map((stage, i) => {
    const prev = i > 0 ? counts[STAGES[i - 1]] : counts[stage];
    return {
      stage,
      count: counts[stage],
      conversion_pct: i > 0 && prev > 0 ? +((counts[stage] / prev) * 100).toFixed(1) : 100,
      total_pct: +((counts[stage] / first) * 100).toFixed(1),
    };
  });

  return {
    days,
    stages,
    revenue: {
      total_deposit_vnd: revenueAgg.deposit,
      total_booking_vnd: revenueAgg.booking,
      avg_booking_vnd: bookingCount > 0 ? Math.round(revenueAgg.booking / bookingCount) : 0,
    },
  };
}

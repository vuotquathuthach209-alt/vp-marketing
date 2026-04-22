/**
 * Retention Cleanup Service — xóa dữ liệu cũ theo policy.
 *
 * Compliance: Nghị định 13/2023/NĐ-CP (VN) — Bảo vệ dữ liệu cá nhân.
 *
 * Chạy cron daily 2:00 AM (VN time, ít traffic).
 *
 * Policy (xem docs/BOT-SALES-FUNNEL-OPS.md):
 *   - Messages (conversation_memory): 60 ngày
 *   - FSM state (bot_conversation_state): 90 ngày nếu không có booking, forever nếu có
 *   - Booking drafts: 2 năm (kế toán + thuế)
 *   - Customer memory: 3 năm từ last_seen
 *   - Handed-off conversations: 180 ngày
 *   - OTA raw data: 90 ngày
 *   - Events: 180 ngày
 *   - Playground: 7 ngày
 */

import { db } from '../db';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface RetentionPolicy {
  messages_days: number;
  fsm_state_days: number;            // chỉ áp dụng cho state KHÔNG có booking_draft
  booking_drafts_days: number;
  customer_memory_days: number;      // từ last_seen
  handoff_days: number;
  ota_raw_days: number;
  events_days: number;
  playground_days: number;
}

export const DEFAULT_POLICY: RetentionPolicy = {
  messages_days: 60,
  fsm_state_days: 90,
  booking_drafts_days: 730,          // 2 years
  customer_memory_days: 1095,        // 3 years
  handoff_days: 180,
  ota_raw_days: 90,
  events_days: 180,
  playground_days: 7,
};

export interface CleanupResult {
  table: string;
  deleted: number;
  policy_days: number;
}

/**
 * Run full retention cleanup. Return per-table stats.
 */
export function runRetentionCleanup(policy: Partial<RetentionPolicy> = {}): {
  results: CleanupResult[];
  total_deleted: number;
  duration_ms: number;
} {
  const t0 = Date.now();
  const p = { ...DEFAULT_POLICY, ...policy };
  const results: CleanupResult[] = [];

  // 1. conversation_memory — 60 ngày
  try {
    const cutoff = Date.now() - p.messages_days * DAY_MS;
    const r = db.prepare(`DELETE FROM conversation_memory WHERE created_at < ?`).run(cutoff);
    results.push({ table: 'conversation_memory', deleted: r.changes, policy_days: p.messages_days });
  } catch (e: any) { console.warn('[retention] conversation_memory fail:', e?.message); }

  // 2. bot_conversation_state — 90 ngày (CHỈ nếu không có booking_draft)
  try {
    const cutoff = Date.now() - p.fsm_state_days * DAY_MS;
    const r = db.prepare(`
      DELETE FROM bot_conversation_state
      WHERE updated_at < ?
        AND sender_id NOT IN (SELECT DISTINCT sender_id FROM bot_booking_drafts WHERE sender_id IS NOT NULL)
    `).run(cutoff);
    results.push({ table: 'bot_conversation_state', deleted: r.changes, policy_days: p.fsm_state_days });
  } catch (e: any) { console.warn('[retention] bot_conversation_state fail:', e?.message); }

  // 3. bot_booking_drafts — 2 years
  try {
    const cutoff = Date.now() - p.booking_drafts_days * DAY_MS;
    const r = db.prepare(`
      DELETE FROM bot_booking_drafts
      WHERE created_at < ? AND status IN ('cancelled', 'no_response')
    `).run(cutoff);
    // Confirmed/paid bookings giữ lại forever cho record (chỉ xóa cancelled sau 2 năm)
    results.push({ table: 'bot_booking_drafts', deleted: r.changes, policy_days: p.booking_drafts_days });
  } catch (e: any) { console.warn('[retention] bot_booking_drafts fail:', e?.message); }

  // 4. customer_memory — 3 years từ last_seen (chỉ xóa khách không quay lại)
  try {
    const cutoff = Date.now() - p.customer_memory_days * DAY_MS;
    const r = db.prepare(`DELETE FROM customer_memory WHERE last_seen_at < ?`).run(cutoff);
    results.push({ table: 'customer_memory', deleted: r.changes, policy_days: p.customer_memory_days });
  } catch (e: any) { console.warn('[retention] customer_memory fail:', e?.message); }

  // 5. OTA raw data — 90 ngày (classified only — keep failed for debugging)
  try {
    const cutoff = Date.now() - p.ota_raw_days * DAY_MS;
    const tables = ['ota_raw_hotels', 'ota_raw_rooms', 'ota_raw_availability', 'ota_raw_images'];
    let totalDeleted = 0;
    for (const t of tables) {
      try {
        const r = db.prepare(`DELETE FROM ${t} WHERE received_at < ? AND status IN ('classified', 'test_cleaned')`).run(cutoff);
        totalDeleted += r.changes;
      } catch {}
    }
    // Also batches
    try {
      const r = db.prepare(`DELETE FROM ota_raw_batches WHERE received_at < ?`).run(cutoff);
      totalDeleted += r.changes;
    } catch {}
    results.push({ table: 'ota_raw_*', deleted: totalDeleted, policy_days: p.ota_raw_days });
  } catch (e: any) { console.warn('[retention] ota_raw fail:', e?.message); }

  // 6. events — 180 ngày
  try {
    const cutoff = Date.now() - p.events_days * DAY_MS;
    const r = db.prepare(`DELETE FROM events WHERE ts < ?`).run(cutoff);
    results.push({ table: 'events', deleted: r.changes, policy_days: p.events_days });
  } catch (e: any) { console.warn('[retention] events fail:', e?.message); }

  // 7. Playground sessions — 7 ngày
  try {
    const cutoff = Date.now() - p.playground_days * DAY_MS;
    const r = db.prepare(`DELETE FROM conversation_memory WHERE sender_id LIKE 'playground_%' AND created_at < ?`).run(cutoff);
    results.push({ table: 'playground_sessions', deleted: r.changes, policy_days: p.playground_days });
  } catch (e: any) { console.warn('[retention] playground fail:', e?.message); }

  // 8. VACUUM database sau khi xóa nhiều (reclaim disk)
  try {
    const totalDeleted = results.reduce((a, b) => a + b.deleted, 0);
    if (totalDeleted > 1000) {
      db.exec('VACUUM');
      console.log('[retention] VACUUM done after cleanup');
    }
  } catch {}

  return {
    results,
    total_deleted: results.reduce((a, b) => a + b.deleted, 0),
    duration_ms: Date.now() - t0,
  };
}

/**
 * Get DB table sizes + row counts (for admin dashboard).
 */
export function getDbStats(): Array<{ table: string; rows: number; size_mb?: number }> {
  const tables = [
    'conversation_memory', 'bot_conversation_state', 'bot_booking_drafts',
    'customer_memory', 'ota_raw_hotels', 'ota_raw_rooms', 'ota_raw_availability',
    'ota_raw_images', 'events', 'ai_cache', 'qa_training_cache',
    'news_articles', 'hotel_profile', 'hotel_room_catalog',
  ];
  const stats: Array<{ table: string; rows: number }> = [];
  for (const t of tables) {
    try {
      const r = db.prepare(`SELECT COUNT(*) as n FROM ${t}`).get() as any;
      stats.push({ table: t, rows: r?.n || 0 });
    } catch {
      stats.push({ table: t, rows: -1 });  // table not found
    }
  }
  stats.sort((a, b) => b.rows - a.rows);
  return stats;
}

/**
 * Full forget — xóa TẤT CẢ data liên quan đến 1 sender_id.
 * Dùng cho GDPR/NĐ-13 right-to-delete request.
 */
export function forgetSender(senderId: string): {
  conversation_memory: number;
  bot_conversation_state: number;
  bot_booking_drafts: number;
  customer_memory: number;
  events: number;
  guest_profiles: number;
  total: number;
} {
  const counts = {
    conversation_memory: 0,
    bot_conversation_state: 0,
    bot_booking_drafts: 0,
    customer_memory: 0,
    events: 0,
    guest_profiles: 0,
    total: 0,
  };

  const del = (sql: string) => {
    try {
      const r = db.prepare(sql).run(senderId);
      return r.changes;
    } catch {
      return 0;
    }
  };

  counts.conversation_memory = del(`DELETE FROM conversation_memory WHERE sender_id = ?`);
  counts.bot_conversation_state = del(`DELETE FROM bot_conversation_state WHERE sender_id = ?`);
  counts.bot_booking_drafts = del(`DELETE FROM bot_booking_drafts WHERE sender_id = ?`);
  counts.customer_memory = del(`DELETE FROM customer_memory WHERE sender_id = ?`);
  try {
    const r = db.prepare(`DELETE FROM events WHERE meta LIKE '%' || ? || '%'`).run(senderId);
    counts.events = r.changes;
  } catch {}
  counts.guest_profiles = del(`DELETE FROM guest_profiles WHERE sender_id = ?`);

  counts.total = Object.values(counts).reduce((a, b) => typeof b === 'number' ? a + b : a, 0);
  return counts;
}

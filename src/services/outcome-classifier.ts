/**
 * Outcome Classifier — v13 Feedback Loop.
 *
 * Cron chạy mỗi 15 phút: quét `bot_reply_outcomes` status='pending' và update outcome dựa trên:
 *
 * Rules (deterministic, fast, no LLM):
 *   1. Cho phone/name trong 60 phút sau reply → converted_to_lead
 *   2. Nói "không hiểu", "hỏi lại", "ý em là sao" trong 10 phút → misunderstood
 *   3. Gửi cùng câu hỏi (similar) trong 5 phút → followup_same_topic
 *   4. Gửi nhiều cảm xúc tiêu cực ("bực", "chán", "tệ") → rage_quit
 *   5. No response trong 48h → ghosted
 *   6. Có reply trong <24h nhưng không match các rule trên → ignored/followup_ok
 *   7. Stage chuyển tới CONFIRM_BOOKING / PAID → booked/closed_won
 */

import { db } from '../db';
import { updateOutcome } from './reply-outcome-logger';
import { getVariantForSenderReply, recordVariantOutcome } from './reply-variant-selector';

const GHOSTED_AFTER_HRS = 48;
const MISUNDERSTOOD_WINDOW_MIN = 10;
const CONVERTED_WINDOW_MIN = 60;
const FOLLOWUP_WINDOW_MIN = 5;

// Map reply_source → template_key (cho A/B test variant tracking)
const SOURCE_TO_TEMPLATE_KEY: Record<string, string> = {
  'funnel_property_type_ask': 'greeting_new',
  'funnel_show_results': 'show_results_list',
  'funnel_closing_contact': 'closing_ask_phone',
  'policy_cancellation': 'policy_cancellation_reply',
};

/** Lookup variant cho reply đã classify + record outcome. */
function propagateOutcomeToVariant(senderId: string, hotelId: number, replySource: string, outcome: string): void {
  try {
    const templateKey = SOURCE_TO_TEMPLATE_KEY[replySource];
    if (!templateKey) return;
    const variant = getVariantForSenderReply(senderId, templateKey, hotelId);
    if (variant) {
      recordVariantOutcome(variant.id, outcome);
    }
  } catch {}
}

// Keywords cho intent detection
const MISUNDERSTOOD_PATTERNS = [
  /không hiểu/i, /hiểu gì/i, /hỏi lại/i, /ý (gì|như thế nào)/i,
  /là sao/i, /ủa/i, /gì vậy/i, /nói gì/i, /lặp lại/i, /nhầm/i, /sai rồi/i,
];
const RAGE_PATTERNS = [
  /tệ quá/i, /chán quá/i, /bực/i, /ngáo/i, /máy móc/i, /người thật đâu/i,
  /cần người thật/i, /admin đâu/i, /chuyển nhân viên/i, /bot dở/i,
];
const PHONE_PATTERN = /(?:\+?84|0)(3|5|7|8|9)\d{8}/;

export interface ClassifyResult {
  processed: number;
  updated_by_outcome: Record<string, number>;
  still_pending: number;
}

export function classifyPendingOutcomes(): ClassifyResult {
  const now = Date.now();
  const out: ClassifyResult = { processed: 0, updated_by_outcome: {}, still_pending: 0 };

  // Lấy pending outcomes > 5 phút trước (để user kịp reply)
  const minAge = 5 * 60_000;
  const pending = db.prepare(
    `SELECT id, hotel_id, sender_id, bot_reply, intent, stage, reply_source, created_at
     FROM bot_reply_outcomes
     WHERE outcome = 'pending' AND created_at <= ?
     ORDER BY created_at ASC
     LIMIT 500`
  ).all(now - minAge) as any[];

  for (const row of pending) {
    out.processed++;
    const ageMs = now - row.created_at;

    // Rule 5: Ghosted nếu quá 48h không response
    if (ageMs > GHOSTED_AFTER_HRS * 3600_000) {
      updateOutcome(row.id, 'ghosted', { age_hours: (ageMs / 3600_000).toFixed(1) });
      propagateOutcomeToVariant(row.sender_id, row.hotel_id, row.reply_source, 'ghosted');
      out.updated_by_outcome['ghosted'] = (out.updated_by_outcome['ghosted'] || 0) + 1;
      continue;
    }

    // Lấy messages của sender sau reply (để check có response không)
    const afterMsgs = db.prepare(
      `SELECT role, message, intent, created_at FROM conversation_memory
       WHERE sender_id = ? AND created_at > ?
       ORDER BY created_at ASC LIMIT 10`
    ).all(row.sender_id, row.created_at) as any[];

    // Filter chỉ user messages (skip các bot replies sau này)
    const userMsgsAfter = afterMsgs.filter(m => m.role === 'user');

    if (userMsgsAfter.length === 0) {
      // Chưa response, và chưa đến 48h → vẫn pending
      out.still_pending++;
      continue;
    }

    const firstUserMsg = userMsgsAfter[0];
    const timeSinceReplyMin = (firstUserMsg.created_at - row.created_at) / 60_000;
    const msg = firstUserMsg.message || '';

    // Rule 2: Misunderstood
    if (timeSinceReplyMin < MISUNDERSTOOD_WINDOW_MIN &&
        MISUNDERSTOOD_PATTERNS.some(p => p.test(msg))) {
      updateOutcome(row.id, 'misunderstood', { next_user_msg: msg.slice(0, 100), delay_min: +timeSinceReplyMin.toFixed(1) });
      propagateOutcomeToVariant(row.sender_id, row.hotel_id, row.reply_source, 'misunderstood');
      out.updated_by_outcome['misunderstood'] = (out.updated_by_outcome['misunderstood'] || 0) + 1;
      continue;
    }

    // Rule 4: Rage quit
    if (RAGE_PATTERNS.some(p => p.test(msg))) {
      updateOutcome(row.id, 'rage_quit', { trigger_msg: msg.slice(0, 100) });
      propagateOutcomeToVariant(row.sender_id, row.hotel_id, row.reply_source, 'misunderstood');
      out.updated_by_outcome['rage_quit'] = (out.updated_by_outcome['rage_quit'] || 0) + 1;
      continue;
    }

    // Rule 1: Converted to lead — khách cho phone trong 60 phút
    if (timeSinceReplyMin < CONVERTED_WINDOW_MIN && PHONE_PATTERN.test(msg)) {
      updateOutcome(row.id, 'converted_to_lead', { phone_detected: true, delay_min: +timeSinceReplyMin.toFixed(1) });
      propagateOutcomeToVariant(row.sender_id, row.hotel_id, row.reply_source, 'converted_to_lead');
      out.updated_by_outcome['converted_to_lead'] = (out.updated_by_outcome['converted_to_lead'] || 0) + 1;
      continue;
    }

    // Rule 7: Booked — nếu có row trong pending_bookings / mkt_bookings_cache cho sender này sau reply
    try {
      const booked = db.prepare(
        `SELECT id FROM pending_bookings WHERE sender_id = ? AND created_at > ? LIMIT 1`
      ).get(row.sender_id, row.created_at) as any;
      if (booked) {
        updateOutcome(row.id, 'booked', { booking_id: booked.id });
        propagateOutcomeToVariant(row.sender_id, row.hotel_id, row.reply_source, 'booked');
        out.updated_by_outcome['booked'] = (out.updated_by_outcome['booked'] || 0) + 1;
        continue;
      }
    } catch {}

    // Rule 7b: Handed off — nếu bot_conversation_state.handed_off = 1
    try {
      const ho = db.prepare(
        `SELECT handed_off FROM bot_conversation_state WHERE sender_id = ?`
      ).get(row.sender_id) as any;
      if (ho?.handed_off) {
        updateOutcome(row.id, 'handed_off', {});
        out.updated_by_outcome['handed_off'] = (out.updated_by_outcome['handed_off'] || 0) + 1;
        continue;
      }
    } catch {}

    // Rule 3: Followup same topic (user tiếp tục conversation bình thường)
    // Nếu timeSinceReplyMin < FOLLOWUP_WINDOW_MIN → followup_ok (coi như reply tốt)
    if (timeSinceReplyMin < FOLLOWUP_WINDOW_MIN * 12) {  // trong 60 phút
      updateOutcome(row.id, 'followup_same_topic', {
        next_msg: msg.slice(0, 60),
        delay_min: +timeSinceReplyMin.toFixed(1),
      });
      out.updated_by_outcome['followup_same_topic'] = (out.updated_by_outcome['followup_same_topic'] || 0) + 1;
      continue;
    }

    // Fallback: nếu có response nhưng > 60 phút → ignored_then_returned (khách quay lại)
    updateOutcome(row.id, 'followup_delayed', { delay_min: +timeSinceReplyMin.toFixed(1) });
    out.updated_by_outcome['followup_delayed'] = (out.updated_by_outcome['followup_delayed'] || 0) + 1;
  }

  return out;
}

/** Aggregate funnel daily metrics — upsert funnel_daily_metrics từ transitions. */
export function aggregateFunnelDaily(hotelId?: number): number {
  const today = new Date();
  const vnNow = new Date(today.getTime() + 7 * 3600_000);
  const dateStr = vnNow.toISOString().slice(0, 10);
  const dayStart = Date.parse(dateStr) - 7 * 3600_000;  // VN 00:00 → UTC ms
  const dayEnd = dayStart + 24 * 3600_000;

  const whereHotel = hotelId ? `AND hotel_id = ${hotelId}` : '';

  // Entered counts: số unique sender vào mỗi stage
  const entered = db.prepare(
    `SELECT hotel_id, to_stage as stage, COUNT(DISTINCT sender_id) as n
     FROM funnel_stage_transitions
     WHERE created_at >= ? AND created_at < ? ${whereHotel}
     GROUP BY hotel_id, to_stage`
  ).all(dayStart, dayEnd) as any[];

  let count = 0;
  for (const e of entered) {
    db.prepare(
      `INSERT INTO funnel_daily_metrics (hotel_id, date, stage, entered_count)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(hotel_id, date, stage) DO UPDATE SET entered_count = excluded.entered_count`
    ).run(e.hotel_id, dateStr, e.stage, e.n);
    count++;
  }

  return count;
}

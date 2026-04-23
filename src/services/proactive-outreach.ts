/**
 * Proactive Outreach — bot chủ động nhắn khách tại thời điểm cao giá trị.
 *
 * 6 triggers:
 *   1. pre_checkin_1d    — 1 ngày trước check-in: remind + upsell early check-in
 *   2. post_checkout_3d  — 3 ngày sau check-out: review request + repeat promo
 *   3. birthday_month    — tháng sinh nhật: auto BIRTHDAY promo DM
 *   4. abandoned_cart    — hold booking expired: flash promo
 *   5. funnel_stuck_24h  — khách không response 24h trong active funnel
 *   6. vip_winback_30d   — VIP inactive 30+ days
 *
 * Flow:
 *   1. Cron daily scanForOutreachOpportunities() → queue rows status='queued'
 *   2. Cron every 30min sendQueuedOutreach() → send theo scheduled_at
 *   3. Rate guard: max 1 outreach/sender/type/day, max 2 total/sender/day
 */

import { db } from '../db';

export interface OutreachTrigger {
  type: string;
  description: string;
  scanQuery: (hotelId: number) => any[];
  buildMessage: (row: any) => { channel: string; template_key?: string; content: string; context: any };
}

/** Dedupe: only queue if no existing queued/sent for same sender+type+scheduled_date. */
function hasPendingOutreach(senderId: string, triggerType: string, withinHours: number = 24): boolean {
  const since = Date.now() - withinHours * 3600_000;
  const row = db.prepare(
    `SELECT id FROM scheduled_outreach
     WHERE sender_id = ? AND trigger_type = ?
       AND (status IN ('queued', 'sent') OR (status = 'converted' AND converted_at > ?))
       AND created_at > ?
     LIMIT 1`
  ).get(senderId, triggerType, since, since) as any;
  return !!row;
}

/** Daily rate check — max 2 outreach/sender/day total. */
function dailyRateExceeded(senderId: string, limit: number = 2): boolean {
  const vnToday = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
  const row = db.prepare(
    `SELECT sent_count FROM outreach_rate_log WHERE sender_id = ? AND date_str = ?`
  ).get(senderId, vnToday) as any;
  return (row?.sent_count || 0) >= limit;
}

function incrementDailyRate(senderId: string): void {
  const vnToday = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
  db.prepare(
    `INSERT INTO outreach_rate_log (sender_id, date_str, sent_count)
     VALUES (?, ?, 1)
     ON CONFLICT(sender_id, date_str) DO UPDATE SET sent_count = sent_count + 1`
  ).run(senderId, vnToday);
}

/* ═══════════════════════════════════════════
   TRIGGER DEFINITIONS
   ═══════════════════════════════════════════ */

export const OUTREACH_TRIGGERS: OutreachTrigger[] = [
  // 1. Pre check-in 1 day
  {
    type: 'pre_checkin_1d',
    description: 'Remind 1 ngày trước check-in + upsell',
    scanQuery: (hotelId: number) => {
      const tomorrowStart = new Date();
      tomorrowStart.setUTCHours(0, 0, 0, 0);
      tomorrowStart.setUTCDate(tomorrowStart.getUTCDate() + 1);
      const tomorrowStr = tomorrowStart.toISOString().slice(0, 10);

      return db.prepare(
        `SELECT id as booking_id, sender_id, customer_phone, customer_name, hotel_id,
                checkin_date, room_type_code, total_price
         FROM sync_bookings
         WHERE hotel_id = ? AND status IN ('confirmed', 'synced')
           AND checkin_date = ?
           AND sender_id IS NOT NULL`
      ).all(hotelId, tomorrowStr) as any[];
    },
    buildMessage: (row: any) => ({
      channel: 'zalo_message',
      template_key: 'pre_checkin_reminder',
      content: `Chào ${row.customer_name || 'anh/chị'}! 🙌\n\nNgày mai ${row.checkin_date} anh/chị check-in tại Sonder rồi ạ — phòng đã sẵn sàng!\n\n⏰ Giờ check-in chuẩn: **14:00**\n💡 Muốn check-in sớm 12:00? Miễn phí nếu phòng trống — inbox em nhé!\n\nĐịa chỉ + hướng dẫn em gửi qua tin nhắn sau ạ 💚`,
      context: { booking_id: row.booking_id, checkin_date: row.checkin_date },
    }),
  },

  // 2. Post check-out 3 days — review + repeat promo
  {
    type: 'post_checkout_3d',
    description: 'Request review 3 ngày sau checkout + repeat promo',
    scanQuery: (hotelId: number) => {
      const threeDaysAgo = new Date();
      threeDaysAgo.setUTCDate(threeDaysAgo.getUTCDate() - 3);
      const threeAgoStr = threeDaysAgo.toISOString().slice(0, 10);

      return db.prepare(
        `SELECT id as booking_id, sender_id, customer_phone, customer_name, hotel_id,
                checkout_date, room_type_code
         FROM sync_bookings
         WHERE hotel_id = ? AND status IN ('checked_out', 'synced', 'confirmed')
           AND checkout_date = ?
           AND sender_id IS NOT NULL`
      ).all(hotelId, threeAgoStr) as any[];
    },
    buildMessage: (row: any) => ({
      channel: 'zalo_message',
      template_key: 'post_checkout_review',
      content: `Chào ${row.customer_name || 'anh/chị'}! 💚\n\nEm là Sonder — cảm ơn anh/chị đã chọn bên em hôm ${row.checkout_date}!\n\n⭐ Anh/chị rate trải nghiệm 1-5⭐ giúp em với ạ? Review thật giúp Sonder cải thiện.\n\n🎁 Gift cho anh/chị: **mã SONDER2026** giảm 15% cho lần đặt tiếp theo (HSD 30 ngày).\n\nKhi nào có kế hoạch đi lại, nhớ Sonder nhé 🌿`,
      context: { booking_id: row.booking_id, gift_code: 'SONDER2026' },
    }),
  },

  // 3. Birthday month
  {
    type: 'birthday_month',
    description: 'Tháng sinh nhật: auto BIRTHDAY promo',
    scanQuery: (hotelId: number) => {
      // Use guest_profiles.preferences.dob (JSON) OR customer_memory if populated
      return db.prepare(
        `SELECT gp.fb_user_id as sender_id,
                gp.phone as customer_phone,
                gp.name as customer_name,
                gp.hotel_id
         FROM guest_profiles gp
         WHERE gp.hotel_id = ?
           AND json_extract(gp.preferences, '$.dob') IS NOT NULL
           AND CAST(strftime('%m', json_extract(gp.preferences, '$.dob'), 'unixepoch') AS INTEGER) = CAST(strftime('%m', 'now') AS INTEGER)`
      ).all(hotelId) as any[];
    },
    buildMessage: (row: any) => ({
      channel: 'zalo_message',
      template_key: 'birthday_promo',
      content: `🎂 Happy Birthday ${row.customer_name || 'anh/chị'}!\n\nSonder gửi tặng anh/chị mã **BIRTHDAY** giảm **20%** (tối đa 700k) cho bất kỳ booking nào trong tháng sinh nhật 🎉\n\nĐặt phòng ngay để enjoy sinh nhật trọn vẹn nhé! Inbox em booking hoặc vào web Sonder.\n\n💚 Chúc anh/chị tuổi mới thật nhiều niềm vui + chuyến đi đáng nhớ!`,
      context: { promo_code: 'BIRTHDAY' },
    }),
  },

  // 4. Abandoned cart
  {
    type: 'abandoned_cart',
    description: 'Khách đã tạo hold booking rồi bỏ → flash promo',
    scanQuery: (hotelId: number) => {
      // Hold expired in last 2-24 hours
      const from = Date.now() - 24 * 3600_000;
      const to = Date.now() - 2 * 3600_000;
      return db.prepare(
        `SELECT id as booking_id, sender_id, customer_phone, customer_name, hotel_id,
                checkin_date, room_type_code, total_price, deposit_amount
         FROM sync_bookings
         WHERE hotel_id = ? AND status = 'cancelled'
           AND notes LIKE '%hold expired%'
           AND expires_at BETWEEN ? AND ?
           AND sender_id IS NOT NULL`
      ).all(hotelId, from, to) as any[];
    },
    buildMessage: (row: any) => ({
      channel: 'zalo_message',
      template_key: 'abandoned_cart_promo',
      content: `⏰ Anh/chị ơi, em thấy bên em chưa nhận được cọc — phòng vẫn còn trống cho ngày ${row.checkin_date}!\n\n🎁 Để giúp anh/chị quyết định nhanh, Sonder áp dụng mã **FLASH100K** — giảm ngay 100k cho booking này (HSD 24h).\n\nEm reserve phòng đến hết hôm nay. Anh/chị muốn em gửi lại QR cọc không ạ? 💚`,
      context: { booking_id: row.booking_id, promo_code: 'FLASH100K' },
    }),
  },

  // 5. Funnel stuck 24h
  {
    type: 'funnel_stuck_24h',
    description: 'Khách dừng giữa funnel 24h không response',
    scanQuery: (hotelId: number) => {
      const cutoff = Date.now() - 24 * 3600_000;
      return db.prepare(
        `SELECT bcs.sender_id, cc.phone as customer_phone, cc.sender_name as customer_name, ? as hotel_id,
                bcs.stage, bcs.updated_at
         FROM bot_conversation_state bcs
         LEFT JOIN customer_contacts cc ON cc.sender_id = bcs.sender_id
         WHERE bcs.updated_at < ? AND bcs.updated_at > ?
           AND bcs.stage NOT IN ('INIT', 'BOOKING_DRAFT_CREATED', 'HANDED_OFF', 'UNCLEAR_FALLBACK')
           AND bcs.handed_off = 0
           AND bcs.sender_id IS NOT NULL`
      ).all(hotelId, cutoff, cutoff - 48 * 3600_000) as any[];
    },
    buildMessage: (row: any) => ({
      channel: 'zalo_message',
      template_key: 'funnel_followup',
      content: `Chào ${row.customer_name || 'anh/chị'}! 👋\n\nEm thấy hôm qua anh/chị đang tìm phòng Sonder nhưng chưa quyết định được. Em có thể help thêm gì không ạ?\n\n💡 Đang có:\n  • Mã **SONDER2026** giảm 15% khách mới\n  • Flash sale tháng này còn 5 phòng\n  • Early bird đặt sớm 30 ngày giảm 10%\n\nAnh/chị inbox em, em tư vấn lại nhanh trong 2 phút nhé 🙌`,
      context: { stage: row.stage, inactive_hours: 24 },
    }),
  },

  // 6. VIP winback 30d
  {
    type: 'vip_winback_30d',
    description: 'Khách VIP không đặt 30+ ngày → winback',
    scanQuery: (hotelId: number) => {
      return db.prepare(
        `SELECT cm.sender_id, cm.phone as customer_phone, cm.name as customer_name, ? as hotel_id,
                cm.customer_tier, cm.confirmed_bookings, cm.last_seen_at
         FROM customer_memory cm
         WHERE cm.customer_tier = 'vip'
           AND cm.last_seen_at < ?
           AND cm.sender_id IS NOT NULL`
      ).all(hotelId, Date.now() - 30 * 24 * 3600_000) as any[];
    },
    buildMessage: (row: any) => ({
      channel: 'zalo_message',
      template_key: 'vip_winback',
      content: `💎 ${row.customer_name || 'Anh/chị'} — Sonder nhớ anh/chị!\n\nLâu rồi không gặp — anh/chị đã ở với Sonder ${row.confirmed_bookings || '3+'} lần, bên em muốn gửi 1 surprise đặc biệt:\n\n🎁 **Ưu đãi VIP returning:**\n  • Giảm **10%** tổng hóa đơn\n  • Free welcome drink + late check-out 14h\n  • Priority room upgrade nếu có\n\nSắp có dịp đi lại không ạ? Inbox em để em lock giá tốt nhất cho anh/chị 💚`,
      context: { tier: row.customer_tier, bookings: row.confirmed_bookings },
    }),
  },
];

/* ═══════════════════════════════════════════
   SCAN + QUEUE
   ═══════════════════════════════════════════ */

export interface ScanResult {
  trigger_type: string;
  candidates: number;
  queued: number;
  skipped_duplicate: number;
  skipped_rate_limit: number;
}

export function scanAndQueueOutreach(hotelId: number = 1): ScanResult[] {
  const results: ScanResult[] = [];
  const now = Date.now();

  for (const trigger of OUTREACH_TRIGGERS) {
    const r: ScanResult = {
      trigger_type: trigger.type,
      candidates: 0,
      queued: 0,
      skipped_duplicate: 0,
      skipped_rate_limit: 0,
    };

    try {
      const candidates = trigger.scanQuery(hotelId);
      r.candidates = candidates.length;

      for (const row of candidates) {
        if (!row.sender_id) continue;

        // Dedupe
        if (hasPendingOutreach(row.sender_id, trigger.type, 7 * 24)) {
          r.skipped_duplicate++;
          continue;
        }

        const msg = trigger.buildMessage(row);

        // Schedule time:
        //   - pre_checkin / post_checkout: 10h sáng VN
        //   - birthday / vip_winback: 11h sáng
        //   - abandoned_cart / funnel_stuck: NGAY (delay 5min để batch)
        const vn10h = new Date();
        vn10h.setUTCHours(3, 0, 0, 0);  // 10h VN = 3h UTC
        if (vn10h.getTime() < now) vn10h.setUTCDate(vn10h.getUTCDate() + 1);

        const scheduledAt = ['abandoned_cart', 'funnel_stuck_24h'].includes(trigger.type)
          ? now + 5 * 60_000   // 5 min delay
          : vn10h.getTime();

        try {
          db.prepare(
            `INSERT OR IGNORE INTO scheduled_outreach
             (hotel_id, trigger_type, sender_id, customer_phone, customer_name,
              channel, template_key, message_content, context_json,
              status, scheduled_at, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)`
          ).run(
            hotelId, trigger.type, row.sender_id,
            row.customer_phone || null, row.customer_name || null,
            msg.channel, msg.template_key || null,
            msg.content,
            JSON.stringify(msg.context),
            scheduledAt, now,
          );
          r.queued++;
        } catch (e) {
          // Probably UNIQUE constraint — already queued
          r.skipped_duplicate++;
        }
      }
    } catch (e: any) {
      console.warn(`[proactive] scan ${trigger.type} fail:`, e?.message);
    }

    results.push(r);
  }

  const totalQueued = results.reduce((s, r) => s + r.queued, 0);
  if (totalQueued > 0) {
    console.log(`[proactive] queued ${totalQueued} outreach messages`);
  }
  return results;
}

/* ═══════════════════════════════════════════
   SEND QUEUED
   ═══════════════════════════════════════════ */

export interface SendResult {
  processed: number;
  sent: number;
  skipped: number;
  failed: number;
}

export async function sendQueuedOutreach(opts: { dryRun?: boolean; limit?: number } = {}): Promise<SendResult> {
  const now = Date.now();
  const result: SendResult = { processed: 0, sent: 0, skipped: 0, failed: 0 };
  const limit = opts.limit || 20;

  const due = db.prepare(
    `SELECT * FROM scheduled_outreach
     WHERE status = 'queued' AND scheduled_at <= ?
     ORDER BY scheduled_at ASC LIMIT ?`
  ).all(now, limit) as any[];

  for (const row of due) {
    result.processed++;

    // Rate limit check
    if (dailyRateExceeded(row.sender_id, 2)) {
      db.prepare(`UPDATE scheduled_outreach SET status = 'skipped', error = 'rate_limit' WHERE id = ?`).run(row.id);
      result.skipped++;
      continue;
    }

    if (opts.dryRun) {
      console.log(`[proactive-send] DRY #${row.id} ${row.trigger_type} → ${row.sender_id}`);
      result.sent++;
      continue;
    }

    try {
      let sent = false;
      if (row.channel === 'zalo_message') {
        const { getZaloOAs, zaloSendText } = require('./zalo');
        const oas = getZaloOAs ? getZaloOAs() : [];
        const oa = oas[0];
        if (!oa) throw new Error('no Zalo OA');

        // sender_id format: 'zalo:XXX' → extract user id
        const userId = row.sender_id.startsWith('zalo:') ? row.sender_id.slice(5) : row.sender_id;
        await zaloSendText(oa, userId, row.message_content);
        sent = true;
      } else if (row.channel === 'fb_message') {
        const { sendFBMessage } = require('./facebook');
        const page = db.prepare(`SELECT fb_page_id, access_token FROM pages WHERE hotel_id = ? LIMIT 1`).get(row.hotel_id) as any;
        if (!page) throw new Error('no FB page');
        await sendFBMessage(page.access_token, row.sender_id, row.message_content);
        sent = true;
      } else if (row.channel === 'telegram') {
        const { notifyAll } = require('./telegram');
        await notifyAll(`[outreach-test] ${row.trigger_type}:\n${row.message_content}`);
        sent = true;
      }

      if (sent) {
        db.prepare(`UPDATE scheduled_outreach SET status = 'sent', sent_at = ? WHERE id = ?`).run(Date.now(), row.id);
        incrementDailyRate(row.sender_id);
        result.sent++;
      } else {
        throw new Error(`unsupported channel: ${row.channel}`);
      }
    } catch (e: any) {
      db.prepare(`UPDATE scheduled_outreach SET status = 'failed', error = ? WHERE id = ?`)
        .run(e?.message?.slice(0, 200) || 'unknown', row.id);
      result.failed++;
    }

    // Gentle rate
    await new Promise(r => setTimeout(r, 300));
  }

  if (result.processed > 0) {
    console.log(`[proactive-send] processed=${result.processed} sent=${result.sent} failed=${result.failed} skipped=${result.skipped}`);
  }
  return result;
}

/** When khách reply sau outreach → mark 'replied' + check conversion later. */
export function markOutreachReplied(senderId: string): void {
  try {
    const recent = db.prepare(
      `SELECT id FROM scheduled_outreach
       WHERE sender_id = ? AND status = 'sent'
         AND sent_at > ?
       ORDER BY sent_at DESC LIMIT 1`
    ).get(senderId, Date.now() - 7 * 24 * 3600_000) as any;
    if (recent) {
      db.prepare(`UPDATE scheduled_outreach SET status = 'replied', replied_at = ? WHERE id = ?`)
        .run(Date.now(), recent.id);
    }
  } catch {}
}

/** When booking confirmed after outreach → mark 'converted'. */
export function markOutreachConverted(senderId: string, bookingId: number): void {
  try {
    const recent = db.prepare(
      `SELECT id FROM scheduled_outreach
       WHERE sender_id = ? AND status IN ('sent', 'replied')
         AND sent_at > ?
       ORDER BY sent_at DESC LIMIT 1`
    ).get(senderId, Date.now() - 7 * 24 * 3600_000) as any;
    if (recent) {
      db.prepare(
        `UPDATE scheduled_outreach SET status = 'converted', converted_at = ?, converted_booking_id = ? WHERE id = ?`
      ).run(Date.now(), bookingId, recent.id);
    }
  } catch {}
}

/**
 * Zalo Weekly Broadcast — chọn 1 bài FB performance cao nhất trong tuần,
 * push broadcast tới Zalo OA followers inbox (tối đa 1 lần/tuần).
 *
 * Strategy:
 *   - Timeline article = default, chạy mọi FB post mới (không push, không spam)
 *   - Broadcast inbox = CHỈ 1 bài/tuần, chọn bài có engagement cao nhất
 *
 * Lịch chạy: Thứ 2 10h sáng VN time
 *
 * Lý do:
 *   - Broadcast dùng 1/15 quota Zalo/tháng (4 broadcasts/tháng) → an toàn
 *   - Follower nhận 1 push/tuần thay vì mỗi bài → không spam
 *   - Bài best quality → CTA cao, không bị unsubscribe
 */

import { db } from '../db';

const BROADCAST_COOLDOWN_MS = 6 * 24 * 3600_000;   // 6 ngày (tránh double-fire)
const WEEKLY_MAX_BROADCASTS = 1;

interface CandidatePost {
  id: number;
  fb_post_id: string;
  hotel_id: number;
  caption: string;
  media_filename?: string;
  published_at: number;
  engagement_score: number;                    // Composite metric
}

/**
 * Pick top FB post của tuần dựa trên engagement.
 * Metric: reactions + comments*3 + shares*5 (shares weighted more).
 */
function pickTopPostOfWeek(hotelId: number): CandidatePost | null {
  const weekAgo = Date.now() - 7 * 24 * 3600_000;
  try {
    // Try to use post_metrics table nếu có (FB insights data)
    const rows = db.prepare(
      `SELECT p.id, p.fb_post_id, p.hotel_id, p.caption, p.published_at,
              m.filename as media_filename,
              COALESCE(pm.reactions, 0) as reactions,
              COALESCE(pm.comments, 0) as comments,
              COALESCE(pm.shares, 0) as shares,
              COALESCE(pm.impressions, 0) as impressions
       FROM posts p
       LEFT JOIN media m ON m.id = p.media_id
       LEFT JOIN (
         SELECT post_id,
                MAX(reactions) as reactions,
                MAX(comments) as comments,
                MAX(shares) as shares,
                MAX(impressions) as impressions
         FROM post_metrics GROUP BY post_id
       ) pm ON pm.post_id = p.id
       WHERE p.hotel_id = ?
         AND p.status = 'published'
         AND p.fb_post_id IS NOT NULL
         AND p.published_at > ?
       ORDER BY (COALESCE(pm.reactions, 0) + COALESCE(pm.comments, 0)*3 + COALESCE(pm.shares, 0)*5) DESC,
                p.published_at DESC
       LIMIT 5`
    ).all(hotelId, weekAgo) as any[];

    if (rows.length === 0) return null;

    const top = rows[0];
    const score = (top.reactions || 0) + (top.comments || 0) * 3 + (top.shares || 0) * 5;
    return {
      id: top.id,
      fb_post_id: top.fb_post_id,
      hotel_id: top.hotel_id,
      caption: top.caption,
      media_filename: top.media_filename,
      published_at: top.published_at,
      engagement_score: score,
    };
  } catch (e: any) {
    console.warn('[zalo-weekly] pickTopPost fail:', e?.message);
    return null;
  }
}

/**
 * Check last broadcast time cho hotel — tránh broadcast 2 lần/tuần.
 */
function lastBroadcastTime(hotelId: number): number {
  try {
    const row = db.prepare(
      `SELECT MAX(created_at) as last FROM cross_post_log
       WHERE hotel_id = ? AND platform = 'zalo_oa' AND result = 'success'
         AND error LIKE '%broadcast%'`
    ).get(hotelId) as any;
    return row?.last || 0;
  } catch { return 0; }
}

/**
 * Main weekly broadcast entry — gọi từ scheduler cron.
 */
export async function runWeeklyZaloBroadcast(hotelId: number = 1): Promise<{
  ok: boolean;
  reason?: string;
  post_id?: number;
  broadcast_id?: string;
  recipients?: number;
}> {
  // 1. Check cooldown
  const lastBroadcast = lastBroadcastTime(hotelId);
  const cooldownRemaining = lastBroadcast + BROADCAST_COOLDOWN_MS - Date.now();
  if (cooldownRemaining > 0) {
    return {
      ok: false,
      reason: `cooldown_active (${Math.round(cooldownRemaining / 3600_000)}h remaining)`,
    };
  }

  // 2. Pick top post
  const top = pickTopPostOfWeek(hotelId);
  if (!top) {
    return { ok: false, reason: 'no_post_this_week' };
  }
  console.log(`[zalo-weekly] Top post #${top.id} engagement_score=${top.engagement_score}`);

  // 3. Get Zalo OAs + check quota
  const { listZaloForHotel } = require('./zalo');
  const oas = listZaloForHotel(hotelId).filter((o: any) => o.enabled);
  if (oas.length === 0) {
    return { ok: false, reason: 'no_zalo_oa' };
  }

  // 4. Resolve image URL từ FB CDN
  let imageUrl: string | undefined;
  try {
    const page = db.prepare(`SELECT access_token FROM pages WHERE hotel_id = ? LIMIT 1`).get(hotelId) as any;
    if (page?.access_token) {
      const axios = require('axios').default;
      const r = await axios.get(`https://graph.facebook.com/v18.0/${top.fb_post_id}`, {
        params: { fields: 'full_picture', access_token: page.access_token },
        timeout: 10_000,
      });
      imageUrl = r.data?.full_picture;
    }
  } catch (e: any) {
    console.warn('[zalo-weekly] fetch FB image fail:', e?.response?.data?.error?.message || e?.message);
  }

  // Fallback: media_filename nếu external URL
  if (!imageUrl && top.media_filename && /^https?:\/\//.test(top.media_filename)) {
    imageUrl = top.media_filename;
  }

  if (!imageUrl) {
    return { ok: false, reason: 'no_image_resolved' };
  }

  // 5. Broadcast tới từng OA
  let totalSent = 0;
  let broadcastId = '';
  let errorMsg = '';

  for (const oa of oas) {
    try {
      const { zaloBroadcastRichMessage } = require('./zalo');
      const result = await zaloBroadcastRichMessage(oa, {
        caption: top.caption.slice(0, 1800),
        imageUrl,
      });

      if (result.sent > 0) {
        totalSent += result.sent;
        broadcastId = result.attachment_id || '';

        // Log vào cross_post_log với marker 'broadcast' trong error field
        db.prepare(
          `INSERT OR IGNORE INTO cross_post_log
           (fb_post_id, hotel_id, platform, target_id, result, external_id, error, created_at)
           VALUES (?, ?, 'zalo_oa', ?, 'success', ?, 'weekly_broadcast_inbox', ?)`
        ).run(top.fb_post_id, hotelId, String(oa.oa_id), broadcastId, Date.now());

        console.log(`[zalo-weekly] ✅ OA=${oa.oa_id} broadcast sent to ${result.sent}/${result.recipient_count} recipients`);
      } else {
        errorMsg = result.errors?.[0]?.error || 'zero_sent';
        console.warn(`[zalo-weekly] OA=${oa.oa_id} broadcast failed: ${errorMsg}`);
      }
    } catch (e: any) {
      errorMsg = e?.message || 'unknown';
      console.error(`[zalo-weekly] OA=${oa.oa_id} exception:`, errorMsg);
    }
  }

  if (totalSent === 0) {
    return { ok: false, reason: errorMsg || 'broadcast_failed', post_id: top.id };
  }

  // 6. Notify admin
  try {
    const { notifyAll } = require('./telegram');
    notifyAll(
      `📢 *Zalo Weekly Broadcast sent*\n` +
      `• Post #${top.id} (${top.fb_post_id})\n` +
      `• Engagement score: ${top.engagement_score}\n` +
      `• Recipients: ${totalSent}\n` +
      `• Preview: ${top.caption.slice(0, 120)}...`
    ).catch(() => {});
  } catch {}

  return { ok: true, post_id: top.id, broadcast_id: broadcastId, recipients: totalSent };
}

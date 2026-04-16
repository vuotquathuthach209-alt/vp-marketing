import cron from 'node-cron';
import { db } from '../db';
import { publishText, publishImage, publishVideo, mediaFullPath, autoRefreshPageTokens } from './facebook';
import { runCampaigns } from './campaigns';
import { runAutoReply } from './autoreply';
import { pullMetrics } from './analytics';
import { decidePendingWinners } from './abtest';
import { notifyAll } from './telegram';
import { getSetting } from '../db';
import { runAutopilotCycle, generateMorningReport, generateEveningReport, researchTopics, runAutopilotAllHotels } from './autopilot';
import { runFullSync, runBookingSync } from './ota-sync';
import { cleanupAiCache } from './ai-cache';
import { checkAndAlert } from './email';
import { runBackup } from './backup';

interface PostRow {
  id: number;
  page_id: number;
  caption: string;
  media_id: number | null;
  media_type: string | null;
  scheduled_at: number;
}

interface PageRow {
  id: number;
  fb_page_id: string;
  access_token: string;
}

interface MediaRow {
  filename: string;
}

async function processDuePosts() {
  const now = Date.now();
  const due = db
    .prepare(
      `SELECT id, page_id, caption, media_id, media_type, scheduled_at
       FROM posts
       WHERE status = 'scheduled' AND scheduled_at <= ?
       ORDER BY scheduled_at ASC
       LIMIT 5`
    )
    .all(now) as PostRow[];

  for (const post of due) {
    db.prepare(`UPDATE posts SET status = 'publishing' WHERE id = ?`).run(post.id);

    try {
      const page = db
        .prepare(`SELECT id, fb_page_id, access_token FROM pages WHERE id = ?`)
        .get(post.page_id) as PageRow | undefined;

      if (!page) throw new Error(`Không tìm thấy page id=${post.page_id}`);

      let result;
      if (post.media_type === 'image' && post.media_id) {
        const media = db
          .prepare(`SELECT filename FROM media WHERE id = ?`)
          .get(post.media_id) as MediaRow | undefined;
        if (!media) throw new Error('Không tìm thấy media');
        result = await publishImage(page.fb_page_id, page.access_token, post.caption, mediaFullPath(media.filename));
      } else if (post.media_type === 'video' && post.media_id) {
        const media = db
          .prepare(`SELECT filename FROM media WHERE id = ?`)
          .get(post.media_id) as MediaRow | undefined;
        if (!media) throw new Error('Không tìm thấy media');
        result = await publishVideo(page.fb_page_id, page.access_token, post.caption, mediaFullPath(media.filename));
      } else {
        result = await publishText(page.fb_page_id, page.access_token, post.caption);
      }

      db.prepare(
        `UPDATE posts SET status = 'published', published_at = ?, fb_post_id = ?, error_message = NULL WHERE id = ?`
      ).run(Date.now(), result.fbPostId, post.id);
      console.log(`[scheduler] Đăng thành công post #${post.id} → ${result.fbPostId}`);
      notifyAll(`✅ *Đăng thành công* post #${post.id}\n\`${result.fbPostId}\`\n\n${post.caption.slice(0, 200)}`).catch(() => {});
    } catch (err: any) {
      const msg = err?.response?.data?.error?.message || err?.message || String(err);
      db.prepare(`UPDATE posts SET status = 'failed', error_message = ? WHERE id = ?`).run(msg, post.id);
      console.error(`[scheduler] Post #${post.id} thất bại: ${msg}`);
      notifyAll(`❌ *Post #${post.id} FAIL*\n${msg}`).catch(() => {});
    }
  }
}

export function startScheduler() {
  // Mỗi phút: xử lý bài đăng lên lịch + chạy campaign
  cron.schedule('* * * * *', () => {
    processDuePosts().catch((e) => console.error('[scheduler] posts error:', e));
    runCampaigns().catch((e) => console.error('[scheduler] campaigns error:', e));
  });
  // Mỗi phút: auto reply comment & tin nhắn (near real-time)
  cron.schedule('* * * * *', () => {
    runAutoReply().catch((e) => console.error('[scheduler] auto-reply error:', e));
  });
  // Mỗi 2 giờ: pull FB insights cho các post đã đăng
  cron.schedule('0 */2 * * *', () => {
    pullMetrics()
      .then((r) => console.log(`[scheduler] metrics pulled: ok=${r.ok} fail=${r.fail}`))
      .catch((e) => console.error('[scheduler] metrics error:', e));
  });
  // Mỗi giờ: check A/B experiments nào đã đủ 24h → quyết định winner
  cron.schedule('15 * * * *', () => {
    try {
      const n = decidePendingWinners();
      if (n > 0) console.log(`[scheduler] A/B: decided ${n} winner(s)`);
    } catch (e) {
      console.error('[scheduler] ab decide error:', e);
    }
  });
  // ── Autopilot: morning prep 6:30 AM VN — runs for ALL active hotels ──
  cron.schedule('30 6 * * *', async () => {
    try {
      console.log('[autopilot] Morning run — all hotels');
      await runAutopilotAllHotels();

      // Generate and send morning reports per hotel
      const hotels = db.prepare(
        `SELECT h.id FROM mkt_hotels h WHERE h.status = 'active'
         AND EXISTS (SELECT 1 FROM settings s WHERE s.key = 'autopilot_enabled' AND s.value = '1' AND s.hotel_id = h.id)`
      ).all() as { id: number }[];

      for (const h of hotels) {
        try {
          const report = await generateMorningReport(h.id);
          // Try hotel-specific telegram first
          const { notifyHotelOrGlobal } = await import('./hotel-telegram');
          const page = db.prepare(`SELECT id FROM pages WHERE hotel_id = ? LIMIT 1`).get(h.id) as any;
          if (page) await notifyHotelOrGlobal(page.id, report);
          else await notifyAll(report);
        } catch (e) { console.error(`[autopilot] morning report hotel ${h.id}:`, e); }
      }
    } catch (e) {
      console.error('[autopilot] morning error:', e);
    }
  });

  // ── Autopilot: evening report 9:00 PM VN — all hotels ──
  cron.schedule('0 21 * * *', async () => {
    try {
      const hotels = db.prepare(
        `SELECT h.id FROM mkt_hotels h WHERE h.status = 'active'
         AND EXISTS (SELECT 1 FROM settings s WHERE s.key = 'autopilot_enabled' AND s.value = '1' AND s.hotel_id = h.id)`
      ).all() as { id: number }[];

      for (const h of hotels) {
        try {
          const report = await generateEveningReport(h.id);
          const { notifyHotelOrGlobal } = await import('./hotel-telegram');
          const page = db.prepare(`SELECT id FROM pages WHERE hotel_id = ? LIMIT 1`).get(h.id) as any;
          if (page) await notifyHotelOrGlobal(page.id, report);
          else await notifyAll(report);
        } catch (e) { console.error(`[autopilot] evening report hotel ${h.id}:`, e); }
      }
    } catch (e) {
      console.error('[autopilot] evening error:', e);
    }
  });

  // ── OTA Sync: hotels+rooms mỗi 6h ──
  cron.schedule('0 */6 * * *', () => {
    runFullSync().catch(e => console.error('[scheduler] ota-sync full error:', e));
  });

  // ── OTA Sync: bookings mỗi 1h ──
  cron.schedule('30 * * * *', () => {
    runBookingSync().catch(e => console.error('[scheduler] ota-sync bookings error:', e));
  });

  // Run initial OTA sync on startup (non-blocking)
  setTimeout(() => {
    runFullSync().catch(e => console.error('[scheduler] initial ota-sync error:', e));
  }, 10000);

  // ── FB Token auto-refresh: 2h sáng mỗi ngày ──
  cron.schedule('0 2 * * *', () => {
    autoRefreshPageTokens()
      .then(r => {
        if (r.refreshed > 0 || r.failed > 0) {
          console.log(`[scheduler] fb-token refresh: ${r.refreshed} ok, ${r.failed} failed`);
          if (r.errors.length) console.warn('[scheduler] fb-token errors:', r.errors);
        }
      })
      .catch(e => console.error('[scheduler] fb-token refresh error:', e));
  });

  // ── Alerting: check mỗi giờ ──
  cron.schedule('0 * * * *', () => {
    checkAndAlert().catch(e => console.error('[scheduler] alert check error:', e));
  });

  // ���─ AI Cache cleanup: 3h sáng mỗi ngày ──
  cron.schedule('0 3 * * *', () => {
    const cleaned = cleanupAiCache();
    if (cleaned > 0) console.log(`[scheduler] ai-cache cleanup: removed ${cleaned} expired entries`);
  });

  // ── Database backup: 4h sáng mỗi ngày, giữ 7 bản ──
  cron.schedule('0 4 * * *', () => {
    runBackup();
  });

  console.log('[scheduler] Đã khởi động: posts+campaigns 1p, auto-reply 1p, metrics 2h, ab decide 1h, autopilot 6:30/21:00, ota-sync 6h/1h, ai-cache 3h, backup 4h');
}

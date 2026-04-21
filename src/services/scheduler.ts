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
import { pruneLearned } from './learning';
import { sendWeeklyReport } from './weekly-report';
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
  // Auto reply: poll mỗi 15 giây (near real-time)
  let replyRunning = false;
  setInterval(async () => {
    if (replyRunning) return; // Tránh chạy chồng
    replyRunning = true;
    try {
      await runAutoReply();
    } catch (e) {
      console.error('[scheduler] auto-reply error:', e);
    } finally {
      replyRunning = false;
    }
  }, 15_000);
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

  // ── Learned Q-A cache prune: 5h sáng mỗi ngày, xoá candidate >90 ngày không đạt MIN_HITS ──
  cron.schedule('0 5 * * *', () => {
    try {
      const n = pruneLearned();
      if (n > 0) console.log(`[scheduler] learned-cache prune: removed ${n} stale candidates`);
    } catch (e) {
      console.error('[scheduler] learned prune error:', e);
    }
  });

  // ── v6 Sprint 4: QA promoter — 5:30 sáng, sau prune ──
  cron.schedule('30 5 * * *', async () => {
    try {
      const { runDailyPromotion } = require('./qa-promoter');
      await runDailyPromotion();
    } catch (e: any) {
      console.error('[scheduler] qa-promoter error:', e?.message);
    }
  });

  // ── v6 Sprint 8: Stalled-lead re-engagement — mỗi 30 phút ──
  cron.schedule('*/30 * * * *', async () => {
    try {
      const { runReengagement } = require('./stalled-lead');
      await runReengagement();
    } catch (e: any) {
      console.error('[scheduler] stalled-lead error:', e?.message);
    }
  });

  // ── v6 Sprint 8: Bot health check — 8 sáng hàng ngày ──
  cron.schedule('0 8 * * *', async () => {
    try {
      const { runDailyHealthCheck } = require('./bot-health');
      await runDailyHealthCheck();
    } catch (e: any) {
      console.error('[scheduler] bot-health error:', e?.message);
    }
  });

  // ── v7: Hotel Knowledge ETL — T2/T4/T6 03:00 ──
  cron.schedule('0 3 * * 1,3,5', async () => {
    try {
      const { runEtl } = require('./etl-runner');
      await runEtl({ trigger: 'cron' });
    } catch (e: any) {
      console.error('[scheduler] etl error:', e?.message);
    }
  });

  // ── Billing renewal reminders: 9h sáng mỗi ngày ──
  cron.schedule('0 9 * * *', async () => {
    try {
      const { runBillingReminders } = require('./billing-reminder');
      const r = await runBillingReminders();
      if (r.sent > 0 || r.expired_newly > 0) {
        console.log(`[scheduler] billing reminders: sent=${r.sent} expired=${r.expired_newly}`);
      }
    } catch (e: any) {
      console.error('[scheduler] billing reminder error:', e?.message);
    }
  });

  // ── Monthly learning aggregation: 6h sáng mùng 1 hàng tháng ──
  cron.schedule('0 6 1 * *', () => {
    try {
      const { aggregateMonthlyLearnings } = require('./monthly-learning');
      const result = aggregateMonthlyLearnings();
      console.log(`[scheduler] monthly learning: ${JSON.stringify(result)}`);
    } catch (e: any) {
      console.error('[scheduler] monthly learning error:', e?.message);
    }
  });

  // ── Weekly quality report: Chủ nhật 8h sáng ──
  cron.schedule('0 8 * * 0', () => {
    sendWeeklyReport().catch(e => console.error('[scheduler] weekly report error:', e));
  });

  // ── News Pipeline v9 ───────────────────────────────────────────
  // Ingest RSS mỗi 2 giờ (khung 6h-23h VN time, skip đêm)
  cron.schedule('0 6-23/2 * * *', async () => {
    try {
      const { ingestAll } = require('./news-ingest');
      const r = await ingestAll();
      if (r.new > 0) console.log(`[scheduler] news-ingest: ${r.new} articles mới từ ${r.sources} nguồn`);
    } catch (e: any) {
      console.error('[scheduler] news-ingest error:', e?.message);
    }
  });

  // Cleanup articles quá cũ: 3h sáng mỗi ngày
  cron.schedule('0 3 * * *', () => {
    try {
      const { cleanupOldArticles } = require('./news-ingest');
      const r = cleanupOldArticles();
      if (r.deleted > 0) console.log(`[scheduler] news cleanup: deleted ${r.deleted} old articles`);
    } catch (e: any) {
      console.error('[scheduler] news cleanup error:', e?.message);
    }
  });

  // Classifier batch mỗi 30 phút (process 10 articles/run; phù hợp với 177
  // articles/ngày ÷ 10 × 48 runs ÷ ngày = đủ headroom)
  cron.schedule('*/30 * * * *', async () => {
    try {
      const { classifyBatch } = require('./news-classifier');
      const r = await classifyBatch(10);
      if (r.processed > 0) console.log(`[scheduler] news-classify: ${JSON.stringify(r)}`);
    } catch (e: any) {
      console.error('[scheduler] news-classify error:', e?.message);
    }
  });

  // Angle generator batch mỗi giờ (slow vì Pollinations image gen ~3s/draft)
  cron.schedule('15 */1 * * *', async () => {
    try {
      const { generateDraftsBatch } = require('./news-angle-generator');
      const r = await generateDraftsBatch(5);
      if (r.processed > 0) console.log(`[scheduler] news-angle: ${JSON.stringify(r)}`);
    } catch (e: any) {
      console.error('[scheduler] news-angle error:', e?.message);
    }
  });

  // Publisher scheduler — mỗi 15 phút check drafts approved + due
  // (Admin set scheduled_at theo khung T2/T4/T6 20h VN mặc định qua UI)
  cron.schedule('*/15 * * * *', async () => {
    try {
      const { publishScheduledBatch } = require('./news-publisher');
      const r = await publishScheduledBatch();
      if (r.considered > 0) console.log(`[scheduler] news-publish: ${JSON.stringify(r)}`);
    } catch (e: any) {
      console.error('[scheduler] news-publish error:', e?.message);
    }
  });

  // Zalo OA token refresh — Zalo tokens live ~25h, refresh mỗi 20h cho safe
  cron.schedule('0 */20 * * *', async () => {
    try {
      const { refreshZaloToken } = require('./zalo');
      const rows = db.prepare(`SELECT * FROM zalo_oa WHERE enabled = 1`).all() as any[];
      let refreshed = 0, failed = 0;
      for (const row of rows) {
        // Decrypt tokens từ row (refreshZaloToken expect raw ZaloOA with decrypted tokens)
        const { decrypt } = require('./crypto');
        const oa = {
          ...row,
          access_token: decrypt(row.access_token) || '',
          refresh_token: decrypt(row.refresh_token),
          app_secret: decrypt(row.app_secret),
        };
        const ok = await refreshZaloToken(oa);
        if (ok) refreshed++;
        else failed++;
      }
      if (rows.length > 0) {
        console.log(`[scheduler] zalo-refresh: ${refreshed} OK, ${failed} failed (of ${rows.length})`);
      }
    } catch (e: any) {
      console.error('[scheduler] zalo-refresh error:', e?.message);
    }
  });

  // Zalo OA Article publish — mỗi 2p check scheduled articles → publish
  cron.schedule('*/2 * * * *', async () => {
    try {
      const { zaloCreateArticle, textToZaloBodyBlocks } = require('./zalo');
      const { decrypt } = require('./crypto');
      const now = Date.now();
      const due = db.prepare(
        `SELECT a.*, oa.access_token, oa.refresh_token, oa.app_secret, oa.oa_name, oa.enabled, oa.hotel_id as oa_hotel_id
         FROM zalo_articles a
         LEFT JOIN zalo_oa oa ON a.oa_id = oa.oa_id AND oa.enabled = 1
         WHERE a.status = 'scheduled' AND a.scheduled_at IS NOT NULL AND a.scheduled_at <= ?
         LIMIT 10`
      ).all(now) as any[];
      if (due.length === 0) return;
      let ok = 0, fail = 0;
      for (const art of due) {
        if (!art.access_token) {
          db.prepare(`UPDATE zalo_articles SET status='failed', error='OA disabled/missing', updated_at=? WHERE id=?`)
            .run(now, art.id);
          fail++; continue;
        }
        db.prepare(`UPDATE zalo_articles SET status='publishing', updated_at=? WHERE id=?`).run(now, art.id);
        try {
          const oa = {
            id: art.oa_hotel_id,
            hotel_id: art.hotel_id,
            oa_id: art.oa_id,
            oa_name: art.oa_name,
            access_token: decrypt(art.access_token) || '',
            refresh_token: decrypt(art.refresh_token),
            app_secret: decrypt(art.app_secret),
            token_expires_at: null,
            enabled: 1,
          };
          const blocks = textToZaloBodyBlocks(art.body_html);
          const result = await zaloCreateArticle(oa, {
            title: art.title,
            description: art.description,
            cover: art.cover_url,
            bodyBlocks: blocks,
            status: 'show',
            comment: 'enable',
          });
          db.prepare(
            `UPDATE zalo_articles SET status='published', zalo_article_id=?, zalo_article_url=?,
             published_at=?, error=NULL, updated_at=? WHERE id=?`
          ).run(result.article_id || null, result.url || null, Date.now(), Date.now(), art.id);
          ok++;
        } catch (e: any) {
          db.prepare(`UPDATE zalo_articles SET status='failed', error=?, updated_at=? WHERE id=?`)
            .run(e?.message || 'unknown', Date.now(), art.id);
          fail++;
        }
      }
      if (due.length > 0) console.log(`[scheduler] zalo-articles-publish: ${ok} OK, ${fail} failed`);
    } catch (e: any) {
      console.error('[scheduler] zalo-articles-publish error:', e?.message);
    }
  });

  console.log('[scheduler] Đã khởi động: posts+campaigns 1p, auto-reply 1p, metrics 2h, ab decide 1h, autopilot 6:30/21:00, ota-sync 6h/1h, ai-cache 3h, backup 4h, learned 5h, weekly-report CN 8h, news-ingest 2h, zalo-refresh 20h, zalo-articles 2p');
}

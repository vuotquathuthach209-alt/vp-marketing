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
    // v22 FIX: Atomic claim — UPDATE only if status still 'scheduled'.
    // Prevents race condition when 2 workers/cron run concurrently.
    const claim = db.prepare(
      `UPDATE posts SET status = 'publishing' WHERE id = ? AND status = 'scheduled'`
    ).run(post.id);
    if (claim.changes === 0) {
      console.log(`[scheduler] lost claim on post ${post.id} (another worker got it)`);
      continue;
    }

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
        // publishImage handles both URL (http...) and local path
        const src = /^https?:\/\//i.test(media.filename) ? media.filename : mediaFullPath(media.filename);
        result = await publishImage(page.fb_page_id, page.access_token, post.caption, src);
      } else if (post.media_type === 'video' && post.media_id) {
        const media = db
          .prepare(`SELECT filename FROM media WHERE id = ?`)
          .get(post.media_id) as MediaRow | undefined;
        if (!media) throw new Error('Không tìm thấy media');
        const src = /^https?:\/\//i.test(media.filename) ? media.filename : mediaFullPath(media.filename);
        result = await publishVideo(page.fb_page_id, page.access_token, post.caption, src);
      } else {
        result = await publishText(page.fb_page_id, page.access_token, post.caption);
      }

      db.prepare(
        `UPDATE posts SET status = 'published', published_at = ?, fb_post_id = ?, error_message = NULL WHERE id = ?`
      ).run(Date.now(), result.fbPostId, post.id);

      // v24: Cross-post FB → IG + Zalo OA (non-blocking fire-and-forget)
      try {
        const { crossPostFromPostId } = require('./cross-post-sync');
        crossPostFromPostId(post.id, 'scheduler').catch((e: any) =>
          console.warn('[scheduler] cross-post fail:', e?.message)
        );
      } catch {}
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

  // ── OTA Sync (v13: DISABLED — returning 0 hotels, replaced by Sync Hub) ──
  // Old pull-based sync đang fail vì:
  //   - OTA data validation fail ("missing name_canonical")
  //   - JSON parse errors (undefined values)
  // New approach: OTA team push availability qua /api/sync/availability endpoint.
  // Nếu cần resurrect old sync, uncomment + fix source data trước.
  //
  // cron.schedule('0 */6 * * *', () => { runFullSync()... });
  // cron.schedule('30 * * * *', () => { runBookingSync()... });
  // setTimeout(() => runFullSync(), 10000);

  // ── v24 Sync Outbox worker: mỗi 30 giây push MKT→OTA pending ops ──
  cron.schedule('*/30 * * * * *', async () => {
    try {
      const { processOutbox } = require('./sync-outbox');
      const r = await processOutbox(20);
      if (r.processed > 0) {
        console.log(`[scheduler] outbox: processed=${r.processed} ok=${r.succeeded} fail=${r.failed} dlq=${r.moved_to_dlq}`);
      }
    } catch (e: any) {
      console.error('[scheduler] outbox-worker error:', e?.message);
    }
  });

  // ── v24: Cleanup orphan in_flight (worker crashed giữa chừng) mỗi 5 phút ──
  cron.schedule('*/5 * * * *', () => {
    try {
      const { db } = require('../db');
      // Reset stuck "in_flight" items → pending (will retry)
      const r = db.prepare(
        `UPDATE sync_outbox
         SET status = 'pending', updated_at = ?
         WHERE status = 'in_flight' AND updated_at < ?`
      ).run(Date.now(), Date.now() - 5 * 60_000);
      if (r.changes > 0) console.log(`[scheduler] outbox: reset ${r.changes} stuck in_flight items`);
    } catch (e: any) { console.warn('[scheduler] outbox cleanup fail:', e?.message); }
  });

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

  // ── v24: Zalo weekly broadcast — Thứ 2 10h sáng VN time ──
  //   Chọn 1 bài FB top engagement trong tuần → push broadcast tới OA followers.
  //   Uses ~1 trong 15 quota Zalo/tháng (4 broadcasts/tháng, an toàn).
  //   Timeline article vẫn cross-post mỗi bài FB (không push, không tốn quota).
  cron.schedule('0 10 * * 1', async () => {
    try {
      const { runWeeklyZaloBroadcast } = require('./zalo-weekly-broadcast');
      const hotels = db.prepare(`SELECT DISTINCT hotel_id FROM pages`).all() as any[];
      for (const h of hotels) {
        const result = await runWeeklyZaloBroadcast(h.hotel_id);
        console.log(`[scheduler] zalo-weekly hotel=${h.hotel_id}:`, JSON.stringify(result));
      }
    } catch (e: any) {
      console.error('[scheduler] zalo-weekly error:', e?.message);
    }
  }, { timezone: 'Asia/Ho_Chi_Minh' });

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

  // ── v13 Feedback Loop — Outcome classifier ─────────────────────────
  // Mỗi 15 phút: quét bot_reply_outcomes status='pending' và classify based on user behavior
  cron.schedule('*/15 * * * *', () => {
    try {
      const { classifyPendingOutcomes, aggregateFunnelDaily } = require('./outcome-classifier');
      const r = classifyPendingOutcomes();
      if (r.processed > 0) {
        const updated = Object.entries(r.updated_by_outcome)
          .map(([k, v]) => `${k}=${v}`).join(' ');
        console.log(`[scheduler] outcome-classify: processed=${r.processed} still_pending=${r.still_pending} | ${updated}`);
      }
      // Daily rollup của funnel metrics
      aggregateFunnelDaily();
    } catch (e: any) {
      console.error('[scheduler] outcome-classify error:', e?.message);
    }
  });

  // ── v16 Marketing Audiences — refresh each audience respecting their interval ──
  // Runs hourly: each audience has refresh_interval_min (60 for abandoned_cart, 1440 for daily)
  cron.schedule('10 * * * *', () => {
    try {
      const { refreshAllAudiences } = require('./marketing-audience-engine');
      const results = refreshAllAudiences(false);
      if (results.length > 0) {
        const ok = results.filter((r: any) => !r.error).length;
        console.log(`[scheduler] audience-refresh: ${ok}/${results.length} refreshed`);
      }
    } catch (e: any) {
      console.error('[scheduler] audience-refresh error:', e?.message);
    }
  });

  // ── v16 Broadcast campaigns — send scheduled campaigns due now ──
  cron.schedule('*/5 * * * *', async () => {
    try {
      const { sendDueCampaigns } = require('./broadcast-sender');
      await sendDueCampaigns();
    } catch (e: any) {
      console.error('[scheduler] broadcast-send error:', e?.message);
    }
  });

  // ── v22: FB Post Metrics puller — hourly insights ──
  cron.schedule('5 * * * *', async () => {
    try {
      const { pullFbMetricsBatch } = require('./fb-metrics-puller');
      const r = await pullFbMetricsBatch();
      if (r.processed > 0) {
        console.log(`[scheduler] fb-metrics: processed=${r.processed} updated=${r.updated}`);
      }
    } catch (e: any) {
      console.error('[scheduler] fb-metrics error:', e?.message);
    }
  });

  // ── v22: DLQ scan — hourly detect failed posts, move to DLQ + notify admin ──
  cron.schedule('20 * * * *', () => {
    try {
      const { scanAndMoveFailures } = require('./posts-dlq');
      const r = scanAndMoveFailures();
      if (r.moved > 0) {
        console.log(`[scheduler] dlq-scan: moved ${r.moved} failures to DLQ`);
      }
    } catch (e: any) {
      console.error('[scheduler] dlq-scan error:', e?.message);
    }
  });

  // ── v22: Weekly cleanup — old drafts, AI images, OCR receipts ──
  // Chủ Nhật 3h sáng VN = 20h UTC Saturday
  cron.schedule('0 20 * * 6', () => {
    try {
      const sixMonthsAgo = Date.now() - 180 * 24 * 3600_000;
      const thirtyDaysAgo = Date.now() - 30 * 24 * 3600_000;

      const oldDrafts = db.prepare(
        `DELETE FROM news_post_drafts WHERE created_at < ? AND status IN ('rejected', 'draft', 'failed')`
      ).run(sixMonthsAgo);

      const oldRemix = db.prepare(
        `DELETE FROM remix_drafts WHERE created_at < ? AND status IN ('draft', 'discarded', 'cancelled')`
      ).run(sixMonthsAgo);

      const oldAiImages = db.prepare(
        `DELETE FROM media WHERE source LIKE 'ai-image%' AND created_at < ?`
      ).run(thirtyDaysAgo);

      const oldOcr = db.prepare(
        `DELETE FROM ocr_receipts WHERE created_at < ? AND verification_status IN ('manual_rejected', 'low_ocr_confidence')`
      ).run(sixMonthsAgo);

      console.log(`[scheduler] weekly-cleanup: drafts=${oldDrafts.changes} remix=${oldRemix.changes} ai_images=${oldAiImages.changes} ocr=${oldOcr.changes}`);
    } catch (e: any) {
      console.error('[scheduler] cleanup error:', e?.message);
    }
  });

  // ── v18 Proactive Outreach: daily scan 9h VN + send every 30min ──
  // Scan daily at 2h UTC (9h VN) for opportunities
  cron.schedule('0 2 * * *', () => {
    try {
      const { scanAndQueueOutreach } = require('./proactive-outreach');
      const results = scanAndQueueOutreach(1);
      const totalQueued = results.reduce((s: number, r: any) => s + r.queued, 0);
      if (totalQueued > 0) {
        console.log(`[scheduler] outreach-scan: queued ${totalQueued} messages`);
      }
    } catch (e: any) {
      console.error('[scheduler] outreach-scan error:', e?.message);
    }
  });

  // Send queued outreach every 30 minutes (respect scheduled_at)
  cron.schedule('*/30 * * * *', async () => {
    try {
      const { sendQueuedOutreach } = require('./proactive-outreach');
      const result = await sendQueuedOutreach({ limit: 20 });
      if (result.processed > 0) {
        console.log(`[scheduler] outreach-send: ${JSON.stringify(result)}`);
      }
    } catch (e: any) {
      console.error('[scheduler] outreach-send error:', e?.message);
    }
  });

  // ── v17 Self-improvement: weekly winner selection + report ──
  // Chủ Nhật 9h sáng VN time = 2h UTC Sunday
  cron.schedule('0 2 * * 0', async () => {
    try {
      const { selectAllWinners } = require('./winner-selector');
      const { sendWeeklyPerformanceReport } = require('./weekly-performance-report');
      const { extractLessonsFromLabels } = require('./prompt-lessons');

      // 1. Extract new lessons từ admin labels
      const lessons = extractLessonsFromLabels();
      console.log(`[scheduler] prompt-lessons: ${JSON.stringify(lessons)}`);

      // 2. Auto winner selection cho running experiments
      const winners = selectAllWinners();
      const promoted = winners.filter((w: any) => w.decision === 'promoted').length;
      if (winners.length > 0) {
        console.log(`[scheduler] winner-select: ${promoted}/${winners.length} promoted`);
      }

      // 3. Weekly report Telegram
      await sendWeeklyPerformanceReport(1);
    } catch (e: any) {
      console.error('[scheduler] weekly self-improvement error:', e?.message);
    }
  });

  // v25: DISABLED — ci-auto-weekly (VnExpress remix) thay bằng product-first daily.
  //      Logic cũ: mỗi T2 lấy 1 bài VnExpress → remix → post.
  //      Vấn đề: content đa chủ đề, không drive booking cho specific property.
  //      Thay thế bằng product-auto-post-daily (dưới).
  //
  // cron.schedule('0 2 * * 1', async () => {
  //   const { runWeeklyAutoPostAllHotels } = require('./ci-auto-weekly');
  //   ...
  // });

  // ── v25: PRODUCT-FIRST AUTO POST — DAILY ──────────────────────────
  //   Phase A: 7h sáng VN — generate plan (pick hotel + image + angle + caption)
  //   Phase B: 9h sáng VN — publish lên FB (cross-post tự động sang IG + Zalo)
  //   Dedup: không lặp hotel 14d, không lặp image 90d, rotate 5 angles.
  //   Loại: verified rating < avg-0.5, <3 reviews, <3 images.
  cron.schedule('0 7 * * *', async () => {
    // Guard: pause if disabled (hard-sell ad-copy posts hurt page edge-rank)
    if (require('../db').getSetting('product_auto_post_enabled') === 'false') {
      console.log('[scheduler] product-auto-post generate SKIPPED (product_auto_post_enabled=false)');
      return;
    }
    try {
      const { generateTodayPlan } = require('./product-auto-post/orchestrator');
      const r = await generateTodayPlan();
      console.log('[scheduler] product-auto-post generate:', JSON.stringify({
        ok: r.ok, reason: r.reason, plan_id: r.plan_id,
        hotel: r.hotel?.name, angle: r.angle,
      }));
    } catch (e: any) {
      console.error('[scheduler] product-auto-post generate error:', e?.message);
    }
  }, { timezone: 'Asia/Ho_Chi_Minh' });

  cron.schedule('0 9 * * *', async () => {
    if (require('../db').getSetting('product_auto_post_enabled') === 'false') {
      console.log('[scheduler] product-auto-post publish SKIPPED (product_auto_post_enabled=false)');
      return;
    }
    try {
      const { publishTodayPlan } = require('./product-auto-post/orchestrator');
      const r = await publishTodayPlan();
      console.log('[scheduler] product-auto-post publish:', JSON.stringify({
        ok: r.ok, reason: r.reason, post_id: r.post_id, fb_post_id: r.fb_post_id,
      }));
    } catch (e: any) {
      console.error('[scheduler] product-auto-post publish error:', e?.message);
    }
  }, { timezone: 'Asia/Ho_Chi_Minh' });

  // ── v25: Auto-sync new hotels từ OTA mỗi 6h ──
  //   Khách sạn mới register OTA → tự động vào bot rotation ngày mai.
  cron.schedule('0 */6 * * *', async () => {
    try {
      const { syncNewHotelsFromOta } = require('./product-auto-post/ota-sync-new-hotels');
      const r = await syncNewHotelsFromOta();
      if (r.created > 0 || r.updated > 0) {
        console.log(`[scheduler] ota-new-hotels-sync: created=${r.created} updated=${r.updated}`);
      }
    } catch (e: any) {
      console.error('[scheduler] ota-new-hotels-sync error:', e?.message);
    }
  });

  // ── v26 Phase A: Vectorize hotels daily 6:30h VN (sau OTA sync, trước generate) ──
  cron.schedule('30 6 * * *', async () => {
    try {
      const { vectorizeAllActiveHotels } = require('./product-auto-post/hotel-vectorizer');
      const r = await vectorizeAllActiveHotels();
      console.log('[scheduler] hotel-vectorize:', JSON.stringify(r));
    } catch (e: any) {
      console.error('[scheduler] hotel-vectorize error:', e?.message);
    }
  }, { timezone: 'Asia/Ho_Chi_Minh' });

  // ── v26 Phase B: Engagement feedback loop mỗi 4h ──
  //   Fetch FB metrics → update auto_post_history.engagement_json
  //   Picker dùng data này tính multiplier cho future picks.
  cron.schedule('15 */4 * * *', async () => {
    try {
      const { updateEngagementFeedback } = require('./product-auto-post/engagement-feedback');
      const r = await updateEngagementFeedback();
      if (r.updated > 0) {
        console.log(`[scheduler] engagement-feedback: updated=${r.updated} high=${r.high_perform.length} low=${r.low_perform.length}`);
      }
    } catch (e: any) {
      console.error('[scheduler] engagement-feedback error:', e?.message);
    }
  });

  // Zalo OA token refresh — v22: cron mỗi 6h (thay vì 20h) + notify admin nếu fail
  //                              Trước đó 20h nhưng nếu miss 1 cycle → 40h → token expire (~25h life).
  cron.schedule('0 */6 * * *', async () => {
    try {
      const { refreshZaloToken } = require('./zalo');
      const { getSetting } = require('../db');
      const appId = getSetting('zalo_app_id');
      const appSecret = getSetting('zalo_app_secret');

      if (!appId || !appSecret) {
        console.warn('[scheduler] zalo-refresh SKIP — missing credentials in settings (zalo_app_id + zalo_app_secret). Use POST /api/zalo/set-credentials');
        // Notify admin 1 lần/ngày
        const today = new Date().toISOString().slice(0, 10);
        const notifyKey = `zalo_missing_creds_${today}`;
        if (!getSetting(notifyKey)) {
          try {
            const { notifyAll } = require('./telegram');
            notifyAll(`🚨 *Zalo bot không hoạt động*\nThiếu zalo_app_id + zalo_app_secret trong settings.\n→ Call POST /api/zalo/set-credentials với App ID + App Secret từ Zalo Developer Console.`).catch(() => {});
            const { setSetting } = require('../db');
            setSetting(notifyKey, '1');
          } catch {}
        }
        return;
      }

      const rows = db.prepare(`SELECT * FROM zalo_oa WHERE enabled = 1`).all() as any[];
      let refreshed = 0, failed = 0;
      const failedOAs: any[] = [];
      for (const row of rows) {
        const { decrypt } = require('./crypto');
        const oa = {
          ...row,
          access_token: decrypt(row.access_token) || '',
          refresh_token: decrypt(row.refresh_token),
          app_secret: decrypt(row.app_secret),
        };
        const ok = await refreshZaloToken(oa);
        if (ok) refreshed++;
        else {
          failed++;
          failedOAs.push({ oa_id: row.oa_id, name: row.oa_name });
        }
      }
      if (rows.length > 0) {
        console.log(`[scheduler] zalo-refresh: ${refreshed} OK, ${failed} failed (of ${rows.length})`);

        // Notify admin nếu có fail
        if (failed > 0) {
          try {
            const { notifyAll } = require('./telegram');
            notifyAll(
              `⚠️ *Zalo token refresh fail*\n` +
              `${failed}/${rows.length} OA(s) failed to refresh:\n` +
              failedOAs.map((o: any) => `  • ${o.name || o.oa_id}`).join('\n') +
              `\n→ Có thể refresh_token cũng hết hạn (> 3 tháng). Cần re-authorize qua Zalo OAuth.`
            ).catch(() => {});
          } catch {}
        }
      }
    } catch (e: any) {
      console.error('[scheduler] zalo-refresh error:', e?.message);
    }
  });

  // Knowledge Sync (Tier 2 RAG embeddings) — 3:00 AM daily
  // Chạy sau retention cleanup, populate embeddings cho Tier 2
  cron.schedule('0 3 * * *', async () => {
    try {
      const { rebuildAllEmbeddings } = require('./knowledge-sync');
      const r = await rebuildAllEmbeddings();
      console.log(`[scheduler] knowledge-sync: ${r.hotels_processed} hotels, ${r.total_chunks} chunks (${r.duration_ms}ms)`);
    } catch (e: any) {
      console.error('[scheduler] knowledge-sync error:', e?.message);
    }
  });

  // Retention Cleanup — 2:00 AM mỗi ngày (ít traffic)
  // Xóa data cũ theo policy (NĐ 13/2023/NĐ-CP compliance)
  cron.schedule('0 2 * * *', async () => {
    try {
      const { runRetentionCleanup } = require('./retention-cleanup');
      const r = runRetentionCleanup();
      if (r.total_deleted > 0) {
        console.log(`[scheduler] retention-cleanup: ${r.total_deleted} rows deleted in ${r.duration_ms}ms`);
        r.results.forEach((res: any) => {
          if (res.deleted > 0) console.log(`  • ${res.table}: ${res.deleted} (policy ${res.policy_days}d)`);
        });
      }
    } catch (e: any) {
      console.error('[scheduler] retention-cleanup error:', e?.message);
    }
  });

  // Funnel follow-up: mỗi 30 phút, remind Telegram nếu booking 'new' > 1h
  cron.schedule('*/30 * * * *', async () => {
    try {
      const cutoff = Date.now() - 60 * 60 * 1000;  // 1h ago
      const stuck = db.prepare(
        `SELECT * FROM bot_booking_drafts
         WHERE status = 'new' AND created_at < ?
         ORDER BY created_at ASC LIMIT 10`
      ).all(cutoff) as any[];
      if (stuck.length === 0) return;

      // Group theo hotel_id để gửi 1 message summary cho mỗi hotel
      const byHotel: Record<number, any[]> = {};
      for (const b of stuck) {
        if (!byHotel[b.hotel_id]) byHotel[b.hotel_id] = [];
        byHotel[b.hotel_id].push(b);
      }

      for (const [hotelIdStr, bookings] of Object.entries(byHotel)) {
        const hotelId = parseInt(hotelIdStr, 10);
        const lines = [
          `⏰ *FOLLOW-UP NEEDED* — ${bookings.length} bookings quá 1h chưa gọi`,
          ``,
          ...bookings.map((b: any) => {
            const age = Math.round((Date.now() - b.created_at) / 60000);
            return `• ${b.name || '?'} 📞 ${b.phone || '?'} — ${age} phút trước`;
          }),
          ``,
          `_Check_: app.sondervn.com/funnel`,
        ];
        const message = lines.join('\n');

        try {
          const page = db.prepare(
            `SELECT p.id FROM pages p JOIN mkt_hotels mh ON mh.id = p.hotel_id WHERE mh.ota_hotel_id = ? LIMIT 1`
          ).get(hotelId) as any;
          if (page?.id) {
            const { notifyHotelOrGlobal } = await import('./hotel-telegram');
            await notifyHotelOrGlobal(page.id, message);
          } else {
            const { notifyAll } = await import('./telegram');
            await notifyAll(message);
          }
        } catch {}
      }
      console.log(`[scheduler] funnel follow-up: ${stuck.length} stuck bookings, ${Object.keys(byHotel).length} hotels notified`);
    } catch (e: any) {
      console.error('[scheduler] funnel follow-up error:', e?.message);
    }
  });

  // OTA Raw Pipeline — Qwen AI classifier cron mỗi 5 phút (batch 5 hotels + 5 rooms + 20 avail + 20 images)
  cron.schedule('*/5 * * * *', async () => {
    try {
      const { runQwenClassifierBatch } = require('./qwen-classifier');
      const stats = await runQwenClassifierBatch();
      const total = stats.hotels.ok + stats.rooms.ok + stats.availability.ok + stats.images.ok;
      const failed = stats.hotels.fail + stats.rooms.fail + stats.availability.fail + stats.images.fail;
      if (total > 0 || failed > 0) {
        console.log(`[scheduler] qwen-classifier: ${total} OK, ${failed} failed (${stats.total_ms}ms) — hotels=${stats.hotels.ok}/${stats.hotels.fail} rooms=${stats.rooms.ok}/${stats.rooms.fail} avail=${stats.availability.ok}/${stats.availability.fail} images=${stats.images.ok}/${stats.images.fail}`);
      }
    } catch (e: any) {
      console.error('[scheduler] qwen-classifier error:', e?.message);
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

  // ── v27B: Template suggestion analyzer — mỗi Chủ nhật 2h sáng ──
  //         Gemini phân tích stuck/handoff conversations → đề xuất template mới
  cron.schedule('0 2 * * 0', async () => {
    try {
      const { runTemplateSuggestionAnalysis } = require('./agentic/template-suggester');
      const r = await runTemplateSuggestionAnalysis();
      console.log(`[scheduler] template-suggestions: evidence=${JSON.stringify(r.evidence_stats)} proposed=${r.suggestions?.length || 0} saved=${r.suggestions_created || 0}`);
    } catch (e: any) {
      console.error('[scheduler] template-suggestions error:', e?.message);
    }
  });

  // ── v27 Phase 6: Auto-promote A/B winner — hàng ngày 3h sáng ──
  //        Log winner analysis today + check 7-day streak + auto-promote nếu đủ điều kiện
  //        Chỉ active khi setting `auto_promote_variants = 'true'`
  cron.schedule('0 3 * * *', async () => {
    try {
      const { runDailyAutoPromote } = require('./agentic/template-variants');
      const r = await runDailyAutoPromote();
      console.log(`[scheduler] auto-promote: checked=${r.checked} logged=${r.logged} eligible=${r.eligible.length} promoted=${r.eligible.filter((e: any) => e.promoted).length} enabled=${r.enabled}`);
    } catch (e: any) {
      console.error('[scheduler] auto-promote error:', e?.message);
    }
  });

  
  // ═══ Story Video — 1 video/3 ngày từ story episode ═══
  cron.schedule('*/30 18-21 * * *', () => {
    import('./story-to-video').then(m => m.runDueStoryVideos())
      .then(r => { if (r.found > 0) console.log('[scheduler] story-video:', JSON.stringify(r)); })
      .catch((e: any) => console.error('[scheduler] story-video err:', e?.message));
  }, { timezone: 'Asia/Ho_Chi_Minh' });

  // ═══ Story Engine — series 8 tập T5+T7 mỗi tháng ═══
  cron.schedule('*/5 18-21 * * 4,6', () => {
    import('./story-engine').then(m => m.runDueStoryEpisodes())
      .then(r => { if (r.found > 0) console.log('[scheduler] story-publish:', JSON.stringify(r)); })
      .catch((e: any) => console.error('[scheduler] story-publish err:', e?.message));
  }, { timezone: 'Asia/Ho_Chi_Minh' });

  // ═══ V2.1 Daily Tips — DEPRECATED (off-philosophy lecture style) ═══
  // Replaced bằng Sonder Stories Anthology (1 tập/ngày 19:00 VN, multi-arc storytelling).
  // Re-enable bằng setting `vs_tips_cron_enabled = 'true'`.
  if ((require('../db').getSetting('vs_tips_cron_enabled') || 'false') === 'true') {
    cron.schedule('0 19 * * 1,3,5', () => {
      import('./video-studio/tips-orchestrator').then(m => m.runDailyTipsAuto({ skipPublish: false }))
        .then(r => {
          console.log(`[scheduler] daily-tips: ok=${r.ok} category=${r.category} topic="${(r.topic || '').substring(0, 60)}" steps=[${r.steps_completed.join(',')}]`);
          if (!r.ok) console.warn(`[scheduler] daily-tips error: ${r.error}`);
        })
        .catch((e: any) => console.error('[scheduler] daily-tips err:', e?.message));
    }, { timezone: 'Asia/Ho_Chi_Minh' });
    console.log('[scheduler] V2.1 Tips cron ENABLED (vs_tips_cron_enabled=true)');
  }

  // ═══ V2.1 Tips ideas replenishment — Sunday 8h sáng VN (kept — harmless) ═══
  cron.schedule('0 8 * * 0', () => {
    import('./video-studio/tips-engine').then(m => m.replenishIdeasIfLow())
      .then(r => {
        if (r.generated > 0) console.log(`[scheduler] tips-replenish: generated=${r.generated} categories=[${r.categories.join(',')}]`);
      })
      .catch((e: any) => console.error('[scheduler] tips-replenish err:', e?.message));
  }, { timezone: 'Asia/Ho_Chi_Minh' });

  // ═══ V2.2 Weekend Special — DEPRECATED (replaced bởi anthology T7 crossover slot) ═══
  // Re-enable bằng setting `vs_weekend_cron_enabled = 'true'`.
  if ((require('../db').getSetting('vs_weekend_cron_enabled') || 'false') === 'true') {
    cron.schedule('0 19 * * 0', () => {
      import('./video-studio/weekend-orchestrator').then(m => m.runWeekendAuto({ skipPublish: false }))
        .then(r => {
          const tag = r.skipped ? `skipped:${r.skipped}` : (r.ok ? 'ok' : 'fail');
          console.log(`[scheduler] weekend-auto: ${tag} theme=${r.theme_type} subject="${r.theme_subject}" steps=[${r.steps_completed.join(',')}]`);
          if (!r.ok && !r.skipped) console.warn(`[scheduler] weekend-auto error: ${r.error}`);
        })
        .catch((e: any) => console.error('[scheduler] weekend-auto err:', e?.message));
    }, { timezone: 'Asia/Ho_Chi_Minh' });
    console.log('[scheduler] V2.2 Weekend cron ENABLED (vs_weekend_cron_enabled=true)');
  }

  // ═══ V3 Sonder Stories Anthology — 2-stage cron ═══
  // Stage A: 17:00 VN — generate pipeline (script→visuals→voice→compose) → status='approved'
  // Stage B: 19:00 VN — publish to FB Reels + YouTube Shorts → status='published'
  //
  // 2-hour buffer between A và B đảm bảo video render xong trước peak publish time.
  // Disable: setting `vs_anthology_cron_enabled = 'false'`.
  // Reference skill: sonder-storytelling
  if ((require('../db').getSetting('vs_anthology_cron_enabled') || 'true') !== 'false') {
    // STAGE A — Generate (17:00 VN)
    cron.schedule('0 17 * * *', async () => {
      try {
        const { runFullAnthologyPipeline } = await import('./anthology/anthology-orchestrator');
        const r = await runFullAnthologyPipeline({ generatedBy: 'cron-17h-generate', autoApprove: true });
        if (r.ok) {
          console.log(`[scheduler] anthology-generate ✅ ep#${r.episode_id} no=${r.episode_no} | "${r.script?.title}" | ${r.duration_sec?.toFixed(1)}s → APPROVED for 19h publish`);
        } else {
          console.warn(`[scheduler] anthology-generate ❌ step=${r.step_failed || '?'} ep#${r.episode_id || '?'}: ${r.error}`);
        }
      } catch (e: any) {
        console.error('[scheduler] anthology-generate err:', e?.message);
      }
    }, { timezone: 'Asia/Ho_Chi_Minh' });

    // STAGE B — Publish (19:00 VN, peak engagement)
    cron.schedule('0 19 * * *', async () => {
      try {
        const { publishNextScheduledEpisode } = await import('./anthology/anthology-publisher');
        const r = await publishNextScheduledEpisode();
        if (r.skipped) {
          console.log(`[scheduler] anthology-publish ⏭ skipped: ${r.skipped}`);
        } else if (r.ok && r.result) {
          console.log(`[scheduler] anthology-publish ✅ ep#${r.result.episode_id} | FB=${r.result.fb.ok ? r.result.fb.post_id : '✗ ' + r.result.fb.error} | YT=${r.result.yt.ok ? r.result.yt.url : '✗ ' + r.result.yt.error}`);
        } else {
          console.warn(`[scheduler] anthology-publish ❌ ${r.error || 'unknown'}`);
        }
      } catch (e: any) {
        console.error('[scheduler] anthology-publish err:', e?.message);
      }
    }, { timezone: 'Asia/Ho_Chi_Minh' });

    console.log('[scheduler] V3 Anthology 2-stage cron ENABLED (generate 17h → publish 19h VN)');
  } else {
    console.log('[scheduler] V3 Anthology cron DISABLED (vs_anthology_cron_enabled=false)');
  }

  // ═══ V4 Sonder Cinema — 1 tập/tuần T7 long-form 5-7 phút ═══
  // Stage A: T7 12:00 VN — generate (15-25 shots × 4-15s mỗi shot, ~30-45 phút)
  // Stage B: T7 20:30 VN — publish YT long-form + FB Reels 60s teaser
  // 8 tiếng buffer (12h gen → 20h30 publish) đảm bảo Cinema render xong (lâu hơn Anthology nhiều)
  // Default ENABLED. Disable: setting `cinema_cron_enabled = 'false'`.
  // Reference skill: sonder-cinema
  if ((require('../db').getSetting('cinema_cron_enabled') || 'true') !== 'false') {
    // STAGE A — T7 12:00 VN generate
    // Reads cinema_target_duration_sec setting (default 60 = PILOT MODE)
    cron.schedule('0 12 * * 6', async () => {
      try {
        const { runFullCinemaPipeline } = await import('./cinema/cinema-orchestrator');
        const { getSetting: gs } = require('../db');
        const targetDur = parseInt(gs('cinema_target_duration_sec') || '60', 10);
        const modeLabel = targetDur <= 90 ? `PILOT ${targetDur}s` : targetDur <= 220 ? `MID ${targetDur}s` : `FULL ${targetDur}s`;

        const charRotation = ['linh', 'tuan', 'vy', 'khanh', 'ha', 'tai'];
        const weekOfYear = Math.floor((Date.now() - new Date(new Date().getFullYear(), 0, 0).getTime()) / (7 * 24 * 3600 * 1000));
        const character = charRotation[weekOfYear % charRotation.length];

        // Premise scaled by duration mode
        const ideaShort = `Cinema ${modeLabel}: ${character}. 1 moment đáng nhớ ở Sonder. POV "mình" intimate. Brand value 1 thấm qua hành động. Closing line poetic.`;
        const ideaLong = `Cinema ${modeLabel}: ${character}. Long-form deep-dive về moment ở Sonder. Callback Anthology facts nếu phù hợp. Multi-act với arc rõ ràng.`;

        const r = await runFullCinemaPipeline({
          primary_character: character,
          episode_idea: targetDur <= 90 ? ideaShort : ideaLong,
          target_duration_sec: targetDur,
          generatedBy: `cron-T7-12h-generate-${modeLabel}`,
          autoApprove: true,
        });

        if (r.ok) {
          console.log(`[scheduler] cinema-generate ✅ ${modeLabel} ep#${r.episode_id} no=${r.episode_no} | "${r.script?.title}" | ${r.duration_sec?.toFixed(1)}s | cost=$${((r.cost_cents || 0) / 100).toFixed(2)} → APPROVED for 20h30 publish`);
        } else if (r.budget_exceeded) {
          console.warn(`[scheduler] cinema-generate 💰 BUDGET EXCEEDED ep#${r.episode_id || '?'}: ${r.error}`);
        } else {
          console.warn(`[scheduler] cinema-generate ❌ step=${r.step_failed} ep#${r.episode_id || '?'}: ${r.error}`);
        }
      } catch (e: any) {
        console.error('[scheduler] cinema-generate err:', e?.message);
      }
    }, { timezone: 'Asia/Ho_Chi_Minh' });

    // STAGE B — T7 20:30 VN publish
    cron.schedule('30 20 * * 6', async () => {
      try {
        const { publishNextScheduledCinemaEpisode } = await import('./cinema/cinema-publisher');
        const r = await publishNextScheduledCinemaEpisode();
        if (r.skipped) {
          console.log(`[scheduler] cinema-publish ⏭ skipped: ${r.skipped}`);
        } else if (r.ok && r.result) {
          console.log(`[scheduler] cinema-publish ✅ ep#${r.result.episode_id} | YT=${r.result.yt.ok ? r.result.yt.url : '✗ ' + r.result.yt.error} | FB=${r.result.fb.ok ? r.result.fb.post_id : '✗ ' + r.result.fb.error}`);
        } else {
          console.warn(`[scheduler] cinema-publish ❌ ${r.error}`);
        }
      } catch (e: any) {
        console.error('[scheduler] cinema-publish err:', e?.message);
      }
    }, { timezone: 'Asia/Ho_Chi_Minh' });

    console.log('[scheduler] V4 Cinema 2-stage cron ENABLED (T7 12h generate → T7 20h30 publish VN, 1 tập/tuần long-form)');
  } else {
    console.log('[scheduler] V4 Cinema cron DISABLED (cinema_cron_enabled=false)');
  }

  // ═══ V5 Content Pipeline (Hybrid 60% real + AI assist) ═══
  // Reference: skill sonder-content-v5
  // 2-stage: 17h gen+render, 19h publish
  // Default DISABLED — enable via setting v5_cron_enabled='true' after Gate 1 review.
  if ((require('../db').getSetting('v5_cron_enabled') || 'false') === 'true') {
    // Stage A: Generate + Render daily 17h VN (Mon-Fri only)
    cron.schedule('0 17 * * 1-5', async () => {
      try {
        const { runV5GeneratePhase } = require('./v5/orchestrator');
        const r = await runV5GeneratePhase({ generated_by: 'cron-17h' });
        if (r.ok) {
          console.log(`[scheduler] v5-generate ✅ script #${r.script_id} | ${r.rendered_count} variants | $${(r.total_cost_usd || 0).toFixed(3)}`);
        } else {
          console.warn(`[scheduler] v5-generate ❌ ${r.step_failed}: ${r.error}`);
        }
      } catch (e: any) {
        console.error('[scheduler] v5-generate err:', e?.message);
      }
    }, { timezone: 'Asia/Ho_Chi_Minh' });

    // Stage B: Publish daily 19h VN (Mon-Fri)
    cron.schedule('0 19 * * 1-5', async () => {
      try {
        const { runV5PublishPhase } = require('./v5/orchestrator');
        const r = await runV5PublishPhase();
        if (r.ok) {
          console.log(`[scheduler] v5-publish ✅ script #${r.script_id} | ${r.published_post_ids?.length || 0} posts`);
        } else {
          console.log(`[scheduler] v5-publish ⏭ ${r.step_failed || 'skip'}`);
        }
      } catch (e: any) {
        console.error('[scheduler] v5-publish err:', e?.message);
      }
    }, { timezone: 'Asia/Ho_Chi_Minh' });

    console.log('[scheduler] V5 Content cron ENABLED (gen 17h → publish 19h VN, T2-T6, hybrid 60% real + AI)');
  } else {
    console.log('[scheduler] V5 Content cron DISABLED (v5_cron_enabled=false)');
  }

  // ═══ Email Automation (Phase 3 — Listmonk + Resend + BullMQ) ═══
  // Reference: skill sonder-tech-sovereignty
  // Default ENABLED. Disable: setting `email_automation_enabled = 'false'`.
  if ((require('../db').getSetting('email_automation_enabled') || 'true') !== 'false') {
    // Start BullMQ worker (consume jobs from queue)
    try {
      const { startEmailWorker } = require('./email-automation');
      startEmailWorker();
    } catch (e: any) {
      console.warn('[scheduler] email worker start fail:', e?.message);
    }

    // Cron: every 15 min — scan OTA bookings + schedule emails
    cron.schedule('*/15 * * * *', async () => {
      try {
        const { runEmailAutomationCron } = require('./email-automation/cron');
        await runEmailAutomationCron();
      } catch (e: any) {
        console.error('[scheduler] email-cron err:', e?.message);
      }
    });
    console.log('[scheduler] Email automation ENABLED (welcome + review + loyalty, every 15 min)');
  } else {
    console.log('[scheduler] Email automation DISABLED (email_automation_enabled=false)');
  }

  // Monthly concept proposal — 28 mỗi tháng 9h sáng VN
  cron.schedule('0 9 28 * *', async () => {
    try {
      const m = await import('./story-engine');
      const now = new Date(Date.now() + 7*3600*1000);
      let nm = now.getUTCMonth() + 2;
      let ny = now.getUTCFullYear();
      if (nm > 12) { nm -= 12; ny++; }
      const slug = ny + '-' + String(nm).padStart(2, '0');
      console.log('[scheduler] story-rotate: building', slug);
      const r = await m.buildAndScheduleMonth(slug);
      console.log('[scheduler] story-rotate result:', JSON.stringify(r).slice(0, 200));
    } catch (e: any) {
      console.error('[scheduler] story-rotate err:', e?.message);
    }
  }, { timezone: 'Asia/Ho_Chi_Minh' });

  console.log('[scheduler] Đã khởi động: posts+campaigns 1p, auto-reply 1p, metrics 2h, ab decide 1h, autopilot 6:30/21:00, ota-sync 6h/1h, ai-cache 3h, backup 4h, learned 5h, weekly-report CN 8h, news-ingest 2h, zalo-refresh 20h, zalo-articles 2p, template-suggest CN 2h, auto-promote daily 3h, anthology daily 17h→19h VN, cinema T7 12h→20h30 VN');
}

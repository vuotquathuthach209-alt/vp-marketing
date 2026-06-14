import cron from 'node-cron';
import { db } from '../db';
import { publishText, publishImage, publishVideo, mediaFullPath, autoRefreshPageTokens } from './facebook';
import { runCampaigns } from './campaigns';
import { pullMetrics } from './analytics';
import { decidePendingWinners } from './abtest';
import { notifyAll } from './telegram';
import { getSetting } from '../db';
import { cleanupAiCache } from './ai-cache';
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
        // 🛡️ Pass source info so firewall logs to audit trail
        const src = /^https?:\/\//i.test(media.filename) ? media.filename : mediaFullPath(media.filename);
        result = await publishImage(page.fb_page_id, page.access_token, post.caption, src, {
          source: 'scheduler',
          source_id: post.id,
        });
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

      // Cross-post (IG + Zalo) REMOVED 2026-05-11 — modules deleted in pivot.
      // FB → IG cross-posting can be re-built later if needed via official Graph API.
      console.log(`[scheduler] Đăng thành công post #${post.id} → ${result.fbPostId}`);
      notifyAll(`✅ *Đăng thành công* post #${post.id}\n\`${result.fbPostId}\`\n\n${post.caption.slice(0, 200)}`).catch(() => {});
    } catch (err: any) {
      const isFirewall = err?.name === 'FirewallBlockedError';
      const msg = err?.response?.data?.error?.message || err?.message || String(err);
      const newStatus = isFirewall ? 'blocked_firewall' : 'failed';
      db.prepare(`UPDATE posts SET status = ?, error_message = ? WHERE id = ?`).run(newStatus, msg, post.id);

      if (isFirewall) {
        console.warn(`[scheduler] 🛡️ Post #${post.id} BLOCKED by firewall: ${msg}`);
        notifyAll(`🛡️ *Post #${post.id} BLOCKED*\nFirewall đã chặn — kiểm tra /admin/copyright/dashboard\n\nReason: ${msg.slice(0, 200)}`).catch(() => {});
      } else {
        console.error(`[scheduler] Post #${post.id} thất bại: ${msg}`);
        notifyAll(`❌ *Post #${post.id} FAIL*\n${msg}`).catch(() => {});
      }
    }
  }
}

export function startScheduler() {
  // Mỗi phút: xử lý bài đăng lên lịch + chạy campaign
  cron.schedule('* * * * *', () => {
    processDuePosts().catch((e) => console.error('[scheduler] posts error:', e));
    runCampaigns().catch((e) => console.error('[scheduler] campaigns error:', e));
  });
  // Auto-reply REMOVED (2026-05-11 pivot): FB Messenger AI handles chat now.
  //
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

  // Learned-cache, stalled-lead, bot-health, outcome-classifier crons REMOVED in pivot 2026-05-11.
  // (All depended on chat pipeline that's now Meta AI's responsibility.)

  // ── Weekly quality report: Chủ nhật 8h sáng ──
  cron.schedule('0 8 * * 0', () => {
    sendWeeklyReport().catch(e => console.error('[scheduler] weekly report error:', e));
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

  // Weekly cleanup REMOVED 2026-05-11: targeted tables (news_post_drafts, remix_drafts) no longer
  // populated since news pipeline was removed. AI images now only via V5T (rare). OCR receipts table
  // dropped in earlier cleanup. Retention-cleanup cron at 2am handles the rest.

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

  // ── OTA-sync-new-hotels + hotel-vectorize + engagement-feedback + Zalo-refresh ──
  // ALL REMOVED in 2026-05-11 pivot.
  // - product-auto-post supporting crons no longer needed (product-auto-post disabled due to takedown)
  // - Zalo module deleted in earlier cleanup
  // V5T pipeline now handles content (uses Drive divider photos, not OTA partner images).

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

  // Funnel follow-up, template-suggester, auto-promote crons REMOVED in pivot 2026-05-11.
  // (All depended on chat bot pipeline / agentic templates.)


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

  // ═══ V5T Text/Image Post Pipeline ═══
  // Reference: skill sonder-content-v5t
  // T3/T5 carousel + single, CN poll/question.
  // Default DISABLED — enable: setting v5t_cron_enabled='true'
  if ((require('../db').getSetting('v5t_cron_enabled') || 'false') === 'true') {
    // V5T REFACTORED: 4 posts/tuần đều đặn (T2/T4/T6 TIPS, CN STORY)
    // T2 10:00 — TIPS post (Sài Gòn Insider guide)
    cron.schedule('0 10 * * 1', async () => {
      try {
        const { runV5TGeneratePhase } = require('./v5t/orchestrator');
        const r = await runV5TGeneratePhase({ type: 'tips_post', generated_by: 'cron-T2-tips' });
        console.log(`[scheduler] v5t-T2-tips: ${r.ok ? '✅' : '❌'} post=${r.post_id}`);
      } catch (e: any) { console.error('[scheduler] v5t-T2 err:', e?.message); }
    }, { timezone: 'Asia/Ho_Chi_Minh' });

    // T4 10:00 — STORY post (Sonder BTS moment)
    cron.schedule('0 10 * * 3', async () => {
      try {
        const { runV5TGeneratePhase } = require('./v5t/orchestrator');
        const r = await runV5TGeneratePhase({ type: 'story_post', generated_by: 'cron-T4-story' });
        console.log(`[scheduler] v5t-T4-story: ${r.ok ? '✅' : '❌'} post=${r.post_id}`);
      } catch (e: any) { console.error('[scheduler] v5t-T4 err:', e?.message); }
    }, { timezone: 'Asia/Ho_Chi_Minh' });

    // T6 10:00 — TIPS post (Sài Gòn Insider, 2nd of week)
    cron.schedule('0 10 * * 5', async () => {
      try {
        const { runV5TGeneratePhase } = require('./v5t/orchestrator');
        const r = await runV5TGeneratePhase({ type: 'tips_post', generated_by: 'cron-T6-tips' });
        console.log(`[scheduler] v5t-T6-tips: ${r.ok ? '✅' : '❌'} post=${r.post_id}`);
      } catch (e: any) { console.error('[scheduler] v5t-T6 err:', e?.message); }
    }, { timezone: 'Asia/Ho_Chi_Minh' });

    // CN 10:00 — STORY post
    cron.schedule('0 10 * * 0', async () => {
      try {
        const { runV5TGeneratePhase } = require('./v5t/orchestrator');
        const r = await runV5TGeneratePhase({ type: 'story_post', generated_by: 'cron-CN-story' });
        console.log(`[scheduler] v5t-CN-story: ${r.ok ? '✅' : '❌'} post=${r.post_id}`);
      } catch (e: any) { console.error('[scheduler] v5t-CN err:', e?.message); }
    }, { timezone: 'Asia/Ho_Chi_Minh' });

    // Publish next approved — chạy 3 mốc 11h/14h/17h (catch-up resilient).
    // runV5TPublishPhase IDEMPOTENT-PER-DAY → chỉ post 1 bài/ngày dù chạy 3 lần.
    // Nếu app restart/down đúng 11h → 14h hoặc 17h vẫn catch up được.
    const v5tPublishSlots = ['0 11 * * *', '0 14 * * *', '0 17 * * *'];
    for (const slot of v5tPublishSlots) {
      cron.schedule(slot, async () => {
        try {
          const { runV5TPublishPhase } = require('./v5t/orchestrator');
          const r = await runV5TPublishPhase();
          if (r.ok) console.log(`[scheduler] v5t-publish (${slot}): ✅ post=${r.post_id} fb=${r.fb_post_id}`);
        } catch (e: any) { console.error('[scheduler] v5t-publish err:', e?.message); }
      }, { timezone: 'Asia/Ho_Chi_Minh' });
    }

    // Startup catch-up — 90s sau khi app khởi động, check bài tồn đọng (nếu hôm nay
    // chưa post + có approved). Đảm bảo restart KHÔNG làm miss bài cả ngày.
    setTimeout(async () => {
      try {
        const nowVNh = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Ho_Chi_Minh' })).getHours();
        if (nowVNh >= 11 && nowVNh < 22) {  // chỉ catch-up trong khung 11h-22h, tránh post đêm
          const { runV5TPublishPhase } = require('./v5t/orchestrator');
          const r = await runV5TPublishPhase();
          if (r.ok) console.log(`[scheduler] v5t-publish (startup catch-up): ✅ post=${r.post_id} fb=${r.fb_post_id}`);
        }
      } catch (e: any) { console.error('[scheduler] v5t startup catch-up err:', e?.message); }
    }, 90_000);

    // Google Drive sync — every 15 min, pull new photos from anh's "divider" folder
    cron.schedule('*/15 * * * *', async () => {
      try {
        const { syncGoogleDriveFolder } = require('./v5t/gdrive-sync');
        const r = await syncGoogleDriveFolder();
        if (r.new_files > 0) {
          console.log(`[scheduler] gdrive-sync: ${r.new_files} new files, downloaded=${r.downloaded}, vision-analyzed=${r.analyzed}`);
        }
      } catch (e: any) { console.error('[scheduler] gdrive-sync err:', e?.message); }
    });

    // SEO → FB cross-post — 19h tối (giờ vàng FB, tách khỏi V5T publish trưa).
    // Đăng bài SEO property/partner đã publish lên FB. IDEMPOTENT-PER-DAY (tối đa
    // 1 bài/ngày). Chỉ chạy khi có bài SEO published chưa cross-post → tự throttle.
    // Setting: seo_fb_crosspost_enabled (default on). Reference: chuyên gia MKT.
    cron.schedule('0 19 * * *', async () => {
      if (require('../db').getSetting('seo_fb_crosspost_enabled') === 'false') return;
      try {
        const { crossPostNextSeoArticle } = require('./seo/fb-crosspost');
        const r = await crossPostNextSeoArticle();
        if (r.ok) console.log(`[scheduler] seo-fb-crosspost: ✅ article #${r.article_id} → fb=${r.fb_post_id}`);
        else if (r.skipped_reason && r.skipped_reason !== 'no eligible article' && r.skipped_reason !== 'already cross-posted today') {
          console.log(`[scheduler] seo-fb-crosspost skip: ${r.skipped_reason}`);
        }
      } catch (e: any) { console.error('[scheduler] seo-fb-crosspost err:', e?.message); }
    }, { timezone: 'Asia/Ho_Chi_Minh' });

    console.log('[scheduler] V5T Text/Image cron ENABLED (T2/T4/T6/CN 10h gen — TIPS+STORY, publish 11h/14h/17h catch-up, gdrive sync 15min, SEO→FB crosspost 19h)');
  } else {
    console.log('[scheduler] V5T Text/Image cron DISABLED (v5t_cron_enabled=false)');
  }

  // Email automation module removed in cleanup phase 3 (was never used).
  // Admin alert emails still work via services/email.ts (sendAlertToAdmin).

  // ═══ Customer Care — auto-sync reviews + comments + SLA alert ═══
  //   Setting care_cron_enabled (default true). Sondervn FB Page reviews + post comments.

  if (require('../db').getSetting('care_cron_enabled') !== 'false') {
    // Reviews sync — every 2 hours (FB recommendations don't change fast)
    cron.schedule('0 */2 * * *', async () => {
      try {
        const { syncReviews } = require('./care/reviews');
        const r = await syncReviews({ since_days: 30 });
        if (r.new > 0) {
          console.log(`[scheduler] care-reviews: ${r.new} new, ${r.notified_admin} alerted (cost classify=$${(r.classified * 0.0001).toFixed(4)})`);
        }
      } catch (e: any) { console.error('[scheduler] care-reviews err:', e?.message); }
    });

    // Comments inbox sync — every 30 min (faster, comments are time-sensitive)
    cron.schedule('*/30 * * * *', async () => {
      try {
        const { syncInbox } = require('./care/inbox');
        const r = await syncInbox({ since_days: 7 });
        if (r.new > 0) {
          console.log(`[scheduler] care-inbox: ${r.new} new, questions=${r.questions}, needs_response=${r.needs_response}`);
        }
      } catch (e: any) { console.error('[scheduler] care-inbox err:', e?.message); }
    });

    // SLA check — every 2 hours, alert if overdue items exist
    cron.schedule('30 */2 * * *', async () => {
      try {
        const { runSlaCheck } = require('./care/sla-tracker');
        const r = await runSlaCheck();
        if (r.overdue > 0) {
          console.log(`[scheduler] care-sla: ${r.overdue} overdue, alerted=${r.alerted}`);
        }
      } catch (e: any) { console.error('[scheduler] care-sla err:', e?.message); }
    });

    console.log('[scheduler] Customer Care cron ENABLED (reviews 2h + inbox 30p + SLA 2h)');
  }

  // ═══ SEO Daily Crawl + Audit + Keyword Rank ═══
  // 3:30 AM VN — after backup at 4 AM (different cron block, runs before backup completes)
  // Reference: skill sonder-tech-sovereignty
  cron.schedule('30 3 * * *', async () => {
    if (require('../db').getSetting('seo_daily_cron_enabled') === 'false') {
      return;
    }
    try {
      const { runDailySeoCron } = require('./seo/daily-cron');
      const r = await runDailySeoCron();
      console.log(`[scheduler] seo-daily: crawled=${r.crawled} new_issues=${r.issues_added} cost=$${r.cost_usd.toFixed(4)} | snap=${JSON.stringify({
        pages: r.snapshot.total_pages,
        critical: r.snapshot.critical_count,
        warnings: r.snapshot.warning_count,
        schema_pct: r.snapshot.schema_coverage_pct,
        alt_pct: r.snapshot.alt_coverage_pct,
      })}`);
    } catch (e: any) {
      console.error('[scheduler] seo-daily error:', e?.message);
    }
  }, { timezone: 'Asia/Ho_Chi_Minh' });

  console.log('[scheduler] SEO daily cron ENABLED (3:30 AM VN — crawl + audit + keyword ranks)');

  // SEO Content Calendar — MỖI NGÀY 9 AM VN — sonder-seo-content skill
  // T2 homestay, T3 hotel, T4 apartment, T5 destination, T6 insider, T7+CN partner B2B
  cron.schedule('0 9 * * *', async () => {
    if (require('../db').getSetting('seo_article_cron_enabled') === 'false') {
      return;
    }
    try {
      const { runDailyContentCalendar } = require('./seo/article-cron');
      const r = await runDailyContentCalendar();
      console.log(`[scheduler] seo-content-calendar: weekday=${r.weekday} pillar=${r.pillar} generated=${r.generated} #${r.article_id || '-'} imgs=${r.images_attached || 0} (${(r.duration_ms / 1000).toFixed(0)}s)`);
    } catch (e: any) {
      console.error('[scheduler] seo-content-calendar error:', e?.message);
    }
  }, { timezone: 'Asia/Ho_Chi_Minh' });

  console.log('[scheduler] SEO content calendar ENABLED (mỗi ngày 9h VN — T2 homestay/T3 hotel/T4 apt/T5 destination/T6 insider/T7+CN đối tác)');
  console.log('[scheduler] Đã khởi động: posts+campaigns 1p, fb-metrics 2h, ab decide 1h, ai-cache 3h, backup 4h, weekly-report CN 8h, retention 2h, knowledge-sync 3h, V5T text/image (T2/T4/T6/CN 10h gen + 11h publish + gdrive-sync 15p), SEO daily 3:30h, SEO article CN 9h, Customer Care (reviews 2h + inbox 30p + SLA 2h)');
}

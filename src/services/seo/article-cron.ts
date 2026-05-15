/**
 * SEO Article Weekly Cron — tự sinh N bài long-tail mỗi Chủ nhật 9h sáng VN.
 *
 * Strategy:
 *  1. Pick N keywords priority=high (long_tail tier), không trùng với bài đã sinh trong 30 ngày
 *  2. Sinh bài qua generateArticle() (Claude Sonnet 4.6)
 *  3. Save status='draft' vào seo_articles
 *  4. Telegram alert admin với link dashboard để review
 *
 * Settings (DB):
 *  - seo_article_cron_enabled — default 'true' (set 'false' để tắt)
 *  - seo_article_cron_count   — default '3' (số bài/tuần)
 *  - seo_article_cron_angle   — default null (random nếu null)
 *
 * Idempotent: nếu pool keyword cạn (hết bài chưa viết), cron skip.
 */

import { db, getSetting } from '../../db';
import { generateArticle, saveArticle, ArticleAngle } from './article-writer';

const RECENT_WINDOW_DAYS = 30;

interface CronResult {
  attempted: number;
  generated: number;
  failed: number;
  skipped_reason?: string;
  article_ids: number[];
  cost_estimate_usd: number;
  duration_ms: number;
}

/** Pick keywords chưa được sinh bài (hoặc đã hơn 30 ngày), ưu tiên high priority + chưa rank top 10. */
function pickCandidateKeywords(limit: number): Array<{ keyword: string; category: string | null }> {
  const cutoff = Date.now() - RECENT_WINDOW_DAYS * 86400_000;

  // Strategy: long_tail keywords NULL rank or rank > 10, chưa được dùng làm keyword_target trong 30 ngày
  const rows = db.prepare(
    `SELECT k.keyword, k.category
     FROM seo_keywords k
     WHERE k.category IN ('long_tail', 'medium_tail')
       AND (k.current_rank IS NULL OR k.current_rank > 10)
       AND NOT EXISTS (
         SELECT 1 FROM seo_articles a
         WHERE LOWER(a.keyword_target) = k.keyword
           AND a.created_at > ?
       )
     ORDER BY
       CASE k.category WHEN 'long_tail' THEN 0 ELSE 1 END,
       (k.current_rank IS NULL) DESC,  -- prioritize not-ranked
       k.current_rank DESC                -- then worst rank first
     LIMIT ?`,
  ).all(cutoff, limit) as Array<{ keyword: string; category: string | null }>;

  return rows;
}

/** Pick random angle based on category. */
function pickAngle(category: string | null): ArticleAngle {
  if (category === 'long_tail') {
    // Random mix of local_insider + destination_guide + how_to
    const pool: ArticleAngle[] = ['local_insider', 'destination_guide', 'how_to', 'list_post'];
    return pool[Math.floor(Math.random() * pool.length)];
  }
  // medium_tail: prefer destination_guide
  return 'destination_guide';
}

/** Pick stronger override if admin set seo_article_cron_angle setting. */
function resolveAngle(category: string | null): ArticleAngle {
  const override = getSetting('seo_article_cron_angle');
  if (override) return override as ArticleAngle;
  return pickAngle(category);
}

/** Send Telegram alert (optional, swallow errors). */
async function notifyAdmin(result: CronResult, sample?: { title: string; keyword: string; id: number }): Promise<void> {
  try {
    const enabled = getSetting('telegram_admin_alerts_enabled') !== 'false';
    if (!enabled) return;
    const token = getSetting('telegram_bot_token') || process.env.TELEGRAM_BOT_TOKEN;
    const chatId = getSetting('telegram_admin_chat_id') || process.env.TELEGRAM_ADMIN_CHAT_ID;
    if (!token || !chatId) return;

    let msg = '📝 *SEO Article Cron — Weekly*\n\n';
    if (result.generated === 0) {
      msg += '⚠️ Không sinh được bài nào tuần này.\n';
      if (result.skipped_reason) msg += `Lý do: ${result.skipped_reason}\n`;
    } else {
      msg += `✅ Sinh ${result.generated}/${result.attempted} bài draft\n`;
      msg += `💰 Cost: ~$${result.cost_estimate_usd.toFixed(3)}\n`;
      msg += `⏱ Time: ${(result.duration_ms / 1000).toFixed(0)}s\n\n`;
      if (sample) {
        msg += `Bài mới: *${sample.title.slice(0, 80)}*\nKeyword: \`${sample.keyword}\`\n\n`;
      }
      msg += `👉 Review tại /admin/seo/dashboard → tab 📝 Articles\n`;
      msg += `Article IDs: ${result.article_ids.join(', ')}`;
    }

    const axios = require('axios');
    await axios.post(
      `https://api.telegram.org/bot${token}/sendMessage`,
      { chat_id: chatId, text: msg, parse_mode: 'Markdown', disable_web_page_preview: true },
      { timeout: 8000 },
    );
  } catch (e: any) {
    console.warn('[seo-article-cron] telegram notify fail:', e?.message);
  }
}

/** Main entry — gọi từ scheduler.ts mỗi Chủ nhật 9h sáng VN. */
export async function runWeeklyArticleGeneration(): Promise<CronResult> {
  const t0 = Date.now();
  const count = parseInt(getSetting('seo_article_cron_count') || '3', 10);
  const result: CronResult = {
    attempted: 0,
    generated: 0,
    failed: 0,
    article_ids: [],
    cost_estimate_usd: 0,
    duration_ms: 0,
  };

  const candidates = pickCandidateKeywords(count);
  if (candidates.length === 0) {
    result.skipped_reason = 'No eligible keywords (all already have recent articles or pool empty)';
    result.duration_ms = Date.now() - t0;
    console.log(`[seo-article-cron] skip: ${result.skipped_reason}`);
    await notifyAdmin(result);
    return result;
  }

  console.log(`[seo-article-cron] Generating ${candidates.length} articles for: ${candidates.map(c => c.keyword).join(', ')}`);

  let firstArticle: { title: string; keyword: string; id: number } | undefined;
  for (const c of candidates) {
    result.attempted++;
    const angle = resolveAngle(c.category);
    try {
      const draft = await generateArticle({
        keyword_target: c.keyword,
        angle,
        language: 'vi',
        target_word_count: 1500,
      });
      if (!draft) {
        result.failed++;
        console.warn(`[seo-article-cron] generation returned null for "${c.keyword}"`);
        continue;
      }
      const id = saveArticle(draft, { angle, category: c.category || undefined });
      result.generated++;
      result.article_ids.push(id);
      result.cost_estimate_usd += 0.02; // rough estimate
      if (!firstArticle) firstArticle = { title: draft.title, keyword: c.keyword, id };
      console.log(`[seo-article-cron] ✅ #${id} "${draft.title.slice(0, 60)}" (${draft.word_count}w)`);
    } catch (e: any) {
      result.failed++;
      console.warn(`[seo-article-cron] generation error for "${c.keyword}":`, e?.message);
    }
  }

  result.duration_ms = Date.now() - t0;
  console.log(`[seo-article-cron] Done: ${result.generated}/${result.attempted} ok, ${result.failed} fail, ${(result.duration_ms / 1000).toFixed(0)}s, ~$${result.cost_estimate_usd.toFixed(3)}`);

  await notifyAdmin(result, firstArticle);
  return result;
}

/** Manual trigger via admin button (testing). */
export async function triggerWeeklyArticleGenerationNow(): Promise<CronResult> {
  return runWeeklyArticleGeneration();
}

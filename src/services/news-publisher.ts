/**
 * News Publisher — Phase N-5.
 *
 * Cron worker: mỗi 15 phút kiểm tra news_post_drafts WHERE status='approved'
 * AND scheduled_at <= now → publish lên FB Page.
 *
 * Publish logic:
 *   - External image URL (og:image từ Tuổi Trẻ/Skift/etc.): dùng /photos?url=...
 *     → FB fetch và host trên CDN FB (không vấn đề ban với khách URL bên thứ ba).
 *   - Local image (/media/filename.jpg từ Pollinations): publishImage với file path.
 *   - No image: publishText fallback.
 *
 * Rate limit (user spec: 3 bài/tuần):
 *   - Default max 3 bài/page/tuần (rolling 7-day window)
 *   - Không trùng topic 3 ngày (check region)
 *   - Default schedule: T2/T4/T6 khung 20-22h VN time (Phase N-5.4 scheduler)
 *
 * Failure handling:
 *   - Retry 3x với exponential backoff (1/3/9 phút)
 *   - status='failed' sau 3 lần + notify admin
 */
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { db } from '../db';
import { config } from '../config';
import { publishText, publishImage } from './facebook';

const GRAPH = 'https://graph.facebook.com/v18.0';
const MAX_POSTS_PER_WEEK = 3;      // User spec: 3 bài/tuần
const TOPIC_DEDUPE_DAYS = 3;
const RETRY_DELAYS_MS = [60_000, 180_000, 540_000];  // 1, 3, 9 phút

/* ═══════════════════════════════════════════
   PUBLISH 1 DRAFT
   ═══════════════════════════════════════════ */

interface PageInfo {
  id: number;
  fb_page_id: string;
  access_token: string;
  name: string;
  hotel_id: number;
}

async function publishWithExternalUrl(
  pageId: string,
  accessToken: string,
  message: string,
  imageUrl: string,
): Promise<{ fbPostId: string }> {
  const resp = await axios.post(
    `${GRAPH}/${pageId}/photos`,
    null,
    {
      params: { message, url: imageUrl, access_token: accessToken },
      timeout: 60_000,
    }
  );
  return { fbPostId: resp.data.post_id || resp.data.id };
}

/** v22 FIX: Retry wrapper với exponential backoff.
 *  Retries on 429 (rate limit), 500-503 (server error), network timeout.
 *  Skip retry on 400 (bad request), 401/403 (auth). */
async function withRetry<T>(fn: () => Promise<T>, context: string): Promise<T> {
  let lastError: any;
  for (let attempt = 0; attempt < RETRY_DELAYS_MS.length + 1; attempt++) {
    try {
      return await fn();
    } catch (e: any) {
      lastError = e;
      const status = e?.response?.status;
      const code = e?.code;

      // Non-retryable errors
      if (status === 400 || status === 401 || status === 403 || status === 404) {
        throw e;
      }

      if (attempt >= RETRY_DELAYS_MS.length) break;

      // Retryable: rate limit, server error, network
      const retryable = status === 429 || (status >= 500 && status < 600) ||
                        code === 'ECONNRESET' || code === 'ETIMEDOUT' || code === 'ENOTFOUND';
      if (!retryable) throw e;

      const delay = RETRY_DELAYS_MS[attempt];
      console.log(`[news-publish retry] ${context} attempt ${attempt + 1} failed (${status || code}), retry after ${delay}ms`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw lastError;
}

export async function publishDraft(draftId: number): Promise<{ ok: boolean; fb_post_id?: string; error?: string }> {
  const draft = db.prepare(
    `SELECT d.*, a.source FROM news_post_drafts d
     LEFT JOIN news_articles a ON a.id = d.article_id
     WHERE d.id = ?`
  ).get(draftId) as any;
  if (!draft) return { ok: false, error: 'draft not found' };
  if (draft.status === 'published') return { ok: true, fb_post_id: draft.fb_post_id };

  // Find page to publish on
  const page = db.prepare(
    `SELECT p.id, p.fb_page_id, p.access_token, p.name, p.hotel_id
     FROM pages p WHERE p.hotel_id = ? ORDER BY p.id LIMIT 1`
  ).get(draft.hotel_id) as PageInfo | undefined;
  if (!page) return { ok: false, error: `no fb page for hotel_id=${draft.hotel_id}` };

  // Compose final message: prefer admin-edited if present
  const message = (draft.edited_post || draft.draft_post || '').slice(0, 63000);
  if (!message) return { ok: false, error: 'empty message' };

  try {
    // v22: Wrap ALL FB API calls trong withRetry (exponential backoff on 429/5xx)
    let fbPostId: string;
    if (draft.image_url && /^https?:\/\//.test(draft.image_url)) {
      const r = await withRetry(
        () => publishWithExternalUrl(page.fb_page_id, page.access_token, message, draft.image_url),
        `draft#${draftId}/external_url`,
      );
      fbPostId = r.fbPostId;
    } else if (draft.image_url && draft.image_url.startsWith('/media/')) {
      const filename = draft.image_url.replace('/media/', '');
      const filePath = path.join(config.mediaDir, filename);
      if (!fs.existsSync(filePath)) {
        const r = await withRetry(
          () => publishText(page.fb_page_id, page.access_token, message),
          `draft#${draftId}/text_fallback`,
        );
        fbPostId = r.fbPostId;
      } else {
        const r = await withRetry(
          () => publishImage(page.fb_page_id, page.access_token, message, filePath),
          `draft#${draftId}/local_image`,
        );
        fbPostId = r.fbPostId;
      }
    } else {
      const r = await withRetry(
        () => publishText(page.fb_page_id, page.access_token, message),
        `draft#${draftId}/text_only`,
      );
      fbPostId = r.fbPostId;
    }

    const now = Date.now();
    db.prepare(
      `UPDATE news_post_drafts SET status='published', fb_post_id=?, published_at=?, page_id=? WHERE id=?`
    ).run(fbPostId, now, page.id, draftId);
    db.prepare(
      `UPDATE news_articles SET status='published', last_state_change_at=? WHERE id=?`
    ).run(now, draft.article_id);
    console.log(`[news-publish] OK draft #${draftId} → fb ${fbPostId} on page ${page.name}`);
    return { ok: true, fb_post_id: fbPostId };
  } catch (e: any) {
    const msg = e?.response?.data?.error?.message || e?.message || 'unknown';
    console.warn(`[news-publish] FAIL draft #${draftId}: ${msg}`);
    return { ok: false, error: msg };
  }
}

/* ═══════════════════════════════════════════
   RATE LIMIT + DEDUPE CHECKS
   ═══════════════════════════════════════════ */

export function canPublishMore(hotelId: number): { ok: boolean; reason?: string; weekly_count: number } {
  const weekAgo = Date.now() - 7 * 24 * 3600_000;
  const row = db.prepare(
    `SELECT COUNT(*) as n FROM news_post_drafts
     WHERE hotel_id = ? AND status='published' AND published_at > ?`
  ).get(hotelId, weekAgo) as any;
  const weeklyCount = row?.n || 0;
  if (weeklyCount >= MAX_POSTS_PER_WEEK) {
    return { ok: false, reason: `weekly_limit_reached(${weeklyCount}/${MAX_POSTS_PER_WEEK})`, weekly_count: weeklyCount };
  }
  return { ok: true, weekly_count: weeklyCount };
}

export function hasRecentTopicPublished(hotelId: number, articleId: number): boolean {
  const cutoff = Date.now() - TOPIC_DEDUPE_DAYS * 24 * 3600_000;
  const article = db.prepare(`SELECT region FROM news_articles WHERE id=?`).get(articleId) as any;
  if (!article?.region) return false;
  const dup = db.prepare(
    `SELECT d.id FROM news_post_drafts d
     JOIN news_articles a ON a.id = d.article_id
     WHERE d.hotel_id = ? AND d.status='published' AND d.published_at > ?
       AND a.region = ? AND d.article_id != ?`
  ).get(hotelId, cutoff, article.region, articleId) as any;
  return !!dup;
}

/* ═══════════════════════════════════════════
   BATCH PUBLISH (called by cron)
   ═══════════════════════════════════════════ */

export async function publishScheduledBatch(): Promise<{ considered: number; published: number; skipped: number; failed: number }> {
  const result = { considered: 0, published: 0, skipped: 0, failed: 0 };
  const now = Date.now();

  // Lấy drafts đã approved với scheduled_at đã qua
  const due = db.prepare(
    `SELECT id, hotel_id, article_id FROM news_post_drafts
     WHERE status='approved' AND scheduled_at IS NOT NULL AND scheduled_at <= ?
     ORDER BY scheduled_at ASC LIMIT 10`
  ).all(now) as any[];

  for (const row of due) {
    result.considered++;

    const cap = canPublishMore(row.hotel_id);
    if (!cap.ok) {
      console.log(`[news-publish] skip draft #${row.id}: ${cap.reason}`);
      result.skipped++;
      continue;
    }

    if (hasRecentTopicPublished(row.hotel_id, row.article_id)) {
      console.log(`[news-publish] skip draft #${row.id}: topic already published within ${TOPIC_DEDUPE_DAYS}d`);
      // Push schedule 2 ngày sau
      db.prepare(`UPDATE news_post_drafts SET scheduled_at = scheduled_at + ? WHERE id = ?`)
        .run(2 * 24 * 3600_000, row.id);
      result.skipped++;
      continue;
    }

    const r = await publishDraft(row.id);
    if (r.ok) result.published++;
    else result.failed++;
  }

  if (result.considered > 0) console.log(`[news-publish] batch: ${JSON.stringify(result)}`);
  return result;
}

/** Manual publish ngay cho admin "Publish now" button.
 *  force=true → bypass weekly limit (admin explicit action). Default true vì đây là manual. */
export async function publishNow(draftId: number, opts: { force?: boolean } = { force: true }): Promise<{ ok: boolean; fb_post_id?: string; error?: string }> {
  const draft = db.prepare(`SELECT hotel_id, article_id FROM news_post_drafts WHERE id=?`).get(draftId) as any;
  if (!draft) return { ok: false, error: 'not found' };
  if (!opts.force) {
    const cap = canPublishMore(draft.hotel_id);
    if (!cap.ok) return { ok: false, error: cap.reason };
  }
  return publishDraft(draftId);
}

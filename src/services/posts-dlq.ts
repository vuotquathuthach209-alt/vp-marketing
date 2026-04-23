/**
 * Posts Dead Letter Queue — v22.
 *
 * Khi 1 post/draft fail quá 3 lần → move sang DLQ + notify admin.
 * Admin có thể review → resolve → retry manual hoặc dismiss.
 *
 * Cron scan:
 *   - posts status='failed' với retry_count (implicit qua error_message frequency)
 *   - news_post_drafts status='failed'
 *   - remix_drafts stuck ở 'draft' với admin_notes có 'publish_fail'
 */

import { db } from '../db';
import { redactSecrets } from './text-utils';

/** Move a failed post/draft to DLQ + notify Telegram. */
export function moveToDlq(input: {
  source_type: 'post' | 'news_draft' | 'remix_draft' | 'ig_publish' | 'crosspost';
  source_id: number;
  hotel_id?: number;
  page_id?: number;
  caption?: string;
  image_url?: string;
  last_error: string;
  first_failed_at: number;
  retry_count?: number;
}): number {
  const now = Date.now();

  // Dedup: kiểm tra đã có trong DLQ chưa
  const existing = db.prepare(
    `SELECT id FROM failed_posts_dlq WHERE source_type = ? AND source_id = ? AND resolved = 0`
  ).get(input.source_type, input.source_id) as any;
  if (existing) {
    // Update last_error + retry_count
    db.prepare(
      `UPDATE failed_posts_dlq
       SET last_error = ?, last_failed_at = ?, retry_count = retry_count + 1
       WHERE id = ?`
    ).run(redactSecrets(input.last_error).slice(0, 500), now, existing.id);
    return existing.id;
  }

  const r = db.prepare(
    `INSERT INTO failed_posts_dlq
     (source_type, source_id, hotel_id, page_id, caption, image_url,
      last_error, retry_count, first_failed_at, last_failed_at, moved_to_dlq_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    input.source_type, input.source_id,
    input.hotel_id || null, input.page_id || null,
    (input.caption || '').slice(0, 500),
    input.image_url || null,
    redactSecrets(input.last_error).slice(0, 500),
    input.retry_count || 3,
    input.first_failed_at, now, now,
  );

  const dlqId = Number(r.lastInsertRowid);
  console.log(`[dlq] moved #${dlqId} (${input.source_type}/${input.source_id}): ${redactSecrets(input.last_error).slice(0, 80)}`);

  // Notify admin via Telegram (async)
  try {
    const { notifyAll } = require('./telegram');
    notifyAll(
      `🚨 *Post failed — moved to DLQ*\n` +
      `• Source: ${input.source_type} #${input.source_id}\n` +
      `• Retries: ${input.retry_count || 3}\n` +
      `• Error: ${redactSecrets(input.last_error).slice(0, 150)}\n` +
      (input.caption ? `• Caption: ${input.caption.slice(0, 80)}...\n` : '') +
      `\nAdmin review: /api/dlq/${dlqId}`
    ).then(() => {
      db.prepare(`UPDATE failed_posts_dlq SET admin_notified = 1, admin_notified_at = ? WHERE id = ?`).run(Date.now(), dlqId);
    }).catch((e: any) => console.warn('[dlq] notify fail:', e?.message));
  } catch {}

  return dlqId;
}

/** Scan failed sources across tables và move to DLQ. Cron hourly. */
export function scanAndMoveFailures(): { scanned: number; moved: number } {
  let scanned = 0, moved = 0;

  // 1. posts status='failed' — treat as 3 retries already (no retry_count col)
  const failedPosts = db.prepare(
    `SELECT p.id, p.page_id, p.hotel_id, p.caption, p.error_message, p.updated_at, p.created_at
     FROM posts p
     WHERE p.status = 'failed'
       AND p.updated_at < ?
       AND NOT EXISTS (
         SELECT 1 FROM failed_posts_dlq d WHERE d.source_type = 'post' AND d.source_id = p.id
       )`
  ).all(Date.now() - 10 * 60_000) as any[];   // At least 10 min old

  for (const p of failedPosts) {
    scanned++;
    moveToDlq({
      source_type: 'post',
      source_id: p.id,
      hotel_id: p.hotel_id,
      page_id: p.page_id,
      caption: p.caption,
      last_error: p.error_message || 'unknown',
      first_failed_at: p.created_at,
      retry_count: 3,
    });
    moved++;
  }

  // 2. news_post_drafts status='failed'
  const failedNews = db.prepare(
    `SELECT nd.id, nd.hotel_id, nd.page_id, nd.draft_post as caption, nd.image_url,
            nd.rejection_reason as error, nd.created_at, nd.last_state_change_at
     FROM news_post_drafts nd
     WHERE nd.status = 'failed'
       AND nd.last_state_change_at < ?
       AND NOT EXISTS (
         SELECT 1 FROM failed_posts_dlq d WHERE d.source_type = 'news_draft' AND d.source_id = nd.id
       )`
  ).all(Date.now() - 10 * 60_000) as any[];

  for (const nd of failedNews) {
    scanned++;
    moveToDlq({
      source_type: 'news_draft',
      source_id: nd.id,
      hotel_id: nd.hotel_id,
      page_id: nd.page_id,
      caption: nd.caption,
      image_url: nd.image_url,
      last_error: nd.error || 'unknown',
      first_failed_at: nd.created_at,
    });
    moved++;
  }

  // 3. remix_drafts stuck ở 'draft' với admin_notes có 'publish_fail'
  const failedRemix = db.prepare(
    `SELECT rd.id, rd.hotel_id, rd.remix_text as caption, rd.admin_notes, rd.created_at, rd.updated_at
     FROM remix_drafts rd
     WHERE rd.status = 'draft'
       AND rd.admin_notes LIKE '%publish_fail%'
       AND rd.updated_at < ?
       AND NOT EXISTS (
         SELECT 1 FROM failed_posts_dlq d WHERE d.source_type = 'remix_draft' AND d.source_id = rd.id
       )`
  ).all(Date.now() - 10 * 60_000) as any[];

  for (const rd of failedRemix) {
    scanned++;
    moveToDlq({
      source_type: 'remix_draft',
      source_id: rd.id,
      hotel_id: rd.hotel_id,
      caption: rd.caption,
      last_error: rd.admin_notes || 'publish_fail',
      first_failed_at: rd.created_at,
    });
    moved++;
  }

  if (moved > 0) console.log(`[dlq-scan] scanned=${scanned} moved=${moved}`);
  return { scanned, moved };
}

export function getDlqItems(limit: number = 50): any[] {
  return db.prepare(
    `SELECT * FROM failed_posts_dlq WHERE resolved = 0 ORDER BY moved_to_dlq_at DESC LIMIT ?`
  ).all(limit) as any[];
}

export function resolveDlqItem(id: number, note: string): boolean {
  const r = db.prepare(
    `UPDATE failed_posts_dlq SET resolved = 1, resolved_at = ?, resolution_note = ? WHERE id = ?`
  ).run(Date.now(), note, id);
  return r.changes > 0;
}

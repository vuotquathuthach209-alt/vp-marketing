/**
 * Publish Log — bảng tổng hợp MỌI bài đăng across mọi kênh.
 *
 * Mọi pipeline publish (V5T FB, blog web, product-auto-post, news draft, ...)
 * gọi helper ở đây để ghi 1 dòng vào publish_log. Nhờ đó admin xem được
 * "bài nào, nguồn nào, lên kênh nào, thành công/thất bại, mấy giờ" ở 1 chỗ.
 *
 * Flow chuẩn:
 *   const logId = logPublishAttempt({ source_type:'v5t', source_id:42,
 *                   channel:'facebook', title:'...', channel_target:pageId });
 *   try { ...publish...; markPublishSuccess(logId, fbPostId, url); }
 *   catch (e) { markPublishFailed(logId, e.message); }
 *
 * Hoặc 1 phát (đã biết kết quả):
 *   recordPublish({ source_type, source_id, channel, status:'success', ... });
 */

import { db, getSetting } from '../db';

export type PublishChannel = 'facebook' | 'instagram' | 'zalo' | 'web_blog' | 'telegram' | 'tiktok';
export type PublishSourceType = 'v5t' | 'seo_article' | 'product_auto_post' | 'news_draft' | 'manual' | 'cross_post' | 'other';
export type PublishStatus = 'success' | 'failed' | 'blocked' | 'pending';

export interface PublishLogInput {
  source_type: PublishSourceType;
  source_id?: string | number | null;
  channel: PublishChannel;
  channel_target?: string | null;
  title?: string | null;
  status?: PublishStatus;
  external_id?: string | null;
  external_url?: string | null;
  error_message?: string | null;
  hotel_id?: number | null;
  attempted_at?: number;
  completed_at?: number | null;
  duration_ms?: number | null;
  meta?: Record<string, any> | null;
}

/** Ghi 1 lần thử đăng — trả về log id. Mặc định status='pending'. */
export function logPublishAttempt(input: PublishLogInput): number {
  const now = Date.now();
  const r = db.prepare(
    `INSERT INTO publish_log
     (source_type, source_id, channel, channel_target, title, status,
      external_id, external_url, error_message, hotel_id,
      attempted_at, completed_at, duration_ms, meta_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.source_type,
    input.source_id != null ? String(input.source_id) : null,
    input.channel,
    input.channel_target || null,
    (input.title || '').slice(0, 300),
    input.status || 'pending',
    input.external_id || null,
    input.external_url || null,
    input.error_message || null,
    input.hotel_id || null,
    input.attempted_at || now,
    input.completed_at || null,
    input.duration_ms || null,
    input.meta ? JSON.stringify(input.meta) : null,
    now,
  );
  return r.lastInsertRowid as number;
}

/** Đánh dấu thành công + external id/url. */
export function markPublishSuccess(logId: number, externalId?: string | null, externalUrl?: string | null): void {
  const now = Date.now();
  const row = db.prepare(`SELECT attempted_at FROM publish_log WHERE id = ?`).get(logId) as any;
  const dur = row ? now - row.attempted_at : null;
  db.prepare(
    `UPDATE publish_log SET status='success', external_id=?, external_url=?, completed_at=?, duration_ms=? WHERE id=?`,
  ).run(externalId || null, externalUrl || null, now, dur, logId);
}

/** Đánh dấu thất bại + lý do. Gửi Telegram alert. */
export function markPublishFailed(logId: number, errorMessage: string): void {
  const now = Date.now();
  const row = db.prepare(`SELECT attempted_at, source_type, channel, title FROM publish_log WHERE id = ?`).get(logId) as any;
  const dur = row ? now - row.attempted_at : null;
  db.prepare(
    `UPDATE publish_log SET status='failed', error_message=?, completed_at=?, duration_ms=? WHERE id=?`,
  ).run(String(errorMessage).slice(0, 500), now, dur, logId);
  if (row) notifyFail(row.source_type, row.channel, row.title, errorMessage);
}

/** Đánh dấu bị firewall/copyright chặn. */
export function markPublishBlocked(logId: number, reason: string): void {
  const now = Date.now();
  const row = db.prepare(`SELECT attempted_at FROM publish_log WHERE id = ?`).get(logId) as any;
  const dur = row ? now - row.attempted_at : null;
  db.prepare(
    `UPDATE publish_log SET status='blocked', error_message=?, completed_at=?, duration_ms=? WHERE id=?`,
  ).run(String(reason).slice(0, 500), now, dur, logId);
}

/** Ghi 1 phát khi đã biết kết quả (không cần 2 bước). */
export function recordPublish(input: PublishLogInput & { status: PublishStatus }): number {
  const id = logPublishAttempt(input);
  if (input.status === 'failed' && input.error_message) {
    notifyFail(input.source_type, input.channel, input.title || '', input.error_message);
  }
  return id;
}

/** Telegram alert khi đăng FAIL (non-blocking). */
function notifyFail(sourceType: string, channel: string, title: string, err: string): void {
  try {
    if (getSetting('publish_log_alert_enabled') === 'false') return;
    if (getSetting('telegram_admin_alerts_enabled') === 'false') return;
    const token = getSetting('telegram_bot_token') || process.env.TELEGRAM_BOT_TOKEN;
    const chatId = getSetting('telegram_admin_chat_id') || process.env.TELEGRAM_ADMIN_CHAT_ID;
    if (!token || !chatId) return;
    const msg = `🔴 *Đăng bài THẤT BẠI*\n\nNguồn: ${sourceType}\nKênh: ${channel}\nBài: ${(title || '').slice(0, 80)}\nLỗi: ${String(err).slice(0, 200)}\n\nXem: /admin/publish-log`;
    const axios = require('axios');
    axios.post(`https://api.telegram.org/bot${token}/sendMessage`,
      { chat_id: chatId, text: msg, parse_mode: 'Markdown', disable_web_page_preview: true },
      { timeout: 8000 }).catch(() => {});
  } catch { /* swallow */ }
}

/* ───────── Query helpers (dashboard) ───────── */

export function getPublishLog(opts: {
  channel?: string; status?: string; source_type?: string;
  since?: number; limit?: number; offset?: number;
}): any[] {
  let sql = `SELECT * FROM publish_log WHERE 1=1`;
  const p: any[] = [];
  if (opts.channel) { sql += ` AND channel = ?`; p.push(opts.channel); }
  if (opts.status) { sql += ` AND status = ?`; p.push(opts.status); }
  if (opts.source_type) { sql += ` AND source_type = ?`; p.push(opts.source_type); }
  if (opts.since) { sql += ` AND attempted_at >= ?`; p.push(opts.since); }
  sql += ` ORDER BY attempted_at DESC LIMIT ? OFFSET ?`;
  p.push(Math.min(opts.limit || 100, 500), opts.offset || 0);
  return db.prepare(sql).all(...p) as any[];
}

export function getPublishStats(sinceDays = 30): any {
  const since = Date.now() - sinceDays * 86400_000;
  const byChannel = db.prepare(
    `SELECT channel,
            SUM(CASE WHEN status='success' THEN 1 ELSE 0 END) AS success,
            SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed,
            SUM(CASE WHEN status='blocked' THEN 1 ELSE 0 END) AS blocked,
            SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) AS pending,
            COUNT(*) AS total
     FROM publish_log WHERE attempted_at >= ? GROUP BY channel`,
  ).all(since) as any[];
  const bySource = db.prepare(
    `SELECT source_type, COUNT(*) AS n,
            SUM(CASE WHEN status='success' THEN 1 ELSE 0 END) AS success
     FROM publish_log WHERE attempted_at >= ? GROUP BY source_type`,
  ).all(since) as any[];
  const byDay = db.prepare(
    `SELECT date(attempted_at/1000,'unixepoch','+7 hours') AS day,
            COUNT(*) AS total,
            SUM(CASE WHEN status='success' THEN 1 ELSE 0 END) AS success,
            SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed
     FROM publish_log WHERE attempted_at >= ?
     GROUP BY day ORDER BY day DESC LIMIT 30`,
  ).all(since) as any[];
  const total = db.prepare(`SELECT COUNT(*) n FROM publish_log`).get() as any;
  return { byChannel, bySource, byDay, total: total.n, since_days: sinceDays };
}

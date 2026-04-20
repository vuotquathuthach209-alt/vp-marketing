/**
 * Spam / Abuse Guard
 *
 * Chặn bot trả lời cho trường hợp:
 *   - Tin nhắn spam (keyword blocklist: cá độ, tín dụng đen, link sex, ...)
 *   - User gửi quá nhanh (>= 10 tin/phút → rate limit)
 *   - User bị mute thủ công (admin block)
 *   - Content gồm link độc hại (simple heuristic)
 *
 * Không chặn hoàn toàn — chỉ skip bot reply để tránh engage vô ích.
 * Ghi log event 'spam_blocked' để admin review.
 */
import { db } from '../db';
import { trackEvent } from './events';

db.exec(`
CREATE TABLE IF NOT EXISTS spam_blocklist (
  sender_id TEXT PRIMARY KEY,
  hotel_id INTEGER,
  reason TEXT,
  blocked_at INTEGER NOT NULL,
  expires_at INTEGER,
  last_message TEXT
);

CREATE TABLE IF NOT EXISTS sender_rate (
  sender_id TEXT PRIMARY KEY,
  page_id INTEGER NOT NULL DEFAULT 0,
  msg_count_1min INTEGER NOT NULL DEFAULT 0,
  msg_count_1hour INTEGER NOT NULL DEFAULT 0,
  last_msg_at INTEGER NOT NULL,
  window_start_1min INTEGER NOT NULL,
  window_start_1hour INTEGER NOT NULL
);
`);

// Keyword blocklist — mở rộng theo thời gian từ false positives
const SPAM_KEYWORDS: RegExp[] = [
  /\b(cá độ|cá cược|baccarat|nổ hũ|đánh bạc online|casino online)\b/i,
  /\b(vay nóng|tín dụng đen|cho vay không thế chấp|vay không chứng minh)\b/i,
  /\b(xxx|porn|sex cam|escort service|call.?girl|massage k[ií]ch d[uụ]c)\b/i,
  /\b(bán acc|bán tk|bán account facebook|mua acc)\b/i,
  /\b(hack.?account|hack.?facebook|hack page)\b/i,
];

const SUSPICIOUS_URL_PATTERNS: RegExp[] = [
  /\b(bit\.ly|tinyurl\.com|t\.co|goo\.gl|shrt\.lu|shorturl\.at)\//i,
];

const RATE_LIMIT_PER_MIN = 10;
const RATE_LIMIT_PER_HOUR = 60;

export interface SpamCheck {
  block: boolean;
  reason?: 'keyword' | 'rate_limit_minute' | 'rate_limit_hour' | 'manual_block' | 'suspicious_link';
  detail?: string;
}

/** Check if message is spam — O(1) rules, no LLM */
export function checkSpam(opts: {
  senderId: string;
  pageId: number;
  message: string;
  hotelId: number;
}): SpamCheck {
  const { senderId, pageId, message, hotelId } = opts;

  // 1. Manual block
  try {
    const row = db.prepare(
      `SELECT reason, expires_at FROM spam_blocklist WHERE sender_id = ?`
    ).get(senderId) as any;
    if (row) {
      if (!row.expires_at || row.expires_at > Date.now()) {
        return { block: true, reason: 'manual_block', detail: row.reason };
      }
    }
  } catch {}

  // 2. Keyword spam
  for (const re of SPAM_KEYWORDS) {
    if (re.test(message)) {
      const detail = `spam keyword: ${re.source}`;
      autoAddToBlocklist(senderId, hotelId, detail, message, 7 * 24 * 3600 * 1000);
      return { block: true, reason: 'keyword', detail };
    }
  }

  // 3. Suspicious URL
  for (const re of SUSPICIOUS_URL_PATTERNS) {
    if (re.test(message)) {
      return { block: true, reason: 'suspicious_link', detail: message.match(re)?.[0] };
    }
  }

  // 4. Rate limit
  const now = Date.now();
  const MIN_WINDOW = 60 * 1000;
  const HOUR_WINDOW = 60 * 60 * 1000;

  try {
    const row = db.prepare(
      `SELECT msg_count_1min, msg_count_1hour, window_start_1min, window_start_1hour
       FROM sender_rate WHERE sender_id = ? AND page_id = ?`
    ).get(senderId, pageId) as any;

    let min_count = 1, hour_count = 1;
    let min_start = now, hour_start = now;

    if (row) {
      // Reset windows if expired
      if (now - row.window_start_1min < MIN_WINDOW) {
        min_count = row.msg_count_1min + 1;
        min_start = row.window_start_1min;
      }
      if (now - row.window_start_1hour < HOUR_WINDOW) {
        hour_count = row.msg_count_1hour + 1;
        hour_start = row.window_start_1hour;
      }
    }

    db.prepare(
      `INSERT INTO sender_rate (sender_id, page_id, msg_count_1min, msg_count_1hour, last_msg_at, window_start_1min, window_start_1hour)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(sender_id) DO UPDATE SET
         msg_count_1min = excluded.msg_count_1min,
         msg_count_1hour = excluded.msg_count_1hour,
         last_msg_at = excluded.last_msg_at,
         window_start_1min = excluded.window_start_1min,
         window_start_1hour = excluded.window_start_1hour`
    ).run(senderId, pageId, min_count, hour_count, now, min_start, hour_start);

    if (min_count > RATE_LIMIT_PER_MIN) {
      return { block: true, reason: 'rate_limit_minute', detail: `${min_count} tin/phút` };
    }
    if (hour_count > RATE_LIMIT_PER_HOUR) {
      return { block: true, reason: 'rate_limit_hour', detail: `${hour_count} tin/giờ` };
    }
  } catch {}

  return { block: false };
}

function autoAddToBlocklist(senderId: string, hotelId: number, reason: string, message: string, durationMs: number) {
  try {
    db.prepare(
      `INSERT OR REPLACE INTO spam_blocklist (sender_id, hotel_id, reason, blocked_at, expires_at, last_message)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(senderId, hotelId, reason, Date.now(), Date.now() + durationMs, message.slice(0, 200));
  } catch {}
}

/** Admin API: manually block */
export function blockSender(senderId: string, hotelId: number, reason: string, days?: number): void {
  const expires = days ? Date.now() + days * 24 * 3600 * 1000 : null;
  db.prepare(
    `INSERT OR REPLACE INTO spam_blocklist (sender_id, hotel_id, reason, blocked_at, expires_at, last_message)
     VALUES (?, ?, ?, ?, ?, '')`
  ).run(senderId, hotelId, reason, Date.now(), expires);
}

export function unblockSender(senderId: string): void {
  db.prepare(`DELETE FROM spam_blocklist WHERE sender_id = ?`).run(senderId);
}

export function listBlocked(hotelId?: number): any[] {
  const sql = hotelId
    ? `SELECT * FROM spam_blocklist WHERE hotel_id = ? ORDER BY blocked_at DESC LIMIT 200`
    : `SELECT * FROM spam_blocklist ORDER BY blocked_at DESC LIMIT 200`;
  return hotelId ? db.prepare(sql).all(hotelId) : db.prepare(sql).all();
}

/** Log block event for analytics */
export function logSpamEvent(senderId: string, pageId: number, hotelId: number, reason: string, detail: string, message: string): void {
  try {
    trackEvent({
      event: 'spam_blocked',
      hotelId,
      meta: { sender_id: senderId, reason, detail, page_id: pageId, message_preview: message.slice(0, 100) },
    });
  } catch {}
}

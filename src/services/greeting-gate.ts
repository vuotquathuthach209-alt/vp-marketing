/**
 * Greeting Gate — chặn bot gửi greeting template 2 lần liên tiếp.
 *
 * Problem (screenshots do user cung cấp):
 *   Bot liên tục lặp lại: "Chào anh/chị! 👋 Em là trợ lý Sonder..."
 *   mỗi khi PROPERTY_TYPE_ASK handler chạy, dù khách đã đang giữa cuộc trò chuyện.
 *
 * Fix:
 *   Trước khi prepend greeting template vào reply, check N tin nhắn bot gần nhất.
 *   Nếu bất kỳ tin nào đã chứa fingerprint (30 kí tự đầu) của template → skip greeting.
 *   Chỉ gửi "loại phòng nào ạ?" thẳng, không chào lại.
 *
 * Tương đương với Python reference:
 *   def should_send_greeting(session_id, greeting_template) -> bool:
 *       last_bot_msgs = get_last_messages(session_id, 'bot', limit=3)
 *       for msg in last_bot_msgs:
 *           if greeting_template[:30] in msg.content:
 *               return False
 *       return True
 */

import { db } from '../db';

const DEFAULT_LOOKBACK = 5;       // v23: 5 messages thay vì 3 (user yêu cầu)
const FINGERPRINT_LEN = 30;       // 30 kí tự đầu của template để match

/**
 * Normalize để compare: lowercase + strip extra whitespace/punctuation.
 * Tránh case-sensitivity + emoji biến thiên giữa các lần render.
 */
function normalize(s: string): string {
  return (s || '')
    .toLowerCase()
    // Strip emoji/dingbats range (keeps text-only signature)
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Lấy N tin nhắn bot gần nhất cho 1 sender.
 */
function getRecentBotMessages(senderId: string, limit: number): string[] {
  try {
    const rows = db.prepare(
      `SELECT message FROM conversation_memory
       WHERE sender_id = ? AND role = 'bot'
       ORDER BY id DESC LIMIT ?`
    ).all(senderId, limit) as any[];
    return rows.map(r => r.message || '');
  } catch {
    return [];
  }
}

/**
 * shouldSendGreeting — gate chính.
 *
 * @param senderId          sender ID (fb:123 | zalo:456)
 * @param greetingTemplate  full greeting candidate (bot sắp gửi)
 * @param lookback          số tin nhắn bot gần nhất cần check (default 5)
 * @returns true nếu CHƯA gửi gần đây → nên gửi. false nếu DUP → bỏ greeting.
 */
export function shouldSendGreeting(
  senderId: string | undefined,
  greetingTemplate: string,
  lookback: number = DEFAULT_LOOKBACK,
): boolean {
  if (!senderId || !greetingTemplate) return true;

  const fingerprint = normalize(greetingTemplate).slice(0, FINGERPRINT_LEN);
  if (fingerprint.length < 10) return true;   // template quá ngắn, không reliable

  const recent = getRecentBotMessages(senderId, lookback);
  for (const msg of recent) {
    if (normalize(msg).includes(fingerprint)) {
      return false;   // đã gửi trong N turn gần nhất → skip
    }
  }
  return true;
}

/**
 * hasRecentBotActivity — kiểm tra sender đã có tương tác bot gần đây chưa.
 * Dùng để: nếu đây là TURN ĐẦU (no history) thì cho phép greeting.
 *          Nếu đang giữa convo → greeting thường redundant.
 */
export function hasRecentBotActivity(senderId: string | undefined, withinMs: number = 60 * 60_000): boolean {
  if (!senderId) return false;
  try {
    const row = db.prepare(
      `SELECT created_at FROM conversation_memory
       WHERE sender_id = ? AND role = 'bot'
       ORDER BY id DESC LIMIT 1`
    ).get(senderId) as any;
    if (!row) return false;
    return (Date.now() - row.created_at) < withinMs;
  } catch { return false; }
}

/**
 * Extract fingerprint từ greeting candidate để log/debug.
 */
export function greetingFingerprint(text: string): string {
  return normalize(text).slice(0, FINGERPRINT_LEN);
}

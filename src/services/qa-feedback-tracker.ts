/**
 * QA Feedback Tracker — Phase 3 of Smart Intent Training Pipeline.
 *
 * Goal: auto-detect positive/negative signals từ next user turn sau khi bot reply,
 * update qa_training_cache.feedback_score + positive_feedback + negative_feedback.
 * Auto-promote trusted / auto-demote bad entries dựa vào score.
 *
 * Flow:
 *   Bot reply (qa_cached hoặc LLM-saved) → rememberLastReply(senderId, qa_cache_id)
 *   Next user message arrives → analyzeFollowUp(senderId, message, historyTail)
 *     → phân loại signal: positive / negative / neutral
 *     → insert qa_feedback row + update qa_training_cache counters
 *
 * Signals:
 *   POSITIVE
 *     - cảm ơn / thanks / ok / tốt / được rồi
 *     - cung cấp số điện thoại (converted)
 *     - tiếp tục hỏi về booking (progress)
 *     - không hỏi lại câu cũ (follow_up_different)
 *   NEGATIVE
 *     - "không phải" / "sai rồi" / "không đúng" / "khác cơ"
 *     - lặp lại câu hỏi gần giống (similarity >= 0.85) → bot chưa hiểu
 *     - yêu cầu người thật ("cho gặp người", "gọi nhân viên")
 *     - complaint / frustrated emotion
 *   NEUTRAL
 *     - bỏ rơi (không reply trong 30 phút) → ignore (don't penalize)
 *     - câu hỏi mới hoàn toàn khác → neutral (don't boost/penalize)
 *
 * Scoring:
 *   +2 feedback_score + positive_feedback++ khi positive
 *   -3 feedback_score + negative_feedback++ khi negative
 *
 * Auto-tier:
 *   autoPromoteTrusted() điều kiện hits_count >= 10 AND feedback_score >= 5 AND negative < positive/2
 *   autoDemoteOnBadFeedback() điều kiện feedback_score <= -10 → demote về pending
 */
import { db } from '../db';
import { embed, cosine, decodeEmbedding } from './embedder';

const MAX_FOLLOW_UP_WINDOW_MS = 30 * 60 * 1000;  // 30 phút: quá lâu coi như không phải feedback
const SAME_QUESTION_THRESHOLD = 0.82;  // ≥ này coi là lặp câu hỏi → negative

export type FeedbackSignal =
  | 'positive_thanks'
  | 'positive_phone_given'
  | 'positive_booking_progress'
  | 'positive_different_topic'
  | 'negative_explicit'          // "không phải", "sai rồi"
  | 'negative_repeated_question' // câu hỏi lặp gần giống
  | 'negative_handoff_request'
  | 'negative_complaint'
  | 'neutral';

export type FeedbackSentiment = 'positive' | 'negative' | 'neutral';

export interface LastReplyRef {
  qa_cache_id: number;
  bot_reply: string;
  user_question: string;
  hotel_id: number;
  ts: number;
  is_cached_hit: boolean;  // true = qa_cache match; false = mới save tier=pending
}

// senderId → LastReplyRef (single-entry, replaced on new reply)
const _lastReply = new Map<string, LastReplyRef>();

/**
 * Gọi ngay sau khi bot send reply (đối với replies có qa_cache_id).
 * Opportunistic GC nếu map > 2000 entries.
 */
export function rememberLastReply(senderId: string | undefined, ref: Omit<LastReplyRef, 'ts'>): void {
  if (!senderId) return;
  _lastReply.set(senderId, { ...ref, ts: Date.now() });
  if (_lastReply.size > 2000) {
    const now = Date.now();
    for (const [k, v] of _lastReply) if (now - v.ts > MAX_FOLLOW_UP_WINDOW_MS) _lastReply.delete(k);
  }
}

/** Hàm nội bộ: detect signal from follow-up message.  */
function classifySignalBasic(followUp: string): FeedbackSignal | null {
  const text = followUp.trim().toLowerCase();
  if (!text) return null;

  // POSITIVE — cảm ơn / đồng ý
  if (/\b(cảm ơn|thanks|thank you|cám ơn|tks|thx|ty)\b/.test(text)) return 'positive_thanks';
  if (/^(ok|okay|đc|được|ổn|tốt|tuyệt|ngon|perfect|oke|oki|ừ|dạ|ya|yes|ừm|hay)\b/i.test(text)) return 'positive_thanks';

  // POSITIVE — provide phone (10-11 digits possibly spaced)
  if (/\b0\d{2}[\s.-]?\d{3}[\s.-]?\d{3,4}\b/.test(text) || /\b\+?84\d{9,10}\b/.test(text)) {
    return 'positive_phone_given';
  }

  // POSITIVE — booking progress signals
  if (/\b(đặt|book|chốt|lấy phòng|thuê|nhận phòng|check-in|checkin)\b/.test(text)) {
    return 'positive_booking_progress';
  }

  // NEGATIVE — explicit contradiction / disagreement
  if (/(không phải ý|sai rồi|không đúng|khác cơ|không phải vậy|không phải thế|hiểu nhầm|ý mình là|ý em là|nhầm rồi)/.test(text)) {
    return 'negative_explicit';
  }

  // NEGATIVE — handoff request
  if (/(cho gặp|gặp người|gọi nhân viên|gọi quản lý|gặp admin|gặp nhân viên|nói chuyện người thật|cho số|số điện thoại của|hotline)/.test(text)) {
    return 'negative_handoff_request';
  }

  // NEGATIVE — complaint / frustrated
  if (/(tệ quá|dở tệ|bực mình|đen đủi|chán|bực|khốn|chết tiệt|rác|kém|dở)/.test(text)) {
    return 'negative_complaint';
  }

  return null;
}

/**
 * Classify follow-up + return detailed signal info.
 * Gọi async để check similarity embedding nếu chưa match rule-based.
 */
export async function analyzeFollowUp(opts: {
  senderId: string;
  message: string;
  hotelId: number;
}): Promise<{ signal: FeedbackSignal; sentiment: FeedbackSentiment; qa_cache_id: number } | null> {
  const last = _lastReply.get(opts.senderId);
  if (!last) return null;

  const age = Date.now() - last.ts;
  if (age > MAX_FOLLOW_UP_WINDOW_MS) {
    _lastReply.delete(opts.senderId);
    return null;
  }

  // Rule-based signal first
  let signal = classifySignalBasic(opts.message);

  // Nếu chưa có signal, check nếu câu hỏi lặp lại (embedding similarity)
  if (!signal) {
    try {
      const v1 = await embed(opts.message);
      const v2 = await embed(last.user_question);
      if (v1 && v2) {
        const sim = cosine(v1, v2);
        if (sim >= SAME_QUESTION_THRESHOLD) {
          signal = 'negative_repeated_question';
        } else {
          signal = 'positive_different_topic';  // câu mới khác → coi là bot trả lời OK, khách move on
        }
      }
    } catch { /* embedder fail → neutral */ }
  }

  if (!signal) signal = 'neutral';

  const sentiment: FeedbackSentiment =
    signal.startsWith('positive_') ? 'positive' :
    signal.startsWith('negative_') ? 'negative' : 'neutral';

  // Không update counter nếu neutral (để tránh nhiễu)
  if (sentiment !== 'neutral') {
    const delta = sentiment === 'positive' ? 2 : -3;
    const posInc = sentiment === 'positive' ? 1 : 0;
    const negInc = sentiment === 'negative' ? 1 : 0;
    try {
      db.prepare(
        `UPDATE qa_training_cache
         SET feedback_score = feedback_score + ?,
             positive_feedback = positive_feedback + ?,
             negative_feedback = negative_feedback + ?
         WHERE id = ?`
      ).run(delta, posInc, negInc, last.qa_cache_id);

      db.prepare(
        `INSERT INTO qa_feedback (qa_cache_id, customer_id, sentiment, signal, follow_up_message, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(last.qa_cache_id, opts.senderId, sentiment, signal, opts.message.slice(0, 500), Date.now());

      console.log(`[qa-feedback] qa_cache_id=${last.qa_cache_id} ${sentiment} signal=${signal} delta=${delta}`);
    } catch (e: any) {
      console.warn('[qa-feedback] update fail:', e?.message);
    }
  }

  // Consume — một reply chỉ đánh giá 1 lần
  _lastReply.delete(opts.senderId);

  return { signal, sentiment, qa_cache_id: last.qa_cache_id };
}

/** Admin manual grade — giống analyze nhưng force sentiment */
export function manualFeedback(opts: {
  qa_cache_id: number;
  sentiment: FeedbackSentiment;
  note?: string;
  admin_user_id?: number;
}): { ok: true } {
  const { sentiment } = opts;
  const delta = sentiment === 'positive' ? 3 : sentiment === 'negative' ? -5 : 0;  // admin grade stronger
  const posInc = sentiment === 'positive' ? 1 : 0;
  const negInc = sentiment === 'negative' ? 1 : 0;

  db.prepare(
    `UPDATE qa_training_cache
     SET feedback_score = feedback_score + ?,
         positive_feedback = positive_feedback + ?,
         negative_feedback = negative_feedback + ?
     WHERE id = ?`
  ).run(delta, posInc, negInc, opts.qa_cache_id);

  db.prepare(
    `INSERT INTO qa_feedback (qa_cache_id, customer_id, sentiment, signal, follow_up_message, created_at)
     VALUES (?, ?, ?, 'admin_manual', ?, ?)`
  ).run(opts.qa_cache_id, `admin_${opts.admin_user_id || 0}`, sentiment, opts.note || '(admin grade)', Date.now());

  return { ok: true };
}

/** Fetch recent feedback cho 1 entry — hiển thị trong admin UI */
export function getRecentFeedback(qa_cache_id: number, limit = 20): any[] {
  return db.prepare(
    `SELECT id, customer_id, sentiment, signal, follow_up_message, created_at
     FROM qa_feedback WHERE qa_cache_id = ?
     ORDER BY id DESC LIMIT ?`
  ).all(qa_cache_id, limit);
}

/** Stats: positive/negative rate across hotel */
export function getFeedbackStats(hotelId: number, sinceMs: number): {
  total: number;
  positive: number;
  negative: number;
  neutral: number;
  top_negative_entries: Array<{ id: number; question: string; negative_count: number; score: number }>;
} {
  const rows = db.prepare(
    `SELECT qf.sentiment, COUNT(*) as n
     FROM qa_feedback qf
     JOIN qa_training_cache qc ON qc.id = qf.qa_cache_id
     WHERE qc.hotel_id = ? AND qf.created_at > ?
     GROUP BY qf.sentiment`
  ).all(hotelId, sinceMs) as any[];
  const byS: Record<string, number> = { positive: 0, negative: 0, neutral: 0 };
  rows.forEach(r => { byS[r.sentiment] = r.n; });
  const total = byS.positive + byS.negative + byS.neutral;

  const top = db.prepare(
    `SELECT id, customer_question as question, negative_feedback as negative_count, feedback_score as score
     FROM qa_training_cache
     WHERE hotel_id = ? AND negative_feedback > 0
     ORDER BY feedback_score ASC, negative_feedback DESC LIMIT 10`
  ).all(hotelId) as any[];

  return { total, positive: byS.positive, negative: byS.negative, neutral: byS.neutral, top_negative_entries: top };
}

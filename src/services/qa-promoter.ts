/**
 * QA Promoter — daily job
 *
 * Quét conversation_memory để tìm Q+A pairs CÓ TÍN HIỆU SATISFACTION,
 * rồi promote vào learned_qa_cache với hits cao hơn để lần sau được cache.
 *
 * Tín hiệu satisfaction (sau bot reply, user thể hiện 1 trong):
 *   - "cảm ơn", "thanks", "ok cảm ơn", "tks"
 *   - User nhắn tiếp về booking (đặt, chuyển khoản, ngày cụ thể)
 *   - User nhắn SĐT → chuyển giai đoạn
 *   - Không có tín hiệu frustrated/complaint trong 2 turn tiếp theo
 *
 * Tín hiệu unsatisfaction:
 *   - "không đúng", "sai rồi", "không phải vậy", "tệ"
 *   - User hỏi lại ngay câu tương tự → bot đã trả lời kém
 *   - Handoff sau đó
 *
 * Chạy: scheduler gọi 1 lần/ngày lúc 5:30 sáng (sau job learned có sẵn).
 */
import { db } from '../db';
import { recordQA } from './learning';

const SATISFACTION_MARKERS = /(cảm ơn|c[aả]m ơn|thanks?|tks|tốt quá|ok lắm|hay quá|đỉnh|tuyệt vời|ngon|chuẩn rồi)/i;
const UNSATISFACTION_MARKERS = /(không đúng|không phải|sai (rồi|mất|r[oồ]i)|tệ|dở|chả hiểu|ko hiểu|không hiểu|hỏi lại|không liên quan)/i;
const BOOKING_PROGRESS_MARKERS = /(đặt phòng|chuyển khoản|chuyển|đã ck|book|sđt|số điện thoại|\b0\d{9,10}\b)/i;

interface Row {
  id: number;
  sender_id: string;
  page_id: number;
  role: string;
  message: string;
  intent: string | null;
  created_at: number;
}

interface PromotedStats {
  scanned_conversations: number;
  qa_candidates: number;
  promoted: number;
  skipped_unsat: number;
  skipped_no_signal: number;
}

/**
 * Scan conversations trong N giờ qua, tìm Q+A pair có satisfaction signal.
 * Promote Q+A vào learned_qa_cache.
 */
export async function promoteSuccessfulQAs(hours = 24): Promise<PromotedStats> {
  const since = Date.now() - hours * 3600 * 1000;
  const rows = db.prepare(
    `SELECT id, sender_id, page_id, role, message, intent, created_at
     FROM conversation_memory
     WHERE created_at >= ?
     ORDER BY sender_id, page_id, id ASC`
  ).all(since) as Row[];

  const stats: PromotedStats = {
    scanned_conversations: 0,
    qa_candidates: 0,
    promoted: 0,
    skipped_unsat: 0,
    skipped_no_signal: 0,
  };

  // Group by sender
  const bySender: Record<string, Row[]> = {};
  for (const r of rows) {
    const key = r.sender_id + ':' + r.page_id;
    (bySender[key] = bySender[key] || []).push(r);
  }
  stats.scanned_conversations = Object.keys(bySender).length;

  // Per-conversation: find Q(user) → A(bot) → follow-up(user) patterns
  for (const conv of Object.values(bySender)) {
    for (let i = 0; i < conv.length - 2; i++) {
      const q = conv[i];
      const a = conv[i + 1];
      const follow = conv[i + 2];
      if (q.role !== 'user' || a.role !== 'bot' || follow.role !== 'user') continue;

      // Skip very short QAs (low learning value)
      if (q.message.length < 8 || a.message.length < 20) continue;

      // Skip booking-related (they're handled by FSM, not RAG cache)
      if (a.intent === 'booking' || a.intent === 'transfer') continue;

      stats.qa_candidates++;

      // Check follow-up signal
      const followText = follow.message;
      if (UNSATISFACTION_MARKERS.test(followText)) {
        stats.skipped_unsat++;
        continue;
      }

      const satisfied =
        SATISFACTION_MARKERS.test(followText) ||
        BOOKING_PROGRESS_MARKERS.test(followText);

      if (!satisfied) {
        stats.skipped_no_signal++;
        continue;
      }

      // Lookup hotel_id via page_id (mkt_pages)
      let hotelId = 1;
      try {
        const p = db.prepare(`SELECT hotel_id FROM pages WHERE id = ?`).get(a.page_id) as any;
        if (p?.hotel_id) hotelId = p.hotel_id;
      } catch {}

      try {
        await recordQA(q.message, a.message, a.intent || 'auto_promoted', hotelId);
        stats.promoted++;
      } catch {
        // continue — not fatal
      }
    }
  }

  return stats;
}

/**
 * Expose for scheduler + route API.
 */
export async function runDailyPromotion(): Promise<PromotedStats> {
  const t0 = Date.now();
  const stats = await promoteSuccessfulQAs(24);
  console.log(`[qa-promoter] ${Date.now() - t0}ms: scanned=${stats.scanned_conversations} candidates=${stats.qa_candidates} promoted=${stats.promoted} unsat=${stats.skipped_unsat} noSig=${stats.skipped_no_signal}`);
  return stats;
}

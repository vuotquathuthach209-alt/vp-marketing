/**
 * Memory Recall — semantic search qua lịch sử hội thoại của user.
 *
 * Mục tiêu: khi user hỏi lại câu gần giống, bot detect và phản hồi tự nhiên
 * như con người ("Như em đã chia sẻ với chị lúc nãy, ..."/"Chị có thể cần thêm gì không ạ?").
 *
 * Lookup:
 *   1. Embed user message hiện tại.
 *   2. So với các user message cùng sender 7 ngày qua (cosine).
 *   3. Nếu > 0.8 và > 1 phút trước → recall hit.
 *   4. Lấy kèm bot reply ngay sau → để dispatcher inject vào prompt.
 *
 * Latency: ~40ms (1 embed + DB scan < 100 rows).
 */
import { db } from '../db';
import { embed, cosine, encodeEmbedding, decodeEmbedding } from './embedder';

const RECALL_THRESHOLD = 0.8;
const LOOKBACK_DAYS = 7;
const MIN_GAP_SECONDS = 60; // tránh echo cùng 1 turn

export interface RecallHit {
  similarity: number;
  past_user_message: string;
  past_bot_reply: string;
  ago_seconds: number;
}

/**
 * Lưu embedding cho 1 user message vừa nhận.
 * Gọi ngay sau saveMessage(role='user').
 */
export async function indexUserMessage(opts: {
  senderId: string;
  pageId: number;
  message: string;
}): Promise<void> {
  try {
    const vec = await embed(opts.message);
    if (!vec) return;
    const buf = encodeEmbedding(vec);
    // Update row mới nhất của sender với role='user' chưa có embedding
    db.prepare(
      `UPDATE conversation_memory
       SET embedding = ?
       WHERE id = (
         SELECT id FROM conversation_memory
         WHERE sender_id = ? AND page_id = ? AND role = 'user' AND embedding IS NULL
         ORDER BY id DESC LIMIT 1
       )`
    ).run(buf, opts.senderId, opts.pageId);
  } catch { /* non-fatal */ }
}

/**
 * Tìm câu user cũ tương tự — trả hit tốt nhất hoặc null.
 */
export async function recall(opts: {
  senderId: string;
  pageId: number;
  message: string;
}): Promise<RecallHit | null> {
  try {
    const queryVec = await embed(opts.message);
    if (!queryVec) return null;

    const cutoff = Date.now() - LOOKBACK_DAYS * 24 * 3600_000;
    const maxAgo = Date.now() - MIN_GAP_SECONDS * 1000;

    // Lấy tối đa 30 user messages gần nhất có embedding
    const rows = db.prepare(
      `SELECT id, message, created_at, embedding FROM conversation_memory
       WHERE sender_id = ? AND page_id = ? AND role = 'user'
         AND created_at >= ? AND created_at <= ?
         AND embedding IS NOT NULL
       ORDER BY id DESC LIMIT 30`
    ).all(opts.senderId, opts.pageId, cutoff, maxAgo) as any[];

    if (rows.length === 0) return null;

    let best: { row: any; sim: number } | null = null;
    for (const r of rows) {
      if (!r.embedding) continue;
      try {
        const pastVec = decodeEmbedding(r.embedding);
        const sim = cosine(queryVec, pastVec);
        if (sim > RECALL_THRESHOLD && (!best || sim > best.sim)) {
          best = { row: r, sim };
        }
      } catch { /* skip corrupt blob */ }
    }
    if (!best) return null;

    // Tìm bot reply NGAY SAU user message đó
    const botReply = db.prepare(
      `SELECT message FROM conversation_memory
       WHERE sender_id = ? AND page_id = ? AND role = 'bot' AND id > ?
       ORDER BY id ASC LIMIT 1`
    ).get(opts.senderId, opts.pageId, best.row.id) as any;

    return {
      similarity: +best.sim.toFixed(3),
      past_user_message: best.row.message,
      past_bot_reply: botReply?.message || '',
      ago_seconds: Math.round((Date.now() - best.row.created_at) / 1000),
    };
  } catch {
    return null;
  }
}

/** Format recall hint để inject vào system prompt */
export function formatRecallHint(hit: RecallHit): string {
  const agoMin = Math.round(hit.ago_seconds / 60);
  const agoText = agoMin < 1 ? 'vừa nãy' : agoMin < 60 ? `${agoMin} phút trước` : `${Math.round(agoMin / 60)} giờ trước`;
  return `LƯU Ý: Khách này đã hỏi câu tương tự ${agoText} ("${hit.past_user_message.slice(0, 100)}"). ` +
    `Bạn đã trả lời: "${hit.past_bot_reply.slice(0, 160)}". ` +
    `Hãy tham chiếu lại câu trả lời cũ một cách tự nhiên (VD: "Như em đã chia sẻ lúc nãy, ..."), KHÔNG lặp nguyên văn, bổ sung thông tin mới nếu có.`;
}

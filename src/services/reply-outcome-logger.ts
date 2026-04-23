/**
 * Reply Outcome Logger — v13 Feedback Loop.
 *
 * Gọi NGAY KHI bot gửi reply → INSERT row với outcome='pending'.
 * Classifier chạy sau (15min cron) để update outcome based on:
 *   - User response trong 24h? → followup/ignored/converted
 *   - User nói "không hiểu"/hỏi lại? → misunderstood
 *   - User cho phone? → converted_to_lead
 *   - No response 48h? → ghosted
 *   - Conversation ended at CONFIRM_BOOKING? → booked
 */

import { db } from '../db';

export interface ReplyLogInput {
  hotelId: number;
  senderId: string;
  userMessage: string;
  botReply: string;
  intent?: string;
  stage?: string;
  replySource: string;            // 'generic_price', 'rag_semantic', 'hotel_overview', 'funnel_budget_ask', ...
  ragChunksUsed?: Array<{ id: number; score: number; type?: string }>;
  llmProvider?: string;
  llmModel?: string;
  latencyMs?: number;
  tokensIn?: number;
  tokensOut?: number;
  conversationMemoryId?: number;  // nếu đã có
}

/** Log 1 reply. Return ID để update sau (latency, tokens, …). */
export function logBotReply(input: ReplyLogInput): number {
  try {
    const r = db.prepare(
      `INSERT INTO bot_reply_outcomes
       (hotel_id, sender_id, conversation_memory_id, user_message, bot_reply,
        intent, stage, reply_source, rag_chunks_used,
        llm_provider, llm_model, latency_ms, tokens_in, tokens_out,
        outcome, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`
    ).run(
      input.hotelId,
      input.senderId,
      input.conversationMemoryId || null,
      (input.userMessage || '').slice(0, 2000),
      (input.botReply || '').slice(0, 4000),
      input.intent || null,
      input.stage || null,
      input.replySource,
      input.ragChunksUsed ? JSON.stringify(input.ragChunksUsed) : null,
      input.llmProvider || null,
      input.llmModel || null,
      input.latencyMs || null,
      input.tokensIn || null,
      input.tokensOut || null,
      Date.now(),
    );
    return r.lastInsertRowid as number;
  } catch (e: any) {
    console.warn('[reply-log] insert fail:', e?.message);
    return 0;
  }
}

/** Update outcome sau khi classifier quyết định. */
export function updateOutcome(
  outcomeId: number,
  outcome: string,
  evidence?: Record<string, any>,
): void {
  try {
    db.prepare(
      `UPDATE bot_reply_outcomes
       SET outcome = ?, outcome_at = ?, outcome_evidence = ?
       WHERE id = ?`
    ).run(outcome, Date.now(), evidence ? JSON.stringify(evidence) : null, outcomeId);
  } catch (e: any) {
    console.warn('[reply-log] update outcome fail:', e?.message);
  }
}

/** Query outcome distribution theo thời gian. */
export function getOutcomeStats(hotelId: number, days: number = 7): {
  by_outcome: Record<string, number>;
  by_source: Record<string, Record<string, number>>;
  total: number;
  pending: number;
} {
  const since = Date.now() - days * 24 * 3600_000;
  const rows = db.prepare(
    `SELECT outcome, reply_source, COUNT(*) as n
     FROM bot_reply_outcomes
     WHERE hotel_id = ? AND created_at > ?
     GROUP BY outcome, reply_source`
  ).all(hotelId, since) as any[];

  const byOutcome: Record<string, number> = {};
  const bySource: Record<string, Record<string, number>> = {};
  let total = 0;
  let pending = 0;

  for (const r of rows) {
    byOutcome[r.outcome] = (byOutcome[r.outcome] || 0) + r.n;
    if (!bySource[r.reply_source]) bySource[r.reply_source] = {};
    bySource[r.reply_source][r.outcome] = r.n;
    total += r.n;
    if (r.outcome === 'pending') pending += r.n;
  }

  return { by_outcome: byOutcome, by_source: bySource, total, pending };
}

/** Top reply_sources có conversion rate cao nhất (converted_to_lead + booked) / total. */
export function getTopPerformingSources(hotelId: number, days: number = 30, minSampleSize: number = 5): Array<{
  reply_source: string;
  total: number;
  converted: number;
  conversion_rate: number;
}> {
  const since = Date.now() - days * 24 * 3600_000;
  const rows = db.prepare(
    `SELECT reply_source,
            COUNT(*) as total,
            SUM(CASE WHEN outcome IN ('converted_to_lead', 'booked', 'closed_won') THEN 1 ELSE 0 END) as converted
     FROM bot_reply_outcomes
     WHERE hotel_id = ? AND created_at > ?
       AND outcome != 'pending'
     GROUP BY reply_source
     HAVING total >= ?
     ORDER BY converted * 1.0 / total DESC`
  ).all(hotelId, since, minSampleSize) as any[];

  return rows.map(r => ({
    reply_source: r.reply_source,
    total: r.total,
    converted: r.converted,
    conversion_rate: +(r.converted / r.total).toFixed(3),
  }));
}

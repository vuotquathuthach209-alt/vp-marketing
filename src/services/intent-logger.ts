/**
 * Intent Logger — record mọi message đi qua Gemini Intent Classifier.
 *
 * Dùng cho:
 *   - Analytics: dashboard intent distribution, FAQ hot topics, conversion by intent
 *   - Training data: export logs → fine-tune classifier
 *   - Debug: trace why bot chose route X cho message Y
 *
 * v23: bổ sung reply_fingerprint + greeting_gated để phân tích duplicate issue.
 */

import { db } from '../db';

export interface IntentLogRow {
  hotel_id: number;
  sender_id: string;
  channel?: 'fb' | 'zalo' | 'web' | 'api' | null;
  user_message: string;
  fsm_stage?: string | null;
  classifier_result?: {
    primary_intent?: string;
    sub_category?: string;
    confidence?: number;
    in_knowledge_base?: boolean;
    needs_clarification?: boolean;
    is_faq_intent?: boolean;
    pause_slot_filling?: boolean;
    extracted_slots?: any;
  } | null;
  classifier_provider?: string | null;
  classifier_latency_ms?: number | null;
  routed_to?: string | null;
  reply_fingerprint?: string | null;
  greeting_gated?: boolean;
  error?: string | null;
}

/**
 * Insert a new intent log row. Non-blocking — errors logged but không throw.
 */
export function logIntent(row: IntentLogRow): number | null {
  try {
    const userMsg = (row.user_message || '').slice(0, 500);
    const slots = row.classifier_result?.extracted_slots;
    const slotsJson = slots ? JSON.stringify(slots).slice(0, 2000) : null;
    const replyFp = row.reply_fingerprint ? String(row.reply_fingerprint).slice(0, 60) : null;

    const stmt = db.prepare(`
      INSERT INTO intent_logs (
        hotel_id, sender_id, channel, user_message, msg_length, fsm_stage,
        primary_intent, sub_category, confidence, in_knowledge_base,
        needs_clarification, is_faq_intent, pause_slot_filling,
        extracted_slots, classifier_provider, classifier_latency_ms,
        routed_to, reply_fingerprint, greeting_gated, error, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const info = stmt.run(
      row.hotel_id,
      row.sender_id,
      row.channel || null,
      userMsg,
      userMsg.length,
      row.fsm_stage || null,
      row.classifier_result?.primary_intent || null,
      row.classifier_result?.sub_category || null,
      typeof row.classifier_result?.confidence === 'number' ? row.classifier_result.confidence : null,
      row.classifier_result?.in_knowledge_base ? 1 : 0,
      row.classifier_result?.needs_clarification ? 1 : 0,
      row.classifier_result?.is_faq_intent ? 1 : 0,
      row.classifier_result?.pause_slot_filling ? 1 : 0,
      slotsJson,
      row.classifier_provider || null,
      row.classifier_latency_ms || null,
      row.routed_to || null,
      replyFp,
      row.greeting_gated ? 1 : 0,
      row.error || null,
      Date.now(),
    );
    return Number(info.lastInsertRowid);
  } catch (e: any) {
    console.warn('[intent-logger] insert fail:', e?.message);
    return null;
  }
}

/**
 * Update an existing log row (khi route được chọn hoặc có reply_fingerprint).
 */
export function updateIntentLog(
  id: number,
  patch: { routed_to?: string; reply_fingerprint?: string; greeting_gated?: boolean; error?: string },
): void {
  try {
    const sets: string[] = [];
    const vals: any[] = [];
    if (patch.routed_to !== undefined) { sets.push('routed_to = ?'); vals.push(patch.routed_to); }
    if (patch.reply_fingerprint !== undefined) { sets.push('reply_fingerprint = ?'); vals.push(String(patch.reply_fingerprint).slice(0, 60)); }
    if (patch.greeting_gated !== undefined) { sets.push('greeting_gated = ?'); vals.push(patch.greeting_gated ? 1 : 0); }
    if (patch.error !== undefined) { sets.push('error = ?'); vals.push(patch.error); }
    if (sets.length === 0) return;
    vals.push(id);
    db.prepare(`UPDATE intent_logs SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  } catch (e: any) {
    console.warn('[intent-logger] update fail:', e?.message);
  }
}

/**
 * Quick stats for admin dashboard.
 */
export function getIntentStats(hotelId: number, sinceMs: number = 24 * 3600_000): {
  total: number;
  by_intent: Record<string, number>;
  by_subcat: Record<string, number>;
  by_route: Record<string, number>;
  greeting_gated_count: number;
  avg_confidence: number;
  avg_latency_ms: number;
} {
  const since = Date.now() - sinceMs;
  try {
    const rows = db.prepare(
      `SELECT primary_intent, sub_category, routed_to, confidence,
              classifier_latency_ms, greeting_gated
       FROM intent_logs WHERE hotel_id = ? AND created_at > ?`
    ).all(hotelId, since) as any[];

    const by_intent: Record<string, number> = {};
    const by_subcat: Record<string, number> = {};
    const by_route: Record<string, number> = {};
    let confSum = 0, confN = 0, latSum = 0, latN = 0, gatedN = 0;

    for (const r of rows) {
      const intent = r.primary_intent || 'unclassified';
      by_intent[intent] = (by_intent[intent] || 0) + 1;
      if (r.sub_category) by_subcat[r.sub_category] = (by_subcat[r.sub_category] || 0) + 1;
      const route = r.routed_to || 'none';
      by_route[route] = (by_route[route] || 0) + 1;
      if (typeof r.confidence === 'number') { confSum += r.confidence; confN++; }
      if (typeof r.classifier_latency_ms === 'number') { latSum += r.classifier_latency_ms; latN++; }
      if (r.greeting_gated) gatedN++;
    }
    return {
      total: rows.length,
      by_intent,
      by_subcat,
      by_route,
      greeting_gated_count: gatedN,
      avg_confidence: confN ? confSum / confN : 0,
      avg_latency_ms: latN ? Math.round(latSum / latN) : 0,
    };
  } catch (e: any) {
    console.warn('[intent-logger] stats fail:', e?.message);
    return { total: 0, by_intent: {}, by_subcat: {}, by_route: {}, greeting_gated_count: 0, avg_confidence: 0, avg_latency_ms: 0 };
  }
}

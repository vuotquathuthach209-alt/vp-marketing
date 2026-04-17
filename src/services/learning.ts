import { db } from '../db';
import { embed, cosine, encodeEmbedding, decodeEmbedding } from './embedder';

/**
 * Learning loop — lazy promotion from real conversations to learned_qa_cache.
 *
 * Flow:
 *   smartReply() calls lookupLearned(msg, hotelId) BEFORE AI generation.
 *   If semantic match (cosine ≥ SERVE_THRESHOLD) and hits ≥ MIN_HITS → serve cached answer.
 *
 *   After any successful reply, smartReply calls recordQA(question, answer, intent, hotelId).
 *   If a similar Q already exists (cosine ≥ DEDUP_THRESHOLD) → bump hits + update last_hit_at.
 *   Otherwise insert as new candidate with hits=1.
 *
 * Self-healing: entries older than 90 days with hits<3 get pruned nightly (by scheduler).
 */

const SERVE_THRESHOLD = 0.88;   // cosine sim required to serve from cache
const DEDUP_THRESHOLD = 0.92;   // cosine sim to merge into existing entry
const MIN_HITS = 3;             // hits required before cache entry serves traffic
const MAX_CANDIDATES = 500;     // per-hotel rows scanned per lookup

interface LearnedRow {
  id: number;
  question: string;
  question_embedding: Buffer | null;
  answer: string;
  intent: string | null;
  hits: number;
}

export interface LearnedHit {
  answer: string;
  intent: string | null;
  hits: number;
  similarity: number;
  id: number;
}

/**
 * Lookup a cached answer by semantic similarity. Returns null if no confident hit.
 */
export async function lookupLearned(
  question: string,
  hotelId: number,
): Promise<LearnedHit | null> {
  const qVec = await embed(question);
  if (!qVec) return null;

  const rows = db
    .prepare(
      `SELECT id, question, question_embedding, answer, intent, hits
       FROM learned_qa_cache
       WHERE hotel_id = ? AND hits >= ? AND question_embedding IS NOT NULL
       ORDER BY hits DESC, last_hit_at DESC
       LIMIT ?`,
    )
    .all(hotelId, MIN_HITS, MAX_CANDIDATES) as LearnedRow[];

  let best: { row: LearnedRow; sim: number } | null = null;
  for (const r of rows) {
    if (!r.question_embedding) continue;
    const vec = decodeEmbedding(r.question_embedding);
    const sim = cosine(qVec, vec);
    if (sim >= SERVE_THRESHOLD && (!best || sim > best.sim)) {
      best = { row: r, sim };
    }
  }
  if (!best) return null;

  // Bump hits + last_hit_at
  try {
    db.prepare(
      `UPDATE learned_qa_cache SET hits = hits + 1, last_hit_at = ? WHERE id = ?`,
    ).run(Date.now(), best.row.id);
  } catch {}

  return {
    id: best.row.id,
    answer: best.row.answer,
    intent: best.row.intent,
    hits: best.row.hits + 1,
    similarity: best.sim,
  };
}

/**
 * Record a Q-A pair as a candidate for learned cache.
 * If a similar Q already exists → bump hits (lazy promotion).
 * Otherwise insert new with hits=1.
 * Non-blocking: caller should fire-and-forget.
 */
export async function recordQA(
  question: string,
  answer: string,
  intent: string | null,
  hotelId: number,
): Promise<void> {
  const q = question.trim();
  const a = answer.trim();
  if (!q || !a || q.length > 500 || a.length > 2000) return;

  const qVec = await embed(q);
  if (!qVec) return;

  // Check against recent candidates (any hits) for dedup
  const rows = db
    .prepare(
      `SELECT id, question_embedding, hits FROM learned_qa_cache
       WHERE hotel_id = ? AND question_embedding IS NOT NULL
       ORDER BY last_hit_at DESC LIMIT ?`,
    )
    .all(hotelId, MAX_CANDIDATES) as Pick<LearnedRow, 'id' | 'question_embedding' | 'hits'>[];

  let bestId: number | null = null;
  let bestSim = 0;
  for (const r of rows) {
    if (!r.question_embedding) continue;
    const vec = decodeEmbedding(r.question_embedding);
    const sim = cosine(qVec, vec);
    if (sim >= DEDUP_THRESHOLD && sim > bestSim) {
      bestId = r.id;
      bestSim = sim;
    }
  }

  const now = Date.now();
  if (bestId !== null) {
    db.prepare(
      `UPDATE learned_qa_cache SET hits = hits + 1, last_hit_at = ?, answer = ? WHERE id = ?`,
    ).run(now, a, bestId);
  } else {
    db.prepare(
      `INSERT INTO learned_qa_cache
       (hotel_id, question, question_embedding, answer, intent, hits, last_hit_at, created_at)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
    ).run(hotelId, q, encodeEmbedding(qVec), a, intent, now, now);
  }
}

/**
 * Stats for admin UI.
 */
export function getLearningStats(hotelId: number) {
  const total = db
    .prepare(`SELECT COUNT(*) as n FROM learned_qa_cache WHERE hotel_id = ?`)
    .get(hotelId) as any;
  const promoted = db
    .prepare(`SELECT COUNT(*) as n FROM learned_qa_cache WHERE hotel_id = ? AND hits >= ?`)
    .get(hotelId, MIN_HITS) as any;
  const topRow = db
    .prepare(
      `SELECT question, answer, intent, hits FROM learned_qa_cache
       WHERE hotel_id = ? ORDER BY hits DESC, last_hit_at DESC LIMIT 10`,
    )
    .all(hotelId);
  return {
    total: total?.n || 0,
    promoted: promoted?.n || 0,
    serve_threshold: SERVE_THRESHOLD,
    dedup_threshold: DEDUP_THRESHOLD,
    min_hits: MIN_HITS,
    top: topRow,
  };
}

/**
 * Prune old unconfident candidates. Call from scheduler nightly.
 */
export function pruneLearned(): number {
  const cutoff = Date.now() - 90 * 24 * 3600 * 1000;
  const res = db
    .prepare(
      `DELETE FROM learned_qa_cache WHERE hits < ? AND last_hit_at < ?`,
    )
    .run(MIN_HITS, cutoff);
  return res.changes || 0;
}

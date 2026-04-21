/**
 * Intent Matcher — core của Smart Training Pipeline v8.
 *
 * Given customer message, search qa_training_cache for similar question.
 * Nếu match ≥ threshold (default 0.7) AND tier is trusted/approved → return cached response.
 * Else → caller gọi smart AI cascade, rồi save kết quả về đây.
 *
 * Embedding: MiniLM ONNX local (384-dim).
 * Storage: SQLite blob (encoded Float32Array).
 *
 * Tiers:
 *   - pending: vừa generate, chờ admin duyệt
 *   - approved: admin đã OK, available for match
 *   - trusted: approved + nhiều hits + positive feedback → match ưu tiên
 *   - rejected: admin từ chối, vẫn giữ để phân tích pattern
 *   - blacklisted: match sẽ refuse, dùng cho spam/troll pattern
 */
import crypto from 'crypto';
import { db, getSetting } from '../db';
import { embed, cosine, encodeEmbedding, decodeEmbedding } from './embedder';

export const MATCH_THRESHOLD_DEFAULT = 0.7;
export const MATCH_THRESHOLD = MATCH_THRESHOLD_DEFAULT;  // backward compat export
const SCAN_LIMIT = 200;       // Số QA entries quét mỗi lần (top recent)
const DEDUPE_SIMILARITY = 0.95; // Trên ngưỡng này coi là câu y hệt

/** Dynamic threshold — admin có thể chỉnh qua /api/training/threshold (per-hotel) */
export function getMatchThreshold(hotelId?: number): number {
  try {
    const v = getSetting('qa_match_threshold', hotelId);
    if (v) {
      const n = parseFloat(v);
      if (!isNaN(n) && n >= 0.5 && n <= 0.95) return n;
    }
  } catch {}
  return MATCH_THRESHOLD_DEFAULT;
}

export interface MatchResult {
  matched: boolean;
  confidence: number;
  qa_cache_id?: number;
  cached_response?: string;
  cached_question?: string;
  tier?: string;
  should_use_cached: boolean;  // true nếu confidence ≥ threshold VÀ tier thuộc trusted/approved
  all_candidates?: Array<{ id: number; confidence: number; tier: string; question: string }>;
}

export type AIProvider = 'gemini_flash' | 'gemini_pro' | 'chatgpt' | 'qwen' | 'gemma' | 'cache' | 'admin_edit';

function hashQuestion(q: string): string {
  return crypto.createHash('sha256').update(q.trim().toLowerCase()).digest('hex').slice(0, 32);
}

export async function matchIntent(opts: {
  hotelId: number;
  customerMessage: string;
  minConfidence?: number;
}): Promise<MatchResult> {
  const minConf = opts.minConfidence ?? getMatchThreshold(opts.hotelId);

  if (!opts.customerMessage || opts.customerMessage.trim().length < 3) {
    return { matched: false, confidence: 0, should_use_cached: false };
  }

  // Embed customer message
  const queryVec = await embed(opts.customerMessage);
  if (!queryVec) return { matched: false, confidence: 0, should_use_cached: false };

  // Load recent trusted/approved/pending (pending cho dedupe; blacklist/rejected bỏ qua)
  const rows = db.prepare(
    `SELECT id, customer_question, ai_response, question_embedding, tier, hits_count, feedback_score
     FROM qa_training_cache
     WHERE hotel_id = ?
       AND tier IN ('trusted', 'approved', 'pending')
       AND question_embedding IS NOT NULL
     ORDER BY
       CASE tier WHEN 'trusted' THEN 1 WHEN 'approved' THEN 2 WHEN 'pending' THEN 3 END,
       feedback_score DESC,
       hits_count DESC
     LIMIT ?`
  ).all(opts.hotelId, SCAN_LIMIT) as any[];

  if (rows.length === 0) return { matched: false, confidence: 0, should_use_cached: false };

  let bestIdx = -1;
  let bestSim = 0;
  const candidates: MatchResult['all_candidates'] = [];

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    try {
      const vec = decodeEmbedding(r.question_embedding as Buffer);
      const sim = cosine(queryVec, vec);
      candidates.push({ id: r.id, confidence: +sim.toFixed(3), tier: r.tier, question: r.customer_question });
      if (sim > bestSim) {
        bestSim = sim;
        bestIdx = i;
      }
    } catch { /* skip corrupt embedding */ }
  }

  candidates.sort((a, b) => b.confidence - a.confidence);

  if (bestIdx < 0) return { matched: false, confidence: 0, should_use_cached: false, all_candidates: candidates.slice(0, 5) };

  const best = rows[bestIdx];
  const useable = bestSim >= minConf && (best.tier === 'trusted' || best.tier === 'approved');

  return {
    matched: bestSim >= minConf,
    confidence: +bestSim.toFixed(3),
    qa_cache_id: best.id,
    cached_response: best.ai_response,
    cached_question: best.customer_question,
    tier: best.tier,
    should_use_cached: useable,
    all_candidates: candidates.slice(0, 5),
  };
}

/**
 * Save new Q&A pair to cache. Dedupe: nếu có entry tương tự ≥ 0.95, merge hits thay vì tạo mới.
 */
export async function saveNewQA(opts: {
  hotelId: number;
  question: string;
  response: string;
  provider: AIProvider;
  model?: string;
  tokens?: number;
  intentCategory?: string;
  contextTags?: string[];
  initialTier?: 'pending' | 'approved';  // Admin có thể preseed 'approved' khi manual add
}): Promise<{ qa_cache_id: number; is_new: boolean }> {
  const now = Date.now();
  const hash = hashQuestion(opts.question);

  // Dedupe by exact hash
  const existingByHash = db.prepare(
    `SELECT id FROM qa_training_cache WHERE hotel_id = ? AND question_hash = ? LIMIT 1`
  ).get(opts.hotelId, hash) as any;
  if (existingByHash) {
    // Increment hits, update last_hit
    db.prepare(`UPDATE qa_training_cache SET hits_count = hits_count + 1, last_hit_at = ? WHERE id = ?`)
      .run(now, existingByHash.id);
    return { qa_cache_id: existingByHash.id, is_new: false };
  }

  // Embed question
  const vec = await embed(opts.question);
  const embeddingBlob = vec ? encodeEmbedding(vec) : null;

  // Dedupe by similarity (0.95+) — merge hits
  if (vec) {
    const scan = db.prepare(
      `SELECT id, question_embedding FROM qa_training_cache
       WHERE hotel_id = ? AND tier IN ('trusted', 'approved', 'pending')
         AND question_embedding IS NOT NULL
       ORDER BY created_at DESC LIMIT 100`
    ).all(opts.hotelId) as any[];
    for (const r of scan) {
      try {
        const v2 = decodeEmbedding(r.question_embedding as Buffer);
        if (cosine(vec, v2) >= DEDUPE_SIMILARITY) {
          db.prepare(`UPDATE qa_training_cache SET hits_count = hits_count + 1, last_hit_at = ? WHERE id = ?`)
            .run(now, r.id);
          return { qa_cache_id: r.id, is_new: false };
        }
      } catch {}
    }
  }

  // Insert new
  const tier = opts.initialTier || 'pending';
  const result = db.prepare(
    `INSERT INTO qa_training_cache (
      hotel_id, customer_question, question_embedding, question_hash,
      ai_response, ai_provider, ai_model, ai_tokens_used,
      tier, hits_count, intent_category, context_tags,
      created_at, last_hit_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`
  ).run(
    opts.hotelId,
    opts.question.trim(),
    embeddingBlob,
    hash,
    opts.response.trim(),
    opts.provider,
    opts.model || null,
    opts.tokens || 0,
    tier,
    opts.intentCategory || null,
    opts.contextTags ? JSON.stringify(opts.contextTags) : null,
    now, now,
  );

  return { qa_cache_id: result.lastInsertRowid as number, is_new: true };
}

/**
 * Approve pending Q&A → tier=approved (bot sẽ dùng match từ giờ).
 */
export function approveQA(qa_cache_id: number, admin_user_id: number, notes?: string, edited_response?: string): void {
  const now = Date.now();
  const params: any[] = [];
  let sql = `UPDATE qa_training_cache SET tier = 'approved', approved_at = ?, last_reviewed_at = ?, admin_user_id = ?`;
  params.push(now, now, admin_user_id);
  if (notes) { sql += `, admin_notes = ?`; params.push(notes); }
  if (edited_response) { sql += `, admin_edited_response = ?, ai_response = ?`; params.push(edited_response, edited_response); }
  sql += ` WHERE id = ?`;
  params.push(qa_cache_id);
  db.prepare(sql).run(...params);
}

export function rejectQA(qa_cache_id: number, admin_user_id: number, reason: string): void {
  db.prepare(
    `UPDATE qa_training_cache SET tier = 'rejected', last_reviewed_at = ?, admin_user_id = ?, admin_notes = ? WHERE id = ?`
  ).run(Date.now(), admin_user_id, reason, qa_cache_id);
}

export function blacklistQA(qa_cache_id: number, admin_user_id: number, reason?: string): void {
  db.prepare(
    `UPDATE qa_training_cache SET tier = 'blacklisted', last_reviewed_at = ?, admin_user_id = ?, admin_notes = ? WHERE id = ?`
  ).run(Date.now(), admin_user_id, reason || 'blacklisted', qa_cache_id);
}

/**
 * Auto-promote approved → trusted khi đủ điều kiện
 */
export function autoPromoteTrusted(): number {
  const result = db.prepare(
    `UPDATE qa_training_cache
     SET tier = 'trusted'
     WHERE tier = 'approved'
       AND hits_count >= 10
       AND feedback_score >= 5
       AND negative_feedback < positive_feedback / 2`
  ).run();
  return result.changes;
}

/**
 * Auto-demote approved/trusted → pending khi feedback xấu
 */
export function autoDemoteOnBadFeedback(): number {
  const result = db.prepare(
    `UPDATE qa_training_cache
     SET tier = 'pending'
     WHERE tier IN ('approved', 'trusted')
       AND feedback_score <= -10`
  ).run();
  return result.changes;
}

/**
 * Stats for admin dashboard
 */
export function getTrainingStats(hotelId?: number): any {
  const filter = hotelId ? `WHERE hotel_id = ?` : '';
  const params = hotelId ? [hotelId] : [];
  const total = db.prepare(`SELECT tier, COUNT(*) as n FROM qa_training_cache ${filter} GROUP BY tier`).all(...params);
  const providers = db.prepare(`SELECT ai_provider, COUNT(*) as n, SUM(ai_tokens_used) as tokens FROM qa_training_cache ${filter} GROUP BY ai_provider`).all(...params);
  const hits_total = db.prepare(`SELECT SUM(hits_count) as total FROM qa_training_cache ${filter}`).get(...params) as any;
  const recent_pending = db.prepare(`SELECT COUNT(*) as n FROM qa_training_cache ${filter} ${filter ? 'AND' : 'WHERE'} tier = 'pending' AND created_at > ?`).get(...params, Date.now() - 24 * 3600_000) as any;
  return {
    by_tier: total,
    by_provider: providers,
    total_hits: hits_total?.total || 0,
    pending_last_24h: recent_pending?.n || 0,
  };
}

/**
 * Self-test — called trên boot để verify matcher works
 */
export async function selfTest(): Promise<void> {
  const sampleQ = 'Khách sạn có wifi miễn phí không?';
  try {
    const vec = await embed(sampleQ);
    if (!vec) {
      console.warn('[intent-matcher] self-test: embedder not ready');
      return;
    }
    if (vec.length !== 384 && vec.length !== 768) {
      console.warn('[intent-matcher] self-test: unexpected embedding dim:', vec.length);
    }
    console.log('[intent-matcher] self-test OK (embedder dim=' + vec.length + ', MATCH_THRESHOLD=' + MATCH_THRESHOLD + ')');
  } catch (e: any) {
    console.warn('[intent-matcher] self-test fail:', e?.message);
  }
}

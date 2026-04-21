/**
 * FAQ Discovery — phân tích conversation_memory để tìm câu hỏi khách
 * hay hỏi mà bot CHƯA có trong qa_training_cache.
 *
 * Flow:
 *   1. Lấy user messages từ conversation_memory (N ngày)
 *   2. Filter: chỉ message LÀ CÂU HỎI (có dấu ?, kết thúc bằng "không/nào/ạ")
 *   3. Cluster theo embedding similarity (cosine >= 0.82)
 *   4. Xếp cluster theo size (cluster lớn = hỏi nhiều)
 *   5. Check mỗi cluster: đã có trong qa_training_cache chưa?
 *   6. Trả danh sách cluster "cần admin duyệt" — centroid + count + status
 */
import { db } from '../db';
import { embed, cosine } from './embedder';

export interface FaqCluster {
  id: string;                        // hash của centroid question
  representative_question: string;   // câu đại diện (thường là câu đầu tiên)
  variants: string[];                // các câu similar (tối đa 5 mẫu)
  frequency: number;                 // số lần khách hỏi
  unique_users: number;
  last_asked_at: number;
  in_cache: boolean;                 // đã có trong qa_training_cache chưa
  cache_match?: {                    // nếu in_cache=true
    qa_cache_id: number;
    tier: string;
    confidence: number;
  };
  suggested_intent?: string;         // guess intent từ rule-based
}

const QUESTION_PATTERN = /(không\??|nào\??|ạ\?|vậy\?|thế\?|\?|mấy|bao nhiêu|sao|đâu)\s*[\.\!]?\s*$/i;
const MIN_QUESTION_LEN = 5;
const MAX_QUESTION_LEN = 300;
const CLUSTER_THRESHOLD = 0.82;

/** Lấy user questions từ conversation_memory */
function fetchUserQuestions(hotelId: number | undefined, sinceTs: number, limit = 1000): Array<{
  sender_id: string;
  message: string;
  created_at: number;
}> {
  const hotelFilter = hotelId
    ? `AND EXISTS (SELECT 1 FROM pages p WHERE p.id = cm.page_id AND p.hotel_id = ?)`
    : '';
  const params: any[] = [sinceTs];
  if (hotelId) params.push(hotelId);
  params.push(limit);

  return db.prepare(
    `SELECT sender_id, message, created_at
     FROM conversation_memory cm
     WHERE role = 'user'
       AND created_at >= ?
       AND sender_id NOT LIKE 'playground_%'
       AND LENGTH(message) BETWEEN ${MIN_QUESTION_LEN} AND ${MAX_QUESTION_LEN}
       ${hotelFilter}
     ORDER BY created_at DESC
     LIMIT ?`
  ).all(...params) as any[];
}

/** Check 1 question xem có trong qa_training_cache không */
async function matchInCache(question: string, hotelId: number | undefined): Promise<FaqCluster['cache_match'] | undefined> {
  try {
    const vec = await embed(question);
    if (!vec) return undefined;
    // Query qa_training_cache rows (chỉ approved/trusted — pending chưa "có thật")
    const whereHotel = hotelId ? `hotel_id = ${hotelId} AND` : '';
    const rows = db.prepare(
      `SELECT id, customer_question, question_embedding, tier
       FROM qa_training_cache
       WHERE ${whereHotel} tier IN ('approved', 'trusted', 'pending')
         AND question_embedding IS NOT NULL
       LIMIT 200`
    ).all() as any[];

    const { decodeEmbedding } = require('./embedder');
    let bestSim = 0;
    let best: any = null;
    for (const r of rows) {
      try {
        const v = decodeEmbedding(r.question_embedding as Buffer);
        const sim = cosine(vec, v);
        if (sim > bestSim) { bestSim = sim; best = r; }
      } catch {}
    }
    if (best && bestSim >= 0.7) {
      return { qa_cache_id: best.id, tier: best.tier, confidence: +bestSim.toFixed(3) };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/** Guess intent từ rule-based */
function guessIntent(text: string): string {
  const t = text.toLowerCase();
  if (/(giá|bao nhiêu|tiền|price|cost)/.test(t)) return 'price_q';
  if (/(phòng trống|còn phòng|available|book)/.test(t)) return 'availability_q';
  if (/(wifi|parking|đậu xe|hồ bơi|pool|gym|tiện nghi)/.test(t)) return 'amenity_q';
  if (/(địa chỉ|ở đâu|location|chi nhánh|address)/.test(t)) return 'location_q';
  if (/(check-?in|nhận phòng|trả phòng|check-?out)/.test(t)) return 'policy_q';
  if (/(giờ|hourly|theo giờ)/.test(t)) return 'hourly_q';
  if (/(tháng|monthly|thuê tháng|dài hạn)/.test(t)) return 'monthly_q';
  if (/(ảnh|hình|photo|image)/.test(t)) return 'photos_q';
  if (/(khuyến mãi|sale|giảm giá|voucher)/.test(t)) return 'promo_q';
  return 'general_q';
}

/** Normalize question cho hash key */
function normalizeQuestion(q: string): string {
  return q.toLowerCase().trim().replace(/[!?.,]/g, '').replace(/\s+/g, ' ');
}

/**
 * Main: discover FAQs
 */
export async function discoverFaqs(opts: {
  hotelId?: number;
  days?: number;
  minFrequency?: number;
  limit?: number;
} = {}): Promise<{
  total_user_questions: number;
  total_clusters: number;
  uncached_clusters: number;
  cached_but_pending_clusters: number;
  suggestions: FaqCluster[];
}> {
  const days = opts.days || 14;
  const minFreq = opts.minFrequency || 2;
  const maxReturn = opts.limit || 30;
  const since = Date.now() - days * 24 * 3600_000;

  // 1. Fetch user messages
  const messages = fetchUserQuestions(opts.hotelId, since, 2000);

  // 2. Filter questions only
  const questions = messages.filter(m =>
    QUESTION_PATTERN.test(m.message.trim()) || m.message.includes('?')
  );

  if (questions.length === 0) {
    return {
      total_user_questions: messages.length,
      total_clusters: 0,
      uncached_clusters: 0,
      cached_but_pending_clusters: 0,
      suggestions: [],
    };
  }

  // 3. Embed all questions (batch, 1 at a time — MiniLM local is fast)
  const embedded: Array<{ msg: typeof messages[0]; vec: Float32Array }> = [];
  for (const q of questions) {
    const vec = await embed(q.message);
    if (vec) embedded.push({ msg: q, vec });
  }

  // 4. Cluster by cosine similarity
  type Cluster = {
    representative: string;
    variants: string[];
    uniqueUsers: Set<string>;
    frequency: number;
    lastAskedAt: number;
    centroid: Float32Array;
  };
  const clusters: Cluster[] = [];

  for (const item of embedded) {
    let bestCluster: Cluster | null = null;
    let bestSim = 0;
    for (const c of clusters) {
      const sim = cosine(item.vec, c.centroid);
      if (sim >= CLUSTER_THRESHOLD && sim > bestSim) {
        bestSim = sim;
        bestCluster = c;
      }
    }
    if (bestCluster) {
      bestCluster.frequency++;
      bestCluster.uniqueUsers.add(item.msg.sender_id);
      if (bestCluster.variants.length < 5 && !bestCluster.variants.includes(item.msg.message)) {
        bestCluster.variants.push(item.msg.message);
      }
      if (item.msg.created_at > bestCluster.lastAskedAt) {
        bestCluster.lastAskedAt = item.msg.created_at;
      }
      // Không update centroid để đơn giản (có thể update = running average sau)
    } else {
      clusters.push({
        representative: item.msg.message,
        variants: [item.msg.message],
        uniqueUsers: new Set([item.msg.sender_id]),
        frequency: 1,
        lastAskedAt: item.msg.created_at,
        centroid: item.vec,
      });
    }
  }

  // 5. Filter + sort by frequency desc
  const significantClusters = clusters
    .filter(c => c.frequency >= minFreq)
    .sort((a, b) => b.frequency - a.frequency)
    .slice(0, maxReturn);

  // 6. Check cache match for each
  const suggestions: FaqCluster[] = [];
  let uncached = 0;
  let cachedPending = 0;
  for (const c of significantClusters) {
    const cacheMatch = await matchInCache(c.representative, opts.hotelId);
    const inCache = !!cacheMatch && (cacheMatch.tier === 'approved' || cacheMatch.tier === 'trusted');
    if (!inCache) uncached++;
    if (cacheMatch?.tier === 'pending') cachedPending++;

    suggestions.push({
      id: require('crypto').createHash('sha1').update(normalizeQuestion(c.representative)).digest('hex').slice(0, 12),
      representative_question: c.representative,
      variants: c.variants,
      frequency: c.frequency,
      unique_users: c.uniqueUsers.size,
      last_asked_at: c.lastAskedAt,
      in_cache: inCache,
      cache_match: cacheMatch,
      suggested_intent: guessIntent(c.representative),
    });
  }

  return {
    total_user_questions: questions.length,
    total_clusters: clusters.length,
    uncached_clusters: uncached,
    cached_but_pending_clusters: cachedPending,
    suggestions,
  };
}

/**
 * Detect similar entries trong qa_training_cache (có thể merge)
 */
export async function detectSimilarEntries(hotelId: number, threshold = 0.9): Promise<Array<{
  a: { id: number; question: string; tier: string };
  b: { id: number; question: string; tier: string };
  similarity: number;
}>> {
  const rows = db.prepare(
    `SELECT id, customer_question, question_embedding, tier
     FROM qa_training_cache
     WHERE hotel_id = ? AND question_embedding IS NOT NULL
     ORDER BY id ASC`
  ).all(hotelId) as any[];

  const { decodeEmbedding } = require('./embedder');
  const pairs: any[] = [];
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      try {
        const va = decodeEmbedding(rows[i].question_embedding as Buffer);
        const vb = decodeEmbedding(rows[j].question_embedding as Buffer);
        const sim = cosine(va, vb);
        if (sim >= threshold) {
          pairs.push({
            a: { id: rows[i].id, question: rows[i].customer_question, tier: rows[i].tier },
            b: { id: rows[j].id, question: rows[j].customer_question, tier: rows[j].tier },
            similarity: +sim.toFixed(3),
          });
        }
      } catch {}
    }
  }
  pairs.sort((a, b) => b.similarity - a.similarity);
  return pairs.slice(0, 50);   // top 50 pairs
}

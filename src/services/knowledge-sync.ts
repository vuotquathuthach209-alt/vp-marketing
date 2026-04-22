/**
 * Knowledge Sync — populate Tier 2 (RAG embeddings) + Tier 3 (Wiki) từ Tier 1 (SQL facts).
 *
 * Architecture: xem .claude/skills/sonder-ecosystem/SKILL.md
 *
 * Flow:
 *   1. Read hotel_profile + hotel_room_catalog + hotel_amenities + hotel_policies
 *   2. Generate chunks theo category (description / amenity / usp / nearby / policy)
 *   3. Embed MiniLM → save hotel_knowledge_embeddings
 *   4. Also populate Tier 3 wiki per hotel (auto slug per namespace)
 *
 * Cron: daily 3:00 AM (sau retention cleanup 2:00 AM)
 * Manual trigger: POST /api/knowledge/rebuild/:hotel_id
 */

import { db } from '../db';
import { embed, encodeEmbedding } from './embedder';

export type ChunkType =
  | 'description'      // mô tả chung
  | 'usp'              // điểm mạnh
  | 'amenity'          // mỗi amenity 1 chunk
  | 'nearby'           // landmark xung quanh
  | 'policy'           // chính sách
  | 'room_feature'     // đặc điểm phòng
  | 'faq';             // FAQ

interface Chunk {
  chunk_type: ChunkType;
  chunk_text: string;
  source?: string;
}

/* ═══════════════════════════════════════════
   Chunk generation từ structured data
   ═══════════════════════════════════════════ */

function chunksForHotel(hotelId: number): Chunk[] {
  const chunks: Chunk[] = [];

  // 1. Hotel profile
  const profile = db.prepare(
    `SELECT name_canonical, property_type, city, district, address, star_rating,
            ai_summary_vi, usp_top3, target_segment,
            monthly_price_from, monthly_price_to, min_stay_months, deposit_months,
            utilities_included, full_kitchen, washing_machine
     FROM hotel_profile WHERE hotel_id = ?`
  ).get(hotelId) as any;

  if (!profile) return chunks;

  // Description chunk
  const descParts: string[] = [];
  descParts.push(`${profile.name_canonical}`);
  if (profile.property_type) descParts.push(`thuộc loại ${profile.property_type}`);
  if (profile.star_rating) descParts.push(`đạt ${profile.star_rating} sao`);
  if (profile.district && profile.city) descParts.push(`tọa lạc tại ${profile.district}, ${profile.city}`);
  if (profile.address) descParts.push(`địa chỉ ${profile.address}`);
  if (profile.ai_summary_vi) descParts.push(profile.ai_summary_vi);
  if (profile.target_segment) descParts.push(`phù hợp đối tượng ${profile.target_segment}`);
  chunks.push({
    chunk_type: 'description',
    chunk_text: descParts.join('. ') + '.',
    source: 'hotel_profile',
  });

  // USP chunks
  try {
    const usps = JSON.parse(profile.usp_top3 || '[]');
    for (const usp of usps) {
      if (typeof usp === 'string' && usp.length > 5) {
        chunks.push({ chunk_type: 'usp', chunk_text: `Điểm mạnh của ${profile.name_canonical}: ${usp}.`, source: 'usp_top3' });
      }
    }
  } catch {}

  // 2. Rooms
  const rooms = db.prepare(
    `SELECT display_name_vi, max_guests, bed_config, size_m2, price_weekday, price_weekend, price_hourly, amenities
     FROM hotel_room_catalog WHERE hotel_id = ?`
  ).all(hotelId) as any[];
  for (const r of rooms) {
    const parts: string[] = [`Phòng ${r.display_name_vi} tại ${profile.name_canonical}`];
    if (r.max_guests) parts.push(`tối đa ${r.max_guests} khách`);
    if (r.bed_config) parts.push(r.bed_config);
    if (r.size_m2) parts.push(`${r.size_m2}m²`);
    if (r.price_weekday) parts.push(`giá ${r.price_weekday.toLocaleString('vi-VN')}₫/đêm`);
    if (r.price_weekend && r.price_weekend !== r.price_weekday) parts.push(`cuối tuần ${r.price_weekend.toLocaleString('vi-VN')}₫`);
    if (r.price_hourly) parts.push(`theo giờ ${r.price_hourly.toLocaleString('vi-VN')}₫/giờ`);
    chunks.push({
      chunk_type: 'room_feature',
      chunk_text: parts.join(', ') + '.',
      source: 'hotel_room_catalog',
    });
    // Amenities per room
    try {
      const amenities = JSON.parse(r.amenities || '[]');
      if (Array.isArray(amenities) && amenities.length) {
        chunks.push({
          chunk_type: 'amenity',
          chunk_text: `Phòng ${r.display_name_vi} tại ${profile.name_canonical} có: ${amenities.join(', ')}.`,
          source: 'room_amenities',
        });
      }
    } catch {}
  }

  // 3. Hotel-level amenities
  try {
    const amenities = db.prepare(`SELECT amenity_name, amenity_category FROM hotel_amenities WHERE hotel_id = ?`).all(hotelId) as any[];
    // Group by category
    const byCat: Record<string, string[]> = {};
    for (const a of amenities) {
      const cat = a.amenity_category || 'general';
      if (!byCat[cat]) byCat[cat] = [];
      byCat[cat].push(a.amenity_name);
    }
    for (const [cat, names] of Object.entries(byCat)) {
      chunks.push({
        chunk_type: 'amenity',
        chunk_text: `${profile.name_canonical} có các tiện nghi ${cat}: ${names.join(', ')}.`,
        source: 'hotel_amenities',
      });
    }
  } catch {}

  // 4. Policies
  try {
    const policies = db.prepare(
      `SELECT checkin_time, checkout_time, cancellation_policy, pet_policy, smoking_policy,
              age_restriction, child_policy, payment_methods
       FROM hotel_policies WHERE hotel_id = ?`
    ).get(hotelId) as any;
    if (policies) {
      const pparts: string[] = [];
      if (policies.checkin_time) pparts.push(`Check-in từ ${policies.checkin_time}`);
      if (policies.checkout_time) pparts.push(`check-out đến ${policies.checkout_time}`);
      if (policies.cancellation_policy) pparts.push(`Hủy phòng: ${policies.cancellation_policy}`);
      if (policies.pet_policy) pparts.push(`Thú cưng: ${policies.pet_policy}`);
      if (policies.smoking_policy) pparts.push(`Hút thuốc: ${policies.smoking_policy}`);
      if (policies.child_policy) pparts.push(`Trẻ em: ${policies.child_policy}`);
      if (policies.payment_methods) pparts.push(`Thanh toán: ${policies.payment_methods}`);
      if (pparts.length) {
        chunks.push({
          chunk_type: 'policy',
          chunk_text: `Chính sách ${profile.name_canonical}: ${pparts.join('. ')}.`,
          source: 'hotel_policies',
        });
      }
    }
  } catch {}

  // 5. Monthly-specific info (CHDV)
  if (profile.property_type === 'apartment' && profile.monthly_price_from) {
    const parts = [`${profile.name_canonical} cho thuê tháng`];
    parts.push(`giá từ ${profile.monthly_price_from.toLocaleString('vi-VN')}₫/tháng`);
    if (profile.monthly_price_to) parts.push(`đến ${profile.monthly_price_to.toLocaleString('vi-VN')}₫/tháng`);
    if (profile.min_stay_months) parts.push(`thuê tối thiểu ${profile.min_stay_months} tháng`);
    if (profile.deposit_months) parts.push(`đặt cọc ${profile.deposit_months} tháng`);
    const services: string[] = [];
    if (profile.utilities_included) services.push('điện nước bao trọn');
    if (profile.full_kitchen) services.push('bếp đầy đủ');
    if (profile.washing_machine) services.push('máy giặt riêng');
    if (services.length) parts.push(`bao gồm ${services.join(', ')}`);
    chunks.push({
      chunk_type: 'description',
      chunk_text: parts.join(', ') + '.',
      source: 'monthly_apartment',
    });
  }

  // 6. Nearby landmarks (từ hotel_profile.nearby_landmarks JSON array nếu có)
  try {
    const pf = db.prepare(`SELECT nearby_landmarks FROM hotel_profile WHERE hotel_id = ?`).get(hotelId) as any;
    if (pf?.nearby_landmarks) {
      const landmarks = JSON.parse(pf.nearby_landmarks);
      if (Array.isArray(landmarks) && landmarks.length) {
        chunks.push({
          chunk_type: 'nearby',
          chunk_text: `${profile.name_canonical} gần các địa điểm: ${landmarks.join(', ')}.`,
          source: 'nearby_landmarks',
        });
      }
    }
  } catch {}

  return chunks;
}

/* ═══════════════════════════════════════════
   Embed + store
   ═══════════════════════════════════════════ */

export async function rebuildEmbeddings(hotelId: number): Promise<{ chunks_deleted: number; chunks_created: number; duration_ms: number }> {
  const t0 = Date.now();
  // Clear old embeddings for this hotel
  const delResult = db.prepare(`DELETE FROM hotel_knowledge_embeddings WHERE hotel_id = ?`).run(hotelId);

  // Generate new chunks
  const chunks = chunksForHotel(hotelId);
  const now = Date.now();
  let created = 0;

  for (const c of chunks) {
    try {
      const vec = await embed(c.chunk_text);
      if (!vec) continue;
      const embeddingBuffer = encodeEmbedding(vec);
      db.prepare(
        `INSERT INTO hotel_knowledge_embeddings (hotel_id, chunk_type, chunk_text, embedding, created_at)
         VALUES (?, ?, ?, ?, ?)`
      ).run(hotelId, c.chunk_type, c.chunk_text, embeddingBuffer, now);
      created++;
    } catch (e: any) {
      console.warn(`[knowledge-sync] embed fail for hotel ${hotelId}:`, e?.message);
    }
  }

  return {
    chunks_deleted: delResult.changes,
    chunks_created: created,
    duration_ms: Date.now() - t0,
  };
}

/**
 * Rebuild embeddings cho TẤT CẢ hotels active.
 */
export async function rebuildAllEmbeddings(): Promise<{
  hotels_processed: number;
  total_chunks: number;
  total_deleted: number;
  duration_ms: number;
}> {
  const t0 = Date.now();
  const hotels = db.prepare(
    `SELECT DISTINCT hp.hotel_id FROM hotel_profile hp
     WHERE EXISTS (SELECT 1 FROM mkt_hotels mh WHERE mh.ota_hotel_id = hp.hotel_id AND mh.status = 'active')`
  ).all() as any[];

  let totalCreated = 0;
  let totalDeleted = 0;
  for (const h of hotels) {
    try {
      const r = await rebuildEmbeddings(h.hotel_id);
      totalCreated += r.chunks_created;
      totalDeleted += r.chunks_deleted;
    } catch (e: any) {
      console.warn(`[knowledge-sync] rebuild hotel ${h.hotel_id} fail:`, e?.message);
    }
  }
  return {
    hotels_processed: hotels.length,
    total_chunks: totalCreated,
    total_deleted: totalDeleted,
    duration_ms: Date.now() - t0,
  };
}

/* ═══════════════════════════════════════════
   Query: semantic search across chunks
   ═══════════════════════════════════════════ */

import { decodeEmbedding, cosine } from './embedder';

export interface SemanticHit {
  hotel_id: number;
  hotel_name?: string;
  chunk_type: ChunkType;
  chunk_text: string;
  score: number;
}

/**
 * Semantic search: embed question + cosine với all chunks.
 * @param hotelIds — nếu truyền → chỉ search trong các hotels này; else all active
 */
export async function semanticSearch(
  query: string,
  opts: { hotelIds?: number[]; topK?: number; minScore?: number; chunkTypes?: ChunkType[] } = {},
): Promise<SemanticHit[]> {
  const topK = opts.topK || 5;
  const minScore = opts.minScore || 0.5;

  const queryVec = await embed(query);
  if (!queryVec) return [];

  let sql = `SELECT e.hotel_id, e.chunk_type, e.chunk_text, e.embedding, hp.name_canonical
             FROM hotel_knowledge_embeddings e
             LEFT JOIN hotel_profile hp ON hp.hotel_id = e.hotel_id`;
  const conditions: string[] = [];
  const params: any[] = [];
  if (opts.hotelIds?.length) {
    conditions.push(`e.hotel_id IN (${opts.hotelIds.map(() => '?').join(',')})`);
    params.push(...opts.hotelIds);
  } else {
    // Default: only active hotels
    conditions.push(`EXISTS (SELECT 1 FROM mkt_hotels mh WHERE mh.ota_hotel_id = e.hotel_id AND mh.status = 'active')`);
  }
  if (opts.chunkTypes?.length) {
    conditions.push(`e.chunk_type IN (${opts.chunkTypes.map(() => '?').join(',')})`);
    params.push(...opts.chunkTypes);
  }
  if (conditions.length) sql += ` WHERE ${conditions.join(' AND ')}`;

  const rows = db.prepare(sql).all(...params) as any[];

  const hits: SemanticHit[] = [];
  for (const row of rows) {
    try {
      const vec = decodeEmbedding(row.embedding);
      const score = cosine(queryVec, vec);
      if (score >= minScore) {
        hits.push({
          hotel_id: row.hotel_id,
          hotel_name: row.name_canonical,
          chunk_type: row.chunk_type,
          chunk_text: row.chunk_text,
          score,
        });
      }
    } catch {}
  }
  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, topK);
}

/* ═══════════════════════════════════════════
   Wiki (Tier 3) query
   ═══════════════════════════════════════════ */

export interface WikiResult {
  slug: string;
  namespace: string;
  title: string;
  content: string;
  tags?: string;
}

export function searchWiki(query: string, namespace?: string, limit = 3): WikiResult[] {
  try {
    let sql = `SELECT slug, namespace, title, content, tags FROM knowledge_wiki WHERE active = 1`;
    const params: any[] = [];
    if (namespace) { sql += ` AND namespace = ?`; params.push(namespace); }
    // Simple LIKE search — có thể upgrade FTS5 sau
    sql += ` AND (title LIKE ? OR content LIKE ? OR tags LIKE ?)`;
    const like = `%${query}%`;
    params.push(like, like, like);
    sql += ` LIMIT ?`;
    params.push(limit);
    return db.prepare(sql).all(...params) as any;
  } catch (e) {
    return [];
  }
}

/** Get all wiki entries in a namespace (admin view) */
export function getWikiByNamespace(namespace: string): WikiResult[] {
  try {
    return db.prepare(
      `SELECT slug, namespace, title, content, tags FROM knowledge_wiki WHERE namespace = ? AND active = 1`
    ).all(namespace) as any;
  } catch { return []; }
}

/* ═══════════════════════════════════════════
   Unified query — Tier 1 + 2 + 3 combined
   ═══════════════════════════════════════════ */

export interface UnifiedAnswer {
  tier: 'facts' | 'semantic' | 'wiki' | 'none';
  answer_snippets: string[];
  confidence: number;
  metadata?: any;
}

/**
 * Smart query resolver: auto pick tier based on query.
 * - Structured (price, availability, capacity) → Tier 1 SQL
 * - Semantic (descriptions, amenities vague) → Tier 2 RAG
 * - Meta (brand, policy global) → Tier 3 Wiki
 */
export async function unifiedQuery(
  query: string,
  hotelIds?: number[],
): Promise<UnifiedAnswer> {
  const q = query.toLowerCase();

  // Meta/wiki signals
  if (/\b(sonder là gì|giới thiệu|brand|thương hiệu|thanh toán|phương thức|chính sách chung|quy định)\b/i.test(q)) {
    const wikiHits = searchWiki(query);
    if (wikiHits.length) {
      return {
        tier: 'wiki',
        answer_snippets: wikiHits.map(h => `[${h.title}] ${h.content.slice(0, 300)}`),
        confidence: 0.8,
        metadata: { hits: wikiHits.length },
      };
    }
  }

  // Semantic
  const hits = await semanticSearch(query, { hotelIds, topK: 3, minScore: 0.4 });
  if (hits.length) {
    return {
      tier: 'semantic',
      answer_snippets: hits.map(h => `[${h.hotel_name || 'hotel-' + h.hotel_id}] ${h.chunk_text}`),
      confidence: hits[0].score,
      metadata: { top_score: hits[0].score, count: hits.length },
    };
  }

  return { tier: 'none', answer_snippets: [], confidence: 0 };
}

/**
 * Hotel Vectorizer — v26 Phase A
 *
 * Compute text embeddings cho hotels để support:
 *   1. Semantic distinctive search (find 3 nearest hotels → highlight USP)
 *   2. Natural language matching (khách nói "yên tĩnh" → match "view công viên")
 *   3. Content gen context enrichment
 *
 * Embedding model: Gemini embedding-001 (768 dims, đã có trong embedder.ts)
 * Storage: vector_embeddings table (BLOB Float32Array)
 *
 * Invalidation: re-compute khi scraped_at changed (auto-sync cron 6h).
 */

import crypto from 'crypto';
import { db } from '../../db';
import { embed, encodeEmbedding, decodeEmbedding, cosine } from '../embedder';

const MODEL_ID = 'gemini-embedding-001';
const DIMS = 768;

/* ═══════════════════════════════════════════
   SCHEMA (tự migrate)
   ═══════════════════════════════════════════ */

db.exec(`
CREATE TABLE IF NOT EXISTS vector_embeddings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_type TEXT NOT NULL,        -- 'hotel' | 'room' | 'post' | 'query'
  entity_id INTEGER NOT NULL,
  text_hash TEXT NOT NULL,          -- MD5 of input text (dedup + invalidation)
  vector BLOB NOT NULL,             -- Float32Array encoded
  model TEXT NOT NULL DEFAULT 'gemini-embedding-001',
  dims INTEGER NOT NULL DEFAULT 768,
  metadata_json TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE(entity_type, entity_id, model)
);
CREATE INDEX IF NOT EXISTS idx_vec_entity ON vector_embeddings(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_vec_hash ON vector_embeddings(text_hash);
`);

/* ═══════════════════════════════════════════
   BUILD HOTEL VECTOR TEXT
   ═══════════════════════════════════════════ */

/**
 * Build canonical text representation for hotel — features, USP, amenities, location.
 * Input cho embedding model.
 */
function buildHotelText(hotelId: number): string | null {
  const row = db.prepare(
    `SELECT name_canonical, city, district, address, property_type, star_rating,
            ai_summary_vi, usp_top3, nearby_landmarks, scraped_data, monthly_price_from
     FROM hotel_profile WHERE hotel_id = ?`
  ).get(hotelId) as any;
  if (!row) return null;

  const parts: string[] = [];
  parts.push(`Hotel: ${row.name_canonical}`);
  parts.push(`Loại: ${row.property_type || 'hotel'}`);
  if (row.district) parts.push(`Khu vực: ${row.district}, ${row.city || 'HCM'}`);
  if (row.address) parts.push(`Địa chỉ: ${row.address}`);
  if (row.star_rating) parts.push(`Hạng sao: ${row.star_rating}`);

  if (row.ai_summary_vi) parts.push(`Mô tả: ${row.ai_summary_vi}`);

  try {
    const usp = JSON.parse(row.usp_top3 || '[]');
    if (Array.isArray(usp) && usp.length) parts.push(`USP: ${usp.join(', ')}`);
  } catch {}

  try {
    const landmarks = JSON.parse(row.nearby_landmarks || '[]');
    if (Array.isArray(landmarks) && landmarks.length) {
      parts.push(`Gần: ${landmarks.slice(0, 5).join(', ')}`);
    }
  } catch {}

  // Pull from scraped_data for amenities + description
  try {
    const sd = JSON.parse(row.scraped_data || '{}');
    if (sd.description) parts.push(`Chi tiết: ${String(sd.description).slice(0, 500)}`);
    if (Array.isArray(sd.included_services) && sd.included_services.length) {
      parts.push(`Dịch vụ: ${sd.included_services.join(', ')}`);
    }
    if (sd.full_kitchen) parts.push('Có bếp đầy đủ');
    if (sd.washing_machine) parts.push('Có máy giặt riêng');
    if (sd.utilities_included) parts.push('Điện nước bao trọn');
  } catch {}

  if (row.monthly_price_from) parts.push(`Giá thuê tháng từ ${Math.round(row.monthly_price_from / 1_000_000)}tr`);

  return parts.join('\n');
}

function textHash(text: string): string {
  return crypto.createHash('md5').update(text).digest('hex').slice(0, 16);
}

/* ═══════════════════════════════════════════
   GET / COMPUTE VECTOR
   ═══════════════════════════════════════════ */

/**
 * Get vector cho hotel (compute + cache nếu chưa có hoặc text đã thay đổi).
 */
export async function getHotelVector(hotelId: number): Promise<Float32Array | null> {
  const text = buildHotelText(hotelId);
  if (!text) return null;
  const hash = textHash(text);

  // Check cache
  const cached = db.prepare(
    `SELECT vector, text_hash FROM vector_embeddings
     WHERE entity_type = 'hotel' AND entity_id = ? AND model = ?`
  ).get(hotelId, MODEL_ID) as any;

  if (cached && cached.text_hash === hash) {
    try { return decodeEmbedding(cached.vector as Buffer); } catch {}
  }

  // Compute
  const vec = await embed(text);
  if (!vec) return null;

  // Store
  try {
    const blob = encodeEmbedding(vec);
    db.prepare(`
      INSERT INTO vector_embeddings
        (entity_type, entity_id, text_hash, vector, model, dims, metadata_json, created_at)
      VALUES ('hotel', ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(entity_type, entity_id, model) DO UPDATE SET
        text_hash = excluded.text_hash,
        vector = excluded.vector,
        created_at = excluded.created_at
    `).run(hotelId, hash, blob, MODEL_ID, DIMS, JSON.stringify({ text_preview: text.slice(0, 120) }), Date.now());
  } catch (e: any) {
    console.warn('[vectorize] cache fail:', e?.message);
  }

  return vec;
}

/**
 * Batch: ensure tất cả active hotels có vector.
 * Gọi từ cron 6:30h sáng (sau OTA sync 6h, trước generate 7h).
 */
export async function vectorizeAllActiveHotels(): Promise<{ total: number; computed: number; cached: number; failed: number }> {
  const hotels = db.prepare(`
    SELECT DISTINCT hp.hotel_id FROM hotel_profile hp
    WHERE EXISTS (SELECT 1 FROM mkt_hotels mh WHERE mh.ota_hotel_id = hp.hotel_id AND mh.status = 'active')
  `).all() as any[];

  const result = { total: hotels.length, computed: 0, cached: 0, failed: 0 };
  for (const h of hotels) {
    const text = buildHotelText(h.hotel_id);
    if (!text) { result.failed++; continue; }
    const hash = textHash(text);
    const cached = db.prepare(
      `SELECT text_hash FROM vector_embeddings WHERE entity_type = 'hotel' AND entity_id = ? AND model = ?`
    ).get(h.hotel_id, MODEL_ID) as any;
    if (cached?.text_hash === hash) { result.cached++; continue; }

    const vec = await getHotelVector(h.hotel_id);
    if (vec) result.computed++;
    else result.failed++;
  }
  console.log(`[vectorize] hotels: total=${result.total} computed=${result.computed} cached=${result.cached} failed=${result.failed}`);
  return result;
}

/* ═══════════════════════════════════════════
   SEMANTIC OPERATIONS
   ═══════════════════════════════════════════ */

/**
 * Tìm N hotels tương tự với target hotel (theo vector cosine).
 * Dùng để xác định "distinctive aspects" cho caption generator.
 */
export async function findSimilarHotels(
  targetHotelId: number,
  limit: number = 3,
): Promise<Array<{ hotel_id: number; name: string; similarity: number }>> {
  const targetVec = await getHotelVector(targetHotelId);
  if (!targetVec) return [];

  // Fetch all cached hotel vectors (except target)
  const rows = db.prepare(`
    SELECT v.entity_id, v.vector, hp.name_canonical
    FROM vector_embeddings v
    JOIN hotel_profile hp ON hp.hotel_id = v.entity_id
    WHERE v.entity_type = 'hotel' AND v.model = ?
      AND v.entity_id != ?
  `).all(MODEL_ID, targetHotelId) as any[];

  const scored = rows.map(r => {
    try {
      const v = decodeEmbedding(r.vector as Buffer);
      return {
        hotel_id: r.entity_id,
        name: r.name_canonical,
        similarity: cosine(targetVec, v),
      };
    } catch { return null; }
  }).filter((x): x is NonNullable<typeof x> => !!x);

  scored.sort((a, b) => b.similarity - a.similarity);
  return scored.slice(0, limit);
}

/**
 * Semantic search: khách query natural language → top N hotels matching.
 * Dùng trong bot chatbot (phase 2) hoặc admin search.
 */
export async function semanticSearchHotels(
  query: string,
  limit: number = 5,
): Promise<Array<{ hotel_id: number; name: string; similarity: number }>> {
  const qVec = await embed(query);
  if (!qVec) return [];

  const rows = db.prepare(`
    SELECT v.entity_id, v.vector, hp.name_canonical
    FROM vector_embeddings v
    JOIN hotel_profile hp ON hp.hotel_id = v.entity_id
    WHERE v.entity_type = 'hotel' AND v.model = ?
  `).all(MODEL_ID) as any[];

  const scored = rows.map(r => {
    try {
      const v = decodeEmbedding(r.vector as Buffer);
      return {
        hotel_id: r.entity_id,
        name: r.name_canonical,
        similarity: cosine(qVec, v),
      };
    } catch { return null; }
  }).filter((x): x is NonNullable<typeof x> => !!x);

  scored.sort((a, b) => b.similarity - a.similarity);
  return scored.slice(0, limit);
}

/**
 * Get distinctive description — hotel đặc biệt gì so với top-similar competitors.
 * Phase 2: dùng LLM để generate dựa trên vector proximity. Phase 1: return raw metadata diff.
 */
export async function getDistinctiveAspects(hotelId: number): Promise<string | null> {
  const similar = await findSimilarHotels(hotelId, 3);
  if (similar.length === 0) return null;

  const target = db.prepare(
    `SELECT name_canonical, property_type, usp_top3, scraped_data FROM hotel_profile WHERE hotel_id = ?`
  ).get(hotelId) as any;
  if (!target) return null;

  const targetUsp = (() => { try { return JSON.parse(target.usp_top3 || '[]'); } catch { return []; } })();

  // Collect USPs of similar hotels
  const similarNames = similar.map(s => s.name).join(', ');
  const similarUsp = new Set<string>();
  for (const s of similar) {
    const row = db.prepare(`SELECT usp_top3 FROM hotel_profile WHERE hotel_id = ?`).get(s.hotel_id) as any;
    try {
      const usp = JSON.parse(row?.usp_top3 || '[]');
      if (Array.isArray(usp)) usp.forEach((u: string) => similarUsp.add(u));
    } catch {}
  }

  // Target's UNIQUE USPs (not in similar)
  const uniqueUsp = targetUsp.filter((u: string) => !similarUsp.has(u));
  if (uniqueUsp.length === 0) return `Các đối thủ gần giống: ${similarNames}. Cần highlight vị trí / giá / trải nghiệm riêng.`;

  return `Điểm riêng của ${target.name_canonical} so với ${similarNames}: ${uniqueUsp.slice(0, 3).join(', ')}`;
}

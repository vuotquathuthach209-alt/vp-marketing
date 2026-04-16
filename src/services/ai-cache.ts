import crypto from 'crypto';
import { db } from '../db';

/**
 * AI Response Cache — giảm chi phí AI bằng cách cache responses tương tự
 *
 * Strategy:
 * 1. Hash prompt → check cache (TTL 24h cho content, 6h cho reply)
 * 2. Template reuse: cùng topic + hotel → dùng lại template
 * 3. Batch: gom nhiều request cùng loại → 1 API call
 */

const CACHE_TTL = {
  content: 24 * 3600000,   // 24h cho content generation
  reply: 6 * 3600000,      // 6h cho smart reply
  template: 72 * 3600000,  // 72h cho templates
};

export function getCachedResponse(promptHash: string, type: string = 'content'): string | null {
  const ttl = CACHE_TTL[type as keyof typeof CACHE_TTL] || CACHE_TTL.content;
  const minTime = Date.now() - ttl;
  const row = db.prepare(`
    SELECT response FROM ai_cache WHERE prompt_hash = ? AND type = ? AND created_at > ?
  `).get(promptHash, type, minTime) as any;
  if (row) {
    db.prepare(`UPDATE ai_cache SET hit_count = hit_count + 1 WHERE prompt_hash = ? AND type = ?`).run(promptHash, type);
    return row.response;
  }
  return null;
}

export function setCachedResponse(promptHash: string, type: string, response: string, hotelId: number = 1): void {
  db.prepare(`
    INSERT OR REPLACE INTO ai_cache (prompt_hash, type, response, hotel_id, hit_count, created_at)
    VALUES (?, ?, ?, ?, 0, ?)
  `).run(promptHash, type, response, hotelId, Date.now());
}

export function hashPrompt(prompt: string): string {
  return crypto.createHash('md5').update(prompt).digest('hex');
}

// Template reuse: tìm template có sẵn cho topic tương tự
export function findSimilarTemplate(hotelId: number, topic: string): string | null {
  const minTime = Date.now() - CACHE_TTL.template;
  // Tìm bài đã đăng cùng hotel, cùng topic keyword
  const keywords = topic.toLowerCase().split(/\s+/).filter(w => w.length > 2).slice(0, 3);
  if (keywords.length === 0) return null;

  const likeClause = keywords.map(() => `LOWER(content) LIKE ?`).join(' AND ');
  const params = keywords.map(k => `%${k}%`);

  const row = db.prepare(`
    SELECT content FROM posts
    WHERE hotel_id = ? AND status = 'published' AND created_at > ? AND ${likeClause}
    ORDER BY created_at DESC LIMIT 1
  `).get(hotelId, minTime, ...params) as any;

  return row?.content || null;
}

// Cleanup expired cache entries (chạy trong scheduler)
export function cleanupAiCache(): number {
  const oldestKeep = Date.now() - CACHE_TTL.template; // keep max 72h
  const result = db.prepare(`DELETE FROM ai_cache WHERE created_at < ?`).run(oldestKeep);
  return result.changes;
}

// Stats
export function getAiCacheStats(): { total: number; hits: number; size_kb: number } {
  const stats = db.prepare(`
    SELECT COUNT(*) as total, SUM(hit_count) as hits, SUM(LENGTH(response)) as size_bytes
    FROM ai_cache
  `).get() as any;
  return {
    total: stats?.total || 0,
    hits: stats?.hits || 0,
    size_kb: Math.round((stats?.size_bytes || 0) / 1024),
  };
}

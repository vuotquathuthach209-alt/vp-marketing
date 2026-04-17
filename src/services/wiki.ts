import { db } from '../db';
import { embed, cosine, decodeEmbedding, isEmbedderReady } from './embedder';

interface WikiRow {
  id: number;
  namespace: string;
  slug: string;
  title: string;
  content: string;
  tags: string;
  always_inject: number;
  embedding: Buffer | null;
}

/**
 * Keyword scoring (fallback khi không có embedding).
 */
function tokenize(text: string): Set<string> {
  const lower = text
    .toLowerCase()
    .normalize('NFC')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ');
  const tokens = lower.split(/\s+/).filter((t) => t.length >= 3);
  return new Set(tokens);
}

function keywordScore(topic: string, row: WikiRow): number {
  const topicTokens = tokenize(topic);
  const rowText = `${row.title} ${row.content}`;
  const rowTokens = tokenize(rowText);

  let common = 0;
  for (const t of topicTokens) if (rowTokens.has(t)) common++;

  try {
    const tags: string[] = JSON.parse(row.tags || '[]');
    for (const tag of tags) {
      if (topic.toLowerCase().includes(tag.toLowerCase())) common += 3;
    }
  } catch {}

  return common;
}

/**
 * Semantic score: cosine similarity giữa topic embedding và row embedding.
 * Kết hợp với tag boost (+0.2 per tag match) để không mất hẳn keyword signal.
 */
function semanticScore(topicVec: Float32Array, topic: string, row: WikiRow): number {
  if (!row.embedding) return -1;
  const rowVec = decodeEmbedding(row.embedding);
  let s = cosine(topicVec, rowVec);
  try {
    const tags: string[] = JSON.parse(row.tags || '[]');
    for (const tag of tags) {
      if (topic.toLowerCase().includes(tag.toLowerCase())) s += 0.2;
    }
  } catch {}
  return s;
}

/**
 * Build context block từ knowledge wiki cho chủ đề cụ thể.
 *
 * Sprint 4: ưu tiên semantic search (embeddings) nếu có, fallback keyword.
 *
 * Chiến lược:
 * - Luôn include tất cả entry có always_inject=1
 * - Luôn include tất cả campaign đang active
 * - Với product/faq/lesson: top-N theo relevance (semantic nếu có, keyword nếu không)
 * - Giới hạn tổng context ~1500 chars
 */
export async function buildContext(topic: string, maxCharsOrHotelId?: number, maxChars2?: number): Promise<string> {
  // Overloaded: buildContext(topic, maxChars) OR buildContext(topic, hotelId, maxChars)
  let hotelId: number | undefined;
  let maxChars: number;
  if (maxChars2 !== undefined) {
    hotelId = maxCharsOrHotelId;
    maxChars = maxChars2;
  } else if (maxCharsOrHotelId !== undefined && maxCharsOrHotelId > 100) {
    maxChars = maxCharsOrHotelId; // It's maxChars (>100 means it's char count, not hotel_id)
  } else if (maxCharsOrHotelId !== undefined) {
    hotelId = maxCharsOrHotelId;
    maxChars = 1500;
  } else {
    maxChars = 1500;
  }

  const query = hotelId
    ? `SELECT id, namespace, slug, title, content, tags, always_inject, embedding FROM knowledge_wiki WHERE active = 1 AND hotel_id = ?`
    : `SELECT id, namespace, slug, title, content, tags, always_inject, embedding FROM knowledge_wiki WHERE active = 1`;
  const all = (hotelId ? db.prepare(query).all(hotelId) : db.prepare(query).all()) as WikiRow[];

  if (all.length === 0) return '';

  // Thử tạo embedding cho topic
  let topicVec: Float32Array | null = null;
  if (isEmbedderReady()) {
    topicVec = await embed(topic);
  }

  const scoreFn = (row: WikiRow): number => {
    if (topicVec && row.embedding) return semanticScore(topicVec, topic, row);
    return keywordScore(topic, row);
  };
  // Ngưỡng tối thiểu: semantic ~0.35, keyword >0
  const minScore = (row: WikiRow): number =>
    topicVec && row.embedding ? 0.35 : 0.5;

  const picked: WikiRow[] = [];
  const pickedIds = new Set<number>();

  for (const r of all) {
    if (r.always_inject === 1) {
      picked.push(r);
      pickedIds.add(r.id);
    }
  }

  // Các namespace "always include" nếu active: campaign, promotion (đang chạy)
  for (const r of all) {
    if ((r.namespace === 'campaign' || r.namespace === 'promotion') && !pickedIds.has(r.id)) {
      picked.push(r);
      pickedIds.add(r.id);
    }
  }

  // Các namespace lấy top-N theo semantic score
  // key = namespace, value = top-N cần lấy
  const SEMANTIC_NS: Record<string, number> = {
    hotel_info: 2,
    room: 3,
    amenity: 3,
    directions: 2,
    policy: 2,
    nearby: 2,
    brand_voice: 2,
    faq: 3,
    // Legacy
    product: 3,
    lesson: 2,
  };

  for (const [ns, topN] of Object.entries(SEMANTIC_NS)) {
    const picks = all
      .filter((r) => r.namespace === ns && !pickedIds.has(r.id))
      .map((r) => ({ row: r, s: scoreFn(r) }))
      .filter((x) => ns === 'lesson' || x.s >= minScore(x.row)) // lesson không cần ngưỡng
      .sort((a, b) => b.s - a.s)
      .slice(0, topN);
    for (const p of picks) {
      picked.push(p.row);
      pickedIds.add(p.row.id);
    }
  }

  if (picked.length === 0) return '';

  const byNs: Record<string, WikiRow[]> = {};
  for (const p of picked) {
    if (!byNs[p.namespace]) byNs[p.namespace] = [];
    byNs[p.namespace].push(p);
  }

  const nsLabels: Record<string, string> = {
    hotel_info: '🏨 THÔNG TIN KHÁCH SẠN',
    room: '🛏 CÁC LOẠI PHÒNG',
    amenity: '✨ TIỆN ÍCH & DỊCH VỤ',
    directions: '🗺 HƯỚNG DẪN DI CHUYỂN',
    policy: '📋 CHÍNH SÁCH',
    nearby: '📍 XUNG QUANH',
    promotion: '🎯 KHUYẾN MÃI ĐANG CHẠY',
    brand_voice: '🎭 GIỌNG VĂN THƯƠNG HIỆU',
    faq: '❓ FAQ LIÊN QUAN',
    // Legacy
    business: '🏢 VỀ DOANH NGHIỆP',
    product: '🏨 SẢN PHẨM',
    campaign: '🎯 CHIẾN DỊCH ĐANG CHẠY',
    lesson: '📚 BÀI HỌC TỪ DATA',
  };

  const order = [
    'hotel_info', 'business',
    'promotion', 'campaign',
    'room', 'product',
    'amenity', 'directions', 'policy', 'nearby',
    'brand_voice',
    'faq',
    'lesson',
  ];
  const parts: string[] = [];
  for (const ns of order) {
    if (!byNs[ns]) continue;
    parts.push(`### ${nsLabels[ns] || ns.toUpperCase()}`);
    for (const r of byNs[ns]) {
      parts.push(`**${r.title}**\n${r.content.trim()}`);
    }
  }

  let text = parts.join('\n\n');

  if (text.length > maxChars) {
    text = text.slice(0, maxChars) + '\n...(đã cắt ngắn)';
  }

  return text;
}

export function getWikiStats() {
  const byNs = db
    .prepare(
      `SELECT namespace, COUNT(*) as count
       FROM knowledge_wiki WHERE active = 1
       GROUP BY namespace`
    )
    .all();
  const embedded = db
    .prepare(
      `SELECT COUNT(*) as n FROM knowledge_wiki WHERE active = 1 AND embedding IS NOT NULL`
    )
    .get() as { n: number };
  const total = db
    .prepare(`SELECT COUNT(*) as n FROM knowledge_wiki WHERE active = 1`)
    .get() as { n: number };
  return { byNamespace: byNs, embedded: embedded.n, total: total.n };
}

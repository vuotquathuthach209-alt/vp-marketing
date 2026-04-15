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
export async function buildContext(topic: string, maxChars = 1500): Promise<string> {
  const all = db
    .prepare(
      `SELECT id, namespace, slug, title, content, tags, always_inject, embedding
       FROM knowledge_wiki WHERE active = 1`
    )
    .all() as WikiRow[];

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

  for (const r of all) {
    if (r.namespace === 'campaign' && !pickedIds.has(r.id)) {
      picked.push(r);
      pickedIds.add(r.id);
    }
  }

  const products = all
    .filter((r) => r.namespace === 'product' && !pickedIds.has(r.id))
    .map((r) => ({ row: r, s: scoreFn(r) }))
    .filter((x) => x.s >= minScore(x.row))
    .sort((a, b) => b.s - a.s)
    .slice(0, 3);
  for (const p of products) {
    picked.push(p.row);
    pickedIds.add(p.row.id);
  }

  const faqs = all
    .filter((r) => r.namespace === 'faq' && !pickedIds.has(r.id))
    .map((r) => ({ row: r, s: scoreFn(r) }))
    .filter((x) => x.s >= minScore(x.row))
    .sort((a, b) => b.s - a.s)
    .slice(0, 2);
  for (const f of faqs) {
    picked.push(f.row);
    pickedIds.add(f.row.id);
  }

  const lessons = all
    .filter((r) => r.namespace === 'lesson' && !pickedIds.has(r.id))
    .map((r) => ({ row: r, s: scoreFn(r) }))
    .sort((a, b) => b.s - a.s)
    .slice(0, 2);
  for (const l of lessons) picked.push(l.row);

  if (picked.length === 0) return '';

  const byNs: Record<string, WikiRow[]> = {};
  for (const p of picked) {
    if (!byNs[p.namespace]) byNs[p.namespace] = [];
    byNs[p.namespace].push(p);
  }

  const nsLabels: Record<string, string> = {
    business: '🏢 VỀ DOANH NGHIỆP',
    product: '🏨 SẢN PHẨM',
    campaign: '🎯 CHIẾN DỊCH ĐANG CHẠY',
    faq: '❓ FAQ LIÊN QUAN',
    lesson: '📚 BÀI HỌC TỪ DATA',
  };

  const order = ['business', 'campaign', 'product', 'faq', 'lesson'];
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

import { db } from '../db';

interface WikiRow {
  id: number;
  namespace: string;
  slug: string;
  title: string;
  content: string;
  tags: string;
  always_inject: number;
}

/**
 * Đếm từ chung giữa 2 chuỗi (simple relevance scoring).
 * Bỏ các từ ngắn (<3 ký tự) và normalize lowercase + unicode.
 */
function tokenize(text: string): Set<string> {
  const lower = text
    .toLowerCase()
    .normalize('NFC')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ');
  const tokens = lower.split(/\s+/).filter((t) => t.length >= 3);
  return new Set(tokens);
}

function score(topic: string, row: WikiRow): number {
  const topicTokens = tokenize(topic);
  const rowText = `${row.title} ${row.content}`;
  const rowTokens = tokenize(rowText);

  let common = 0;
  for (const t of topicTokens) if (rowTokens.has(t)) common++;

  // Tag matching: weight cao hơn
  try {
    const tags: string[] = JSON.parse(row.tags || '[]');
    for (const tag of tags) {
      if (topic.toLowerCase().includes(tag.toLowerCase())) common += 3;
    }
  } catch {}

  return common;
}

/**
 * Build context block từ knowledge wiki cho chủ đề cụ thể.
 *
 * Chiến lược:
 * - Luôn include tất cả entry có always_inject=1 (thường là business/brand-voice)
 * - Luôn include tất cả campaign đang active
 * - Với mỗi namespace khác (product, faq, lesson), chọn top-N theo relevance score
 * - Giới hạn tổng context ~1500 chars để tiết kiệm token
 */
export function buildContext(topic: string, maxChars = 1500): string {
  const all = db
    .prepare(
      `SELECT id, namespace, slug, title, content, tags, always_inject
       FROM knowledge_wiki WHERE active = 1`
    )
    .all() as WikiRow[];

  if (all.length === 0) return '';

  const picked: WikiRow[] = [];
  const pickedIds = new Set<number>();

  // 1. always_inject
  for (const r of all) {
    if (r.always_inject === 1) {
      picked.push(r);
      pickedIds.add(r.id);
    }
  }

  // 2. Tất cả campaign active
  for (const r of all) {
    if (r.namespace === 'campaign' && !pickedIds.has(r.id)) {
      picked.push(r);
      pickedIds.add(r.id);
    }
  }

  // 3. Top-3 product relevant
  const products = all
    .filter((r) => r.namespace === 'product' && !pickedIds.has(r.id))
    .map((r) => ({ row: r, s: score(topic, r) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, 3);
  for (const p of products) {
    picked.push(p.row);
    pickedIds.add(p.row.id);
  }

  // 4. Top-2 FAQ relevant
  const faqs = all
    .filter((r) => r.namespace === 'faq' && !pickedIds.has(r.id))
    .map((r) => ({ row: r, s: score(topic, r) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, 2);
  for (const f of faqs) {
    picked.push(f.row);
    pickedIds.add(f.row.id);
  }

  // 5. Top-2 lesson (insight từ data thực tế)
  const lessons = all
    .filter((r) => r.namespace === 'lesson' && !pickedIds.has(r.id))
    .slice(0, 2);
  for (const l of lessons) picked.push(l);

  if (picked.length === 0) return '';

  // Group theo namespace để context có cấu trúc
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

  // Cắt nếu quá dài
  if (text.length > maxChars) {
    text = text.slice(0, maxChars) + '\n...(đã cắt ngắn)';
  }

  return text;
}

/**
 * Thống kê wiki: count theo namespace.
 */
export function getWikiStats() {
  return db
    .prepare(
      `SELECT namespace, COUNT(*) as count
       FROM knowledge_wiki WHERE active = 1
       GROUP BY namespace`
    )
    .all();
}

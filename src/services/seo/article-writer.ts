/**
 * SEO Article Writer — generate publish-ready SEO articles for sondervn.com blog.
 *
 * Sondervn.com hiện chưa có write API → workflow:
 *   1. vp-mkt generates article (Claude Sonnet)
 *   2. Stored in seo_articles table
 *   3. Admin reviews via /admin/seo/articles dashboard
 *   4. Admin clicks "Copy HTML" or "Copy Markdown" → paste vào sondervn.com CMS
 *   5. Admin mark as published + paste live URL
 *
 * Article structure (E-E-A-T optimized):
 *   - SEO title (50-60 chars, primary keyword first)
 *   - Meta description (140-160 chars, CTA + keyword)
 *   - H1 (engaging hook + keyword)
 *   - 5-10 H2/H3 sections (target word count 1500-2500)
 *   - FAQ section (FAQPage Schema-compatible)
 *   - Article JSON-LD schema
 *   - Internal link suggestions (to sondervn.com/khach-san/* pages)
 *   - 3-5 image alt-text suggestions
 *
 * Reference: Google Helpful Content guidelines — prioritize HUMAN value over keyword stuffing.
 */

import { db, getSetting } from '../../db';
import { generate } from '../router';

export type ArticleAngle =
  | 'destination_guide'     // "10 things to do in Q1 Saigon"
  | 'hotel_comparison'      // "Top 5 boutique hotels Saigon under 1M"
  | 'travel_tips'            // "How to find cheap last-minute hotels in VN"
  | 'local_insider'          // "Sài Gòn sáng sớm — quán phở 5h local hay tới"
  | 'how_to'                  // "How to book sondervn.com — 3 steps"
  | 'list_post'               // "7 hidden gems in Da Lat"
  | 'seasonal'                // "Best time to visit Phu Quoc"
  | 'news_local';             // "Sài Gòn metro tuyến 1 mở — ảnh hưởng đến du lịch"

export interface ArticleDraft {
  title: string;
  slug: string;
  meta_description: string;
  h1: string;
  body_md: string;            // Markdown
  body_html: string;           // Rendered HTML (server-side from MD)
  faq: Array<{ question: string; answer: string }>;
  keyword_target: string;
  related_keywords: string[];
  internal_links: Array<{ anchor: string; url: string; reason: string }>;
  image_suggestions: Array<{ alt_vi: string; alt_en: string; placement: string }>;
  article_schema: object;     // JSON-LD Article
  faq_schema: object | null;  // JSON-LD FAQPage if FAQ has items
  word_count: number;
}

/** Slugify Vietnamese title → URL-safe ASCII slug. */
function slugify(s: string): string {
  return s.toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')   // strip Vietnamese accents
    .replace(/đ/g, 'd').replace(/Đ/g, 'd')
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
}

/** Minimal MD → HTML converter (no external deps). Supports headings, paragraphs, lists, bold, italic, links. */
function mdToHtml(md: string): string {
  let html = md;
  // Headings
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');
  // Bold / italic
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
  // Links
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
  // Lists
  html = html.replace(/^(?:\* |- )(.+)$/gm, '<li>$1</li>');
  html = html.replace(/(<li>.*<\/li>\n?)+/g, (m) => `<ul>${m}</ul>`);
  // Paragraphs (any line not already a tag)
  html = html.split('\n').map((line) => {
    if (!line.trim()) return '';
    if (line.match(/^<(h[1-6]|ul|li|p|div|section)/)) return line;
    return `<p>${line}</p>`;
  }).join('\n');
  return html;
}

/** Build article JSON-LD schema. */
function buildArticleSchema(opts: {
  title: string;
  slug: string;
  meta_description: string;
  word_count: number;
  publish_url?: string;
  image_url?: string;
}): object {
  return {
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: opts.title,
    description: opts.meta_description,
    url: opts.publish_url || `https://sondervn.com/blog/${opts.slug}`,
    wordCount: opts.word_count,
    image: opts.image_url || undefined,
    author: { '@type': 'Organization', name: 'Sondervn', url: 'https://sondervn.com' },
    publisher: {
      '@type': 'Organization',
      name: 'Sondervn',
      url: 'https://sondervn.com',
      logo: { '@type': 'ImageObject', url: 'https://sondervn.com/logo.png' },
    },
    datePublished: new Date().toISOString().slice(0, 10),
    inLanguage: 'vi-VN',
  };
}

function buildFaqSchema(faq: ArticleDraft['faq']): object | null {
  if (!faq || faq.length === 0) return null;
  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: faq.map((f) => ({
      '@type': 'Question',
      name: f.question,
      acceptedAnswer: { '@type': 'Answer', text: f.answer },
    })),
  };
}

/** Generate one full article. */
export async function generateArticle(opts: {
  keyword_target: string;
  angle?: ArticleAngle;
  hotel_id?: number | null;
  language?: 'vi' | 'en';
  target_word_count?: number;
}): Promise<ArticleDraft | null> {
  const angle = opts.angle || 'destination_guide';
  const language = opts.language || 'vi';
  const targetWords = opts.target_word_count || 1800;

  // Optional hotel context
  let hotelContext = '';
  if (opts.hotel_id) {
    const h = db.prepare(`SELECT * FROM hotel_profile WHERE hotel_id = ?`).get(opts.hotel_id) as any;
    if (h) {
      hotelContext = `\nHOTEL CONTEXT (anchor mentions where natural):
- Name: ${h.name_canonical}
- Address: ${h.address || ''}
- City: ${h.city || ''}, District: ${h.district || ''}
- Star rating: ${h.star_rating || 'n/a'}
- Summary: ${(h.ai_summary_vi || '').slice(0, 300)}`;
    }
  }

  const angleGuide: Record<ArticleAngle, string> = {
    destination_guide: 'Hướng dẫn điểm đến — giới thiệu 1 thành phố/quận, ăn-ngủ-chơi, người local hay tới',
    hotel_comparison: 'So sánh top khách sạn theo tiêu chí (giá, vị trí, tiện ích) — table-friendly format',
    travel_tips: 'Tips du lịch thực dụng — checklist, do/don\'t, save money/time',
    local_insider: 'Góc nhìn dân bản địa — chỗ ăn ngon ít người biết, sáng sớm hoặc tối khuya, character thật',
    how_to: 'Hướng dẫn step-by-step — quy trình rõ ràng, có number 1-2-3',
    list_post: 'Listicle — top 5/7/10 highlights, mỗi mục 2-3 đoạn',
    seasonal: 'Theo mùa/sự kiện — thời điểm tốt nhất, weather, festival',
    news_local: 'Tin local relevant cho khách du lịch — đường xá, sự kiện, thông tin mới',
  };

  const systemPrompt = `Em là content strategist Sondervn (nền tảng đặt phòng khách sạn Việt Nam). Viết bài blog SEO.

PHILOSOPHY (BẮT BUỘC):
- Google Helpful Content guidelines: giá trị thật cho người đọc trước, keyword sau
- Tone: warm, knowledgeable, locally insightful (không bốc đồng hay hard-sell)
- KHÔNG keyword stuffing — keyword target xuất hiện tự nhiên 4-7 lần trong toàn bài
- KHÔNG generic ("tuyệt vời", "đỉnh cao") — phải SPECIFIC (tên đường, giá, giờ)
- Vietnamese tự nhiên, ngắn câu, paragraph 2-4 dòng
- Mention sondervn.com 1-2 lần (subtle CTA, không spam)
${hotelContext}

ANGLE: ${angle} — ${angleGuide[angle]}

KEYWORD TARGET: "${opts.keyword_target}"
TARGET WORD COUNT: ${targetWords} từ (range ±15%)
LANGUAGE: ${language}

OUTPUT STRICT JSON, không markdown wrapper, không text trước sau:
{
  "title": "<50-60 chars, primary keyword in first 30 chars, engaging>",
  "meta_description": "<140-160 chars, keyword + CTA>",
  "h1": "<engaging hook variant of title, 60-80 chars>",
  "slug": "<lowercase-dash-separated, no Vietnamese diacritics, ≤80 chars>",
  "body_md": "<full article body in Markdown — 1500-2500 từ. Structure: intro 2 đoạn → 5-8 H2 sections, mỗi section 2-4 đoạn + có thể có H3 nhỏ → kết luận 1 đoạn (KHÔNG hard-sell). Dùng **bold**, *italic*, [link](url) khi cần. KHÔNG put H1 vào body_md.>",
  "faq": [
    {"question": "<câu hỏi khách thường hỏi liên quan keyword>", "answer": "<câu trả lời 50-150 từ, có sondervn.com mention nếu phù hợp>"},
    ...3-5 FAQ items
  ],
  "related_keywords": ["<10 LSI keywords liên quan>"],
  "internal_links": [
    {"anchor": "<anchor text>", "url": "https://sondervn.com/<path>", "reason": "<why this link helps reader>"},
    ...3-5 internal link suggestions
  ],
  "image_suggestions": [
    {"alt_vi": "<alt VI 60-125 chars descriptive>", "alt_en": "<alt EN 60-125 chars>", "placement": "<hero | section-2 | section-4 | FAQ>"},
    ...3-5 image suggestions
  ]
}

QUAN TRỌNG:
- body_md PHẢI có 1500-2500 từ Vietnamese
- KHÔNG dùng "Bạn có biết...", "Hè này...", "Khám phá ngay..."
- Mỗi H2 có 1 chi tiết cụ thể (tên quán, số đường, giờ mở, giá) — KHÔNG generic
- FAQ phải là câu hỏi THẬT người Việt search Google (vd "khách sạn Q1 giá dưới 500k có không?")
- internal_links PHẢI tới sondervn.com (sondervn.com/khach-san/* hoặc sondervn.com/khu-vuc/*)`;

  // Estimate maxTokens: Vietnamese uses ~3 tokens / word in JSON wrapper (incl. escape, indent, FAQ, schema fields).
  // Cap at 8192 (Claude Sonnet 4.6 default max output without extended-output beta).
  const estimatedMaxTokens = Math.min(8192, Math.max(3000, Math.ceil(targetWords * 4)));

  // Try LLM up to 2 times
  let lastErr = '';
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const raw = (await generate({
        task: 'caption',          // routes to Claude Sonnet 4.6
        system: systemPrompt,
        user: 'Generate ONLY the JSON. No markdown wrapper, no text before/after.',
        maxTokensOverride: estimatedMaxTokens,
      })).trim();

      // Robust JSON extract (mirror post-writer)
      let parsed: any = null;
      try { parsed = JSON.parse(raw); } catch {}
      if (!parsed) {
        const cleaned = raw.replace(/^```(?:json|JSON)?\s*\n?/m, '').replace(/\n?\s*```\s*$/m, '').trim();
        try { parsed = JSON.parse(cleaned); } catch {}
      }
      if (!parsed) {
        const m = raw.match(/\{[\s\S]*\}/);
        if (m) try { parsed = JSON.parse(m[0]); } catch {}
      }
      if (!parsed || !parsed.title || !parsed.body_md) {
        const len = raw.length;
        const head = raw.slice(0, 200).replace(/\s+/g, ' ');
        const tail = raw.slice(-200).replace(/\s+/g, ' ');
        lastErr = `pass${attempt}: invalid JSON or missing fields (raw ${len} chars, head="${head}", tail="${tail}")`;
        if (attempt === 1) { console.warn('[seo-article-writer]', lastErr, '— retrying'); continue; }
        throw new Error(lastErr);
      }

      // Validate + normalize
      const slug = parsed.slug ? slugify(String(parsed.slug)) : slugify(parsed.title);
      const wordCount = String(parsed.body_md).split(/\s+/).filter(Boolean).length;
      const bodyHtml = mdToHtml(String(parsed.body_md));
      const faq = Array.isArray(parsed.faq)
        ? parsed.faq.filter((f: any) => f.question && f.answer).slice(0, 8)
        : [];

      const articleSchema = buildArticleSchema({
        title: parsed.title, slug, meta_description: parsed.meta_description,
        word_count: wordCount,
      });
      const faqSchema = buildFaqSchema(faq);

      return {
        title: String(parsed.title).trim(),
        slug,
        meta_description: String(parsed.meta_description || '').trim().slice(0, 165),
        h1: String(parsed.h1 || parsed.title).trim(),
        body_md: String(parsed.body_md).trim(),
        body_html: bodyHtml,
        faq,
        keyword_target: opts.keyword_target,
        related_keywords: Array.isArray(parsed.related_keywords) ? parsed.related_keywords.slice(0, 15) : [],
        internal_links: Array.isArray(parsed.internal_links) ? parsed.internal_links.slice(0, 8) : [],
        image_suggestions: Array.isArray(parsed.image_suggestions) ? parsed.image_suggestions.slice(0, 8) : [],
        article_schema: articleSchema,
        faq_schema: faqSchema,
        word_count: wordCount,
      };
    } catch (e: any) {
      lastErr = e.message;
      if (attempt === 1) continue;
      console.warn('[seo-article-writer] final fail:', lastErr);
      return null;
    }
  }
  return null;
}

/** Persist generated article to DB. */
export function saveArticle(draft: ArticleDraft, opts?: {
  hotel_id?: number | null;
  category?: string;
  angle?: ArticleAngle;
}): number {
  const now = Date.now();
  const r = db.prepare(
    `INSERT INTO seo_articles
     (title, slug, meta_description, h1, body_md, body_html, faq_json,
      keyword_target, related_keywords_json, internal_links_json, image_suggestions_json,
      article_schema_json, faq_schema_json, word_count,
      hotel_id, category, angle, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)`,
  ).run(
    draft.title, draft.slug, draft.meta_description, draft.h1, draft.body_md, draft.body_html,
    JSON.stringify(draft.faq),
    draft.keyword_target,
    JSON.stringify(draft.related_keywords),
    JSON.stringify(draft.internal_links),
    JSON.stringify(draft.image_suggestions),
    JSON.stringify(draft.article_schema),
    draft.faq_schema ? JSON.stringify(draft.faq_schema) : null,
    draft.word_count,
    opts?.hotel_id || null,
    opts?.category || null,
    opts?.angle || null,
    now, now,
  );
  return r.lastInsertRowid as number;
}

export function listArticles(opts?: { status?: string; limit?: number }): any[] {
  let sql = `SELECT id, title, slug, meta_description, keyword_target, word_count, status,
                    angle, hotel_id, published_url, created_at, updated_at
             FROM seo_articles WHERE 1=1`;
  const params: any[] = [];
  if (opts?.status) { sql += ` AND status = ?`; params.push(opts.status); }
  sql += ` ORDER BY created_at DESC LIMIT ?`;
  params.push(opts?.limit || 50);
  return db.prepare(sql).all(...params) as any[];
}

export function getArticle(id: number): any | null {
  const row = db.prepare(`SELECT * FROM seo_articles WHERE id = ?`).get(id) as any;
  if (!row) return null;
  // Parse JSON fields
  for (const k of ['faq_json', 'related_keywords_json', 'internal_links_json',
                    'image_suggestions_json', 'article_schema_json', 'faq_schema_json']) {
    try { row[k.replace('_json', '')] = JSON.parse(row[k] || 'null'); } catch {}
    delete row[k];
  }
  return row;
}

export function markPublished(id: number, publishedUrl: string): boolean {
  const r = db.prepare(
    `UPDATE seo_articles SET status = 'published', published_url = ?, published_at = ?, updated_at = ?
     WHERE id = ? AND status IN ('draft', 'reviewed')`,
  ).run(publishedUrl, Date.now(), Date.now(), id);
  return r.changes > 0;
}

export function approveArticle(id: number): boolean {
  const r = db.prepare(
    `UPDATE seo_articles SET status = 'reviewed', updated_at = ? WHERE id = ? AND status = 'draft'`,
  ).run(Date.now(), id);
  return r.changes > 0;
}

export function deleteArticle(id: number): boolean {
  return db.prepare(`DELETE FROM seo_articles WHERE id = ?`).run(id).changes > 0;
}

/** Topic suggester — based on tracked keywords + crawled gaps. */
export function suggestTopics(opts?: { limit?: number }): Array<{
  keyword: string;
  reason: string;
  suggested_angle: ArticleAngle;
  priority: 'high' | 'medium' | 'low';
}> {
  const limit = opts?.limit || 10;
  const suggestions: any[] = [];

  // 1. Tracked keywords with rank > 10 (not yet ranking top page)
  const lowRank = db.prepare(
    `SELECT keyword, current_rank, category FROM seo_keywords WHERE current_rank IS NULL OR current_rank > 10 LIMIT ?`,
  ).all(limit) as any[];
  for (const k of lowRank) {
    suggestions.push({
      keyword: k.keyword,
      reason: k.current_rank ? `Rank #${k.current_rank} — viết bài SEO để boost top 5` : 'Chưa rank — viết bài để bắt đầu rank',
      suggested_angle: k.category === 'location' ? 'destination_guide' : 'list_post',
      priority: !k.current_rank ? 'high' : k.current_rank > 30 ? 'high' : 'medium',
    });
  }

  // 2. Hotel-specific topics (one article per hotel could be a money-page)
  const hotels = db.prepare(
    `SELECT hotel_id, name_canonical, city FROM hotel_profile WHERE name_canonical IS NOT NULL LIMIT 5`,
  ).all() as any[];
  for (const h of hotels) {
    if (suggestions.length >= limit) break;
    suggestions.push({
      keyword: `${h.name_canonical} review ${h.city || ''}`.trim(),
      reason: `Hotel-specific article cho ${h.name_canonical}`,
      suggested_angle: 'hotel_comparison',
      priority: 'medium',
    });
  }

  return suggestions.slice(0, limit);
}

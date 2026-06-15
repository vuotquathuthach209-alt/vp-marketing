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
import { trendsPromptBlock } from './trends';

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

  /* ───────── PASS 1: Body + title ─────────
   * Vietnamese in JSON wrapper costs ~3-4 tokens/word once you account for
   * \" escapes, \n, and indent. A 1800-word body alone ≈ 6000-7200 tokens.
   * Putting body + FAQ + related + internal_links + image_suggestions ALL
   * in one JSON makes the response ≥ 10000 tokens — well past the Sonnet
   * 4.6 default 8192 output cap → truncation. Hence 2-pass.
   */
  const trendsBlock = await trendsPromptBlock();
  const bodyPrompt = `Em là content strategist Sondervn (nền tảng đặt phòng khách sạn Việt Nam). Viết bài blog SEO.

PHILOSOPHY (BẮT BUỘC — chuẩn thuật toán Google 2026):
- Google Helpful Content: giá trị thật cho người đọc trước, keyword sau
- E-E-A-T (TRỌNG TÂM 2026): viết như NGƯỜI THẬT ĐÃ TỪNG TỚI — chi tiết trải nghiệm thực (không khí, mùi vị, "người ở đây mới biết"), KHÔNG viết kiểu tổng hợp Wikipedia/chung chung
- INFORMATION GAIN: thêm ÍT NHẤT 1 góc nhìn/insight RIÊNG mà các bài top Google chưa có (mẹo thật, so sánh thực tế, lưu ý ít ai nói) — KHÔNG xào lại nội dung có sẵn (Google 2026 phạt bài "scaled/thin")
- Tone: warm, knowledgeable, locally insightful (không bốc đồng hay hard-sell)
- KHÔNG keyword stuffing — keyword target xuất hiện tự nhiên 4-7 lần trong toàn bài
- KHÔNG generic ("tuyệt vời", "đỉnh cao") — phải SPECIFIC (tên đường, giá, giờ)
- Vietnamese tự nhiên, ngắn câu, paragraph 2-4 dòng
- CHUYỂN ĐỔI: Sonder vận hành KS THẬT ở TP.HCM + Đà Lạt → khi bài về 2 nơi này, lồng KHÉO 1 gợi ý chỗ ở Sonder phù hợp + link sondervn.com/khach-san (đúng ngữ cảnh, tự nhiên, KHÔNG hard-sell). Bài về nơi khác: chỉ mention sondervn.com 1 lần nhẹ
${hotelContext}

ANGLE: ${angle} — ${angleGuide[angle]}

KEYWORD TARGET: "${opts.keyword_target}"
TARGET WORD COUNT: ${targetWords} từ (HARD LIMIT ${Math.round(targetWords * 1.15)} từ — KHÔNG vượt quá)
LANGUAGE: ${language}
${trendsBlock}

OUTPUT STRICT JSON (KHÔNG markdown wrapper, KHÔNG text trước sau):
{
  "title": "<50-60 chars, primary keyword in first 30 chars, engaging>",
  "meta_description": "<140-160 chars, keyword + CTA>",
  "h1": "<engaging hook variant of title, 60-80 chars>",
  "slug": "<lowercase-dash-separated, no Vietnamese diacritics, ≤80 chars>",
  "body_md": "<full article body in Markdown — STRICT ${targetWords} từ ±15%. Structure: intro 2 đoạn → 4-6 H2 sections (mỗi 2-3 đoạn) → kết luận 1 đoạn. KHÔNG H1 trong body. Dùng **bold**, *italic* khi cần.>"
}

QUAN TRỌNG:
- body_md PHẢI ≤ ${Math.round(targetWords * 1.15)} từ Vietnamese (đếm chính xác)
- KHÔNG dùng cliché "Bạn có biết...", "Hè này...", "Khám phá ngay..."
- Mỗi H2 có 1 chi tiết cụ thể (tên quán, số đường, giờ mở, giá) — KHÔNG generic`;

  // Pass 1 budget: targetWords × 3 tokens/word + 500 buffer for title/meta/h1/slug.
  const pass1MaxTokens = Math.min(8000, Math.max(2500, Math.ceil(targetWords * 3) + 500));

  let body: any = null;
  let bodyErr = '';
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const raw = (await generate({
        task: 'caption', system: bodyPrompt,
        user: 'Generate ONLY the JSON. No markdown wrapper, no text before/after.',
        maxTokensOverride: pass1MaxTokens,
      })).trim();
      const parsed = extractJson(raw);
      if (!parsed || !parsed.title || !parsed.body_md) {
        const head = raw.slice(0, 200).replace(/\s+/g, ' ');
        const tail = raw.slice(-200).replace(/\s+/g, ' ');
        bodyErr = `pass1 attempt${attempt}: invalid JSON or missing fields (raw ${raw.length} chars, head="${head}", tail="${tail}")`;
        if (attempt === 1) { console.warn('[seo-article-writer]', bodyErr, '— retrying'); continue; }
        throw new Error(bodyErr);
      }
      body = parsed;
      break;
    } catch (e: any) {
      if (attempt === 1) continue;
      console.warn('[seo-article-writer] body final fail:', e?.message || e);
      return null;
    }
  }
  if (!body) return null;

  /* ───────── PASS 2: Metadata (FAQ + related + internal_links + image_suggestions) ───────── */

  const metaPrompt = `Bạn vừa viết một bài SEO. Bây giờ tạo metadata cho bài đó.

KEYWORD TARGET: "${opts.keyword_target}"
TITLE BÀI: "${body.title}"
BODY EXCERPT (200 chars đầu): "${String(body.body_md).slice(0, 200)}..."

OUTPUT STRICT JSON (KHÔNG markdown wrapper):
{
  "faq": [
    {"question": "<câu hỏi THẬT người Việt search Google liên quan keyword>", "answer": "<60-120 từ, có sondervn.com nếu phù hợp>"},
    ...3-4 FAQ items
  ],
  "related_keywords": ["<8-10 LSI keywords liên quan, mỗi cái 2-5 từ>"],
  "internal_links": [
    {"anchor": "<anchor text 2-5 từ>", "url": "https://sondervn.com/<path>", "reason": "<lý do ngắn>"},
    ...2-3 internal links to sondervn.com
  ],
  "image_suggestions": [
    {"alt_vi": "<alt VI 60-125 chars>", "alt_en": "<alt EN 60-125 chars>", "placement": "<hero | section-2 | section-4>"},
    ...2-3 image suggestions
  ]
}

QUAN TRỌNG:
- FAQ là câu hỏi THẬT người Việt search (vd "khách sạn Q1 giá dưới 500k có không?")
- internal_links PHẢI tới sondervn.com (sondervn.com/khach-san/* hoặc /khu-vuc/*)`;

  let meta: any = { faq: [], related_keywords: [], internal_links: [], image_suggestions: [] };
  try {
    const raw = (await generate({
      task: 'caption', system: metaPrompt,
      user: 'Generate ONLY the JSON. No markdown wrapper.',
      maxTokensOverride: 2500,
    })).trim();
    const parsed = extractJson(raw);
    if (parsed) meta = { ...meta, ...parsed };
    else console.warn('[seo-article-writer] pass2 metadata fallback to empty (raw:', raw.slice(0, 150), ')');
  } catch (e: any) {
    console.warn('[seo-article-writer] pass2 fail (non-fatal):', e?.message);
  }

  /* ───────── Assemble final draft ───────── */
  const slug = body.slug ? slugify(String(body.slug)) : slugify(body.title);
  const wordCount = String(body.body_md).split(/\s+/).filter(Boolean).length;
  const bodyHtml = mdToHtml(String(body.body_md));
  const faq = Array.isArray(meta.faq) ? meta.faq.filter((f: any) => f.question && f.answer).slice(0, 8) : [];

  return {
    title: String(body.title).trim(),
    slug,
    meta_description: String(body.meta_description || '').trim().slice(0, 165),
    h1: String(body.h1 || body.title).trim(),
    body_md: String(body.body_md).trim(),
    body_html: bodyHtml,
    faq,
    keyword_target: opts.keyword_target,
    related_keywords: Array.isArray(meta.related_keywords) ? meta.related_keywords.slice(0, 15) : [],
    internal_links: Array.isArray(meta.internal_links) ? meta.internal_links.slice(0, 8) : [],
    image_suggestions: Array.isArray(meta.image_suggestions) ? meta.image_suggestions.slice(0, 8) : [],
    article_schema: buildArticleSchema({
      title: body.title, slug, meta_description: body.meta_description, word_count: wordCount,
    }),
    faq_schema: buildFaqSchema(faq),
    word_count: wordCount,
  };
}

/** Robust JSON extraction: try direct parse, strip ```json fences, then find {…}. */
function extractJson(raw: string): any | null {
  try { return JSON.parse(raw); } catch {}
  const cleaned = raw.replace(/^```(?:json|JSON)?\s*\n?/m, '').replace(/\n?\s*```\s*$/m, '').trim();
  try { return JSON.parse(cleaned); } catch {}
  const m = raw.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch {} }
  return null;
}

/* ═══════════════════════════════════════════════════════════════════
 *  sonder-seo-content skill — Property (B2C) + Partner (B2B) generators
 *  Anti-AI + cảm xúc + giống người thật. Reference: SKILL.md
 * ═══════════════════════════════════════════════════════════════════ */

/** Anti-AI writing rules — inject vào MỌI prompt. Giảm ~85% dấu vết AI. */
const ANTI_AI_RULES = `
QUY TẮC VIẾT NHƯ NGƯỜI THẬT (BẮT BUỘC — vi phạm = bài hỏng):
- CẤM TUYỆT ĐỐI các cụm sáo rỗng AI: "hãy cùng khám phá", "không thể bỏ qua",
  "tuyệt vời", "đắm chìm", "thiên đường", "viên ngọc", "điểm đến lý tưởng",
  "trải nghiệm khó quên", "không gì tuyệt hơn", "chắc chắn sẽ", "đừng quên",
  "nói không ngoa", "có thể nói rằng", "đáng để", "tọa lạc", "sở hữu",
  "mang đến", "đem lại", "không chỉ... mà còn", "vô vàn", "đa dạng và phong phú".
- BẮT BUỘC chi tiết giác quan THẬT: mùi (cà phê sáng, mưa đất), âm thanh
  (xe máy đêm Bùi Viện, gió thông Đà Lạt), nhiệt độ, ánh sáng giờ cụ thể.
- BẮT BUỘC ý kiến cá nhân + NHƯỢC ĐIỂM thật: "khu này ồn về đêm, ai khó ngủ
  nên tránh", "đường vào hơi khó tìm" — không chỉ toàn khen.
- Câu DÀI ngắn xen kẽ. Có câu cụt 3-4 từ. Có câu kể lể dài.
- Xưng "tôi"/"mình" như người từng tới thật. Kể 1 khoảnh khắc cụ thể.
- Số liệu cụ thể (giá, giờ, khoảng cách, tên đường) — KHÔNG nói chung chung.
- KHÔNG markdown bullet quá nhiều — viết văn xuôi như người kể chuyện.`;

/** Build internal links + FAQ schema sau khi có body (tách pass 2 chung). */
async function genMetadata(opts: {
  keyword: string; title: string; bodyExcerpt: string; audienceNote: string;
}): Promise<{ faq: any[]; related_keywords: string[]; internal_links: any[] }> {
  const prompt = `Bạn vừa viết bài SEO. Tạo metadata.

KEYWORD: "${opts.keyword}"
TITLE: "${opts.title}"
EXCERPT: "${opts.bodyExcerpt.slice(0, 200)}..."
${opts.audienceNote}

OUTPUT STRICT JSON (không markdown wrapper):
{
  "faq": [{"question":"<câu hỏi THẬT người Việt search Google>","answer":"<60-110 từ tự nhiên>"}, ...3-4 items],
  "related_keywords": ["<8-10 LSI keyword 2-5 từ>"],
  "internal_links": [{"anchor":"<2-5 từ>","url":"https://sondervn.com/<path>","reason":"<ngắn>"}, ...2-3 items]
}`;
  try {
    const raw = (await generate({ task: 'caption', system: prompt, user: 'Generate ONLY JSON.', maxTokensOverride: 2500 })).trim();
    const p = extractJson(raw) || {};
    return {
      faq: Array.isArray(p.faq) ? p.faq.filter((f: any) => f.question && f.answer).slice(0, 6) : [],
      related_keywords: Array.isArray(p.related_keywords) ? p.related_keywords.slice(0, 15) : [],
      internal_links: Array.isArray(p.internal_links) ? p.internal_links.slice(0, 8) : [],
    };
  } catch { return { faq: [], related_keywords: [], internal_links: [] }; }
}

/**
 * B2C PROPERTY article — dựa data thật hotel_profile (KHÔNG bịa số liệu).
 * Claude expand thành bài có cảm xúc + local insight.
 */
export async function generatePropertyArticle(hotelId: number): Promise<ArticleDraft | null> {
  const h = db.prepare(`SELECT * FROM hotel_profile WHERE hotel_id = ?`).get(hotelId) as any;
  if (!h) { console.warn(`[article-writer] hotel ${hotelId} not found`); return null; }

  // Gom facts thật từ DB (KHÔNG bịa)
  const rooms = db.prepare(`SELECT display_name_vi, price_weekday, price_weekend, max_guests, bed_config, size_m2, description_vi FROM hotel_room_catalog WHERE hotel_id = ? LIMIT 6`).all(hotelId) as any[];
  const amenities = db.prepare(`SELECT name_vi, category, free FROM hotel_amenities WHERE hotel_id = ? LIMIT 20`).all(hotelId) as any[];
  const policy = db.prepare(`SELECT * FROM hotel_policies WHERE hotel_id = ?`).get(hotelId) as any;

  const propType = h.property_type || 'hotel';
  const typeLabel = propType === 'homestay' ? 'homestay' : propType === 'apartment' ? 'căn hộ dịch vụ' : 'khách sạn';

  const facts = `
DATA THẬT (chỉ dùng số liệu này, KHÔNG bịa thêm):
- Tên: ${h.name_canonical || h.name}
- Loại: ${typeLabel}
- Thành phố: ${h.city || '?'} — Quận/khu: ${h.district || '?'}
- Địa chỉ: ${h.address || '?'}
- Hạng sao: ${h.star_rating || 'n/a'}
- Tóm tắt: ${(h.ai_summary_vi || '').slice(0, 400)}
- USP: ${h.usp_top3 || ''}
- Landmark gần: ${h.nearby_landmarks || ''}
- Phòng: ${rooms.map(r => `${r.display_name_vi} (${r.price_weekday ? r.price_weekday + 'đ' : '?'}/đêm, ${r.max_guests || '?'} khách${r.size_m2 ? ', ' + r.size_m2 + 'm²' : ''}${r.description_vi ? ' — ' + String(r.description_vi).slice(0, 80) : ''})`).join('; ') || 'chưa có data phòng cụ thể'}
- Tiện ích: ${amenities.map(a => a.name_vi).filter(Boolean).slice(0, 15).join(', ') || 'cơ bản'}
- Check-in/out: ${policy ? `${policy.checkin_time || '14h'} / ${policy.checkout_time || '12h'}` : '14h / 12h'}
${h.monthly_price_from ? `- Thuê tháng từ: ${h.monthly_price_from}đ` : ''}`;

  const keyword = `${typeLabel} ${h.district || h.city || ''}`.trim().toLowerCase();

  const sys = `Em là người ${h.city || 'địa phương'} sống ở đây nhiều năm, từng tới ${h.name_canonical || h.name} thật. Viết review/giới thiệu ${typeLabel} này cho người sắp đặt phòng.

${facts}

${ANTI_AI_RULES}

PHILOSOPHY:
- Google Helpful Content: giá trị thật cho người đọc.
- Mention sondervn.com 1 lần tự nhiên (chỗ đặt phòng property này, không hard-sell).
- KHÔNG bịa: tên đường/giá/tiện ích PHẢI khớp DATA THẬT trên. Nếu data thiếu thì
  viết về khu vực/trải nghiệm chung quanh thay vì bịa.
- 1200-1600 từ.

OUTPUT STRICT JSON (không markdown wrapper):
{
  "title": "<55-65 chars, có tên ${typeLabel} + địa danh, hấp dẫn, KHÔNG sáo>",
  "meta_description": "<140-160 chars có CTA>",
  "h1": "<biến thể title 60-80 chars>",
  "slug": "<lowercase-dash, không dấu, ≤80 chars>",
  "body_md": "<1200-1600 từ Markdown. Mở bài bằng 1 khoảnh khắc/cảm nhận THẬT. 4-6 H2: vị trí & đường đi, phòng ốc thực tế, tiện ích đáng tiền/không, khu vực xung quanh ăn chơi, ai HỢP / ai KHÔNG hợp ở đây, mẹo đặt phòng. Kết 1 đoạn thật lòng (có nhược điểm). KHÔNG H1 trong body.>"
}`;

  let body: any = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const raw = (await generate({ task: 'caption', system: sys, user: 'Generate ONLY JSON. No markdown wrapper.', maxTokensOverride: 7000 })).trim();
      const p = extractJson(raw);
      if (p && p.title && p.body_md) { body = p; break; }
      if (attempt === 2) { console.warn('[article-writer] property gen fail (JSON)'); return null; }
    } catch (e: any) { if (attempt === 2) { console.warn('[article-writer] property gen err:', e?.message); return null; } }
  }
  if (!body) return null;

  const slug = body.slug ? slugify(String(body.slug)) : slugify(body.title);
  const wordCount = String(body.body_md).split(/\s+/).filter(Boolean).length;
  const meta = await genMetadata({ keyword, title: body.title, bodyExcerpt: body.body_md, audienceNote: 'Audience: khách du lịch sắp đặt phòng.' });
  const faq = meta.faq;

  return {
    title: String(body.title).trim(),
    slug,
    meta_description: String(body.meta_description || '').trim().slice(0, 165),
    h1: String(body.h1 || body.title).trim(),
    body_md: String(body.body_md).trim(),
    body_html: mdToHtml(String(body.body_md)),
    faq,
    keyword_target: keyword,
    related_keywords: meta.related_keywords,
    internal_links: meta.internal_links,
    image_suggestions: [],
    article_schema: buildArticleSchema({ title: body.title, slug, meta_description: body.meta_description, word_count: wordCount }),
    faq_schema: buildFaqSchema(faq),
    word_count: wordCount,
  };
}

/** 8 B2B partner themes — xoay vòng. Reference: chiến lược KD Sonder. */
export const PARTNER_THEMES: Array<{ slug: string; title_hint: string; angle: string }> = [
  { slug: 'pms-mien-phi', title_hint: 'Phần mềm PMS quản lý khách sạn miễn phí khi là đối tác Sonder', angle: 'Lợi ích PMS free — chủ KS không tốn phí phần mềm quản lý phòng/booking/khách' },
  { slug: 'chi-tra-phi-khi-co-booking', title_hint: 'Chỉ trả phí khi có booking thật — mô hình 0 rủi ro cho chủ nhà', angle: 'Không phí cố định, không phí setup, chỉ commission khi có giao dịch qua nền tảng' },
  { slug: 'thue-dai-ngan-ngay', title_hint: 'Cho thuê dài ngày hay ngắn ngày — tối ưu doanh thu phòng thế nào', angle: 'Phân tích bài toán doanh thu: lấp phòng ngắn ngày vs ổn định dài ngày' },
  { slug: 'cau-chuyen-doi-tac', title_hint: 'Chủ homestay tăng lấp phòng mùa thấp điểm nhờ nền tảng Sonder', angle: 'Case study (kể chuyện thật, không bịa số cụ thể nếu không có data)' },
  { slug: 'dang-property-3-buoc', title_hint: 'Đăng khách sạn/homestay lên Sonder — quy trình 3 bước, 10 phút', angle: 'Hướng dẫn onboarding đối tác từng bước, đơn giản hóa' },
  { slug: 'tu-quan-ly-vs-nen-tang', title_hint: 'Tự quản lý booking hay qua nền tảng OTA — bài toán chi phí & công sức', angle: 'So sánh khách quan: thời gian, chi phí, độ phủ khách' },
  { slug: 'lap-phong-mua-thap-diem', title_hint: 'Lấp phòng trống mùa thấp điểm bằng khách thuê dài ngày', angle: 'Chiến lược doanh thu mùa vắng — long-stay, digital nomad' },
  { slug: 'vi-sao-len-ota-noi-dia', title_hint: 'Vì sao chủ khách sạn Việt nên có mặt trên OTA nội địa', angle: 'OTA nội địa hiểu thị trường VN, commission hợp lý hơn OTA quốc tế' },
];

/**
 * B2B PARTNER article — thu hút chủ nhà/chủ KS ký đối tác.
 * Tone business, ROI, CTA "Đăng ký đối tác miễn phí".
 */
export async function generatePartnerArticle(themeSlug?: string): Promise<ArticleDraft | null> {
  // Pick theme: chỉ định hoặc xoay vòng (ít dùng gần nhất)
  let theme = PARTNER_THEMES.find(t => t.slug === themeSlug);
  if (!theme) {
    const recent = db.prepare(
      `SELECT partner_theme FROM seo_articles WHERE partner_theme IS NOT NULL ORDER BY created_at DESC LIMIT 8`,
    ).all() as any[];
    const recentSlugs = new Set(recent.map(r => r.partner_theme));
    theme = PARTNER_THEMES.find(t => !recentSlugs.has(t.slug)) || PARTNER_THEMES[Math.floor(Math.random() * PARTNER_THEMES.length)];
  }

  const sys = `Em là chuyên gia phát triển đối tác của Sonder Vietnam (nền tảng OTA bán phòng cho khách sạn/homestay đối tác). Viết bài thu hút CHỦ NHÀ / CHỦ KHÁCH SẠN đăng ký làm đối tác.

CHỦ ĐỀ: ${theme.title_hint}
GÓC: ${theme.angle}

GIÁ TRỊ CỐT LÕI SONDER cho đối tác (dùng làm luận điểm, KHÔNG bịa thêm con số):
- PMS quản lý khách sạn MIỄN PHÍ (phòng, booking, khách, lịch)
- Chỉ phát sinh phí khi có giao dịch THẬT qua nền tảng (không phí cố định/setup)
- Hỗ trợ cho thuê DÀI ngày lẫn NGẮN ngày → tối đa hóa doanh thu, lấp phòng trống
- OTA nội địa hiểu thị trường VN

${ANTI_AI_RULES}

PHILOSOPHY:
- Đối tượng đọc: chủ khách sạn nhỏ, chủ homestay, host Airbnb đang cân nhắc kênh bán.
- Tone: tin cậy, thực tế, nói chuyện như người trong nghề — KHÔNG quảng cáo lố.
- Thừa nhận thẳng: nền tảng nào cũng có commission, nhưng giải thích vì sao xứng đáng.
- KHÔNG bịa số liệu (% tăng doanh thu, số đối tác) trừ khi nói chung chung định tính.
- CTA cuối: mời đăng ký đối tác (form/hotline) — tự nhiên, không ép.
- 1100-1500 từ.

OUTPUT STRICT JSON (không markdown wrapper):
{
  "title": "<55-65 chars, hướng tới chủ nhà/chủ KS, cụ thể, KHÔNG sáo>",
  "meta_description": "<140-160 chars, có CTA dành cho đối tác>",
  "h1": "<biến thể title>",
  "slug": "<lowercase-dash không dấu ≤80>",
  "body_md": "<1100-1500 từ. Mở bài bằng 1 nỗi đau THẬT của chủ KS (phòng trống, phí OTA quốc tế cao, quản lý thủ công). 4-5 H2 giải quyết từng vấn đề. Kết = CTA đăng ký đối tác. KHÔNG H1 trong body.>"
}`;

  let body: any = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const raw = (await generate({ task: 'caption', system: sys, user: 'Generate ONLY JSON. No markdown wrapper.', maxTokensOverride: 6500 })).trim();
      const p = extractJson(raw);
      if (p && p.title && p.body_md) { body = p; break; }
      if (attempt === 2) { console.warn('[article-writer] partner gen fail (JSON)'); return null; }
    } catch (e: any) { if (attempt === 2) { console.warn('[article-writer] partner gen err:', e?.message); return null; } }
  }
  if (!body) return null;

  const slug = body.slug ? slugify(String(body.slug)) : slugify(body.title);
  const wordCount = String(body.body_md).split(/\s+/).filter(Boolean).length;
  const keyword = theme.title_hint.toLowerCase().slice(0, 60);
  const meta = await genMetadata({ keyword, title: body.title, bodyExcerpt: body.body_md, audienceNote: 'Audience: chủ khách sạn/homestay cân nhắc làm đối tác OTA.' });
  const faq = meta.faq;

  // CTA block cứng cuối bài (đảm bảo luôn có call-to-action B2B)
  const ctaMd = `\n\n---\n\n## Đăng ký đối tác Sonder — miễn phí\n\nBạn là chủ khách sạn, homestay hay căn hộ cho thuê? Đăng property lên Sonder hoàn toàn miễn phí, dùng PMS quản lý không tốn phí, chỉ trả phí khi có booking thật. [Đăng ký đối tác ngay](https://sondervn.com/danh-cho-doi-tac) hoặc gọi hotline để được tư vấn.`;
  const fullMd = String(body.body_md).trim() + ctaMd;

  return {
    title: String(body.title).trim(),
    slug,
    meta_description: String(body.meta_description || '').trim().slice(0, 165),
    h1: String(body.h1 || body.title).trim(),
    body_md: fullMd,
    body_html: mdToHtml(fullMd),
    faq,
    keyword_target: keyword,
    related_keywords: meta.related_keywords,
    internal_links: meta.internal_links,
    image_suggestions: [],
    article_schema: buildArticleSchema({ title: body.title, slug, meta_description: body.meta_description, word_count: wordCount }),
    faq_schema: buildFaqSchema(faq),
    word_count: wordCount,
    // @ts-ignore — extra field consumed by saveArticle/cron
    _partner_theme: theme.slug,
  } as any;
}

/** Persist generated article to DB. */
export function saveArticle(draft: ArticleDraft, opts?: {
  hotel_id?: number | null;
  category?: string;
  angle?: ArticleAngle;
  audience?: 'b2c' | 'b2b';
  content_pillar?: string;
  source_hotel_id?: number | null;
  partner_theme?: string | null;
}): number {
  const now = Date.now();
  const partnerTheme = opts?.partner_theme ?? (draft as any)._partner_theme ?? null;
  const r = db.prepare(
    `INSERT INTO seo_articles
     (title, slug, meta_description, h1, body_md, body_html, faq_json,
      keyword_target, related_keywords_json, internal_links_json, image_suggestions_json,
      article_schema_json, faq_schema_json, word_count,
      hotel_id, category, angle, status,
      audience, content_pillar, source_hotel_id, partner_theme,
      created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?)`,
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
    opts?.source_hotel_id || opts?.hotel_id || null,
    opts?.category || null,
    opts?.angle || null,
    opts?.audience || 'b2c',
    opts?.content_pillar || null,
    opts?.source_hotel_id || null,
    partnerTheme,
    now, now,
  );
  const articleId = r.lastInsertRowid as number;

  // Round-robin: cập nhật last_article_at cho property (nếu là bài property)
  if (opts?.source_hotel_id) {
    db.prepare(
      `UPDATE hotel_profile SET last_article_at = ?, article_count = COALESCE(article_count,0)+1 WHERE hotel_id = ?`,
    ).run(now, opts.source_hotel_id);
  }
  return articleId;
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

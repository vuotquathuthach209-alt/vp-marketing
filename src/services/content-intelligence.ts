/**
 * Content Intelligence — phân tích bài viết để học công thức viral.
 *
 * 3 module:
 *   1. getTopInternalPosts() — phân tích bài ĐÃ ĐĂNG của Sonder, tìm top performer
 *   2. analyzeInspiration() — admin paste text/URL, AI bóc pattern
 *   3. remixPost() — biến inspiration → Sonder voice với angle mới
 *
 * Nguyên tắc: TRANSFORM SUBSTANTIALLY (>50% khác) để an toàn copyright.
 * KHÔNG copy verbatim. Luôn inject Sonder context + CTA + hashtags.
 */
import { db } from '../db';
import { smartCascade } from './smart-cascade';

/* ═══════════════════════════════════════════
   MODULE 1: INTERNAL POST PERFORMANCE MINER
   ═══════════════════════════════════════════ */

export interface InternalPostInsight {
  post_id: number;
  fb_post_id?: string;
  caption: string;
  published_at: number;
  page_name?: string;
  // Metrics (latest snapshot)
  reach: number;
  likes: number;
  comments: number;
  shares: number;
  clicks: number;
  engagement_score: number;           // Weighted: likes + 3*comments + 5*shares
  engagement_rate: number;            // engagement / reach (if reach > 0)
  // Pattern hints
  length_chars: number;
  has_emoji: boolean;
  has_question: boolean;
  has_number: boolean;
  has_cta_keyword: boolean;
}

export function getTopInternalPosts(opts: {
  hotelId?: number;
  days?: number;
  limit?: number;
}): InternalPostInsight[] {
  const days = opts.days || 30;
  const limit = opts.limit || 20;
  const since = Date.now() - days * 24 * 3600_000;

  const hotelFilter = opts.hotelId
    ? `AND EXISTS (SELECT 1 FROM pages pg WHERE pg.id = p.page_id AND pg.hotel_id = ${opts.hotelId})`
    : '';

  const rows = db.prepare(
    `SELECT
       p.id AS post_id,
       p.fb_post_id,
       p.caption,
       p.published_at,
       pg.name AS page_name,
       -- Lấy metrics snapshot mới nhất
       (SELECT reach FROM post_metrics pm WHERE pm.post_id = p.id ORDER BY pm.pulled_at DESC LIMIT 1) AS reach,
       (SELECT likes FROM post_metrics pm WHERE pm.post_id = p.id ORDER BY pm.pulled_at DESC LIMIT 1) AS likes,
       (SELECT comments FROM post_metrics pm WHERE pm.post_id = p.id ORDER BY pm.pulled_at DESC LIMIT 1) AS comments,
       (SELECT shares FROM post_metrics pm WHERE pm.post_id = p.id ORDER BY pm.pulled_at DESC LIMIT 1) AS shares,
       (SELECT clicks FROM post_metrics pm WHERE pm.post_id = p.id ORDER BY pm.pulled_at DESC LIMIT 1) AS clicks
     FROM posts p
     LEFT JOIN pages pg ON pg.id = p.page_id
     WHERE p.published_at >= ? AND p.fb_post_id IS NOT NULL
       ${hotelFilter}
     ORDER BY p.published_at DESC
     LIMIT ?`
  ).all(since, limit) as any[];

  const insights: InternalPostInsight[] = rows.map(r => {
    const likes = r.likes || 0;
    const comments = r.comments || 0;
    const shares = r.shares || 0;
    const reach = r.reach || 0;
    const clicks = r.clicks || 0;
    const engScore = likes + 3 * comments + 5 * shares;
    const engRate = reach > 0 ? engScore / reach : 0;
    const caption = r.caption || '';

    return {
      post_id: r.post_id,
      fb_post_id: r.fb_post_id,
      caption,
      published_at: r.published_at,
      page_name: r.page_name,
      reach,
      likes,
      comments,
      shares,
      clicks,
      engagement_score: engScore,
      engagement_rate: +engRate.toFixed(4),
      length_chars: caption.length,
      has_emoji: /[\u{1F300}-\u{1F9FF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}]/u.test(caption),
      has_question: /[\?？]/.test(caption),
      has_number: /\d+[%đKkMm\.]?/.test(caption),
      has_cta_keyword: /(inbox|đặt ngay|book now|gọi ngay|xem ngay|click|liên hệ|nhắn)/i.test(caption),
    };
  });

  // Sort by engagement_score desc
  return insights.sort((a, b) => b.engagement_score - a.engagement_score);
}

/** Analyze patterns của top performers */
export function extractInternalPatterns(posts: InternalPostInsight[]): {
  top_N_posts: InternalPostInsight[];
  avg_length: number;
  emoji_rate: number;
  question_rate: number;
  number_rate: number;
  cta_rate: number;
  best_time_of_day: string;
  insights_text: string;
} {
  const top = posts.slice(0, Math.ceil(posts.length * 0.2));   // Top 20%
  if (top.length === 0) {
    return {
      top_N_posts: [],
      avg_length: 0, emoji_rate: 0, question_rate: 0,
      number_rate: 0, cta_rate: 0, best_time_of_day: 'N/A',
      insights_text: 'Chưa có data.',
    };
  }

  const avgLen = Math.round(top.reduce((s, p) => s + p.length_chars, 0) / top.length);
  const emojiRate = top.filter(p => p.has_emoji).length / top.length;
  const questionRate = top.filter(p => p.has_question).length / top.length;
  const numberRate = top.filter(p => p.has_number).length / top.length;
  const ctaRate = top.filter(p => p.has_cta_keyword).length / top.length;

  // Best time of day (hour buckets)
  const hourCounts: Record<number, { count: number; totalScore: number }> = {};
  for (const p of top) {
    const hour = new Date(p.published_at).getUTCHours();   // UTC hours
    const vnHour = (hour + 7) % 24;                         // Convert UTC → VN
    if (!hourCounts[vnHour]) hourCounts[vnHour] = { count: 0, totalScore: 0 };
    hourCounts[vnHour].count++;
    hourCounts[vnHour].totalScore += p.engagement_score;
  }
  const bestHour = Object.entries(hourCounts)
    .sort(([, a], [, b]) => b.totalScore - a.totalScore)[0]?.[0];

  const insights = [
    `📝 Độ dài tối ưu: ~${avgLen} ký tự (dựa trên top ${top.length} bài)`,
    emojiRate > 0.5 ? '✨ Dùng emoji → tăng engagement (tỷ lệ top bài: ' + Math.round(emojiRate * 100) + '%)' : '⚠️ Top bài ít emoji — thử thêm',
    questionRate > 0.4 ? '❓ Câu hỏi thu hút comment (' + Math.round(questionRate * 100) + '%)' : '',
    numberRate > 0.4 ? '📊 Số liệu làm hook tốt (' + Math.round(numberRate * 100) + '%)' : '',
    ctaRate > 0.5 ? '🔗 CTA rõ ràng (' + Math.round(ctaRate * 100) + '%)' : '⚠️ Top bài ít CTA — thử thêm "inbox / đặt ngay"',
    `⏰ Giờ đăng hiệu quả nhất: ${bestHour}h VN time`,
  ].filter(Boolean).join('\n');

  return {
    top_N_posts: top,
    avg_length: avgLen,
    emoji_rate: +emojiRate.toFixed(2),
    question_rate: +questionRate.toFixed(2),
    number_rate: +numberRate.toFixed(2),
    cta_rate: +ctaRate.toFixed(2),
    best_time_of_day: bestHour ? `${bestHour}h` : 'N/A',
    insights_text: insights,
  };
}

/* ═══════════════════════════════════════════
   MODULE 2: INSPIRATION ANALYZER (AI pattern extraction)
   ═══════════════════════════════════════════ */

export interface InspirationAnalysis {
  hook: string;
  emotion: string;
  structure: string;
  cta: string;
  topic_tags: string[];
  why_it_works: string;
  remix_angles: string[];
}

const ANALYZER_SYSTEM = `Bạn là chuyên gia marketing phân tích bài đăng mạng xã hội viral trong ngành du lịch / khách sạn Việt Nam.

Nhiệm vụ: Đọc 1 bài đăng → bóc tách công thức, trả JSON:

{
  "hook": "curiosity_question|number_shock|story_led|emotional_pain|fomo|controversy|list_teaser|personal_experience",
  "emotion": "excitement|nostalgia|urgency|aspiration|humor|fomo|warmth|awe",
  "structure": "problem_solution|listicle|story_arc|compare|reveal|tutorial|quote|data_driven",
  "cta": "soft_inquiry|direct_book|share_invite|comment_prompt|link_click|no_cta",
  "topic_tags": ["du lịch biển", "homestay", "food tour", ...],
  "why_it_works": "Giải thích 2-3 câu vì sao bài này hiệu quả (từ góc độ marketing)",
  "remix_angles": [
    "3-5 góc độ Sonder có thể remix bài này",
    "Ví dụ: 'Áp dụng cho căn hộ thuê tháng Tân Bình'",
    "'Đổi target thành khách công tác dài hạn'"
  ]
}

CẤM: copy nội dung bài gốc vào output. Chỉ phân tích + suggest angle.`;

export async function analyzeInspiration(text: string): Promise<InspirationAnalysis | null> {
  if (!text || text.length < 30) return null;

  const user = `Bài đăng cần phân tích:
"""
${text.slice(0, 2000)}
"""

Trả JSON đúng 7 trường (hook, emotion, structure, cta, topic_tags, why_it_works, remix_angles).`;

  try {
    const result = await smartCascade({
      system: ANALYZER_SYSTEM,
      user,
      maxTokens: 800,
      temperature: 0.3,
    });
    // Parse JSON from response
    let json = result.text.trim();
    const fence = json.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fence) json = fence[1].trim();
    const s = json.indexOf('{');
    const e = json.lastIndexOf('}');
    if (s >= 0 && e > s) json = json.slice(s, e + 1);
    const parsed = JSON.parse(json);
    return {
      hook: String(parsed.hook || 'unknown'),
      emotion: String(parsed.emotion || 'unknown'),
      structure: String(parsed.structure || 'unknown'),
      cta: String(parsed.cta || 'unknown'),
      topic_tags: Array.isArray(parsed.topic_tags) ? parsed.topic_tags.slice(0, 8) : [],
      why_it_works: String(parsed.why_it_works || ''),
      remix_angles: Array.isArray(parsed.remix_angles) ? parsed.remix_angles.slice(0, 5) : [],
    };
  } catch (e: any) {
    console.warn('[content-intel] analyze fail:', e?.message);
    return null;
  }
}

/* ═══════════════════════════════════════════
   MODULE 3: POST REMIXER (brand voice transform)
   ═══════════════════════════════════════════ */

export interface RemixOptions {
  inspirationText: string;
  inspirationAnalysis?: InspirationAnalysis;
  targetAngle?: string;                    // Admin chọn 1 angle từ remix_angles
  hotelName?: string;
  brandVoice?: 'friendly' | 'formal' | 'luxury';
  productGroup?: 'monthly_apartment' | 'nightly_stay';
  customInstruction?: string;              // Admin thêm instruction
}

export interface RemixResult {
  remix_text: string;
  hashtags: string[];
  provider: string;
  tokens_used: number;
  originality_score: number;               // 0-1, higher = more transformed
}

function getBrandVoiceInstructions(voice: string): string {
  return voice === 'formal'
    ? 'Giọng chuyên nghiệp, trang trọng. Dùng "quý khách". Không emoji.'
    : voice === 'luxury'
    ? 'Giọng sang trọng, tinh tế. Tối đa 1 emoji ✨. Nhấn trải nghiệm cao cấp.'
    : 'Giọng thân thiện, ấm áp. Dùng "anh/chị", "ạ", "nhé". 1-2 emoji phù hợp (✨🌿💚📌).';
}

export async function remixPost(opts: RemixOptions): Promise<RemixResult | null> {
  const voice = opts.brandVoice || 'friendly';
  const voiceBlock = getBrandVoiceInstructions(voice);
  const hotelContext = opts.hotelName ? `Khách sạn: ${opts.hotelName}.` : '';
  const productContext = opts.productGroup === 'monthly_apartment'
    ? 'Sản phẩm: căn hộ dịch vụ cho thuê theo THÁNG.'
    : 'Sản phẩm: phòng thuê theo đêm.';
  const angleBlock = opts.targetAngle ? `Góc độ cần nhắm: ${opts.targetAngle}` : '';
  const customBlock = opts.customInstruction ? `Lưu ý thêm: ${opts.customInstruction}` : '';

  const analysisHints = opts.inspirationAnalysis
    ? `Hook gốc: ${opts.inspirationAnalysis.hook}. Emotion: ${opts.inspirationAnalysis.emotion}. Structure: ${opts.inspirationAnalysis.structure}.`
    : '';

  const system = `Bạn là biên tập viên fanpage du lịch Sonder Việt Nam. Nhiệm vụ:
Đọc 1 bài đăng "cảm hứng" từ trang khác → viết LẠI bài mới cho Sonder theo ĐÚNG cách marketing chuẩn.

QUY TẮC BẮT BUỘC:
1. KHÔNG copy bất kỳ câu nào từ bài gốc — TRANSFORM hoàn toàn.
2. Giữ công thức nhưng đổi nội dung: nếu bài gốc dùng "hook số liệu" → ta cũng dùng số liệu nhưng số liệu KHÁC, phù hợp Sonder.
3. Kết nối với sản phẩm Sonder cụ thể (căn hộ / khách sạn / homestay).
4. 100-150 từ tiếng Việt.
5. Kết bằng CTA liên quan Sonder (inbox / đặt sớm / tư vấn miễn phí).
6. ${voiceBlock}

${hotelContext} ${productContext}
${angleBlock}
${customBlock}
${analysisHints}

Output FORMAT:
[Hook 1 câu theo công thức bài gốc — nhưng NỘI DUNG khác]
[2-3 câu phát triển ý về Sonder]
[CTA 1 câu]

Chỉ trả nội dung bài viết. KHÔNG hashtag, KHÔNG markdown, KHÔNG commentary.`;

  const user = `Bài cảm hứng gốc (KHÔNG copy):
"""
${opts.inspirationText.slice(0, 1500)}
"""

Viết bài Sonder tương đương công thức, nội dung hoàn toàn mới.`;

  try {
    const result = await smartCascade({
      system,
      user,
      maxTokens: 500,
      temperature: 0.7,
    });
    const remix = result.text.trim()
      .replace(/^```[a-z]*\s*/i, '')
      .replace(/\s*```\s*$/i, '')
      .trim();
    if (remix.length < 80) return null;

    // Compute originality: compare 5-grams với bài gốc
    const originality = computeOriginalityScore(opts.inspirationText, remix);

    // Pick 4 hashtags từ Sonder pool
    const hashtags = pickSonderHashtags(opts.productGroup);

    return {
      remix_text: remix + '\n\n' + hashtags.join(' '),
      hashtags,
      provider: result.provider,
      tokens_used: result.tokens_out,
      originality_score: originality,
    };
  } catch (e: any) {
    console.warn('[content-intel] remix fail:', e?.message);
    return null;
  }
}

/** Compute originality score: 0 = identical, 1 = completely different. Uses 5-gram overlap. */
function computeOriginalityScore(original: string, remix: string): number {
  const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, '').split(/\s+/).filter(Boolean);
  const origWords = norm(original);
  const remixWords = norm(remix);
  if (origWords.length < 5 || remixWords.length < 5) return 1;

  const ngrams = (words: string[], n = 5): Set<string> => {
    const set = new Set<string>();
    for (let i = 0; i <= words.length - n; i++) set.add(words.slice(i, i + n).join(' '));
    return set;
  };

  const origNgrams = ngrams(origWords);
  const remixNgrams = ngrams(remixWords);
  let overlap = 0;
  for (const ng of remixNgrams) if (origNgrams.has(ng)) overlap++;

  const overlapRate = remixNgrams.size > 0 ? overlap / remixNgrams.size : 0;
  return +(1 - overlapRate).toFixed(3);
}

function pickSonderHashtags(productGroup?: string): string[] {
  const core = ['#SonderVN'];
  if (productGroup === 'monthly_apartment') {
    return [...core, '#CanHoDichVu', '#ChoThueTheoThang', '#LuuTru'];
  }
  return [...core, '#DuLich', '#KhachSan', '#DuLichVietNam'];
}

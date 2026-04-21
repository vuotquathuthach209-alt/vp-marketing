/**
 * News Angle Generator — Phase N-3.
 *
 * Nhận articles status='angle_generated' (đã qua classifier N-2) →
 *   1. Gemini sinh "angle" 80-120 từ tiếng Việt, TRUNG LẬP, hướng du lịch
 *   2. Append Sonder spin: CTA rotation + hashtag pool
 *   3. Resolve image:
 *        Priority 1: og:image từ article (nếu source không phải AAA wire —
 *                    tránh vấn đề copyright với Reuters/AP)
 *        Priority 2: Pollinations AI gen từ prompt neutral travel scene
 *   4. Insert row vào news_post_drafts status='pending' → sẵn sàng admin duyệt
 *
 * Brand voice constraints:
 *   - KHÔNG chỉ trích, không nêu tên đảng phái/lãnh đạo
 *   - Tập trung vào TÁC ĐỘNG ĐẾN HÀNH VI DU LỊCH
 *   - Kết câu hướng về giải pháp linh hoạt (Sonder CTA)
 */
import { db } from '../db';
import { smartCascade } from './smart-cascade';
import { fetchOgImage } from './news-ingest';
import { generateImagePollinations } from './pollinations';
import { getSourceById } from './news-sources';

const BATCH_SIZE = 5;           // generate 5 drafts/run (Gemini free tier thoải mái)
const SONDER_HOTEL_ID = 1;      // Default Sonder page owner cho multi-tenant sau

// ── CTA rotation (3 biến thể, brand voice Sonder) ──────────────────
const CTAS = [
  '📍 Tại Sonder, nếu lịch trình của anh/chị cần điều chỉnh, đội ngũ sẵn sàng hỗ trợ đổi ngày hoặc refund linh hoạt nhé ạ 💚',
  '💬 Nếu chuyến đi cần thay đổi, inbox Sonder để được hỗ trợ nhanh, miễn phí tư vấn 💚',
  '🔔 Anh/chị cần tư vấn lịch trình thay thế? Team Sonder luôn sẵn sàng inbox miễn phí nhé 💚',
];

// ── Hashtag rotation pool ──────────────────────────────────────────
const HASHTAG_POOL = [
  '#SonderVN',
  '#DuLichLinhHoat',
  '#HoTroKhachHang',
  '#LuuTru',
  '#KhachSan',
  '#DuLich',
  '#TraiNghiemSonder',
];

function pickCTA(): string {
  return CTAS[Math.floor(Math.random() * CTAS.length)];
}

function pickHashtags(n = 3): string {
  // #SonderVN always first; 2 others random
  const mandatory = ['#SonderVN'];
  const rest = HASHTAG_POOL.filter(h => !mandatory.includes(h));
  const shuffled = rest.sort(() => Math.random() - 0.5).slice(0, n - 1);
  return [...mandatory, ...shuffled].join(' ');
}

/* ═══════════════════════════════════════════
   ANGLE GENERATOR (Gemini)
   ═══════════════════════════════════════════ */

const ANGLE_SYSTEM = `Bạn là biên tập viên cho fanpage du lịch Sonder Việt Nam. Viết bài đăng Facebook theo đúng quy tắc:

QUY TẮC:
1. TRUNG LẬP — chỉ nói tác động đến HÀNH VI DU LỊCH / ĐẶT PHÒNG.
2. KHÔNG chỉ trích quốc gia, đảng phái, tôn giáo, cá nhân, tổ chức.
3. Trích dẫn nguồn (ví dụ "theo VnExpress", "theo Skift") hoặc số liệu nếu có.
4. 80-120 từ tiếng Việt, thân thiện, chuyên nghiệp.
5. Kết bằng 1 câu gợi mở hướng về trải nghiệm du lịch linh hoạt.
6. CẤM dùng: "chỉ trích", "đáng trách", "lỗi của", "phải chịu trách nhiệm", "thủ phạm", "vô đạo đức", tên chính trị gia cụ thể.

CẤU TRÚC:
[1 câu mở bài về sự kiện + nguồn]
[2-3 câu tác động tới du khách / ngành lưu trú + số liệu hoặc xu hướng]
[1 câu kết gợi mở về giải pháp linh hoạt]

Chỉ trả nội dung bài viết. KHÔNG hashtag, KHÔNG CTA, KHÔNG markdown.`;

export async function generateAngle(opts: {
  title: string;
  body: string | null;
  source: string;
  region?: string;
  angle_hint?: string;
}): Promise<{ angle: string; provider: string; tokens: number } | null> {
  const sourceLabel = getSourceById(opts.source)?.name || opts.source;
  const user = `Tin nguồn "${sourceLabel}":
Tiêu đề: ${opts.title}
${opts.body ? `Nội dung: ${opts.body.slice(0, 1000)}` : ''}
${opts.region ? `Khu vực: ${opts.region}` : ''}
${opts.angle_hint ? `Góc gợi ý: ${opts.angle_hint}` : ''}

Viết bài 80-120 từ theo quy tắc trên. Chỉ nội dung, không hashtag.`;

  try {
    const result = await smartCascade({
      system: ANGLE_SYSTEM,
      user,
      maxTokens: 600,
      temperature: 0.4,
    });
    const angle = result.text.trim()
      // Strip markdown fence nếu có
      .replace(/^```[a-z]*\s*/i, '')
      .replace(/\s*```\s*$/i, '')
      .trim();
    if (angle.length < 50) return null;
    return { angle, provider: result.provider, tokens: result.tokens_out };
  } catch (e: any) {
    console.warn(`[news-angle] Gemini fail: ${e?.message}`);
    return null;
  }
}

/* ═══════════════════════════════════════════
   SONDER SPIN (brand voice)
   ═══════════════════════════════════════════ */

export function applySonderSpin(angle: string): { draft: string; hashtags: string[] } {
  const cta = pickCTA();
  const hashtagLine = pickHashtags(3);
  const draft = `${angle.trim()}\n\n${cta}\n\n${hashtagLine}`;
  return { draft, hashtags: hashtagLine.split(' ').filter(Boolean) };
}

/* ═══════════════════════════════════════════
   IMAGE RESOLVER
   ═══════════════════════════════════════════ */

/**
 * Resolve image URL cho post. Strategy:
 * - og:image từ VN sources (A tier) an toàn hơn: họ để og:image public, thường
 *   dùng cho share FB/Twitter (implicit license for social sharing).
 * - og:image từ AAA wire services (BBC Reuters AP): KHÔNG dùng — copyright risk cao.
 * - Fallback: Pollinations AI gen brand-safe travel scene.
 */
export async function resolveImage(opts: {
  articleUrl: string;
  sourceId: string;
  angleHint?: string;
  title: string;
  region?: string;
}): Promise<{ url: string; media_id?: number; source: 'og_image' | 'pollinations' } | null> {
  const src = getSourceById(opts.sourceId);
  const tier = src?.tier;

  // og:image: chỉ dùng cho source A tier (VN mainstream) + AA (industry specialist như Skift)
  // Tránh AAA wire services để không đụng copyright Reuters/AP/AFP
  if (tier === 'A' || tier === 'AA') {
    try {
      const og = await fetchOgImage(opts.articleUrl);
      if (og && /^https?:\/\//.test(og)) {
        return { url: og, source: 'og_image' };
      }
    } catch { /* fall through */ }
  }

  // AI generate (Pollinations free, no key) — neutral travel scene
  try {
    const prompt = buildImagePrompt(opts);
    const mediaId = await generateImagePollinations(prompt);
    // URL trực tiếp phục vụ qua /media static
    const row = db.prepare(`SELECT filename FROM media WHERE id = ?`).get(mediaId) as any;
    if (row?.filename) {
      return { url: `/media/${row.filename}`, media_id: mediaId, source: 'pollinations' };
    }
  } catch (e: any) {
    console.warn(`[news-angle] image gen fail: ${e?.message}`);
  }
  return null;
}

function buildImagePrompt(opts: { angleHint?: string; title: string; region?: string }): string {
  // Brand-safe: neutral, editorial, no faces/text/logos
  const regionPart = opts.region ? `${opts.region}, ` : '';
  const hint = opts.angleHint ? ` ${opts.angleHint}.` : '';
  return `Professional editorial travel photography, ${regionPart}beautiful destination, ` +
    `cinematic lighting, scenic landscape, soft natural colors, no people faces, no text, ` +
    `no logos, magazine style, high quality, 4K detail.${hint}`;
}

/* ═══════════════════════════════════════════
   MAIN DRAFT GENERATION
   ═══════════════════════════════════════════ */

export interface DraftResult {
  article_id: number;
  draft_id?: number;
  status: 'created' | 'angle_fail' | 'image_fail' | 'db_fail' | 'already_exists';
  error?: string;
}

export async function generateDraftForArticle(articleId: number, hotelId: number = SONDER_HOTEL_ID): Promise<DraftResult> {
  const article = db.prepare(
    `SELECT id, url, title, body, source, region, angle_hint, status
     FROM news_articles WHERE id = ?`
  ).get(articleId) as any;
  if (!article) return { article_id: articleId, status: 'db_fail', error: 'article not found' };

  // Dedupe: đã có draft cho article này chưa?
  const existing = db.prepare(
    `SELECT id FROM news_post_drafts WHERE article_id = ? AND hotel_id = ?`
  ).get(articleId, hotelId) as any;
  if (existing) return { article_id: articleId, draft_id: existing.id, status: 'already_exists' };

  // 1. Generate angle
  const ang = await generateAngle({
    title: article.title,
    body: article.body,
    source: article.source,
    region: article.region,
    angle_hint: article.angle_hint,
  });
  if (!ang) {
    db.prepare(
      `UPDATE news_articles SET status='safety_failed', status_note='angle_gen_failed', last_state_change_at=? WHERE id=?`
    ).run(Date.now(), articleId);
    return { article_id: articleId, status: 'angle_fail', error: 'angle generation returned null' };
  }

  // 2. Apply Sonder spin
  const spin = applySonderSpin(ang.angle);

  // 3. Resolve image (fire-and-forget for now, don't block draft creation)
  const img = await resolveImage({
    articleUrl: article.url,
    sourceId: article.source,
    angleHint: article.angle_hint,
    title: article.title,
    region: article.region,
  });

  // 4. Insert draft
  const now = Date.now();
  try {
    const result = db.prepare(
      `INSERT INTO news_post_drafts
       (article_id, hotel_id, draft_angle, draft_post, image_url, hashtags,
        ai_provider, ai_tokens_used, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`
    ).run(
      articleId, hotelId, ang.angle, spin.draft,
      img?.url || null, JSON.stringify(spin.hashtags),
      ang.provider, ang.tokens, now
    );
    const draftId = Number(result.lastInsertRowid);

    // Move article to pending_review state
    db.prepare(
      `UPDATE news_articles SET status='pending_review', last_state_change_at=? WHERE id=?`
    ).run(now, articleId);

    console.log(`[news-angle] draft #${draftId} created for article #${articleId} img=${img?.source || 'none'}`);
    return { article_id: articleId, draft_id: draftId, status: 'created' };
  } catch (e: any) {
    return { article_id: articleId, status: 'db_fail', error: e.message };
  }
}

/** Batch process articles at status='angle_generated' */
export async function generateDraftsBatch(limit = BATCH_SIZE, hotelId: number = SONDER_HOTEL_ID): Promise<{
  processed: number;
  created: number;
  angle_fail: number;
  db_fail: number;
  already_exists: number;
}> {
  const result = { processed: 0, created: 0, angle_fail: 0, db_fail: 0, already_exists: 0 };
  const pending = db.prepare(
    `SELECT id FROM news_articles WHERE status='angle_generated'
     ORDER BY impact_score DESC, published_at DESC LIMIT ?`
  ).all(limit) as any[];

  for (const row of pending) {
    const r = await generateDraftForArticle(row.id, hotelId);
    result.processed++;
    if (r.status === 'created') result.created++;
    else if (r.status === 'angle_fail') result.angle_fail++;
    else if (r.status === 'db_fail') result.db_fail++;
    else if (r.status === 'already_exists') result.already_exists++;
    // Rate limit soft — 1s giữa mỗi draft để tránh burst Gemini + Pollinations
    await new Promise(res => setTimeout(res, 1000));
  }

  console.log(`[news-angle] batch: ${JSON.stringify(result)}`);
  return result;
}

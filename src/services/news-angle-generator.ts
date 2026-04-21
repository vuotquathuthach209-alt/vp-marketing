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
import { runSafetyGate } from './news-safety';

const BATCH_SIZE = 5;           // generate 5 drafts/run (Gemini free tier thoải mái)
const SONDER_HOTEL_ID = 1;      // Default Sonder page owner cho multi-tenant sau

// ═══════════════════════════════════════════════════════════
// v10 Đợt 2.4: Context-aware CTA pool (11 biến thể)
// Chọn CTA theo "theme" của bài viết (từ angle text + region + hint).
// ═══════════════════════════════════════════════════════════
type CtaTheme =
  | 'flexible_reschedule'   // khi bài về huỷ/đổi lịch, thời tiết xấu, biến động
  | 'book_early_discount'   // khi bài về giá tăng, peak season
  | 'experience_consult'    // khi bài về trải nghiệm, discovery
  | 'long_stay'             // khi bài về xu hướng thuê dài
  | 'generic';

const CTA_LIBRARY: Record<CtaTheme, string[]> = {
  flexible_reschedule: [
    '📍 Tại Sonder, nếu lịch trình của anh/chị cần điều chỉnh, đội ngũ sẵn sàng hỗ trợ đổi ngày hoặc refund linh hoạt nhé ạ 💚',
    '🔔 Chuyến đi cần thay đổi? Inbox Sonder để team hỗ trợ đổi lịch nhanh, miễn phí nhé 💚',
    '🤝 Sonder cam kết đồng hành: đổi ngày / refund linh hoạt khi anh/chị cần 💚',
  ],
  book_early_discount: [
    '🎁 Đặt sớm tại Sonder để giữ giá tốt + ưu đãi độc quyền cho khách quen nhé ạ 💚',
    '💡 Sonder đang nhận đặt phòng cho giai đoạn sắp tới — khung giá sớm vẫn còn nhiều lựa chọn hấp dẫn 💚',
    '🔥 Peak season sắp đến, inbox Sonder ngay để được lock giá sớm + voucher tặng kèm 💚',
  ],
  experience_consult: [
    '🌿 Anh/chị muốn trải nghiệm như bài viết? Inbox Sonder để team tư vấn hành trình phù hợp nhất 💚',
    '✈️ Sonder có thể gợi ý điểm đến + lưu trú theo đúng phong cách anh/chị muốn. Inbox em nhé 💚',
    '📸 Muốn có chuyến đi để đời như vậy? Sonder tư vấn trọn gói miễn phí cho anh/chị 💚',
  ],
  long_stay: [
    '🏠 Sonder có căn hộ thuê tháng đầy đủ tiện nghi — inbox để nhận báo giá chi tiết nhé ạ 💚',
    '🔑 Lưu trú dài ngày ở Sonder: bếp + máy giặt + điện nước bao trọn, giá tốt nhất khi đặt sớm 💚',
  ],
  generic: [
    '💬 Nếu cần tư vấn thêm về lưu trú, inbox Sonder nhé — team luôn sẵn sàng hỗ trợ miễn phí 💚',
    '📞 Sonder hỗ trợ 24/7 qua inbox hoặc hotline. Anh/chị cần bất kỳ thông tin gì đều có em giúp 💚',
  ],
};

// Detect CTA theme từ angle text + article context
function detectCtaTheme(angle: string, angleHint?: string, title?: string): CtaTheme {
  const text = (angle + ' ' + (angleHint || '') + ' ' + (title || '')).toLowerCase();
  // flexible_reschedule — biến động/huỷ/đổi
  if (/(hủy|huỷ|hoãn|đổi lịch|thời tiết|mưa bão|thiên tai|bất ổn|xung đột|chiến sự|cancel|postpone|disrupt)/.test(text))
    return 'flexible_reschedule';
  // book_early — giá tăng / peak
  if (/(giá tăng|tăng giá|đắt hơn|peak|cao điểm|lễ 30|tết|noel|lễ tết|mùa du lịch|sold out|hết phòng)/.test(text))
    return 'book_early_discount';
  // long_stay — xu hướng thuê dài
  if (/(thuê tháng|dài hạn|long[- ]?stay|remote work|wfh|workation|du mục số|digital nomad)/.test(text))
    return 'long_stay';
  // experience — trải nghiệm
  if (/(trải nghiệm|khám phá|food tour|săn|check[- ]?in|ngắm|view|scenic|hidden gem|địa điểm mới)/.test(text))
    return 'experience_consult';
  return 'generic';
}

function pickCTA(theme: CtaTheme): string {
  const pool = CTA_LIBRARY[theme] || CTA_LIBRARY.generic;
  return pool[Math.floor(Math.random() * pool.length)];
}

// ═══════════════════════════════════════════════════════════
// v10 Đợt 2.3: Smart hashtag bank (categorized + rotate)
// ═══════════════════════════════════════════════════════════
const HASHTAG_MANDATORY = '#SonderVN';
const HASHTAG_BANK = {
  core: ['#SonderVN', '#TraiNghiemSonder', '#SonderViet'],
  travel: ['#DuLich', '#DuLichLinhHoat', '#DuLichVietNam', '#DiLa', '#KhamPha'],
  accommodation: ['#LuuTru', '#KhachSan', '#Homestay', '#CanHoDichVu', '#ChoThueTheoThang'],
  theme: {
    flexible: ['#HoTroKhachHang', '#DatPhongLinhHoat', '#YenTamDatPhong'],
    budget: ['#GiaTotNhat', '#TietKiemChiPhi', '#GiaMem'],
    luxury: ['#NghiDuongCaoCap', '#PhongCachSong'],
    business: ['#CongTac', '#BusinessTravel', '#WorkStay'],
    family: ['#DuLichGiaDinh', '#KyNghi', '#SumVay'],
  },
  location: {
    'Ho Chi Minh': ['#SaiGon', '#TPHCM', '#TanBinh'],
    'Ha Noi': ['#HaNoi', '#36PhoPhuong'],
    'Da Nang': ['#DaNang', '#BienMyKhe'],
    'Nha Trang': ['#NhaTrang', '#BienKhanHoa'],
  },
};

function pickHashtags(opts: { theme: CtaTheme; city?: string; count?: number }): string {
  const count = opts.count || 4;
  const pool: string[] = [HASHTAG_MANDATORY];
  // 1 travel tag
  pool.push(HASHTAG_BANK.travel[Math.floor(Math.random() * HASHTAG_BANK.travel.length)]);
  // 1 theme-based tag
  const themeMap: Record<CtaTheme, keyof typeof HASHTAG_BANK.theme> = {
    flexible_reschedule: 'flexible',
    book_early_discount: 'budget',
    experience_consult: 'family',
    long_stay: 'business',
    generic: 'flexible',
  };
  const themeTags = HASHTAG_BANK.theme[themeMap[opts.theme]] || HASHTAG_BANK.theme.flexible;
  pool.push(themeTags[Math.floor(Math.random() * themeTags.length)]);
  // 1 location tag if match
  if (opts.city) {
    const locTags = (HASHTAG_BANK.location as any)[opts.city];
    if (locTags?.length) pool.push(locTags[Math.floor(Math.random() * locTags.length)]);
    else pool.push(HASHTAG_BANK.accommodation[Math.floor(Math.random() * HASHTAG_BANK.accommodation.length)]);
  } else {
    pool.push(HASHTAG_BANK.accommodation[Math.floor(Math.random() * HASHTAG_BANK.accommodation.length)]);
  }
  // Dedupe + limit
  const unique = Array.from(new Set(pool)).slice(0, count);
  return unique.join(' ');
}

// ═══════════════════════════════════════════════════════════
// v10 Đợt 2.1: Hook types for angle opening
// ═══════════════════════════════════════════════════════════
type HookType = 'curiosity_question' | 'number_shock' | 'story_led' | 'trend_reveal';

function pickHookType(): HookType {
  const pool: HookType[] = ['curiosity_question', 'number_shock', 'story_led', 'trend_reveal'];
  return pool[Math.floor(Math.random() * pool.length)];
}

function hookInstruction(hook: HookType): string {
  const map: Record<HookType, string> = {
    curiosity_question: 'CÂU MỞ ĐẦU là 1 CÂU HỎI gây tò mò cho độc giả (ví dụ: "Anh/chị có từng nghĩ...?")',
    number_shock: 'CÂU MỞ ĐẦU phải bắt đầu bằng 1 SỐ LIỆU gây chú ý (ví dụ: "62% du khách quốc tế đang...")',
    story_led: 'CÂU MỞ ĐẦU là 1 MẨU CHUYỆN NGẮN về du khách cụ thể (ví dụ: "Một nhóm khách Úc U70 đã bay 9 tiếng chỉ để...")',
    trend_reveal: 'CÂU MỞ ĐẦU REVEAL 1 XU HƯỚNG mới bất ngờ (ví dụ: "Có một thay đổi lớn đang diễn ra âm thầm trong ngành lưu trú...")',
  };
  return map[hook];
}

/* ═══════════════════════════════════════════
   ANGLE GENERATOR (Gemini)
   ═══════════════════════════════════════════ */

// ═══════════════════════════════════════════════════════════
// v10 Đợt 2.2: Per-brand-voice prompt library
// ═══════════════════════════════════════════════════════════
const VOICE_INSTRUCTIONS: Record<string, string> = {
  friendly: `Giọng điệu: THÂN THIỆN, ấm áp, gần gũi như nói chuyện với bạn bè.
  - Dùng "anh/chị", "nhé", "ạ" tự nhiên.
  - Có thể thêm 1-2 emoji phù hợp (✨🌿💚📌) — không lạm dụng.
  - Tránh ngôn ngữ quá trang trọng, xa cách.`,
  formal: `Giọng điệu: CHUYÊN NGHIỆP, trang trọng, đáng tin cậy.
  - Dùng "quý khách", "chúng tôi".
  - KHÔNG emoji.
  - Câu cú chuẩn mực, chỉn chu.`,
  luxury: `Giọng điệu: SANG TRỌNG, tinh tế, truyền cảm hứng.
  - Dùng từ ngữ chọn lọc, gợi hình ảnh đẳng cấp.
  - Tối đa 1 emoji tinh tế (✨).
  - Nhấn mạnh trải nghiệm độc bản, riêng tư.`,
};

function buildAngleSystem(brandVoice: string, hook: HookType): string {
  const voiceBlock = VOICE_INSTRUCTIONS[brandVoice] || VOICE_INSTRUCTIONS.friendly;
  const hookBlock = hookInstruction(hook);

  return `Bạn là biên tập viên fanpage du lịch Sonder Việt Nam. Viết bài đăng Facebook theo đúng quy tắc:

QUY TẮC NỘI DUNG:
1. TRUNG LẬP — chỉ nói tác động đến HÀNH VI DU LỊCH / ĐẶT PHÒNG.
2. KHÔNG chỉ trích quốc gia, đảng phái, tôn giáo, cá nhân, tổ chức.
3. Trích dẫn nguồn (ví dụ "theo VnExpress", "theo Skift") hoặc số liệu nếu có.
4. 80-120 từ tiếng Việt.
5. Kết bằng 1 câu gợi mở hướng về trải nghiệm du lịch.
6. CẤM dùng: "chỉ trích", "đáng trách", "lỗi của", "phải chịu trách nhiệm", "thủ phạm", "vô đạo đức", tên chính trị gia cụ thể.

${voiceBlock}

HOOK (quan trọng):
${hookBlock}

CẤU TRÚC:
[Câu mở bài theo hook type]
[2-3 câu tác động tới du khách / ngành lưu trú + số liệu / xu hướng]
[1 câu kết gợi mở về lựa chọn linh hoạt]

Chỉ trả nội dung bài viết. KHÔNG hashtag, KHÔNG CTA, KHÔNG markdown.`;
}

export async function generateAngle(opts: {
  title: string;
  body: string | null;
  source: string;
  region?: string;
  angle_hint?: string;
  brand_voice?: string;       // v10 Đợt 2.2 — per-hotel voice
  hook_type?: HookType;        // v10 Đợt 2.1 — explicit hook override (otherwise random)
}): Promise<{ angle: string; provider: string; tokens: number; hook: HookType } | null> {
  const sourceLabel = getSourceById(opts.source)?.name || opts.source;
  const brandVoice = opts.brand_voice || 'friendly';
  const hook = opts.hook_type || pickHookType();
  const system = buildAngleSystem(brandVoice, hook);

  const user = `Tin nguồn "${sourceLabel}":
Tiêu đề: ${opts.title}
${opts.body ? `Nội dung: ${opts.body.slice(0, 1000)}` : ''}
${opts.region ? `Khu vực: ${opts.region}` : ''}
${opts.angle_hint ? `Góc gợi ý: ${opts.angle_hint}` : ''}

Viết bài 80-120 từ theo quy tắc trên. Chỉ nội dung, không hashtag.`;

  try {
    const result = await smartCascade({
      system,
      user,
      maxTokens: 600,
      temperature: 0.5,   // +0.1 để đa dạng hook
    });
    const angle = result.text.trim()
      .replace(/^```[a-z]*\s*/i, '')
      .replace(/\s*```\s*$/i, '')
      .trim();
    if (angle.length < 50) return null;
    return { angle, provider: result.provider, tokens: result.tokens_out, hook };
  } catch (e: any) {
    console.warn(`[news-angle] Gemini fail: ${e?.message}`);
    return null;
  }
}

/* ═══════════════════════════════════════════
   SONDER SPIN (brand voice)
   ═══════════════════════════════════════════ */

/**
 * v10 Đợt 2: Apply Sonder spin với context-aware CTA + smart hashtags.
 * Detect theme từ angle text để chọn CTA variant phù hợp.
 */
export function applySonderSpin(opts: {
  angle: string;
  title?: string;
  angle_hint?: string;
  city?: string;
}): { draft: string; hashtags: string[]; cta_theme: CtaTheme } {
  const theme = detectCtaTheme(opts.angle, opts.angle_hint, opts.title);
  const cta = pickCTA(theme);
  const hashtagLine = pickHashtags({ theme, city: opts.city, count: 4 });
  const draft = `${opts.angle.trim()}\n\n${cta}\n\n${hashtagLine}`;
  return {
    draft,
    hashtags: hashtagLine.split(' ').filter(Boolean),
    cta_theme: theme,
  };
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
  status: 'created' | 'safety_rejected' | 'angle_fail' | 'image_fail' | 'db_fail' | 'already_exists';
  safety_reason?: string;
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

  // v10 Đợt 2.2: Lookup brand_voice + city từ hotel context
  let brandVoice = 'friendly';
  let hotelCity: string | undefined;
  try {
    const ctx = db.prepare(
      `SELECT brand_voice, city FROM v_hotel_bot_context WHERE mkt_hotel_id = ?`
    ).get(hotelId) as any;
    if (ctx) {
      brandVoice = ctx.brand_voice || 'friendly';
      hotelCity = ctx.city || undefined;
    }
  } catch {}

  // 1. Generate angle (với per-hotel voice + random hook)
  const ang = await generateAngle({
    title: article.title,
    body: article.body,
    source: article.source,
    region: article.region,
    angle_hint: article.angle_hint,
    brand_voice: brandVoice,
  });
  if (!ang) {
    db.prepare(
      `UPDATE news_articles SET status='safety_failed', status_note='angle_gen_failed', last_state_change_at=? WHERE id=?`
    ).run(Date.now(), articleId);
    return { article_id: articleId, status: 'angle_fail', error: 'angle generation returned null' };
  }

  // 2. Apply Sonder spin với context-aware CTA + smart hashtags
  const spin = applySonderSpin({
    angle: ang.angle,
    title: article.title,
    angle_hint: article.angle_hint,
    city: hotelCity,
  });

  // 3. Phase N-4: SAFETY GATE trên bài đăng đầy đủ (angle + CTA + hashtags)
  const safety = await runSafetyGate(spin.draft);
  const now = Date.now();

  if (!safety.passed) {
    // Auto-reject: lưu draft để admin xem tại sao bị reject + học pattern
    try {
      const result = db.prepare(
        `INSERT INTO news_post_drafts
         (article_id, hotel_id, draft_angle, draft_post, hashtags,
          ai_provider, ai_tokens_used, safety_flags, auto_rejected,
          rejection_reason, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 'rejected', ?)`
      ).run(
        articleId, hotelId, ang.angle, spin.draft, JSON.stringify(spin.hashtags),
        ang.provider, ang.tokens, JSON.stringify(safety),
        safety.failure_reason || 'safety_fail', now
      );
      const draftId = Number(result.lastInsertRowid);
      db.prepare(
        `UPDATE news_articles SET status='safety_failed', status_note=?, last_state_change_at=? WHERE id=?`
      ).run(safety.failure_reason || 'safety_fail', now, articleId);
      console.log(`[news-angle] SAFETY REJECT draft #${draftId} article #${articleId}: ${safety.failure_reason}`);
      return { article_id: articleId, draft_id: draftId, status: 'safety_rejected', safety_reason: safety.failure_reason };
    } catch (e: any) {
      return { article_id: articleId, status: 'db_fail', error: e.message };
    }
  }

  // 4. Resolve image (chỉ cho drafts passed safety — tiết kiệm Pollinations)
  const img = await resolveImage({
    articleUrl: article.url,
    sourceId: article.source,
    angleHint: article.angle_hint,
    title: article.title,
    region: article.region,
  });

  // 5. Insert draft status='pending' (chờ admin review)
  try {
    const result = db.prepare(
      `INSERT INTO news_post_drafts
       (article_id, hotel_id, draft_angle, draft_post, image_url, hashtags,
        ai_provider, ai_tokens_used, safety_flags, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`
    ).run(
      articleId, hotelId, ang.angle, spin.draft,
      img?.url || null, JSON.stringify(spin.hashtags),
      ang.provider, ang.tokens, JSON.stringify(safety), now
    );
    const draftId = Number(result.lastInsertRowid);

    // Move article to pending_review state
    db.prepare(
      `UPDATE news_articles SET status='pending_review', last_state_change_at=? WHERE id=?`
    ).run(now, articleId);

    console.log(`[news-angle] draft #${draftId} created for article #${articleId} img=${img?.source || 'none'} safety=ok`);
    return { article_id: articleId, draft_id: draftId, status: 'created' };
  } catch (e: any) {
    return { article_id: articleId, status: 'db_fail', error: e.message };
  }
}

/** Batch process articles at status='angle_generated' */
export async function generateDraftsBatch(limit = BATCH_SIZE, hotelId: number = SONDER_HOTEL_ID): Promise<{
  processed: number;
  created: number;
  safety_rejected: number;
  angle_fail: number;
  db_fail: number;
  already_exists: number;
}> {
  const result = { processed: 0, created: 0, safety_rejected: 0, angle_fail: 0, db_fail: 0, already_exists: 0 };
  const pending = db.prepare(
    `SELECT id FROM news_articles WHERE status='angle_generated'
     ORDER BY impact_score DESC, published_at DESC LIMIT ?`
  ).all(limit) as any[];

  for (const row of pending) {
    const r = await generateDraftForArticle(row.id, hotelId);
    result.processed++;
    if (r.status === 'created') result.created++;
    else if (r.status === 'safety_rejected') result.safety_rejected++;
    else if (r.status === 'angle_fail') result.angle_fail++;
    else if (r.status === 'db_fail') result.db_fail++;
    else if (r.status === 'already_exists') result.already_exists++;
    // Rate limit soft — 1s giữa mỗi draft để tránh burst Gemini + Pollinations
    await new Promise(res => setTimeout(res, 1000));
  }

  console.log(`[news-angle] batch: ${JSON.stringify(result)}`);
  return result;
}

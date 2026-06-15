/**
 * SEO Article Daily Content Calendar — sonder-seo-content skill.
 *
 * Cron chạy MỖI NGÀY 9h sáng VN. Theo thứ trong tuần → sinh đúng hạng mục:
 *
 *   T2 → Homestay (B2C, round-robin 3 homestay)        pillar=homestay
 *   T3 → Khách sạn (B2C, round-robin 5 hotel)           pillar=hotel
 *   T4 → Apartment (B2C, round-robin 3 apartment)       pillar=apartment
 *   T5 → Destination guide / Travel tips (B2C)          pillar=destination/tips
 *   T6 → Local insider / Listicle (B2C)                 pillar=insider
 *   T7 → Đối tác OTA #1 (B2B, partner theme rotation)   pillar=partner
 *   CN → Đối tác OTA #2 (B2B, partner theme rotation)   pillar=partner
 *
 * Mọi bài: status='draft' → admin review dashboard → "🌐 Publish to blog".
 * Ảnh: pickImagesForArticle (dedup 60d + Gemini tag + copyright firewall).
 * Telegram alert sau mỗi lần sinh.
 *
 * Settings (DB):
 *  - seo_article_cron_enabled — 'true' (default) | 'false' tắt
 *  - seo_article_calendar_override — JSON map ghi đè lịch (optional)
 */

import { db, getSetting } from '../../db';
import {
  generateArticle, generatePropertyArticle, generatePartnerArticle, saveArticle, ArticleAngle,
} from './article-writer';
import { pickImagesForArticle, recordArticleImages, injectImagesIntoHtml, ContentPillar } from './article-images';

interface DayResult {
  weekday: number;
  pillar: string;
  audience: 'b2c' | 'b2b';
  generated: boolean;
  article_id?: number;
  title?: string;
  images_attached?: number;
  skipped_reason?: string;
  error?: string;
  duration_ms: number;
}

/** Map JS getDay() (0=CN..6=T7) → kế hoạch nội dung. */
function planForWeekday(d: number): {
  pillar: ContentPillar; audience: 'b2c' | 'b2b'; category: string; mode: 'property' | 'keyword' | 'partner';
  propertyType?: 'homestay' | 'hotel' | 'apartment'; angle?: ArticleAngle;
} {
  switch (d) {
    // 14/06/2026 — Lịch ĐA DẠNG DU LỊCH: bỏ B2B đối tác khỏi blog công khai, mở 6 góc du lịch khác nhau.
    case 1: return { pillar: 'destination', audience: 'b2c', category: 'diem-den', mode: 'keyword', angle: 'destination_guide' };  // T2 cẩm nang điểm đến
    case 2: return { pillar: 'insider', audience: 'b2c', category: 'am-thuc', mode: 'keyword', angle: 'local_insider' };          // T3 ẩm thực / địa phương
    case 3: return { pillar: 'destination', audience: 'b2c', category: 'huong-dan', mode: 'keyword', angle: 'how_to' };           // T4 lịch trình / kinh nghiệm
    case 4: return { pillar: 'insider', audience: 'b2c', category: 'diem-den', mode: 'keyword', angle: 'list_post' };             // T5 listicle hidden-gems
    case 5: return { pillar: 'destination', audience: 'b2c', category: 'huong-dan', mode: 'keyword', angle: 'travel_tips' };      // T6 mẹo du lịch
    case 6: { const types: ('homestay' | 'hotel' | 'apartment')[] = ['homestay', 'hotel', 'apartment']; const pt = types[Math.floor(Date.now() / (7 * 86400_000)) % 3]; return { pillar: pt, audience: 'b2c', category: 'diem-den', mode: 'property', propertyType: pt }; } // T7 giới thiệu 1 nơi ở thật (xoay vòng)
    case 0: return { pillar: 'destination', audience: 'b2c', category: 'tin-tuc', mode: 'keyword', angle: 'seasonal' };           // CN theo mùa
    default: return { pillar: 'destination', audience: 'b2c', category: 'diem-den', mode: 'keyword', angle: 'destination_guide' };
  }
}

/** Round-robin: chọn property cũ nhất chưa viết (theo last_article_at). */
function pickNextProperty(propertyType: 'homestay' | 'hotel' | 'apartment'): any | null {
  return db.prepare(
    `SELECT hotel_id, name_canonical, city, district, last_article_at
     FROM hotel_profile
     WHERE property_type = ?
     ORDER BY (last_article_at IS NULL) DESC, last_article_at ASC
     LIMIT 1`,
  ).get(propertyType) as any;
}

/** Pick keyword chưa viết 45 ngày cho B2C non-property (destination/tips/insider). */
function pickKeyword(): { keyword: string; category: string | null } | null {
  const cutoff = Date.now() - 45 * 86400_000;
  return db.prepare(
    `SELECT k.keyword, k.category FROM seo_keywords k
     WHERE k.category IN ('long_tail','medium_tail')
       AND NOT EXISTS (
         SELECT 1 FROM seo_articles a WHERE LOWER(a.keyword_target)=k.keyword AND a.created_at > ?
       )
     ORDER BY (k.current_rank IS NULL) DESC, RANDOM() LIMIT 1`,
  ).get(cutoff) as any;
}

async function notifyAdmin(r: DayResult): Promise<void> {
  try {
    if (getSetting('telegram_admin_alerts_enabled') === 'false') return;
    const token = getSetting('telegram_bot_token') || process.env.TELEGRAM_BOT_TOKEN;
    const chatId = getSetting('telegram_admin_chat_id') || process.env.TELEGRAM_ADMIN_CHAT_ID;
    if (!token || !chatId) return;
    const wd = ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'][r.weekday];
    let msg = `📝 *Bài SEO mới — ${wd}*\n\n`;
    let replyMarkup: any = undefined;
    if (r.generated && r.article_id) {
      const art = db.prepare(`SELECT title, meta_description, status, audience FROM seo_articles WHERE id=?`).get(r.article_id) as any;
      const isDraft = art && art.status !== 'published';
      msg += `✅ *${r.pillar}* (${String(r.audience || '').toUpperCase()}) — ${isDraft ? '⏳ CHỜ DUYỆT' : '🌐 đã đăng'}\n`;
      msg += `*${String(art?.title || r.title || '').slice(0, 110)}*\n`;
      if (art?.meta_description) msg += `_${String(art.meta_description).slice(0, 180)}_\n`;
      msg += `🖼 ${r.images_attached || 0} ảnh · 🆔 #${r.article_id}`;
      if (isDraft && art?.audience === 'b2c') {
        msg += `\n\n👇 Bấm để duyệt:`;
        replyMarkup = { inline_keyboard: [[
          { text: '✅ Đăng lên web', callback_data: `pub:${r.article_id}` },
          { text: '❌ Bỏ', callback_data: `skip:${r.article_id}` },
        ]] };
      } else if (isDraft) {
        msg += `\n\n👉 Bài đối tác (B2B) — duyệt ở /admin/seo/dashboard`;
      }
    } else {
      msg += `⚠️ Không sinh bài ${r.pillar}: ${r.skipped_reason || r.error || 'unknown'}`;
    }
    const axios = require('axios');
    const payload: any = { chat_id: chatId, text: msg, parse_mode: 'Markdown', disable_web_page_preview: true };
    if (replyMarkup) payload.reply_markup = replyMarkup;
    await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, payload, { timeout: 8000 });
  } catch (e: any) { console.warn('[article-cron] telegram fail:', e?.message); }
}

/** Attach ảnh (dedup + copyright) vào bài đã save. */
async function attachImages(articleId: number, pillar: ContentPillar, title: string): Promise<number> {
  try {
    // Bài điểm đến → lấy ảnh stock theo từ khóa điểm đến (keyword_target)
    let stockQuery: string | undefined;
    try { const a = db.prepare(`SELECT keyword_target FROM seo_articles WHERE id=?`).get(articleId) as any; stockQuery = a?.keyword_target || title; } catch { stockQuery = title; }
    const imgs = await pickImagesForArticle({ pillar, count: 4, stockQuery });
    if (imgs.length === 0) return 0;
    recordArticleImages(articleId, imgs.map(i => ({ footage_id: i.footage_id, scene: i.scene, public_url: i.public_url })));
    const a = db.prepare(`SELECT body_html FROM seo_articles WHERE id=?`).get(articleId) as any;
    if (a) {
      const newHtml = injectImagesIntoHtml(a.body_html || '', imgs.map(i => ({ public_url: i.public_url, scene: i.scene })), title);
      db.prepare(`UPDATE seo_articles SET body_html=?, updated_at=? WHERE id=?`).run(newHtml, Date.now(), articleId);
    }
    return imgs.length;
  } catch (e: any) {
    console.warn('[article-cron] attach images fail:', e?.message);
    return 0;
  }
}

/** Đẩy bài đã publish sang blog du lịch công khai OTA (sondervn.com/tin-tuc) qua HMAC-SHA256.
 *  Dùng CURL (Node networking server này không ổn định — bài học bug Telegram ETIMEDOUT).
 *  CHỈ gọi cho bài B2C; nội dung B2B/đối tác KHÔNG lên blog du lịch công khai.
 *  14/06/2026: viết phần đẩy này — trước đó cron chỉ log "auto-published" mà KHÔNG hề POST sang OTA. */
function pushArticleToBlog(articleId: number): boolean {
  try {
    if (getSetting('SONDERVN_BLOG_BRIDGE_ENABLED') === 'false') return false;
    const secret = process.env.MKT_API_SECRET || process.env.SONDERVN_MKT_API_SECRET;
    const base = process.env.SONDERVN_BASE_URL || 'https://sondervn.com';
    if (!secret) { console.warn('[bridge] thiếu MKT_API_SECRET'); return false; }
    const a = db.prepare(
      `SELECT slug, title, meta_description, body_html, body_md, category, related_keywords_json, cover_image_url, published_at FROM seo_articles WHERE id=?`
    ).get(articleId) as any;
    if (!a || !a.slug) { console.warn('[bridge] không thấy bài', articleId); return false; }
    let tags: string[] = [];
    try { tags = (JSON.parse(a.related_keywords_json || '[]') as string[]).filter(Boolean).slice(0, 8); } catch {}
    const cover = (a.cover_image_url && /^https?:\/\//.test(a.cover_image_url)) ? a.cover_image_url : null;
    const desc = a.meta_description ? String(a.meta_description).slice(0, 1000) : null;
    const payload = {
      slug: a.slug, title: String(a.title || '').slice(0, 500), excerpt: desc,
      content: a.body_html || a.body_md || '', coverImage: cover,
      category: a.category || 'tin-tuc', tags, author: 'Sonder', status: 'published',
      seoTitle: String(a.title || '').slice(0, 500), seoDescription: desc,
      publishedAt: a.published_at ? new Date(Number(a.published_at)).toISOString() : new Date().toISOString(),
    };
    const body = JSON.stringify({
      envelope: { source: 'bot-mkt', type: 'blog.upsert', idempotency_key: `art-${articleId}-${a.slug}`.slice(0, 128), emitted_at: new Date().toISOString(), contract_version: '1' },
      kind: 'blog.upsert', payload,
    });
    const sig = require('crypto').createHmac('sha256', secret).update(body).digest('hex');
    const fs = require('fs'); const tmp = `/tmp/blogpush-${articleId}.json`; fs.writeFileSync(tmp, body);
    const out = require('child_process').execFileSync('curl', [
      '-s', '-X', 'POST', `${base}/api/inbound/marketing-content`,
      '-H', 'Content-Type: application/json', '-H', `X-Mkt-Signature: ${sig}`,
      '--data-binary', `@${tmp}`, '--max-time', '30',
    ], { encoding: 'utf8' });
    try { fs.unlinkSync(tmp); } catch {}
    const ok = out.includes('"success":true');
    console.log(`[bridge] push #${articleId} (${a.category}) → ${ok ? 'OK ✓' : 'FAIL'} ${out.slice(0, 140)}`);
    return ok;
  } catch (e: any) { console.warn('[bridge] push fail:', e?.message || e); return false; }
}

/** MAIN — gọi từ scheduler mỗi ngày 9h sáng VN. */
export async function runDailyContentCalendar(forceWeekday?: number): Promise<DayResult> {
  const t0 = Date.now();
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Ho_Chi_Minh' }));
  const weekday = forceWeekday !== undefined ? forceWeekday : now.getDay();
  const plan = planForWeekday(weekday);
  const result: DayResult = { weekday, pillar: plan.pillar, audience: plan.audience, generated: false, duration_ms: 0 };

  console.log(`[article-cron] Daily calendar — weekday=${weekday} pillar=${plan.pillar} mode=${plan.mode}`);

  try {
    let draft: any = null;
    let saveOpts: any = { audience: plan.audience, content_pillar: plan.pillar, category: plan.category };

    if (plan.mode === 'property') {
      const prop = pickNextProperty(plan.propertyType!);
      if (!prop) { result.skipped_reason = `no ${plan.propertyType} in hotel_profile`; result.duration_ms = Date.now() - t0; await notifyAdmin(result); return result; }
      console.log(`[article-cron] property: #${prop.hotel_id} ${prop.name_canonical}`);
      draft = await generatePropertyArticle(prop.hotel_id);
      saveOpts.source_hotel_id = prop.hotel_id;
      saveOpts.angle = 'destination_guide';
    } else if (plan.mode === 'partner') {
      draft = await generatePartnerArticle();
      saveOpts.angle = 'how_to';
    } else {
      // keyword mode (destination/insider)
      const kw = pickKeyword();
      if (!kw) { result.skipped_reason = 'no eligible keyword'; result.duration_ms = Date.now() - t0; await notifyAdmin(result); return result; }
      draft = await generateArticle({ keyword_target: kw.keyword, angle: plan.angle, language: 'vi', target_word_count: 1500 });
      saveOpts.angle = plan.angle;
    }

    if (!draft) { result.error = 'generation returned null'; result.duration_ms = Date.now() - t0; await notifyAdmin(result); return result; }

    const articleId = saveArticle(draft, saveOpts);
    result.article_id = articleId;
    result.title = draft.title;
    result.generated = true;

    // Attach ảnh (mọi bài có cover + inline, dedup + copyright safe)
    result.images_attached = await attachImages(articleId, plan.pillar, draft.title);

    // Auto-publish lên blog ngay (toggle: setting seo_auto_publish, mặc định BẬT).
    // Bài draft → published → hiện trên sondervn.com/tin-tuc. Tắt: set seo_auto_publish='false'.
    if (getSetting('seo_auto_publish') !== 'false') {
      try {
        const row = db.prepare(`SELECT slug FROM seo_articles WHERE id = ?`).get(articleId) as any;
        const nowMs = Date.now();
        db.prepare(
          `UPDATE seo_articles SET status='published', published_url=?, published_at=?, reviewed_at=COALESCE(reviewed_at,?), updated_at=? WHERE id=? AND status='draft'`
        ).run(`https://sondervn.com/tin-tuc/${row.slug}`, nowMs, nowMs, nowMs, articleId);
        (result as any).published = true;
        // CHỈ đẩy lên blog du lịch công khai cho bài B2C (đối tác B2B giữ nội bộ).
        if (plan.audience === 'b2c') {
          const pushed = pushArticleToBlog(articleId);
          console.log(`[article-cron] ${pushed ? '🌐 ĐÃ ĐẨY LÊN OTA' : '⚠️ đẩy OTA thất bại'} #${articleId} → /tin-tuc/${row.slug}`);
        } else {
          console.log(`[article-cron] (B2B đối tác — KHÔNG đẩy lên blog công khai) #${articleId}`);
        }
      } catch (e: any) {
        console.warn('[article-cron] auto-publish fail:', e?.message || e);
      }
    }

    result.duration_ms = Date.now() - t0;
    console.log(`[article-cron] ✅ #${articleId} "${draft.title.slice(0, 60)}" (${draft.word_count}w, ${result.images_attached} imgs, ${(result.duration_ms / 1000).toFixed(0)}s)`);
    await notifyAdmin(result);
    return result;
  } catch (e: any) {
    result.error = e?.message || String(e);
    result.duration_ms = Date.now() - t0;
    console.error('[article-cron] daily error:', result.error);
    await notifyAdmin(result);
    return result;
  }
}

/** Duyệt + ĐĂNG 1 bài draft → set published + đẩy bridge lên sondervn.com/tin-tuc.
 *  Dùng cho nút duyệt Telegram (pub:<id>) + dashboard. Trả {ok, url, error}. */
export function publishArticleNow(articleId: number): { ok: boolean; url?: string; error?: string } {
  try {
    const row = db.prepare(`SELECT slug, status, audience FROM seo_articles WHERE id = ?`).get(articleId) as any;
    if (!row) return { ok: false, error: 'not_found' };
    const url = `https://sondervn.com/tin-tuc/${row.slug}`;
    if (row.status === 'published') return { ok: true, url };
    const nowMs = Date.now();
    db.prepare(
      `UPDATE seo_articles SET status='published', published_url=?, published_at=?, reviewed_at=COALESCE(reviewed_at,?), updated_at=? WHERE id=?`
    ).run(url, nowMs, nowMs, nowMs, articleId);
    let pushed = true;
    if (row.audience === 'b2c') pushed = pushArticleToBlog(articleId);   // chỉ B2C lên blog công khai
    return { ok: true, url, error: pushed ? undefined : 'published_local_nhung_bridge_loi' };
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }
}

/** Bỏ qua 1 bài draft (không đăng) → status='reviewed'. Dùng cho nút skip:<id>. */
export function skipArticle(articleId: number): boolean {
  try {
    const r = db.prepare(`UPDATE seo_articles SET status='reviewed', updated_at=? WHERE id=? AND status='draft'`).run(Date.now(), articleId);
    return r.changes > 0;
  } catch { return false; }
}

/** Manual trigger 1 ngày bất kỳ (test). forceWeekday: 0=CN..6=T7. */
export async function triggerDailyNow(forceWeekday?: number): Promise<DayResult> {
  return runDailyContentCalendar(forceWeekday);
}

/** Legacy weekly (giữ cho backward-compat manual trigger cũ). */
export async function runWeeklyArticleGeneration(): Promise<any> {
  // Redirect sang daily calendar theo hôm nay
  const r = await runDailyContentCalendar();
  return { attempted: 1, generated: r.generated ? 1 : 0, failed: r.generated ? 0 : 1, article_ids: r.article_id ? [r.article_id] : [], cost_estimate_usd: 0.02, duration_ms: r.duration_ms, skipped_reason: r.skipped_reason };
}
export async function triggerWeeklyArticleGenerationNow(): Promise<any> { return runWeeklyArticleGeneration(); }

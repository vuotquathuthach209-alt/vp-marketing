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
    case 1: return { pillar: 'homestay', audience: 'b2c', category: 'diem-den', mode: 'property', propertyType: 'homestay' };
    case 2: return { pillar: 'hotel', audience: 'b2c', category: 'diem-den', mode: 'property', propertyType: 'hotel' };
    case 3: return { pillar: 'apartment', audience: 'b2c', category: 'diem-den', mode: 'property', propertyType: 'apartment' };
    case 4: return { pillar: 'destination', audience: 'b2c', category: 'huong-dan', mode: 'keyword', angle: 'destination_guide' };
    case 5: return { pillar: 'insider', audience: 'b2c', category: 'tin-tuc', mode: 'keyword', angle: 'local_insider' };
    case 6: return { pillar: 'partner', audience: 'b2b', category: 'doi-tac', mode: 'partner' };
    case 0: return { pillar: 'partner', audience: 'b2b', category: 'doi-tac', mode: 'partner' };
    default: return { pillar: 'destination', audience: 'b2c', category: 'huong-dan', mode: 'keyword', angle: 'destination_guide' };
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
    let msg = `📝 *SEO Content Calendar — ${wd}*\n\n`;
    if (r.generated) {
      msg += `✅ Sinh bài *${r.pillar}* (${r.audience.toUpperCase()})\n`;
      msg += `"${(r.title || '').slice(0, 90)}"\n`;
      msg += `🖼 ${r.images_attached || 0} ảnh · 🆔 #${r.article_id}\n\n`;
      msg += `👉 Review: /admin/seo/dashboard → 📝 Articles → "🌐 Publish to blog"`;
    } else {
      msg += `⚠️ Không sinh bài ${r.pillar}: ${r.skipped_reason || r.error || 'unknown'}`;
    }
    const axios = require('axios');
    await axios.post(`https://api.telegram.org/bot${token}/sendMessage`,
      { chat_id: chatId, text: msg, parse_mode: 'Markdown', disable_web_page_preview: true },
      { timeout: 8000 });
  } catch (e: any) { console.warn('[article-cron] telegram fail:', e?.message); }
}

/** Attach ảnh (dedup + copyright) vào bài đã save. */
async function attachImages(articleId: number, pillar: ContentPillar, title: string): Promise<number> {
  try {
    const imgs = await pickImagesForArticle({ pillar, count: 4 });
    if (imgs.length === 0) return 0;
    recordArticleImages(articleId, imgs.map(i => ({ footage_id: i.footage_id, scene: i.scene })));
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
        console.log(`[article-cron] 🌐 auto-published #${articleId} → /tin-tuc/${row.slug}`);
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

/**
 * Content Intelligence — AUTO WEEKLY PUBLISHER.
 *
 * Mỗi tuần 1 lần (Monday 9h VN time) bot tự:
 *   1. Fetch inspiration từ web/social:
 *      - Priority 1: news_articles mới nhất (status = 'relevant' hoặc 'ingested') - curated RSS
 *      - Priority 2: inspiration_posts đã có AI analyzed
 *   2. Nếu chưa có AI analysis → gọi analyzeInspiration
 *   3. Gọi remixPost để viết bài theo Sonder voice (transform > 50%)
 *   4. Lưu vào remix_drafts status='approved'
 *   5. Publish lên fanpage đầu tiên của hotel_id
 *
 * Rate limit: 1 bài/tuần (check remix_drafts.published_at trong 7 ngày qua).
 * Safety: originality_score >= 0.5 (remix khác bài gốc >= 50%).
 */

import fs from 'fs';
import path from 'path';
import { db } from '../db';
import { config } from '../config';
import {
  analyzeInspiration,
  remixPost,
  InspirationAnalysis,
} from './content-intelligence';
import { publishText, publishImage } from './facebook';
import { fetchOgImage } from './news-ingest';
import { generateImagePollinations } from './pollinations';
import { notifyAll } from './telegram';

/* ═══════════════════════════════════════════
   WEEKLY LIMIT CHECK (calendar week Mon–Sun VN time)
   ═══════════════════════════════════════════ */

/** Trả về timestamp start-of-week hiện tại (Thứ 2 00:00 VN time, UTC ms). */
export function startOfCurrentWeekVN(): number {
  const now = new Date();
  // VN time = UTC + 7
  const vnNow = new Date(now.getTime() + 7 * 3600_000);
  // JS Date.getUTCDay(): Sun=0, Mon=1, ..., Sat=6
  const vnDay = vnNow.getUTCDay();
  // Days since Monday: Mon=0, Tue=1, ..., Sun=6
  const daysSinceMonday = (vnDay + 6) % 7;
  // Monday 00:00 VN time
  const monday = new Date(vnNow);
  monday.setUTCDate(vnNow.getUTCDate() - daysSinceMonday);
  monday.setUTCHours(0, 0, 0, 0);
  // Convert back to UTC ms
  return monday.getTime() - 7 * 3600_000;
}

export function ciPublishedThisWeek(hotelId: number): number {
  const weekStart = startOfCurrentWeekVN();
  const row = db.prepare(
    `SELECT COUNT(*) as n FROM remix_drafts
     WHERE hotel_id = ? AND status = 'published' AND published_at >= ?`
  ).get(hotelId, weekStart) as any;
  return row?.n || 0;
}

/* ═══════════════════════════════════════════
   PICK INSPIRATION SOURCE
   ═══════════════════════════════════════════ */

interface InspirationSource {
  kind: 'news_article' | 'existing_inspiration';
  id: number;
  text: string;
  source_name: string;
  source_url?: string;
  image_url?: string;
  region?: string;
}

/** Ưu tiên picking: article mới nhất về du lịch/khách sạn (region không trùng bài đã post tuần trước) */
function pickInspirationSource(hotelId: number): InspirationSource | null {
  const twoWeeksAgo = Date.now() - 14 * 24 * 3600_000;

  // Priority 0: inspiration_posts từ social/blog (analyzed, chưa remix gần đây)
  //             → ƯU TIÊN vì đây là nguồn user-curated / social trend
  const fromSocial = db.prepare(
    `SELECT ip.* FROM inspiration_posts ip
     WHERE ip.hotel_id = ? AND ip.status = 'analyzed'
       AND NOT EXISTS (
         SELECT 1 FROM remix_drafts rd
         WHERE rd.inspiration_id = ip.id AND rd.created_at > ?
       )
     ORDER BY ip.created_at DESC
     LIMIT 1`
  ).get(hotelId, twoWeeksAgo) as any;

  if (fromSocial) {
    return {
      kind: 'existing_inspiration',
      id: fromSocial.id,
      text: fromSocial.original_text,
      source_name: fromSocial.source_name || 'Social/Blog',
      source_url: fromSocial.source_url,
    };
  }

  // Loại bỏ các region đã post trong 2 tuần qua (tránh trùng topic)
  const recentRegions = db.prepare(
    `SELECT DISTINCT a.region FROM remix_drafts rd
     JOIN inspiration_posts ip ON ip.id = rd.inspiration_id
     LEFT JOIN news_articles a ON a.url = ip.source_url
     WHERE rd.hotel_id = ? AND rd.published_at > ? AND a.region IS NOT NULL`
  ).all(hotelId, twoWeeksAgo) as any[];
  const excludedRegions = recentRegions.map(r => r.region).filter(Boolean);

  // Priority 1: news_articles status='angle_generated' (đã qua classifier) trong 7 ngày qua
  //             Ưu tiên travel_relevant=1 + relevance_score cao
  const oneWeekAgo = Date.now() - 7 * 24 * 3600_000;
  const regionFilter = excludedRegions.length
    ? `AND (region IS NULL OR region NOT IN (${excludedRegions.map(() => '?').join(',')}))`
    : '';

  const article = db.prepare(
    `SELECT id, title, body, url, region, source, is_travel_relevant, relevance_score
     FROM news_articles
     WHERE status IN ('angle_generated', 'pending_review', 'approved', 'published')
       AND published_at > ?
       AND is_travel_relevant = 1
       AND (political_risk IS NULL OR political_risk < 0.3)
       AND title NOT LIKE '%Mỹ:%'
       AND title NOT LIKE '%chính trị%'
       AND title NOT LIKE '%bầu cử%'
       AND title NOT LIKE '%chiến tranh%'
       AND title NOT LIKE '%Trump%'
       AND title NOT LIKE '%Biden%'
       AND title NOT LIKE '%Tổng thống%'
       AND title NOT LIKE '%Putin%'
       AND title NOT LIKE '%Xi Jinping%'
       ${regionFilter}
     ORDER BY
       relevance_score DESC,
       published_at DESC
     LIMIT 1`
  ).get(oneWeekAgo, ...excludedRegions) as any;

  if (article) {
    const text = `${article.title}\n\n${article.body || ''}`.trim().slice(0, 3000);
    if (text.length >= 80) {
      return {
        kind: 'news_article',
        id: article.id,
        text,
        source_name: article.source || 'News',
        source_url: article.url,
        region: article.region,
      };
    }
  }

  return null;
}

/* ═══════════════════════════════════════════
   SAVE + ANALYZE INSPIRATION (nếu từ news_article)
   ═══════════════════════════════════════════ */

async function ensureInspirationAnalyzed(
  source: InspirationSource,
  hotelId: number,
): Promise<{ inspirationId: number; analysis: InspirationAnalysis } | null> {
  // Nếu đã là existing_inspiration → load analysis
  if (source.kind === 'existing_inspiration') {
    const ip = db.prepare(
      `SELECT * FROM inspiration_posts WHERE id = ?`
    ).get(source.id) as any;
    if (!ip || !ip.pattern_hook) return null;
    return {
      inspirationId: ip.id,
      analysis: {
        hook: ip.pattern_hook,
        emotion: ip.pattern_emotion || 'unknown',
        structure: ip.pattern_structure || 'unknown',
        cta: ip.pattern_cta || 'unknown',
        topic_tags: ip.topic_tags ? JSON.parse(ip.topic_tags) : [],
        why_it_works: ip.ai_insights || '',
        remix_angles: ip.remix_angle_suggestions ? JSON.parse(ip.remix_angle_suggestions) : [],
      },
    };
  }

  // news_article → analyze + save
  const analysis = await analyzeInspiration(source.text);
  if (!analysis) return null;

  const result = db.prepare(
    `INSERT INTO inspiration_posts
     (hotel_id, source_name, source_url, source_type, original_text, language,
      pattern_hook, pattern_emotion, pattern_structure, pattern_cta,
      topic_tags, ai_insights, remix_angle_suggestions,
      status, created_at, analyzed_at)
     VALUES (?, ?, ?, 'blog', ?, 'vi', ?, ?, ?, ?, ?, ?, ?, 'analyzed', ?, ?)`
  ).run(
    hotelId,
    source.source_name,
    source.source_url || null,
    source.text,
    analysis.hook,
    analysis.emotion,
    analysis.structure,
    analysis.cta,
    JSON.stringify(analysis.topic_tags),
    analysis.why_it_works,
    JSON.stringify(analysis.remix_angles),
    Date.now(),
    Date.now(),
  );

  return { inspirationId: result.lastInsertRowid as number, analysis };
}

/* ═══════════════════════════════════════════
   MAIN: runWeeklyAutoPost
   ═══════════════════════════════════════════ */

export interface WeeklyRunResult {
  ok: boolean;
  skipped?: string;
  fb_post_id?: string;
  remix_draft_id?: number;
  originality_score?: number;
  hotel_id?: number;
  error?: string;
}

export async function runWeeklyAutoPost(hotelId: number = 1): Promise<WeeklyRunResult> {
  console.log(`[ci-weekly] Start hotel #${hotelId}`);

  // 1. Check weekly limit (1/tuần)
  const already = ciPublishedThisWeek(hotelId);
  if (already >= 1) {
    console.log(`[ci-weekly] SKIP: đã post ${already} bài CI tuần này`);
    return { ok: false, skipped: `already_posted_this_week(${already})` };
  }

  // 2a. Fresh ingest từ blog travel VN + (nếu token OK) FB fanpage competitors
  try {
    const { ingestAllInspirationSources } = require('./social-inspiration-fetcher');
    const res = await ingestAllInspirationSources(hotelId);
    console.log(`[ci-weekly] Social ingest: blog=${res.blog.saved} fb=${res.facebook.saved} analyzed=${res.total_analyzed}`);
  } catch (e: any) {
    console.warn(`[ci-weekly] social ingest fail:`, e?.message);
  }

  // 2b. Pick inspiration source (priority: social/blog > news_articles)
  const source = pickInspirationSource(hotelId);
  if (!source) {
    console.log(`[ci-weekly] SKIP: không tìm thấy inspiration source phù hợp`);
    return { ok: false, skipped: 'no_inspiration_available' };
  }
  console.log(`[ci-weekly] Source: ${source.kind} #${source.id} (${source.source_name}) — "${source.text.slice(0, 60)}..."`);

  // 3. Ensure analyzed
  const analyzed = await ensureInspirationAnalyzed(source, hotelId);
  if (!analyzed) {
    return { ok: false, error: 'inspiration_analysis_failed' };
  }
  console.log(`[ci-weekly] Analysis: hook=${analyzed.analysis.hook} emotion=${analyzed.analysis.emotion}`);

  // 4. Pick hotel name + remix angle
  const hotel = db.prepare(
    `SELECT hp.name_canonical, hp.property_type
     FROM hotel_profile hp
     WHERE EXISTS (SELECT 1 FROM mkt_hotels mh WHERE mh.ota_hotel_id = hp.hotel_id AND mh.status = 'active')
     LIMIT 1`
  ).get() as any;
  const hotelName = hotel?.name_canonical || 'Sonder';
  const productGroup: 'monthly_apartment' | 'nightly_stay' =
    hotel?.property_type === 'apartment' ? 'monthly_apartment' : 'nightly_stay';

  const angle = analyzed.analysis.remix_angles[0] || `Áp dụng cho ${hotelName}`;

  // 5. Remix
  const remix = await remixPost({
    inspirationText: source.text,
    inspirationAnalysis: analyzed.analysis,
    targetAngle: angle,
    hotelName,
    brandVoice: 'friendly',
    productGroup,
  });
  if (!remix) {
    return { ok: false, error: 'remix_failed' };
  }
  console.log(`[ci-weekly] Remix OK: ${remix.remix_text.length} chars, originality=${remix.originality_score}`);

  // Safety: originality >= 0.5
  if (remix.originality_score < 0.5) {
    console.warn(`[ci-weekly] SKIP: originality=${remix.originality_score} < 0.5 (too similar to source)`);
    return { ok: false, skipped: `low_originality(${remix.originality_score})` };
  }

  // 6. Save remix_drafts status='approved'
  const now = Date.now();
  const draftResult = db.prepare(
    `INSERT INTO remix_drafts
     (inspiration_id, hotel_id, remix_angle, remix_text, brand_voice,
      hashtags, ai_provider, ai_tokens_used, status, scheduled_at, created_at, admin_notes)
     VALUES (?, ?, ?, ?, 'friendly', ?, ?, ?, 'approved', ?, ?, 'auto-generated by ci-weekly')`
  ).run(
    analyzed.inspirationId,
    hotelId,
    angle,
    remix.remix_text,
    JSON.stringify(remix.hashtags),
    remix.provider,
    remix.tokens_used,
    now,
    now,
  );
  const remixDraftId = draftResult.lastInsertRowid as number;

  // 7. Find fanpage for this hotel
  const page = db.prepare(
    `SELECT id, fb_page_id, access_token, name FROM pages WHERE hotel_id = ? ORDER BY id LIMIT 1`
  ).get(hotelId) as any;
  if (!page) {
    return { ok: false, error: 'no_fb_page_for_hotel' };
  }

  // 8a. Fetch og:image nếu có source_url (tăng engagement)
  let imageUrl: string | undefined = source.image_url;
  if (!imageUrl && source.source_url) {
    try {
      imageUrl = await fetchOgImage(source.source_url);
      console.log(`[ci-weekly] og:image: ${imageUrl ? 'found' : 'none'}`);
    } catch {}
  }

  // 8b. Nếu vẫn không có image → gen bằng Pollinations AI từ topic_tags
  let localImagePath: string | null = null;
  if (!imageUrl) {
    try {
      const tags = analyzed.analysis.topic_tags.slice(0, 3).join(', ');
      const prompt = tags
        ? `Vietnamese travel scene: ${tags}, hotel apartment, warm lighting, cinematic, high quality, no text, no logo`
        : 'Vietnam travel luxury serviced apartment, warm lighting, cinematic, cozy, no text, no logo';
      console.log(`[ci-weekly] Generating AI image: "${prompt.slice(0, 80)}..."`);
      const mediaId = await generateImagePollinations(prompt);
      const media = db.prepare(`SELECT filename FROM media WHERE id = ?`).get(mediaId) as any;
      if (media?.filename) {
        localImagePath = path.join(config.mediaDir, media.filename);
        if (!fs.existsSync(localImagePath)) localImagePath = null;
      }
      console.log(`[ci-weekly] AI image: ${localImagePath ? 'OK' : 'fail'}`);
    } catch (e: any) {
      console.warn(`[ci-weekly] AI image gen fail:`, e?.message);
    }
  }

  // 9. Publish!
  try {
    let fbPostId: string;
    if (imageUrl && /^https?:\/\//.test(imageUrl)) {
      // Use og:image từ article — FB fetch + CDN
      const axios = require('axios');
      const GRAPH = 'https://graph.facebook.com/v18.0';
      const resp = await axios.post(
        `${GRAPH}/${page.fb_page_id}/photos`,
        null,
        {
          params: { message: remix.remix_text, url: imageUrl, access_token: page.access_token },
          timeout: 60_000,
        }
      );
      fbPostId = resp.data.post_id || resp.data.id;
    } else if (localImagePath) {
      // AI-generated local file
      const r = await publishImage(page.fb_page_id, page.access_token, remix.remix_text, localImagePath);
      fbPostId = r.fbPostId;
    } else {
      const r = await publishText(page.fb_page_id, page.access_token, remix.remix_text);
      fbPostId = r.fbPostId;
    }

    db.prepare(
      `UPDATE remix_drafts SET status='published', fb_post_id=?, published_at=? WHERE id=?`
    ).run(fbPostId, Date.now(), remixDraftId);

    console.log(`[ci-weekly] ✅ Published: fb=${fbPostId} draft=${remixDraftId}`);

    // Notify admin
    try {
      notifyAll(
        `🤖 *CI Auto Weekly Post*\n` +
        `• Hotel: ${hotelName}\n` +
        `• Page: ${page.name}\n` +
        `• Inspiration: ${source.source_name}\n` +
        `• Originality: ${remix.originality_score}\n` +
        `• FB Post: \`${fbPostId}\`\n` +
        `• Preview: ${remix.remix_text.slice(0, 200)}...`
      ).catch(() => {});
    } catch {}

    return {
      ok: true,
      fb_post_id: fbPostId,
      remix_draft_id: remixDraftId,
      originality_score: remix.originality_score,
      hotel_id: hotelId,
    };
  } catch (e: any) {
    const errMsg = e?.response?.data?.error?.message || e?.message || 'unknown';
    console.error(`[ci-weekly] Publish FAIL: ${errMsg}`);
    db.prepare(
      `UPDATE remix_drafts SET status='draft', admin_notes=? WHERE id=?`
    ).run(`publish_fail: ${errMsg}`, remixDraftId);
    return { ok: false, error: errMsg, remix_draft_id: remixDraftId };
  }
}

/** Run cho TẤT CẢ active hotels */
export async function runWeeklyAutoPostAllHotels(): Promise<WeeklyRunResult[]> {
  const hotels = db.prepare(
    `SELECT DISTINCT hotel_id FROM mkt_hotels WHERE status = 'active'`
  ).all() as any[];

  const results: WeeklyRunResult[] = [];
  for (const h of hotels) {
    try {
      const r = await runWeeklyAutoPost(h.hotel_id);
      results.push(r);
    } catch (e: any) {
      results.push({ ok: false, hotel_id: h.hotel_id, error: e?.message || 'unknown' });
    }
  }
  return results;
}

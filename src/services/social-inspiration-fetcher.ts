/**
 * Social Inspiration Fetcher — lấy cảm hứng từ mạng xã hội + blog travel VN.
 *
 * 3 nguồn:
 *   1. Travel blog RSS VN (VnExpress Du lịch, iVIVU, BlogMia, ...)
 *   2. Facebook public fanpage posts (qua Graph API, cần token)
 *   3. Instagram public hashtag posts (qua public web scrape, fragile)
 *
 * Output: lưu vào `inspiration_posts` status='analyzed' để CI auto-weekly pick.
 */

import axios from 'axios';
import { db } from '../db';
import { parseRSS, fetchOgImage } from './news-ingest';
import { analyzeInspiration } from './content-intelligence';

const USER_AGENT = 'SonderBot/1.0 (+https://app.sondervn.com)';

/* ═══════════════════════════════════════════
   TRAVEL BLOG RSS (VN-focused, travel/hospitality)
   ═══════════════════════════════════════════ */

export const TRAVEL_BLOG_SOURCES: Array<{ name: string; url: string; type: string; tier: string }> = [
  // Travel news VN (verified working)
  { name: 'VnExpress Du lịch', url: 'https://vnexpress.net/rss/du-lich.rss', type: 'blog', tier: 'AAA' },
  { name: 'VnExpress Kinh doanh', url: 'https://vnexpress.net/rss/kinh-doanh.rss', type: 'blog', tier: 'AAA' },
  // Travel blogs
  { name: 'iVIVU Blog', url: 'https://blog.ivivu.com/feed/', type: 'travel_blog', tier: 'A' },
  // VietnamPlus (already in news_sources but RSS backup)
  { name: 'VietnamPlus Du lịch', url: 'https://www.vietnamplus.vn/rss/du-lich.rss', type: 'blog', tier: 'AA' },
  // Tuổi Trẻ du lịch
  { name: 'Tuổi Trẻ Du lịch', url: 'https://tuoitre.vn/rss/du-lich.rss', type: 'blog', tier: 'AA' },
];

/** Fetch 1 RSS source → return parsed items */
async function fetchRssItems(source: { name: string; url: string }): Promise<Array<any>> {
  try {
    const resp = await axios.get(source.url, {
      timeout: 15_000,
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/rss+xml, text/xml, */*' },
      maxContentLength: 5_000_000,
    });
    const xml = String(resp.data || '');
    const items = parseRSS(xml);
    return items.map(i => ({ ...i, source_name: source.name }));
  } catch (e: any) {
    console.warn(`[social-insp] RSS fail ${source.name}:`, e?.message);
    return [];
  }
}

/** Ingest blog articles → inspiration_posts (analyzed). */
export async function ingestTravelBlogs(hotelId: number = 1): Promise<{ fetched: number; saved: number; analyzed: number }> {
  const out = { fetched: 0, saved: 0, analyzed: 0 };
  const now = Date.now();
  const maxAge = 7 * 24 * 3600_000;  // chỉ lấy bài < 7 days

  for (const source of TRAVEL_BLOG_SOURCES) {
    const items = await fetchRssItems(source);
    out.fetched += items.length;

    for (const item of items.slice(0, 5)) {  // max 5 bài/source/lần
      if (!item.title || !item.description) continue;
      if (now - item.pub_date > maxAge) continue;

      // Dedupe bằng source_url
      const existing = db.prepare(
        `SELECT id FROM inspiration_posts WHERE source_url = ? LIMIT 1`
      ).get(item.link) as any;
      if (existing) continue;

      const text = `${item.title}\n\n${item.description}`.slice(0, 3000);
      if (text.length < 100) continue;

      // Lưu raw trước — analyze sau nếu cần
      const r = db.prepare(
        `INSERT INTO inspiration_posts
         (hotel_id, source_name, source_url, source_type, original_text, language, status, created_at)
         VALUES (?, ?, ?, 'blog', ?, 'vi', 'pending', ?)`
      ).run(hotelId, item.source_name, item.link, text, now);
      out.saved++;

      // Analyze với Gemini (throttle: chỉ analyze 2 bài/source/run để không burn quota)
      if (out.analyzed < 10) {
        const analysis = await analyzeInspiration(text);
        if (analysis) {
          db.prepare(
            `UPDATE inspiration_posts SET
              pattern_hook = ?, pattern_emotion = ?, pattern_structure = ?, pattern_cta = ?,
              topic_tags = ?, ai_insights = ?, remix_angle_suggestions = ?,
              status = 'analyzed', analyzed_at = ?
             WHERE id = ?`
          ).run(
            analysis.hook, analysis.emotion, analysis.structure, analysis.cta,
            JSON.stringify(analysis.topic_tags),
            analysis.why_it_works,
            JSON.stringify(analysis.remix_angles),
            now,
            r.lastInsertRowid,
          );
          out.analyzed++;
        }
      }

      // Gentle rate limit
      await new Promise(r => setTimeout(r, 500));
    }
  }

  console.log(`[social-insp] ingested: fetched=${out.fetched} saved=${out.saved} analyzed=${out.analyzed}`);
  return out;
}

/* ═══════════════════════════════════════════
   FACEBOOK PUBLIC FANPAGE POSTS
   ═══════════════════════════════════════════ */

/** Danh sách fanpage nguồn cảm hứng (travel/hotel VN competitors + influencers). */
export const FB_INSPIRATION_PAGES: Array<{ name: string; page_id: string; category: string }> = [
  // Competitor hotel chains
  { name: 'Vinpearl', page_id: 'Vinpearl.JSC', category: 'luxury_hotel' },
  { name: 'Mường Thanh Hotels', page_id: 'MuongThanhHospitality', category: 'mid_hotel' },
  // Travel influencers VN
  { name: 'Check in Vietnam', page_id: 'checkinvietnam', category: 'influencer' },
  { name: 'Dulich24h', page_id: 'dulich24hvn', category: 'travel_blog' },
];

/**
 * Fetch top recent posts from 1 public FB page.
 * Requires page_id + a valid app access token.
 */
export async function fetchFbPagePosts(
  pageId: string,
  accessToken: string,
  limit: number = 5,
): Promise<Array<{ id: string; message: string; created_time: number; permalink_url?: string }>> {
  try {
    const resp = await axios.get(
      `https://graph.facebook.com/v18.0/${pageId}/posts`,
      {
        params: {
          access_token: accessToken,
          fields: 'id,message,created_time,permalink_url',
          limit,
        },
        timeout: 15_000,
      }
    );
    const data = resp.data?.data || [];
    return data
      .filter((p: any) => p.message && p.message.length >= 100)
      .map((p: any) => ({
        id: p.id,
        message: p.message,
        created_time: new Date(p.created_time).getTime(),
        permalink_url: p.permalink_url,
      }));
  } catch (e: any) {
    console.warn(`[social-insp] FB fetch fail ${pageId}:`, e?.response?.data?.error?.message || e?.message);
    return [];
  }
}

/**
 * Ingest FB page posts → inspiration_posts.
 * Cần access_token của app có Pages Public Content Access permission.
 */
export async function ingestFbPagePosts(
  hotelId: number = 1,
  accessTokenOverride?: string,
): Promise<{ fetched: number; saved: number; analyzed: number }> {
  const out = { fetched: 0, saved: 0, analyzed: 0 };
  const now = Date.now();
  const maxAge = 14 * 24 * 3600_000;

  // Lấy access token từ page đầu tiên (nếu không có override)
  let accessToken = accessTokenOverride;
  if (!accessToken) {
    const page = db.prepare(`SELECT access_token FROM pages WHERE hotel_id = ? LIMIT 1`).get(hotelId) as any;
    accessToken = page?.access_token;
  }
  if (!accessToken) {
    console.warn('[social-insp] no FB access token available');
    return out;
  }

  for (const p of FB_INSPIRATION_PAGES) {
    const posts = await fetchFbPagePosts(p.page_id, accessToken, 3);
    out.fetched += posts.length;

    for (const post of posts) {
      if (now - post.created_time > maxAge) continue;

      const existing = db.prepare(
        `SELECT id FROM inspiration_posts WHERE source_url = ? LIMIT 1`
      ).get(post.permalink_url || post.id) as any;
      if (existing) continue;

      const r = db.prepare(
        `INSERT INTO inspiration_posts
         (hotel_id, source_name, source_url, source_type, original_text, language, status, created_at)
         VALUES (?, ?, ?, 'facebook', ?, 'vi', 'pending', ?)`
      ).run(hotelId, p.name, post.permalink_url || post.id, post.message, now);
      out.saved++;

      if (out.analyzed < 5) {
        const analysis = await analyzeInspiration(post.message);
        if (analysis) {
          db.prepare(
            `UPDATE inspiration_posts SET
              pattern_hook = ?, pattern_emotion = ?, pattern_structure = ?, pattern_cta = ?,
              topic_tags = ?, ai_insights = ?, remix_angle_suggestions = ?,
              status = 'analyzed', analyzed_at = ?
             WHERE id = ?`
          ).run(
            analysis.hook, analysis.emotion, analysis.structure, analysis.cta,
            JSON.stringify(analysis.topic_tags),
            analysis.why_it_works,
            JSON.stringify(analysis.remix_angles),
            now,
            r.lastInsertRowid,
          );
          out.analyzed++;
        }
      }

      await new Promise(r => setTimeout(r, 500));
    }
  }

  console.log(`[social-insp] FB ingested: fetched=${out.fetched} saved=${out.saved} analyzed=${out.analyzed}`);
  return out;
}

/* ═══════════════════════════════════════════
   UNIFIED RUNNER (all sources)
   ═══════════════════════════════════════════ */

export async function ingestAllInspirationSources(hotelId: number = 1) {
  const blogRes = await ingestTravelBlogs(hotelId).catch(e => {
    console.warn('[social-insp] blog fail:', e?.message);
    return { fetched: 0, saved: 0, analyzed: 0 };
  });

  // FB ingest chỉ chạy nếu env flag FB_INGEST_ENABLED=1 (cần Pages Public Content Access approved)
  const fbRes = process.env.FB_INGEST_ENABLED === '1'
    ? await ingestFbPagePosts(hotelId).catch(e => {
        console.warn('[social-insp] fb fail:', e?.message);
        return { fetched: 0, saved: 0, analyzed: 0 };
      })
    : { fetched: 0, saved: 0, analyzed: 0 };

  return {
    blog: blogRes,
    facebook: fbRes,
    total_saved: blogRes.saved + fbRes.saved,
    total_analyzed: blogRes.analyzed + fbRes.analyzed,
  };
}

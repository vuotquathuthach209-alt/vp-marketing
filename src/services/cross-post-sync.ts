/**
 * Cross-Post Sync — auto fan-out FB post → IG + Zalo OA.
 *
 * Gọi SAU KHI FB publish thành công. Hàm non-blocking: fire-and-forget
 * (không throw nếu IG/Zalo fail). Log kết quả vào bảng cross_post_log.
 *
 * Flow:
 *   1. Lookup FB post content: caption + image_url (nếu có)
 *   2. Instagram: publishToHotel(hotelId, imageUrl, caption)
 *   3. Zalo OA: zaloCreateArticle(oa, { title, cover, bodyBlocks }) hoặc
 *      broadcast rich message (tuỳ endpoint khả dụng)
 *   4. Log per-platform result
 *
 * Idempotency: mỗi (fb_post_id × platform) chỉ cross-post 1 lần.
 * Nếu gọi lại → check cross_post_log và skip.
 */

import { db } from '../db';

export interface CrossPostSource {
  fb_post_id: string;
  hotel_id: number;
  page_id?: number;
  caption: string;
  image_url?: string;               // PUBLIC URL nếu có ảnh
  source_type?: 'manual' | 'scheduler' | 'campaign' | 'news' | 'ci_weekly';
}

export interface CrossPostResult {
  fb_post_id: string;
  ig: { attempted: number; success: number; errors: string[] };
  zalo: { attempted: number; success: number; errors: string[] };
  skipped_reason?: string;
}

/* ═══════════════════════════════════════════
   SCHEMA — log mỗi lần cross-post
   ═══════════════════════════════════════════ */

db.exec(`
CREATE TABLE IF NOT EXISTS cross_post_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fb_post_id TEXT NOT NULL,
  hotel_id INTEGER NOT NULL,
  platform TEXT NOT NULL,                -- 'instagram' | 'zalo_oa'
  target_id TEXT,                        -- ig_account_id or oa_id
  result TEXT NOT NULL,                  -- 'success' | 'failed' | 'skipped'
  external_id TEXT,                      -- ig_media_id or zalo_article_id
  error TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE(fb_post_id, platform, target_id)
);
CREATE INDEX IF NOT EXISTS idx_xpost_fb ON cross_post_log(fb_post_id);
CREATE INDEX IF NOT EXISTS idx_xpost_hotel_created ON cross_post_log(hotel_id, created_at DESC);
`);

/* ═══════════════════════════════════════════
   Utility: check if already cross-posted
   ═══════════════════════════════════════════ */

function alreadyCrossPosted(fbPostId: string, platform: string, targetId: string): boolean {
  const row = db.prepare(
    `SELECT result FROM cross_post_log
     WHERE fb_post_id = ? AND platform = ? AND target_id = ? AND result = 'success'`
  ).get(fbPostId, platform, targetId) as any;
  return !!row;
}

function logResult(
  fbPostId: string,
  hotelId: number,
  platform: string,
  targetId: string,
  result: 'success' | 'failed' | 'skipped',
  externalId?: string,
  error?: string,
) {
  try {
    db.prepare(
      `INSERT OR REPLACE INTO cross_post_log
       (fb_post_id, hotel_id, platform, target_id, result, external_id, error, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(fbPostId, hotelId, platform, targetId, result, externalId || null, error || null, Date.now());
  } catch (e: any) {
    console.warn('[cross-post] log fail:', e?.message);
  }
}

/* ═══════════════════════════════════════════
   INSTAGRAM FAN-OUT
   ═══════════════════════════════════════════ */

async function fanOutInstagram(src: CrossPostSource): Promise<CrossPostResult['ig']> {
  const out = { attempted: 0, success: 0, errors: [] as string[] };

  if (!src.image_url) {
    // IG require image — skip text-only posts
    out.errors.push('no_image_skipped');
    return out;
  }

  try {
    const { publishToHotel, getIgAccountsForHotel } = require('./instagram-publisher');
    const accounts = getIgAccountsForHotel(src.hotel_id);
    if (!accounts || accounts.length === 0) {
      out.errors.push('no_ig_accounts');
      return out;
    }

    // Filter accounts đã cross-post rồi (idempotency)
    const pending = accounts.filter((a: any) =>
      !alreadyCrossPosted(src.fb_post_id, 'instagram', String(a.id))
    );
    if (pending.length === 0) {
      out.errors.push('all_already_posted');
      return out;
    }

    out.attempted = pending.length;
    // publishToHotel iterate tất cả active accounts
    const results = await publishToHotel(src.hotel_id, src.image_url, src.caption);

    for (const r of results) {
      const targetId = String(r.ig_account_id);
      if (r.ok) {
        out.success++;
        logResult(src.fb_post_id, src.hotel_id, 'instagram', targetId, 'success', r.ig_media_id);
        console.log(`[cross-post] ✅ IG fb=${src.fb_post_id} → ig_media=${r.ig_media_id}`);
      } else {
        out.errors.push(`ig_${targetId}:${r.error}`);
        logResult(src.fb_post_id, src.hotel_id, 'instagram', targetId, 'failed', undefined, r.error);
        console.warn(`[cross-post] IG fb=${src.fb_post_id} fail: ${r.error}`);
      }
    }
  } catch (e: any) {
    out.errors.push(`ig_exception:${e?.message}`);
    console.warn('[cross-post] IG fan-out exception:', e?.message);
  }

  return out;
}

/* ═══════════════════════════════════════════
   ZALO OA FAN-OUT (broadcast rich message as article)
   ═══════════════════════════════════════════ */

async function fanOutZalo(src: CrossPostSource): Promise<CrossPostResult['zalo']> {
  const out = { attempted: 0, success: 0, errors: [] as string[] };

  try {
    // v24 FIX: Dùng listZaloForHotel() để auto-decrypt token (raw SQL → encrypted)
    const { listZaloForHotel } = require('./zalo');
    const oas = listZaloForHotel(src.hotel_id).filter((o: any) => o.enabled);

    if (oas.length === 0) {
      out.errors.push('no_zalo_oa');
      return out;
    }

    for (const oa of oas) {
      const targetId = String(oa.oa_id);
      if (alreadyCrossPosted(src.fb_post_id, 'zalo_oa', targetId)) continue;
      out.attempted++;

      // Check token still valid
      if (oa.token_expires_at && oa.token_expires_at < Date.now()) {
        out.errors.push(`zalo_${targetId}:token_expired`);
        logResult(src.fb_post_id, src.hotel_id, 'zalo_oa', targetId, 'failed', undefined, 'token_expired');
        continue;
      }

      try {
        const { zaloCreateArticle, textToZaloBodyBlocks } = require('./zalo');
        // Build article payload
        const caption = src.caption.trim();
        // Title = first non-empty line or first 80 chars
        const firstLine = caption.split('\n').find(l => l.trim().length > 10) || caption;
        const title = firstLine.slice(0, 80);
        // Description = second paragraph hoặc next chunk
        const desc = caption.length > 80 ? caption.slice(80, 250).trim() : '';
        const bodyBlocks = textToZaloBodyBlocks(caption);

        const cover = src.image_url || '';
        if (!cover) {
          // Zalo article yêu cầu cover image — fallback: skip
          out.errors.push(`zalo_${targetId}:no_cover_image`);
          logResult(src.fb_post_id, src.hotel_id, 'zalo_oa', targetId, 'skipped', undefined, 'no_cover');
          continue;
        }

        const result = await zaloCreateArticle(oa, {
          title,
          description: desc,
          cover,
          bodyBlocks,
          status: 'show',
          comment: 'enable',
        });

        out.success++;
        logResult(src.fb_post_id, src.hotel_id, 'zalo_oa', targetId, 'success', result.article_id);
        console.log(`[cross-post] ✅ Zalo OA=${targetId} fb=${src.fb_post_id} → ${result.article_id || result.url}`);
      } catch (e: any) {
        const msg = e?.response?.data?.message || e?.message || 'unknown';
        out.errors.push(`zalo_${targetId}:${msg}`);
        logResult(src.fb_post_id, src.hotel_id, 'zalo_oa', targetId, 'failed', undefined, msg);
        console.warn(`[cross-post] Zalo OA=${targetId} fail: ${msg}`);
      }
    }
  } catch (e: any) {
    out.errors.push(`zalo_exception:${e?.message}`);
    console.warn('[cross-post] Zalo fan-out exception:', e?.message);
  }

  return out;
}

/* ═══════════════════════════════════════════
   MAIN ENTRY — gọi từ mọi FB publish point
   ═══════════════════════════════════════════ */

/**
 * Cross-post a published FB post to IG + Zalo.
 *
 * Non-blocking: không throw, return result object.
 * Caller KHÔNG await nếu muốn fire-and-forget (nhưng khuyến nghị await để
 * log kết quả).
 */
export async function crossPostToAllPlatforms(src: CrossPostSource): Promise<CrossPostResult> {
  console.log(`[cross-post] begin fb=${src.fb_post_id} hotel=${src.hotel_id} source=${src.source_type || 'unknown'}`);

  // Parallel execution — IG + Zalo độc lập
  const [igResult, zaloResult] = await Promise.all([
    fanOutInstagram(src).catch(e => ({ attempted: 0, success: 0, errors: [`exception:${e?.message}`] })),
    fanOutZalo(src).catch(e => ({ attempted: 0, success: 0, errors: [`exception:${e?.message}`] })),
  ]);

  const result: CrossPostResult = {
    fb_post_id: src.fb_post_id,
    ig: igResult,
    zalo: zaloResult,
  };

  console.log(`[cross-post] done fb=${src.fb_post_id}: IG ${igResult.success}/${igResult.attempted}, Zalo ${zaloResult.success}/${zaloResult.attempted}`);
  return result;
}

/**
 * Fetch image URL trực tiếp từ FB CDN (via Graph API) cho bài đã publish.
 * Đáng tin cậy hơn local media URL vì:
 *   - FB CDN luôn reachable globally (IG + Zalo fetch dễ)
 *   - Không phụ thuộc DNS của mkt.sondervn.com
 *   - Image format + size đã được FB xử lý chuẩn
 */
async function fetchFbPostImageUrl(fbPostId: string, accessToken: string): Promise<string | undefined> {
  try {
    const axios = require('axios').default;
    // Try full_picture first (largest image)
    const r = await axios.get(`https://graph.facebook.com/v18.0/${fbPostId}`, {
      params: { fields: 'full_picture,attachments{media}', access_token: accessToken },
      timeout: 10_000,
    });
    const data = r.data || {};
    if (data.full_picture && /^https:\/\//.test(data.full_picture)) return data.full_picture;
    // Fallback: attachments[].media.image.src
    const atts = data.attachments?.data || [];
    for (const a of atts) {
      const src = a?.media?.image?.src;
      if (src && /^https:\/\//.test(src)) return src;
    }
    return undefined;
  } catch (e: any) {
    console.warn('[cross-post] fetch FB image fail:', e?.response?.data?.error?.message || e?.message);
    return undefined;
  }
}

/**
 * Resolve post caption + image from posts table → call crossPostToAllPlatforms.
 * v24: Prefer FB CDN image URL over local media (tránh DNS issue + đảm bảo
 *      URL globally reachable).
 */
export async function crossPostFromPostId(postId: number, sourceType?: string): Promise<CrossPostResult | null> {
  try {
    const post = db.prepare(
      `SELECT p.id, p.fb_post_id, p.hotel_id, p.page_id, p.caption, p.media_id, p.media_type,
              m.filename as media_filename,
              pg.fb_page_id as fb_page_id, pg.access_token as page_access_token
       FROM posts p
       LEFT JOIN media m ON m.id = p.media_id
       LEFT JOIN pages pg ON pg.id = p.page_id
       WHERE p.id = ? AND p.status = 'published' AND p.fb_post_id IS NOT NULL`
    ).get(postId) as any;

    if (!post) return null;

    // Resolve image URL — PRIORITY 1: fetch from FB CDN (most reliable)
    let imageUrl: string | undefined;
    if (post.media_type === 'image' && post.page_access_token && post.fb_post_id) {
      imageUrl = await fetchFbPostImageUrl(post.fb_post_id, post.page_access_token);
      if (imageUrl) {
        console.log(`[cross-post] resolved FB CDN image: ${imageUrl.slice(0, 80)}...`);
      }
    }

    // Priority 2: media_filename might be (a) full URL, (b) local filename, (c) path
    if (!imageUrl && post.media_type === 'image' && post.media_filename) {
      const mf = String(post.media_filename);
      if (/^https?:\/\//.test(mf)) {
        // Already full URL (e.g. Google Drive, uploaded via URL) — use as-is
        imageUrl = mf;
        console.log(`[cross-post] using external URL from media_filename: ${imageUrl.slice(0, 80)}...`);
      } else {
        // Local filename → prepend public base URL
        const { config } = require('../config');
        const baseUrl = config.publicBaseUrl || process.env.PUBLIC_BASE_URL || 'https://mkt.sondervn.com';
        imageUrl = `${baseUrl.replace(/\/$/, '')}/media/${mf.replace(/^\/+/, '')}`;
        console.log(`[cross-post] fallback to public base URL: ${imageUrl.slice(0, 80)}...`);
      }
    }

    return await crossPostToAllPlatforms({
      fb_post_id: post.fb_post_id,
      hotel_id: post.hotel_id,
      page_id: post.page_id,
      caption: post.caption || '',
      image_url: imageUrl,
      source_type: (sourceType as any) || 'scheduler',
    });
  } catch (e: any) {
    console.warn('[cross-post] crossPostFromPostId exception:', e?.message);
    return null;
  }
}

/* ═══════════════════════════════════════════
   ADMIN / STATUS QUERIES
   ═══════════════════════════════════════════ */

export function getCrossPostStats(hotelId: number, sinceMs: number = 7 * 24 * 3600_000): any {
  const since = Date.now() - sinceMs;
  const rows = db.prepare(
    `SELECT platform, result, COUNT(*) as n
     FROM cross_post_log
     WHERE hotel_id = ? AND created_at > ?
     GROUP BY platform, result`
  ).all(hotelId, since) as any[];

  return rows.reduce((acc: any, r: any) => {
    acc[r.platform] = acc[r.platform] || { success: 0, failed: 0, skipped: 0 };
    acc[r.platform][r.result] = r.n;
    return acc;
  }, {});
}

export function listCrossPostLog(hotelId: number, limit: number = 50): any[] {
  return db.prepare(
    `SELECT * FROM cross_post_log WHERE hotel_id = ? ORDER BY created_at DESC LIMIT ?`
  ).all(hotelId, limit) as any[];
}

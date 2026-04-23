/**
 * Instagram Publisher — Official Graph API v18.
 *
 * Flow (2-step):
 *   1. POST /{ig-id}/media — create container with image_url + caption
 *      → returns { id: "creation_id" }
 *   2. POST /{ig-id}/media_publish — publish container
 *      → returns { id: "ig_media_id" }
 *
 * Prereq:
 *   - IG Business/Creator account
 *   - Linked to FB Page
 *   - Page access_token has instagram_content_publish permission
 *   - Image must be PUBLIC URL (FB fetches from it — cannot pass base64)
 *   - JPEG, < 8MB, aspect ratio 1:1 to 4:5 (vertical), 1080px recommended
 *
 * Rate limit: 25 posts/24h per IG Business account (per Meta docs)
 *
 * Docs: https://developers.facebook.com/docs/instagram-api/guides/content-publishing
 */

import axios from 'axios';
import { db } from '../db';
import { truncateByCodePoints, redactSecrets } from './text-utils';
import { isSafeUrl } from './news-ingest';

const GRAPH = 'https://graph.facebook.com/v18.0';

export interface IgAccount {
  id: number;
  hotel_id: number;
  ig_business_id: string;
  ig_username?: string;
  linked_fb_page_id?: number;
  access_token?: string;          // nếu override riêng
}

/** Resolve access_token — ưu tiên IG override, fallback linked FB page token. */
function resolveAccessToken(account: IgAccount): string | null {
  if (account.access_token) return account.access_token;
  if (account.linked_fb_page_id) {
    const page = db.prepare(`SELECT access_token FROM pages WHERE id = ?`).get(account.linked_fb_page_id) as any;
    return page?.access_token || null;
  }
  return null;
}

/** List active IG accounts for a hotel. */
export function getIgAccountsForHotel(hotelId: number): IgAccount[] {
  return db.prepare(
    `SELECT * FROM instagram_accounts WHERE hotel_id = ? AND active = 1 ORDER BY id`
  ).all(hotelId) as any[];
}

/** Daily rate limit check. */
function isRateLimited(igAccountId: number): boolean {
  const dayAgo = Date.now() - 24 * 3600_000;
  const cnt = db.prepare(
    `SELECT COUNT(*) as n FROM posts WHERE fb_post_id LIKE 'ig_%' AND published_at > ?`
  ).get(dayAgo) as any;
  return (cnt?.n || 0) >= 20;   // Leave buffer of 5
}

/* ═══════════════════════════════════════════
   SINGLE IMAGE POST
   ═══════════════════════════════════════════ */

export interface PublishImageInput {
  ig_business_id: string;
  access_token: string;
  image_url: string;              // Must be PUBLIC URL
  caption: string;                // Max 2200 chars
}

export async function publishImage(input: PublishImageInput): Promise<{ ok: boolean; ig_media_id?: string; creation_id?: string; error?: string }> {
  // v22: URL safety + image validation
  const urlCheck = isSafeUrl(input.image_url);
  if (!urlCheck.safe) {
    return { ok: false, error: `unsafe_url:${urlCheck.reason}` };
  }
  try {
    // Validate image size + content-type via HEAD (tránh upload file quá lớn hoặc SVG nguy hiểm)
    try {
      const headResp = await axios.head(input.image_url, { timeout: 8_000, maxRedirects: 3 });
      const size = parseInt(headResp.headers['content-length'] || '0', 10);
      const ctype = String(headResp.headers['content-type'] || '').toLowerCase();
      if (size > 8 * 1024 * 1024) {
        return { ok: false, error: `image_too_large:${(size / 1024 / 1024).toFixed(1)}MB > 8MB (IG limit)` };
      }
      if (ctype && !['image/jpeg', 'image/jpg', 'image/png', 'image/webp'].some(t => ctype.includes(t))) {
        return { ok: false, error: `invalid_content_type:${ctype}` };
      }
    } catch (headErr: any) {
      // HEAD có thể fail (không phải server nào cũng support) — log + proceed
      console.warn('[ig-publisher] HEAD check skip:', headErr?.message?.slice(0, 100));
    }

    // Step 1: Create container
    const createResp = await axios.post(
      `${GRAPH}/${input.ig_business_id}/media`,
      null,
      {
        params: {
          image_url: input.image_url,
          caption: truncateByCodePoints(input.caption, 2200),   // v22 UTF-8 safe
          access_token: input.access_token,
        },
        timeout: 45_000,
      }
    );

    const creationId = createResp.data?.id;
    if (!creationId) {
      return { ok: false, error: 'no creation_id from /media' };
    }

    // Optional: wait 3s for container to be ready (IG needs to fetch image)
    await new Promise(r => setTimeout(r, 3000));

    // Step 2: Publish container
    const publishResp = await axios.post(
      `${GRAPH}/${input.ig_business_id}/media_publish`,
      null,
      {
        params: {
          creation_id: creationId,
          access_token: input.access_token,
        },
        timeout: 30_000,
      }
    );

    const mediaId = publishResp.data?.id;
    if (!mediaId) {
      return { ok: false, creation_id: creationId, error: 'published but no media_id' };
    }

    return { ok: true, ig_media_id: mediaId, creation_id: creationId };
  } catch (e: any) {
    const errMsg = e?.response?.data?.error?.message || e?.message || 'unknown';
    const safe = redactSecrets(errMsg);  // v22: redact tokens
    console.warn('[ig-publisher] fail:', safe);
    return { ok: false, error: safe };
  }
}

/* ═══════════════════════════════════════════
   CAROUSEL (multiple images, up to 10)
   ═══════════════════════════════════════════ */

export async function publishCarousel(input: {
  ig_business_id: string;
  access_token: string;
  image_urls: string[];           // 2-10 URLs
  caption: string;
}): Promise<{ ok: boolean; ig_media_id?: string; error?: string }> {
  if (input.image_urls.length < 2 || input.image_urls.length > 10) {
    return { ok: false, error: 'carousel needs 2-10 images' };
  }

  try {
    // Step 1: Create child containers
    const childIds: string[] = [];
    for (const url of input.image_urls) {
      const r = await axios.post(
        `${GRAPH}/${input.ig_business_id}/media`,
        null,
        {
          params: {
            image_url: url,
            is_carousel_item: true,
            access_token: input.access_token,
          },
          timeout: 30_000,
        }
      );
      const id = r.data?.id;
      if (!id) return { ok: false, error: 'carousel child failed' };
      childIds.push(id);
      await new Promise(r => setTimeout(r, 500));
    }

    // Step 2: Create carousel container
    const carouselResp = await axios.post(
      `${GRAPH}/${input.ig_business_id}/media`,
      null,
      {
        params: {
          media_type: 'CAROUSEL',
          children: childIds.join(','),
          caption: input.caption.slice(0, 2200),
          access_token: input.access_token,
        },
        timeout: 30_000,
      }
    );
    const creationId = carouselResp.data?.id;
    if (!creationId) return { ok: false, error: 'carousel container failed' };

    await new Promise(r => setTimeout(r, 3000));

    // Step 3: Publish
    const publishResp = await axios.post(
      `${GRAPH}/${input.ig_business_id}/media_publish`,
      null,
      { params: { creation_id: creationId, access_token: input.access_token }, timeout: 30_000 }
    );

    return { ok: true, ig_media_id: publishResp.data?.id };
  } catch (e: any) {
    return { ok: false, error: e?.response?.data?.error?.message || e?.message || 'unknown' };
  }
}

/* ═══════════════════════════════════════════
   HIGH-LEVEL: publish cho hotel
   ═══════════════════════════════════════════ */

/** Publish 1 image + caption cho TẤT CẢ IG accounts active của hotel. */
export async function publishToHotel(hotelId: number, imageUrl: string, caption: string): Promise<Array<{
  ig_account_id: number;
  ig_business_id: string;
  ok: boolean;
  ig_media_id?: string;
  error?: string;
}>> {
  const accounts = getIgAccountsForHotel(hotelId);
  const results: any[] = [];

  for (const acc of accounts) {
    if (isRateLimited(acc.id)) {
      results.push({ ig_account_id: acc.id, ig_business_id: acc.ig_business_id, ok: false, error: 'rate_limit_24h' });
      continue;
    }

    const token = resolveAccessToken(acc);
    if (!token) {
      results.push({ ig_account_id: acc.id, ig_business_id: acc.ig_business_id, ok: false, error: 'no access_token' });
      continue;
    }

    // IG caption optimization: ensure hashtags ở cuối
    const igCaption = optimizeCaptionForIG(caption);

    const result = await publishImage({
      ig_business_id: acc.ig_business_id,
      access_token: token,
      image_url: imageUrl,
      caption: igCaption,
    });

    if (result.ok) {
      // Log + update counter
      db.prepare(
        `UPDATE instagram_accounts SET last_published_at = ?, total_posts = total_posts + 1, updated_at = ? WHERE id = ?`
      ).run(Date.now(), Date.now(), acc.id);
    }

    results.push({
      ig_account_id: acc.id,
      ig_business_id: acc.ig_business_id,
      ok: result.ok,
      ig_media_id: result.ig_media_id,
      error: result.error,
    });
  }

  return results;
}

/** Optimize caption for IG — cap length, move hashtags to end. */
function optimizeCaptionForIG(caption: string): string {
  const MAX = 2200;
  let text = String(caption || '');

  // Extract hashtags (#Sonder, etc.)
  const hashtagRegex = /#[\w\u00C0-\u024F\u1E00-\u1EFF]+/g;
  const hashtags = text.match(hashtagRegex) || [];
  const textWithoutTags = text.replace(hashtagRegex, '').replace(/\s+/g, ' ').trim();

  // Build: main text + \n\n + hashtags block
  const uniqueTags = Array.from(new Set(hashtags));
  let result = textWithoutTags;
  if (uniqueTags.length > 0) {
    result += '\n\n' + uniqueTags.join(' ');
  }

  return result.slice(0, MAX);
}

/* ═══════════════════════════════════════════
   Admin: provision IG account
   ═══════════════════════════════════════════ */

export function addIgAccount(input: {
  hotel_id: number;
  ig_business_id: string;
  ig_username?: string;
  linked_fb_page_id?: number;
  access_token?: string;
}): number {
  const now = Date.now();
  const r = db.prepare(
    `INSERT INTO instagram_accounts
     (hotel_id, ig_business_id, ig_username, linked_fb_page_id, access_token, active, total_posts, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 1, 0, ?, ?)`
  ).run(
    input.hotel_id, input.ig_business_id,
    input.ig_username || null,
    input.linked_fb_page_id || null,
    input.access_token || null,
    now, now,
  );
  return Number(r.lastInsertRowid);
}

/** Verify IG account — test fetch profile. */
export async function verifyIgAccount(igBusinessId: string, accessToken: string): Promise<{ valid: boolean; username?: string; error?: string }> {
  try {
    const r = await axios.get(`${GRAPH}/${igBusinessId}`, {
      params: {
        fields: 'username,biography,followers_count,media_count',
        access_token: accessToken,
      },
      timeout: 10_000,
    });
    return { valid: true, username: r.data?.username };
  } catch (e: any) {
    return { valid: false, error: e?.response?.data?.error?.message || e?.message };
  }
}

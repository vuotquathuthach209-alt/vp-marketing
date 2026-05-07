/**
 * V5T Publisher — FB photo + carousel + poll/question.
 *
 * Reference: skill sonder-content-v5t
 *
 * FB Graph API endpoints:
 *   Single image: POST /{page-id}/photos
 *   Carousel:     POST /{page-id}/photos (per image, get IDs) → POST /{page-id}/feed with attached_media[]
 *   Poll:         POST /{page-id}/feed with poll = true (FB Graph API limited — fallback question post)
 *   Question:     POST /{page-id}/feed (regular text+image post)
 */

import axios from 'axios';
import * as fs from 'fs';
import { db } from '../../db';

const GRAPH = 'https://graph.facebook.com/v21.0';

export interface V5TPublishResult {
  ok: boolean;
  fb_post_id?: string;
  error?: string;
}

interface FbPage { id: number; name: string; fb_page_id: string; access_token: string; }

function pickFbPage(): FbPage | null {
  return db.prepare(`SELECT * FROM pages WHERE id = 1`).get() as FbPage || null;
}

/** Upload 1 image as unpublished photo → return FB photo ID (for carousel) */
async function uploadUnpublishedPhoto(
  page: FbPage,
  imagePath: string,
): Promise<string | null> {
  try {
    const FormData = require('form-data');
    const form = new FormData();
    form.append('source', fs.createReadStream(imagePath));
    form.append('published', 'false');
    form.append('access_token', page.access_token);

    const r = await axios.post(
      `${GRAPH}/${page.fb_page_id}/photos`,
      form,
      { headers: form.getHeaders(), timeout: 60000, maxContentLength: 50 * 1024 * 1024 },
    );
    return r.data?.id || null;
  } catch (e: any) {
    console.warn('[v5t-publish] upload photo fail:', e?.response?.data?.error?.message || e.message);
    return null;
  }
}

/** Publish single image post */
export async function publishSingleImage(opts: {
  imagePath: string;
  caption: string;
}): Promise<V5TPublishResult> {
  const page = pickFbPage();
  if (!page?.access_token) return { ok: false, error: 'no_fb_page' };

  try {
    const FormData = require('form-data');
    const form = new FormData();
    form.append('source', fs.createReadStream(opts.imagePath));
    form.append('caption', opts.caption);
    form.append('access_token', page.access_token);

    const r = await axios.post(
      `${GRAPH}/${page.fb_page_id}/photos`,
      form,
      { headers: form.getHeaders(), timeout: 60000, maxContentLength: 50 * 1024 * 1024 },
    );
    if (r.data?.post_id) return { ok: true, fb_post_id: r.data.post_id };
    if (r.data?.id) return { ok: true, fb_post_id: r.data.id };
    return { ok: false, error: 'no_post_id' };
  } catch (e: any) {
    return { ok: false, error: 'fb_upload: ' + (e?.response?.data?.error?.message || e.message) };
  }
}

/** Publish carousel post (multi-photo with caption) */
export async function publishCarousel(opts: {
  imagePaths: string[];
  caption: string;
}): Promise<V5TPublishResult> {
  const page = pickFbPage();
  if (!page?.access_token) return { ok: false, error: 'no_fb_page' };
  if (opts.imagePaths.length < 2) return { ok: false, error: 'carousel_needs_2plus_images' };

  try {
    // 1. Upload each image as unpublished
    const photoIds: string[] = [];
    for (const p of opts.imagePaths) {
      const id = await uploadUnpublishedPhoto(page, p);
      if (id) photoIds.push(id);
    }
    if (photoIds.length === 0) return { ok: false, error: 'all_uploads_failed' };

    // 2. Create feed post with attached_media[]
    const params: any = {
      message: opts.caption,
      access_token: page.access_token,
    };
    photoIds.forEach((id, i) => {
      params[`attached_media[${i}]`] = JSON.stringify({ media_fbid: id });
    });

    const r = await axios.post(`${GRAPH}/${page.fb_page_id}/feed`, null, { params, timeout: 60000 });
    if (r.data?.id) return { ok: true, fb_post_id: r.data.id };
    return { ok: false, error: 'no_feed_id' };
  } catch (e: any) {
    return { ok: false, error: 'carousel_publish: ' + (e?.response?.data?.error?.message || e.message) };
  }
}

/**
 * Publish poll question post — FB Graph API doesn't support native polls anymore (deprecated 2024).
 * Fallback: regular question post with options listed in caption.
 */
export async function publishQuestionPost(opts: {
  question: string;
  options?: string[];
  imagePath?: string;
}): Promise<V5TPublishResult> {
  const page = pickFbPage();
  if (!page?.access_token) return { ok: false, error: 'no_fb_page' };

  // Build caption: question + options as list
  const lines = [opts.question];
  if (opts.options && opts.options.length > 0) {
    lines.push('');
    opts.options.forEach((opt, i) => lines.push(`${String.fromCharCode(65 + i)}. ${opt}`));
    lines.push('');
    lines.push('Comment chữ A/B/C/D nhé.');
  }
  const caption = lines.join('\n');

  if (opts.imagePath && fs.existsSync(opts.imagePath)) {
    return publishSingleImage({ imagePath: opts.imagePath, caption });
  }

  // Text-only fallback (algo deprioritized but works)
  try {
    const r = await axios.post(
      `${GRAPH}/${page.fb_page_id}/feed`,
      null,
      { params: { message: caption, access_token: page.access_token }, timeout: 30000 },
    );
    if (r.data?.id) return { ok: true, fb_post_id: r.data.id };
    return { ok: false, error: 'no_feed_id' };
  } catch (e: any) {
    return { ok: false, error: 'text_publish: ' + (e?.response?.data?.error?.message || e.message) };
  }
}

/* ───────── Main entry ───────── */

export async function publishV5TPost(opts: {
  post_id: number;
  variant?: 'a' | 'b' | 'c';            // which caption variant to use
}): Promise<V5TPublishResult> {
  const post = db.prepare(`SELECT * FROM v5t_posts WHERE id = ?`).get(opts.post_id) as any;
  if (!post) return { ok: false, error: 'post_not_found' };

  const variant = opts.variant || 'a';
  const captionKey = `caption_${variant}` as 'caption_a' | 'caption_b' | 'caption_c';
  const caption = post[captionKey] as string;

  // Get composed images
  const images = db.prepare(
    `SELECT * FROM v5t_post_images WHERE post_id = ? ORDER BY position`,
  ).all(opts.post_id) as any[];

  let result: V5TPublishResult;

  // V5T refactored: 2 main types (tips_post + story_post) — both single image
  if ((post.type === 'tips_post' || post.type === 'story_post') && images.length >= 1) {
    result = await publishSingleImage({ imagePath: images[0].composed_path, caption });
  } else if (post.type === 'ugc_repost' && images.length >= 1) {
    result = await publishSingleImage({ imagePath: images[0].composed_path, caption });
  } else {
    return { ok: false, error: `unsupported type ${post.type} or no images` };
  }

  if (result.ok && result.fb_post_id) {
    db.prepare(
      `UPDATE v5t_posts SET status = 'posted', fb_post_id = ?, posted_at = ? WHERE id = ?`,
    ).run(result.fb_post_id, Date.now(), opts.post_id);

    // Track in v5t_ab_results
    db.prepare(
      `INSERT INTO v5t_ab_results
       (post_id, variant, caption, posted_at, fb_post_id, last_metrics_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(opts.post_id, variant, caption, Date.now(), result.fb_post_id, Date.now());
  }

  return result;
}

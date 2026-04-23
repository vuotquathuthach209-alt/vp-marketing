/**
 * Facebook Page-to-Page Cross-post.
 *
 * Khi 1 page published post → tự động publish sang các target pages (owned).
 *
 * Note: Meta chỉ cho phép publish giữa pages MÌNH SỞ HỮU (same admin).
 * Không phải "share post" mà là post content lại (để tránh "same exact ID" detection
 * trigger spam filter). Có small modification optional.
 *
 * Delay mặc định 10 phút giữa source + target → natural variance, tránh flag.
 */

import { db } from '../db';
import { publishText, publishImage } from './facebook';
import { redactSecrets } from './text-utils';

export interface CrossPostLink {
  id: number;
  source_page_id: number;
  target_page_id: number;
  delay_minutes: number;
  modify_caption?: string;
  active: number;
}

export function getCrossPostLinks(sourcePageId: number): CrossPostLink[] {
  return db.prepare(
    `SELECT * FROM page_crosspost_links WHERE source_page_id = ? AND active = 1`
  ).all(sourcePageId) as any[];
}

export function addCrossPostLink(input: {
  source_page_id: number;
  target_page_id: number;
  delay_minutes?: number;
  modify_caption?: string;
}): number {
  const now = Date.now();
  const r = db.prepare(
    `INSERT OR REPLACE INTO page_crosspost_links
     (source_page_id, target_page_id, delay_minutes, modify_caption, active, created_at)
     VALUES (?, ?, ?, ?, 1, ?)`
  ).run(
    input.source_page_id, input.target_page_id,
    input.delay_minutes ?? 20,  // v22: 20 min default (tránh FB spam-detect)
    input.modify_caption || null,
    now,
  );
  return Number(r.lastInsertRowid);
}

/** Queue a crosspost (không gửi ngay — delay để tránh spam flag). */
export function scheduleCrossPost(sourcePageId: number, opts: {
  caption: string;
  image_url?: string;
  image_path?: string;     // Local file path nếu có
}): Array<{ target_page_id: number; scheduled_at: number; link_id: number }> {
  const links = getCrossPostLinks(sourcePageId);
  const now = Date.now();
  const scheduled: any[] = [];

  for (const link of links) {
    const delayMs = (link.delay_minutes || 20) * 60_000;  // v22: default 20 min
    const scheduledAt = now + delayMs;

    // Apply caption modification if defined
    let finalCaption = opts.caption;
    if (link.modify_caption) {
      // Simple: prepend or append
      if (link.modify_caption.startsWith('PREPEND:')) {
        finalCaption = link.modify_caption.slice(8) + '\n\n' + opts.caption;
      } else if (link.modify_caption.startsWith('APPEND:')) {
        finalCaption = opts.caption + '\n\n' + link.modify_caption.slice(7);
      } else if (link.modify_caption.startsWith('REPLACE:')) {
        finalCaption = link.modify_caption.slice(8);
      }
    }

    // Use existing `posts` table as queue (scheduled status)
    const page = db.prepare(`SELECT id, hotel_id FROM pages WHERE id = ?`).get(link.target_page_id) as any;
    if (!page) continue;

    const result = db.prepare(
      `INSERT INTO posts (page_id, caption, media_type, status, scheduled_at, hotel_id, created_at)
       VALUES (?, ?, ?, 'scheduled', ?, ?, ?)`
    ).run(
      link.target_page_id,
      finalCaption.slice(0, 63000),
      opts.image_url ? 'image' : 'none',
      scheduledAt,
      page.hotel_id,
      now,
    );

    scheduled.push({
      target_page_id: link.target_page_id,
      scheduled_at: scheduledAt,
      link_id: link.id,
      post_id: Number(result.lastInsertRowid),
    });

    console.log(`[fb-xpost] scheduled source=${sourcePageId} → target=${link.target_page_id} at +${link.delay_minutes}min`);
  }

  return scheduled;
}

/** Directly publish to target page (bypass queue, for immediate post). */
export async function publishToTargetPage(targetPageId: number, opts: {
  caption: string;
  image_url?: string;
  image_path?: string;
}): Promise<{ ok: boolean; fb_post_id?: string; error?: string }> {
  const page = db.prepare(`SELECT fb_page_id, access_token, name FROM pages WHERE id = ?`).get(targetPageId) as any;
  if (!page) return { ok: false, error: 'target page not found' };

  try {
    let fbPostId: string;
    if (opts.image_url) {
      // Use /photos with url param — FB fetches it
      const axios = require('axios');
      const GRAPH = 'https://graph.facebook.com/v18.0';
      const r = await axios.post(
        `${GRAPH}/${page.fb_page_id}/photos`,
        null,
        {
          params: { message: opts.caption, url: opts.image_url, access_token: page.access_token },
          timeout: 60_000,
        }
      );
      fbPostId = r.data.post_id || r.data.id;
    } else if (opts.image_path) {
      const r = await publishImage(page.fb_page_id, page.access_token, opts.caption, opts.image_path);
      fbPostId = r.fbPostId;
    } else {
      const r = await publishText(page.fb_page_id, page.access_token, opts.caption);
      fbPostId = r.fbPostId;
    }
    return { ok: true, fb_post_id: fbPostId };
  } catch (e: any) {
    const msg = e?.response?.data?.error?.message || e?.message || 'unknown';
    return { ok: false, error: redactSecrets(msg) };   // v22 redact tokens
  }
}

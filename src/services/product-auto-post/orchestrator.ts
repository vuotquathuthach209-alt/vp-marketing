/**
 * Product Auto Post Orchestrator — daily flow.
 *
 * 2 phases:
 *
 *   Phase A — "generate" (cron 7h sáng VN):
 *     1. Pick hotel (picker)
 *     2. Pick image (image-picker, dedup)
 *     3. Pick angle (caption-generator)
 *     4. Generate caption (LLM)
 *     5. Save vào auto_post_plan + auto_post_history (status=generated)
 *     6. Telegram notify admin (preview)
 *
 *   Phase B — "publish" (cron 9h sáng VN):
 *     7. Read today's plan
 *     8. Download image từ URL (để upload FB direct, không rely external URL)
 *     9. Create posts row + publish qua FB API
 *    10. Cross-post sẽ tự động trigger (via existing hook)
 *    11. Update auto_post_history status=published, link post_id
 */

import fs from 'fs';
import path from 'path';
import axios from 'axios';
import { db } from '../../db';
import { pickHotelForToday, pickEligibleHotels, HotelCandidate } from './picker';
import { pickImage, ImageCandidate } from './image-picker';
import { pickAngleSmart, generateCaption, captionHash, validateCaption, Angle } from './caption-generator';

function vnDate(d: Date = new Date()): string {
  return new Date(d.getTime() + 7 * 3600_000).toISOString().slice(0, 10);
}

/* ═══════════════════════════════════════════
   PHASE A — GENERATE
   ═══════════════════════════════════════════ */

export async function generateTodayPlan(): Promise<{
  ok: boolean;
  plan_id?: number;
  date?: string;
  hotel?: HotelCandidate;
  image?: ImageCandidate;
  angle?: Angle;
  caption?: string;
  reason?: string;
}> {
  const date = vnDate();
  console.log(`[auto-post] generating plan for ${date}`);

  // Check if plan already exists today
  const existing = db.prepare(
    `SELECT id, status FROM auto_post_plan WHERE scheduled_date = ?`
  ).get(date) as any;
  if (existing && existing.status !== 'planned') {
    return { ok: false, reason: `already_${existing.status}`, plan_id: existing.id, date };
  }

  // 1. Pick top N eligible hotels (try in order until one has usable image)
  const candidates = pickEligibleHotels({ limit: 5 });
  if (candidates.length === 0) {
    return { ok: false, reason: 'no_eligible_hotel', date };
  }

  // Shuffle top 3 for tie-break diversity, sau đó fallback qua rest
  const top3 = candidates.slice(0, 3).sort(() => Math.random() - 0.5);
  const ordered = [...top3, ...candidates.slice(3)];

  let hotel: HotelCandidate | null = null;
  let image: ImageCandidate | null = null;
  const triedReasons: string[] = [];

  for (const c of ordered) {
    console.log(`[auto-post] try hotel #${c.hotel_id} "${c.name}" score=${c.score}`);
    const img = await pickImage(c.hotel_id);
    if (img) {
      hotel = c;
      image = img;
      break;
    }
    triedReasons.push(`${c.hotel_id}:no_image`);
  }

  if (!hotel || !image) {
    return {
      ok: false,
      reason: `no_image_in_any_candidate: ${triedReasons.join(', ')}`,
      date,
    };
  }
  console.log(`[auto-post] picked hotel #${hotel.hotel_id} "${hotel.name}" with image ${image.source}`);

  // 1.5. v26 Phase A: Vector search distinctive aspects (cho caption gen)
  let distinctiveContext: string | undefined;
  try {
    const { getDistinctiveAspects } = require('./hotel-vectorizer');
    distinctiveContext = (await getDistinctiveAspects(hotel.hotel_id)) || undefined;
    if (distinctiveContext) {
      console.log(`[auto-post] distinctive context: ${distinctiveContext.slice(0, 150)}`);
    }
  } catch (e: any) {
    console.warn('[auto-post] vector distinctive fail (non-fatal):', e?.message);
  }

  // 3. Pick angle
  const angle = pickAngleSmart(hotel.hotel_id);
  console.log(`[auto-post] angle=${angle} for hotel=${hotel.hotel_id}`);

  // 4. Generate caption (với distinctive context nếu có)
  const imageCtx = image.room_type ? `Phòng: ${image.room_type}` : undefined;
  const ctxParts = [imageCtx, distinctiveContext].filter(Boolean);
  const gen = await generateCaption(hotel, angle, {
    imageContext: ctxParts.length ? ctxParts.join(' | ') : undefined,
  });
  if (!gen) {
    return { ok: false, reason: 'caption_gen_failed', date, hotel, image, angle };
  }

  // QA
  const qa = validateCaption(gen.caption, hotel);
  if (!qa.ok) {
    console.warn(`[auto-post] QA fail: ${qa.issues.join(', ')} — caption still used`);
    // Don't fail, just log. Admin có thể edit trong plan.
  }

  // 5. Save plan
  const capHash = captionHash(gen.caption);
  const now = Date.now();

  const planInsert = db.prepare(`
    INSERT INTO auto_post_plan
      (scheduled_date, hotel_id, angle, image_url, image_fingerprint, caption_draft, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'generated', ?, ?)
    ON CONFLICT(scheduled_date) DO UPDATE SET
      hotel_id = excluded.hotel_id,
      angle = excluded.angle,
      image_url = excluded.image_url,
      image_fingerprint = excluded.image_fingerprint,
      caption_draft = excluded.caption_draft,
      status = 'generated',
      updated_at = excluded.updated_at
    RETURNING id
  `).get(date, hotel.hotel_id, angle, image.url, image.fingerprint, gen.caption, now, now) as any;

  const planId = planInsert?.id;

  // Also insert into history as 'generated'
  db.prepare(`
    INSERT INTO auto_post_history
      (scheduled_date, hotel_id, image_url, image_fingerprint, angle_used, caption_hash, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 'generated', ?)
  `).run(date, hotel.hotel_id, image.url, image.fingerprint, angle, capHash, now);

  // 6. Telegram notify
  try {
    const { notifyAll } = require('../telegram');
    notifyAll(
      `🎯 *Product Auto Post — ${date}*\n` +
      `• Hotel: ${hotel.name} (score=${hotel.score})\n` +
      `• Angle: ${angle}\n` +
      `• Image: ${image.source} ${image.url.slice(0, 60)}...\n` +
      `• Caption (${gen.caption.length} chars, ${gen.provider}):\n\n` +
      gen.caption.slice(0, 500) + (gen.caption.length > 500 ? '...' : '') +
      `\n\nPublish 9h sáng. Edit preview: /api/auto-post/plan/${planId}`
    ).catch(() => {});
  } catch {}

  return { ok: true, plan_id: planId, date, hotel, image, angle, caption: gen.caption };
}

/* ═══════════════════════════════════════════
   PHASE B — PUBLISH
   ═══════════════════════════════════════════ */

/**
 * Download image to local media/ để FB upload trực tiếp.
 * Avoids rate-limit issues with external image fetch by FB.
 */
async function downloadImageToMedia(imageUrl: string): Promise<string | null> {
  try {
    const https = require('https');
    const resp = await axios.get(imageUrl, {
      responseType: 'arraybuffer',
      timeout: 20_000,
      maxContentLength: 10 * 1024 * 1024,
      maxRedirects: 3,
      // v25: OTA server có self-signed cert với IP → allow tạm
      httpsAgent: new https.Agent({ rejectUnauthorized: false }),
    });
    const buf = Buffer.from(resp.data);
    const ctype = String(resp.headers['content-type'] || 'image/jpeg').toLowerCase();
    const ext = ctype.includes('png') ? 'png' : ctype.includes('webp') ? 'webp' : 'jpg';
    const filename = `autopost_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`;

    const { config } = require('../../config');
    const mediaDir = config.mediaDir || path.join(process.cwd(), 'data', 'media');
    if (!fs.existsSync(mediaDir)) fs.mkdirSync(mediaDir, { recursive: true });
    const fullPath = path.join(mediaDir, filename);
    fs.writeFileSync(fullPath, buf);

    return filename;
  } catch (e: any) {
    console.warn('[auto-post] download image fail:', e?.message);
    return null;
  }
}

export async function publishTodayPlan(): Promise<{
  ok: boolean;
  reason?: string;
  post_id?: number;
  fb_post_id?: string;
  plan_id?: number;
}> {
  const date = vnDate();
  const plan = db.prepare(
    `SELECT * FROM auto_post_plan WHERE scheduled_date = ? AND status = 'generated'`
  ).get(date) as any;

  if (!plan) {
    return { ok: false, reason: `no_plan_for_${date}` };
  }

  console.log(`[auto-post] publishing plan #${plan.id} for ${date}`);

  // Get page + hotel
  const page = db.prepare(
    `SELECT p.*, mh.ota_hotel_id as hotel_ota_id
     FROM pages p
     LEFT JOIN mkt_hotels mh ON mh.id = p.hotel_id
     WHERE mh.ota_hotel_id = ? OR p.hotel_id = 1
     ORDER BY (mh.ota_hotel_id = ?) DESC
     LIMIT 1`
  ).get(plan.hotel_id, plan.hotel_id) as any;

  if (!page) {
    return { ok: false, reason: 'no_fb_page', plan_id: plan.id };
  }

  // Download image
  let localFilename = await downloadImageToMedia(plan.image_url);
  if (!localFilename) {
    console.warn('[auto-post] local download failed, trying external URL publish');
  }

  let mediaId: number | null = null;
  if (localFilename) {
    const now = Date.now();
    try {
      const fs = require('fs');
      const { config } = require('../../config');
      const path = require('path');
      const fullPath = path.join(config.mediaDir || path.join(process.cwd(), 'data', 'media'), localFilename);
      const stats = fs.statSync(fullPath);
      const r = db.prepare(
        `INSERT INTO media (filename, mime_type, size, source, created_at, hotel_id)
         VALUES (?, 'image/jpeg', ?, 'auto-product-post', ?, ?)`
      ).run(localFilename, stats.size, now, page.hotel_id);
      mediaId = Number(r.lastInsertRowid);
    } catch (e: any) {
      console.warn('[auto-post] media insert fail:', e?.message);
      localFilename = null;
    }
  }

  // Create post row
  const postInsert = db.prepare(
    `INSERT INTO posts (page_id, caption, media_id, media_type, status, scheduled_at, hotel_id, created_at)
     VALUES (?, ?, ?, ?, 'publishing', ?, ?, ?)`
  ).run(page.id, plan.caption_draft, mediaId, mediaId ? 'image' : 'none', Date.now(), page.hotel_id, Date.now());
  const postId = Number(postInsert.lastInsertRowid);

  // Publish
  try {
    const { publishImage, publishText, mediaFullPath } = require('../facebook');
    let result;
    if (localFilename) {
      result = await publishImage(page.fb_page_id, page.access_token, plan.caption_draft, mediaFullPath(localFilename));
    } else {
      // External URL not ideal, but fallback
      result = await publishText(page.fb_page_id, page.access_token, plan.caption_draft);
    }

    // Update post + plan + history
    const now = Date.now();
    db.prepare(
      `UPDATE posts SET status = 'published', published_at = ?, fb_post_id = ? WHERE id = ?`
    ).run(now, result.fbPostId, postId);

    db.prepare(
      `UPDATE auto_post_plan SET status = 'published', updated_at = ? WHERE id = ?`
    ).run(now, plan.id);

    db.prepare(
      `UPDATE auto_post_history
       SET status = 'published', post_id = ?, published_at = ?
       WHERE scheduled_date = ? AND hotel_id = ?`
    ).run(postId, now, date, plan.hotel_id);

    // v24: Trigger cross-post (IG + Zalo timeline)
    try {
      const { crossPostFromPostId } = require('../cross-post-sync');
      crossPostFromPostId(postId, 'auto_product_daily').catch((e: any) =>
        console.warn('[auto-post] cross-post fail:', e?.message)
      );
    } catch {}

    console.log(`[auto-post] ✅ published post #${postId} fb=${result.fbPostId} for hotel=${plan.hotel_id}`);
    return { ok: true, post_id: postId, fb_post_id: result.fbPostId, plan_id: plan.id };
  } catch (e: any) {
    const msg = e?.response?.data?.error?.message || e?.message || 'unknown';
    db.prepare(`UPDATE posts SET status = 'failed', error_message = ? WHERE id = ?`).run(msg, postId);
    db.prepare(`UPDATE auto_post_plan SET status = 'planned', updated_at = ?, admin_note = ? WHERE id = ?`)
      .run(Date.now(), `publish_fail: ${msg}`, plan.id);
    db.prepare(
      `UPDATE auto_post_history SET status = 'failed' WHERE scheduled_date = ? AND hotel_id = ?`
    ).run(date, plan.hotel_id);
    console.error('[auto-post] publish FAIL:', msg);
    return { ok: false, reason: msg, plan_id: plan.id, post_id: postId };
  }
}

/* ═══════════════════════════════════════════
   QUERIES cho admin
   ═══════════════════════════════════════════ */

export function getUpcomingPlan(days: number = 7): any[] {
  const today = vnDate();
  return db.prepare(
    `SELECT * FROM auto_post_plan WHERE scheduled_date >= ? ORDER BY scheduled_date ASC LIMIT ?`
  ).all(today, days) as any[];
}

export function getHistory(limit: number = 30): any[] {
  return db.prepare(
    `SELECT h.*, p.fb_post_id, p.caption as post_caption, hp.name_canonical as hotel_name
     FROM auto_post_history h
     LEFT JOIN posts p ON p.id = h.post_id
     LEFT JOIN hotel_profile hp ON hp.hotel_id = h.hotel_id
     ORDER BY h.scheduled_date DESC LIMIT ?`
  ).all(limit) as any[];
}

export function skipPlan(planId: number, note: string): boolean {
  try {
    const r = db.prepare(
      `UPDATE auto_post_plan SET status = 'skipped', admin_note = ?, updated_at = ? WHERE id = ?`
    ).run(note, Date.now(), planId);
    return r.changes > 0;
  } catch { return false; }
}

/**
 * V5T Image Composer — sharp + text overlay for carousel/single posts.
 *
 * Reference: skill sonder-content-v5t
 */

import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import sharp from 'sharp';
import { db } from '../../db';
import { generateAIImage } from '../v5/fal-generator';
import type { V5TPost, V5TPostImage } from './types';

const V5T_OUT_DIR = '/opt/vp-marketing/data/media/v5t-out';
const V5_OUT_DIR = '/opt/vp-marketing/data/media/v5-out';
const CINEMA_SHOTS_DIR = '/opt/vp-marketing/data/media/cinema-shots';
const CINEMA_OUT_DIR = '/opt/vp-marketing/data/media/cinema-out';
const ANTH_VISUALS_DIR = '/opt/vp-marketing/data/media/anth-visuals';
const TMP_FRAMES_DIR = '/opt/vp-marketing/data/media/v5t-frames';

if (!fs.existsSync(V5T_OUT_DIR)) fs.mkdirSync(V5T_OUT_DIR, { recursive: true });
if (!fs.existsSync(TMP_FRAMES_DIR)) fs.mkdirSync(TMP_FRAMES_DIR, { recursive: true });

const TARGET_SIZE = 1080;  // 1080×1080 square

/* ───────── Video frame extraction (FREE fallback when FAL exhausted) ───────── */

/** Extract 1 frame from a video at given timestamp (seconds) */
function extractFrameFromVideo(videoPath: string, atSec: number, outPath: string): boolean {
  try {
    const r = spawnSync('ffmpeg', [
      '-y',
      '-ss', String(atSec),
      '-i', videoPath,
      '-vframes', '1',
      '-q:v', '2',
      outPath,
    ], { encoding: 'utf8', timeout: 30000 });
    return r.status === 0 && fs.existsSync(outPath);
  } catch {
    return false;
  }
}

/** Find a usable source video from existing media libraries (real Pexels OR Cinema clips) */
function pickFallbackVideo(): string | null {
  const libraries = [
    ANTH_VISUALS_DIR,    // Pexels real footage — best quality, real
    CINEMA_SHOTS_DIR,    // Hailuo Pro AI — close-up character shots
    V5_OUT_DIR,          // Recent V5 Reels output — composite
  ];
  for (const dir of libraries) {
    if (!fs.existsSync(dir)) continue;
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.mp4'));
    if (files.length === 0) continue;
    const pick = files[Math.floor(Math.random() * files.length)];
    return path.join(dir, pick);
  }
  return null;
}

/** Get a fallback image by extracting random frame from existing video library */
function getFallbackImageFromVideo(prefix: string, position: number): { path: string; cost: number } | null {
  const videoPath = pickFallbackVideo();
  if (!videoPath) return null;

  // Pick frame at 30%-70% of video duration (avoid title cards / black frames)
  const r = spawnSync('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1', videoPath,
  ], { encoding: 'utf8' });
  const duration = parseFloat(r.stdout?.trim() || '5') || 5;
  const atSec = duration * (0.3 + Math.random() * 0.4);

  const framePath = path.join(TMP_FRAMES_DIR, `${prefix}-frame-${position}-${Date.now()}.jpg`);
  if (extractFrameFromVideo(videoPath, atSec, framePath)) {
    return { path: framePath, cost: 0 };
  }
  return null;
}

/** Resolve 1 image source — ONLY real photo from v5_footage.
 *
 * If v5t_require_real_photo=true (DEFAULT after refactor):
 *   - ONLY accept real photo uploaded by Sonder staff
 *   - NO AI Flux fallback
 *   - NO video frame extraction fallback (Hailuo/Pexels too synthetic)
 *   - Reject post if no real photo available
 *
 * Reason: Skill V5T mandate "AUTHENTIC > POLISH" + Meta C2PA penalty
 * for AI content. Better skip post than publish synthetic.
 */
async function resolveImageSource(opts: {
  postId: number;
  position: number;
  preferRealFootage: boolean;
  theme: string;
  /** Footage IDs ALREADY picked for THIS post (carousel slots filled before this one). Avoid re-picking. */
  excludeFootageIds?: number[];
  /** For carousel slots > 0: prefer this content_type if inventory allows */
  preferContentType?: 'tips' | 'story' | 'general';
}): Promise<{ path: string; source: 'real_footage' | 'ai_image'; footage_id?: number; cost: number } | null> {
  const requireRealPhoto = require('../../db').getSetting('v5t_require_real_photo') === 'true';
  const excludeIds = opts.excludeFootageIds || [];

  // Pre-publish copyright gate (added 2026-05-11 after FB takedown).
  // Setting: v5t_copyright_check_enabled (default true). Setting: v5t_copyright_block_threshold (default 60).
  const copyrightEnabled = require('../../db').getSetting('v5t_copyright_check_enabled') !== 'false';
  const blockThreshold = parseInt(require('../../db').getSetting('v5t_copyright_block_threshold') || '60', 10);

  const checkCopyright = async (imagePath: string): Promise<boolean> => {
    if (!copyrightEnabled) return true;
    try {
      const { isImageSafeToPublish } = require('../copyright/verifier');
      const r = await isImageSafeToPublish(imagePath, { threshold: blockThreshold });
      if (!r.ok) {
        console.warn(`[v5t-composer] 🚫 COPYRIGHT BLOCK ${imagePath} — score=${r.assessment.risk_score}/${r.assessment.risk_level} reasons:`, r.assessment.risk_reasons);
        // Auto-add to review queue
        db.prepare(
          `INSERT OR IGNORE INTO copyright_review_queue (image_path, source_table, source_id, status, created_at)
           VALUES (?, 'v5_footage', NULL, 'pending', ?)`,
        ).run(imagePath, Date.now());
      }
      return r.ok;
    } catch (e: any) {
      console.warn('[v5t-composer] copyright check fail (allowing):', e?.message);
      return true;  // fail open
    }
  };

  // 0. PRIORITY (only for position 0): if post-writer already picked a footage_id (caption written for it),
  // render exactly that photo — guarantees caption ↔ image consistency + no-dup propagation.
  if (opts.position === 0) {
    const post = db.prepare(`SELECT picked_footage_id FROM v5t_posts WHERE id = ?`).get(opts.postId) as any;
    if (post?.picked_footage_id) {
      const picked = db.prepare(`SELECT * FROM v5_footage WHERE id = ?`).get(post.picked_footage_id) as any;
      if (picked?.path && fs.existsSync(picked.path)) {
        const ext = path.extname(picked.path).toLowerCase();
        if (['.jpg', '.jpeg', '.png', '.webp'].includes(ext)) {
          const safe = await checkCopyright(picked.path);
          if (!safe) {
            console.warn(`[v5t-composer] picked_footage_id=${picked.id} BLOCKED by copyright check — using fallback`);
            // skip this picked photo, let the query fallback below pick another
          } else {
            db.prepare(`UPDATE v5_footage SET used_count = used_count + 1 WHERE id = ?`).run(picked.id);
            console.log(`[v5t-composer] pos0 using picked_footage_id=${picked.id} (caption hero, copyright OK)`);
            return { path: picked.path, source: 'real_footage', footage_id: picked.id, cost: 0 };
          }
        }
        if (['.mp4', '.mov', '.webm'].includes(ext)) {
          const framePath = path.join(TMP_FRAMES_DIR, `v5t-${opts.postId}-real-${opts.position}-${Date.now()}.jpg`);
          if (extractFrameFromVideo(picked.path, 1.0, framePath)) {
            db.prepare(`UPDATE v5_footage SET used_count = used_count + 1 WHERE id = ?`).run(picked.id);
            return { path: framePath, source: 'real_footage', footage_id: picked.id, cost: 0 };
          }
        }
      }
      console.warn(`[v5t-composer] picked_footage_id=${post.picked_footage_id} not usable, falling back to query`);
    }
  }

  // Build SQL exclusion clause for within-post dedup
  const exclusionSql = excludeIds.length > 0
    ? `AND v5_footage.id NOT IN (${excludeIds.map(() => '?').join(',')})`
    : '';

  // 1a. Try preferred content_type first (matches post style — tips for tips_post carousel slot)
  if (opts.preferContentType) {
    const matched = db.prepare(
      `SELECT * FROM v5_footage
       WHERE (media_type = 'image' OR media_type IS NULL)
         AND notes LIKE ?
         AND NOT EXISTS (
           SELECT 1 FROM v5t_post_images vpi WHERE vpi.footage_id = v5_footage.id
         )
         ${exclusionSql}
       ORDER BY RANDOM()
       LIMIT 1`,
    ).get(`%content_type:${opts.preferContentType}%`, ...excludeIds) as any;
    if (matched?.path && fs.existsSync(matched.path)) {
      const ext = path.extname(matched.path).toLowerCase();
      if (['.jpg', '.jpeg', '.png', '.webp'].includes(ext)) {
        db.prepare(`UPDATE v5_footage SET used_count = used_count + 1 WHERE id = ?`).run(matched.id);
        return { path: matched.path, source: 'real_footage', footage_id: matched.id, cost: 0 };
      }
    }
  }

  // 1b. Fallback: any never-used photo with NO-DUPLICATE filter
  const footage = db.prepare(
    `SELECT * FROM v5_footage
     WHERE (media_type = 'image' OR media_type IS NULL)
       AND NOT EXISTS (
         SELECT 1 FROM v5t_post_images vpi WHERE vpi.footage_id = v5_footage.id
       )
       ${exclusionSql}
     ORDER BY RANDOM()
     LIMIT 1`,
  ).get(...excludeIds) as any;

  if (footage?.path && fs.existsSync(footage.path)) {
    const ext = path.extname(footage.path).toLowerCase();
    if (['.jpg', '.jpeg', '.png', '.webp'].includes(ext)) {
      db.prepare(`UPDATE v5_footage SET used_count = used_count + 1 WHERE id = ?`).run(footage.id);
      return { path: footage.path, source: 'real_footage', footage_id: footage.id, cost: 0 };
    }
    // Sonder staff video → extract frame (still real, free)
    if (['.mp4', '.mov', '.webm'].includes(ext)) {
      const framePath = path.join(TMP_FRAMES_DIR, `v5t-${opts.postId}-real-${opts.position}-${Date.now()}.jpg`);
      if (extractFrameFromVideo(footage.path, 1.0, framePath)) {
        db.prepare(`UPDATE v5_footage SET used_count = used_count + 1 WHERE id = ?`).run(footage.id);
        return { path: framePath, source: 'real_footage', footage_id: footage.id, cost: 0 };
      }
    }
  }

  // 2. STRICT MODE: reject if no real photo (don't fallback AI)
  if (requireRealPhoto) {
    console.log(`[v5t-composer] no real photo available + require_real_photo=true → reject post`);
    return null;
  }

  // 3. Permissive mode (legacy): try AI Flux + video frame fallback
  console.log(`[v5t-composer] permissive mode — trying AI Flux fallback`);
  const r = await generateAIImage({
    prompt: `Sonder Vietnam boutique guesthouse, ${opts.theme === 'saigon_insider' ? 'Saigon street life' : 'cozy hotel interior'}, square 1:1, cinematic, photo realistic`,
    aspect_ratio: '1:1',
    filename_prefix: `v5t-${opts.postId}-pos${opts.position}`,
  });
  if (r.ok && r.local_path) return { path: r.local_path, source: 'ai_image', cost: r.cost_usd };

  const fallback = getFallbackImageFromVideo(`v5t-${opts.postId}`, opts.position);
  if (fallback) return { path: fallback.path, source: 'ai_image', cost: 0 };

  return null;
}

/** Apply text overlay (hook line) to image — sharp SVG composite */
async function addTextOverlay(opts: {
  inputPath: string;
  outputPath: string;
  hookText: string;
}): Promise<boolean> {
  try {
    const escapedHook = opts.hookText
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');

    // SVG with text — bottom-left aligned, semi-transparent gradient overlay
    const svgOverlay = `
<svg width="${TARGET_SIZE}" height="${TARGET_SIZE}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="grad" x1="0%" y1="50%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="black" stop-opacity="0"/>
      <stop offset="100%" stop-color="black" stop-opacity="0.7"/>
    </linearGradient>
  </defs>
  <rect width="100%" height="100%" fill="url(#grad)"/>
  <text x="60" y="980" font-family="Georgia, serif" font-size="48" font-weight="400"
        fill="white" stroke="rgba(0,0,0,0.6)" stroke-width="0.5">${escapedHook}</text>
</svg>`;

    await sharp(opts.inputPath)
      .resize(TARGET_SIZE, TARGET_SIZE, { fit: 'cover' })
      .composite([{ input: Buffer.from(svgOverlay), top: 0, left: 0 }])
      .jpeg({ quality: 85 })
      .toFile(opts.outputPath);
    return true;
  } catch (e: any) {
    console.warn('[v5t-composer] text overlay fail:', e.message);
    return false;
  }
}

/** Just resize to 1080×1080 (no overlay) */
async function resizeOnly(inputPath: string, outputPath: string): Promise<boolean> {
  try {
    await sharp(inputPath)
      .resize(TARGET_SIZE, TARGET_SIZE, { fit: 'cover' })
      .jpeg({ quality: 85 })
      .toFile(outputPath);
    return true;
  } catch {
    return false;
  }
}

/* ───────── Main: compose carousel/single ───────── */

export async function composeV5TPost(postId: number): Promise<{
  ok: boolean;
  images: V5TPostImage[];
  total_cost_usd: number;
  error?: string;
}> {
  const post = db.prepare(`SELECT * FROM v5t_posts WHERE id = ?`).get(postId) as V5TPost | undefined;
  if (!post) return { ok: false, images: [], total_cost_usd: 0, error: 'post_not_found' };

  // ─── Determine carousel size based on type + inventory ───
  // STORY: always 1 (single moment photo).
  // TIPS: try carousel 3-5 if inventory has enough never-used tips/general photos.
  //   - count available tips photos first (preferred)
  //   - if <3 tips available, count general (fallback)
  //   - if total available <3, fallback to single image
  let numImages = 1;
  let carouselContentType: 'tips' | 'general' | null = null;

  if (post.type === 'tips_post') {
    const { getSetting } = require('../../db');
    const carouselEnabled = getSetting('v5t_tips_carousel_enabled') !== 'false';  // default ON
    const targetMin = parseInt(getSetting('v5t_tips_carousel_min') || '3', 10);
    const targetMax = parseInt(getSetting('v5t_tips_carousel_max') || '5', 10);

    if (carouselEnabled) {
      // Count never-used tips photos (excluding hero already picked)
      const heroId = post.picked_footage_id || 0;
      const tipsCount = (db.prepare(
        `SELECT COUNT(*) AS n FROM v5_footage
         WHERE (media_type = 'image' OR media_type IS NULL)
           AND notes LIKE '%content_type:tips%'
           AND id != ?
           AND NOT EXISTS (SELECT 1 FROM v5t_post_images vpi WHERE vpi.footage_id = v5_footage.id)`,
      ).get(heroId) as any).n as number;

      const generalCount = (db.prepare(
        `SELECT COUNT(*) AS n FROM v5_footage
         WHERE (media_type = 'image' OR media_type IS NULL)
           AND notes LIKE '%content_type:general%'
           AND id != ?
           AND NOT EXISTS (SELECT 1 FROM v5t_post_images vpi WHERE vpi.footage_id = v5_footage.id)`,
      ).get(heroId) as any).n as number;

      // Prefer tips, fallback to general. Need targetMin-1 additional photos (hero is the 1st).
      if (tipsCount >= targetMin - 1) {
        numImages = Math.min(targetMax, 1 + tipsCount);
        carouselContentType = 'tips';
      } else if (generalCount >= targetMin - 1) {
        numImages = Math.min(targetMax, 1 + generalCount);
        carouselContentType = 'general';
      } else {
        console.log(`[v5t-composer] TIPS carousel inventory insufficient (tips=${tipsCount}, general=${generalCount}, need ≥${targetMin - 1}) → fallback to single image`);
      }
    }
  }

  console.log(`[v5t-composer] composing ${numImages} images for post ${postId} (type=${post.type}${carouselContentType ? `, carousel=${carouselContentType}` : ''})`);

  // Pick winning hook for image overlay (use variant A as default for compose phase)
  const hookText = post.caption_a.split('\n')[0]?.trim() || '';

  const images: V5TPostImage[] = [];
  const usedFootageIds: number[] = [];  // track within-post to prevent same photo twice in carousel
  let totalCost = 0;

  for (let i = 0; i < numImages; i++) {
    const src = await resolveImageSource({
      postId,
      position: i,
      preferRealFootage: i < Math.ceil(numImages * 0.6),  // 60% real
      theme: post.theme,
      excludeFootageIds: usedFootageIds,  // don't pick same photo twice in same carousel
      preferContentType: i === 0 ? undefined : (carouselContentType || undefined),  // pos 0 = hero (post-writer's pick)
    });

    if (!src) {
      console.warn(`[v5t-composer] image ${i} unresolved`);
      continue;
    }
    totalCost += src.cost;

    // First image of carousel/single gets text overlay (hook)
    const hasOverlay = i === 0 && hookText.length > 0 && hookText.length < 80;
    const composedPath = path.join(V5T_OUT_DIR, `post-${postId}-img-${i}.jpg`);

    const ok = hasOverlay
      ? await addTextOverlay({ inputPath: src.path, outputPath: composedPath, hookText })
      : await resizeOnly(src.path, composedPath);

    if (!ok) continue;

    // Track for within-post dedup (carousel slots must all be distinct photos)
    if (src.footage_id) usedFootageIds.push(src.footage_id);

    const r = db.prepare(
      `INSERT INTO v5t_post_images
       (post_id, position, source, footage_id, ai_prompt,
        composed_path, width, height, has_text_overlay, cost_usd, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      postId, i, src.source, src.footage_id || null, null,
      composedPath, TARGET_SIZE, TARGET_SIZE, hasOverlay ? 1 : 0,
      src.cost, Date.now(),
    );

    images.push({
      id: r.lastInsertRowid as number,
      post_id: postId,
      position: i,
      source: src.source,
      footage_id: src.footage_id,
      composed_path: composedPath,
      width: TARGET_SIZE,
      height: TARGET_SIZE,
      has_text_overlay: hasOverlay,
      cost_usd: src.cost,
      created_at: Date.now(),
    });
  }

  if (images.length === 0) {
    db.prepare(`UPDATE v5t_posts SET status = 'failed' WHERE id = ?`).run(postId);
    return { ok: false, images: [], total_cost_usd: totalCost, error: 'no images composed' };
  }

  db.prepare(`UPDATE v5t_posts SET status = 'rendered' WHERE id = ?`).run(postId);
  console.log(`[v5t-composer] ✅ post ${postId}: ${images.length} images, $${totalCost.toFixed(3)}`);

  return { ok: true, images, total_cost_usd: totalCost };
}

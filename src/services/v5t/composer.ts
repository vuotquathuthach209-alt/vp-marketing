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

/** Resolve 1 image source via fallback chain:
 *  1. v5_footage real photos (uploaded by Sonder staff) — primary
 *  2. v5_footage video → extract frame (real footage, free)
 *  3. AI Flux gen (FAL credit needed)
 *  4. Existing video libraries → extract frame (Pexels Anthology + Cinema shots)
 *  5. null (skip shot)
 */
async function resolveImageSource(opts: {
  postId: number;
  position: number;
  preferRealFootage: boolean;
  theme: string;
}): Promise<{ path: string; source: 'real_footage' | 'ai_image'; footage_id?: number; cost: number } | null> {
  // 1. Try real footage from v5_footage (image type)
  if (opts.preferRealFootage) {
    const footage = db.prepare(
      `SELECT * FROM v5_footage
       WHERE used_count < 10
         AND (media_type = 'image' OR media_type IS NULL)
       ORDER BY used_count ASC, RANDOM()
       LIMIT 1`,
    ).get() as any;

    if (footage?.path && fs.existsSync(footage.path)) {
      const ext = path.extname(footage.path).toLowerCase();
      if (['.jpg', '.jpeg', '.png', '.webp'].includes(ext)) {
        db.prepare(`UPDATE v5_footage SET used_count = used_count + 1 WHERE id = ?`).run(footage.id);
        return { path: footage.path, source: 'real_footage', footage_id: footage.id, cost: 0 };
      }

      // 2. Real footage stored as video → extract frame (still real, free)
      if (['.mp4', '.mov', '.webm'].includes(ext)) {
        const framePath = path.join(TMP_FRAMES_DIR, `v5t-${opts.postId}-real-${opts.position}-${Date.now()}.jpg`);
        if (extractFrameFromVideo(footage.path, 1.0, framePath)) {
          db.prepare(`UPDATE v5_footage SET used_count = used_count + 1 WHERE id = ?`).run(footage.id);
          return { path: framePath, source: 'real_footage', footage_id: footage.id, cost: 0 };
        }
      }
    }
  }

  // 3. Try AI Flux gen
  const prompt = `Sonder Vietnam boutique guesthouse, ${opts.theme === 'saigon_insider' ? 'Saigon street life morning quiet' : 'cozy hotel interior warm amber light'}, square 1:1, cinematic, photo realistic, vertical depth`;
  const r = await generateAIImage({
    prompt,
    aspect_ratio: '1:1',
    filename_prefix: `v5t-${opts.postId}-pos${opts.position}`,
  });
  if (r.ok && r.local_path) {
    return { path: r.local_path, source: 'ai_image', cost: r.cost_usd };
  }

  // 4. FAL exhausted / failed → fallback to existing video library frame extraction
  console.log(`[v5t-composer] AI image fail, fallback to video-frame extraction for pos ${opts.position}`);
  const fallback = getFallbackImageFromVideo(`v5t-${opts.postId}`, opts.position);
  if (fallback) {
    return { path: fallback.path, source: 'ai_image', cost: 0 };
  }

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

  // Image count
  const numImages =
    post.type === 'carousel' ? 4 + Math.floor(Math.random() * 3) :  // 4-6
    post.type === 'single_image' ? 1 :
    post.type === 'poll' ? 1 :
    post.type === 'question' ? 1 :
    1;

  console.log(`[v5t-composer] composing ${numImages} images for post ${postId} (type=${post.type})`);

  // Pick winning hook for image overlay (use variant A as default for compose phase)
  const hookText = post.caption_a.split('\n')[0]?.trim() || '';

  const images: V5TPostImage[] = [];
  let totalCost = 0;

  for (let i = 0; i < numImages; i++) {
    const src = await resolveImageSource({
      postId,
      position: i,
      preferRealFootage: i < Math.ceil(numImages * 0.6),  // 60% real
      theme: post.theme,
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

    const stat = fs.statSync(composedPath);
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

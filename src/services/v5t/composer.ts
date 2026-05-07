/**
 * V5T Image Composer — sharp + text overlay for carousel/single posts.
 *
 * Reference: skill sonder-content-v5t
 */

import * as fs from 'fs';
import * as path from 'path';
import sharp from 'sharp';
import { db } from '../../db';
import { generateAIImage } from '../v5/fal-generator';
import type { V5TPost, V5TPostImage } from './types';

const V5T_OUT_DIR = '/opt/vp-marketing/data/media/v5t-out';
if (!fs.existsSync(V5T_OUT_DIR)) fs.mkdirSync(V5T_OUT_DIR, { recursive: true });

const TARGET_SIZE = 1080;  // 1080×1080 square

/** Resolve 1 image source: real footage or AI gen */
async function resolveImageSource(opts: {
  postId: number;
  position: number;
  preferRealFootage: boolean;
  theme: string;
}): Promise<{ path: string; source: 'real_footage' | 'ai_image'; footage_id?: number; cost: number } | null> {
  // Try real footage first if preferred
  if (opts.preferRealFootage) {
    const footage = db.prepare(
      `SELECT * FROM v5_footage
       WHERE used_count < 10
         AND (media_type = 'image' OR media_type IS NULL)
       ORDER BY used_count ASC, RANDOM()
       LIMIT 1`,
    ).get() as any;

    if (footage?.path && fs.existsSync(footage.path)) {
      // Check if it's actually image extension
      const ext = path.extname(footage.path).toLowerCase();
      if (['.jpg', '.jpeg', '.png', '.webp'].includes(ext)) {
        db.prepare(`UPDATE v5_footage SET used_count = used_count + 1 WHERE id = ?`).run(footage.id);
        return { path: footage.path, source: 'real_footage', footage_id: footage.id, cost: 0 };
      }
    }
  }

  // Fallback: AI gen via FAL Flux
  const prompt = `Sonder Vietnam boutique guesthouse, ${opts.theme === 'saigon_insider' ? 'Saigon street life' : 'cozy hotel interior'}, square 1:1, cinematic warm light, photo realistic`;
  const r = await generateAIImage({
    prompt,
    aspect_ratio: '1:1',
    filename_prefix: `v5t-${opts.postId}-pos${opts.position}`,
  });
  if (r.ok && r.local_path) {
    return { path: r.local_path, source: 'ai_image', cost: r.cost_usd };
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

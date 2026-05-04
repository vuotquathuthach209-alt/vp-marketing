/**
 * Weekend Visuals — mixed AI image gen + Pexels stock fetcher.
 *
 * Per-scene strategy:
 *   - prefer_visual='ai' → Gemini Flash Image (controlled VN aesthetic) + Pexels fallback
 *   - prefer_visual='stock' → Pexels stock first + AI image fallback
 *
 * Deduplication: cùng video không reuse clip Pexels.
 *
 * Future V2.3: replace Gemini Flash Image với FAL.AI FLUX cho character consistency.
 */

import * as fs from 'fs';
import * as path from 'path';
import axios from 'axios';
import { searchPexels } from './providers/pexels';
import type { WeekendScene } from './weekend-engine';

const MEDIA_DIR = '/opt/vp-marketing/data/media';
const WEEKEND_VISUALS_DIR = path.join(MEDIA_DIR, 'weekend-visuals');

if (!fs.existsSync(WEEKEND_VISUALS_DIR)) fs.mkdirSync(WEEKEND_VISUALS_DIR, { recursive: true });

export interface WeekendVisual {
  scene_idx: number;
  type: 'ai' | 'stock';
  local_path: string;
  natural_duration_sec: number;     // 0 for image, real for video
  source_id?: string;
}

const usedPexelsIds = new Set<string>();

export function resetUsedClips(): void {
  usedPexelsIds.clear();
}

// ═══════════════════════════════════════════════════════════
// AI image gen — reuse imagegen.generateImageSmart từ existing
// ═══════════════════════════════════════════════════════════

async function generateAIImage(prompt: string, mood: string, camera: string): Promise<string | null> {
  try {
    const moodLight = {
      calm: 'soft balanced natural light',
      warm: 'warm golden hour lighting',
      uplifting: 'bright hopeful natural light',
      cinematic: 'dramatic cinematic lighting',
      intimate: 'soft warm intimate lighting',
    }[mood] || 'warm natural lighting';

    const cameraDesc = {
      'close-up': 'close-up detail shot',
      'wide': 'wide cinematic establishing shot',
      'medium': 'medium shot',
      'aerial': 'aerial bird-eye view',
      'pov': 'first-person POV',
    }[camera] || 'medium shot';

    const enhancedPrompt = `${prompt}, ${cameraDesc}, ${moodLight}, Vietnamese setting, Saigon atmosphere, no Western faces, cinematic editorial photography, shot on Sony A7, magazine quality | negative: text, watermark, blurry, distorted face, cartoon, oversaturated, low quality`;

    // Try existing imagegen module
    let mediaRow: any;
    try {
      const { generateImageSmart } = require('../imagegen');
      const r = await generateImageSmart(enhancedPrompt);
      const { db } = require('../../db');
      mediaRow = db.prepare(`SELECT filename FROM media WHERE id = ?`).get(r.mediaId);
    } catch (e: any) {
      console.warn('[weekend-visuals] imagegen err:', e?.message);
      return null;
    }

    if (!mediaRow) return null;
    const isUrl = /^https?:\/\//i.test(mediaRow.filename);
    return isUrl ? mediaRow.filename : path.join(MEDIA_DIR, mediaRow.filename);
  } catch (e: any) {
    console.warn('[weekend-visuals] AI image fail:', e?.message);
    return null;
  }
}

// ═══════════════════════════════════════════════════════════
// Pexels stock fetcher
// ═══════════════════════════════════════════════════════════

async function fetchPexelsClip(query: string, sceneIdx: number): Promise<{ path: string; duration: number; clipId: string } | null> {
  try {
    if (!query || query.length < 4) return null;

    const clips = await searchPexels(query, {
      orientation: 'portrait',
      perPage: 8,
      minDuration: 4,
      maxDuration: 30,
    });
    if (!clips || clips.length === 0) return null;

    let clip = clips.find((c: any) => !usedPexelsIds.has(String(c.id)) && (c.height >= 1080 || c.width >= 1080));
    if (!clip) clip = clips.find((c: any) => !usedPexelsIds.has(String(c.id))) || clips[0];
    usedPexelsIds.add(String(clip.id));

    const filename = `weekend-pexels-${clip.id}.mp4`;
    const localPath = path.join(WEEKEND_VISUALS_DIR, filename);

    if (!fs.existsSync(localPath)) {
      const resp = await axios.get(clip.clip_url, {
        responseType: 'arraybuffer',
        timeout: 90_000,
        maxContentLength: 50 * 1024 * 1024,
      });
      fs.writeFileSync(localPath, Buffer.from(resp.data));
    }

    return { path: localPath, duration: clip.duration_sec, clipId: String(clip.id) };
  } catch (e: any) {
    console.warn(`[weekend-visuals] Pexels "${query.slice(0, 40)}":`, e?.message);
    return null;
  }
}

// ═══════════════════════════════════════════════════════════
// Per-scene fetch with prefer_visual hint
// ═══════════════════════════════════════════════════════════

export async function fetchVisualForScene(scene: WeekendScene): Promise<WeekendVisual | null> {
  const tryAI = async () => {
    const aiPath = await generateAIImage(scene.visual_prompt, scene.mood, scene.camera);
    if (aiPath) {
      console.log(`[weekend-visuals] scene ${scene.scene_idx} → AI image (${path.basename(aiPath)})`);
      return { scene_idx: scene.scene_idx, type: 'ai' as const, local_path: aiPath, natural_duration_sec: 0 };
    }
    return null;
  };

  const tryStock = async () => {
    const clip = await fetchPexelsClip(scene.visual_query, scene.scene_idx);
    if (clip) {
      console.log(`[weekend-visuals] scene ${scene.scene_idx} → Pexels (${path.basename(clip.path)} ${clip.duration}s)`);
      return {
        scene_idx: scene.scene_idx,
        type: 'stock' as const,
        local_path: clip.path,
        natural_duration_sec: clip.duration,
        source_id: clip.clipId,
      };
    }
    return null;
  };

  // Primary based on prefer_visual hint
  if (scene.prefer_visual === 'ai') {
    const ai = await tryAI();
    if (ai) return ai;
    const stock = await tryStock();
    return stock;
  } else {
    const stock = await tryStock();
    if (stock) return stock;
    const ai = await tryAI();
    return ai;
  }
}

// ═══════════════════════════════════════════════════════════
// Fetch all scenes (sequential to control rate + dedup)
// ═══════════════════════════════════════════════════════════

export async function fetchAllWeekendVisuals(scenes: WeekendScene[]): Promise<Array<WeekendVisual | null>> {
  resetUsedClips();
  const results: Array<WeekendVisual | null> = [];

  for (const scene of scenes) {
    const v = await fetchVisualForScene(scene);
    results.push(v);
  }

  return results;
}

// ═══════════════════════════════════════════════════════════
// Custom thumbnail generator (separate from scenes)
// ═══════════════════════════════════════════════════════════

export async function generateThumbnail(prompt: string): Promise<string | null> {
  // Use AI image gen with thumbnail-specific prompt
  const enhanced = `${prompt}, vertical 9:16 thumbnail composition, eye-catching, bold subject, vibrant colors, high contrast, Vietnamese aesthetic | negative: text overlay, blurry, distorted, low quality`;
  return await generateAIImage(enhanced, 'cinematic', 'medium');
}

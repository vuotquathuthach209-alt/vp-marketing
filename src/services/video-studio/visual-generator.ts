/**
 * Visual Generator — unified interface cho stock + AI video providers.
 *
 * V1: Tier A = stock only (Pexels + Pixabay fallback)
 * V3 (future): hybrid/AI tiers (Runway, Luma, Hailuo)
 *
 * Input: scene với stock_keywords + visual_prompt + duration
 * Output: clip URL phù hợp
 */

import { searchPexels, markClipUsed as markPexelsUsed, PexelsClip } from './providers/pexels';
import { searchPixabay, PixabayClip } from './providers/pixabay';

export interface VisualClip {
  provider: 'pexels' | 'pixabay' | 'runway' | 'luma' | 'hailuo';
  clip_id: string;
  clip_url: string;
  thumbnail_url?: string;
  duration_sec: number;
  width: number;
  height: number;
  photographer?: string;
  license: string;
}

export interface VisualFetchOpts {
  stock_keywords: string[];           // Primary search terms
  visual_prompt?: string;              // Fallback longer description
  duration_sec: number;                // Target clip duration
  aspect_ratio?: string;               // '9:16' | '1:1' | '16:9'
  tier?: 'stock' | 'hybrid' | 'premium';
}

/**
 * Main entry — fetch best matching clip for scene.
 *
 * Strategy:
 *   1. Try Pexels (stock_keywords[0]) with orientation
 *   2. If not enough, try Pexels with visual_prompt shortened
 *   3. Fallback to Pixabay
 *   4. Pick clip closest to target duration
 *
 * Returns null if nothing found → caller should generate prompt alternative
 * or surface error to admin.
 */
export async function fetchVisualForScene(opts: VisualFetchOpts): Promise<VisualClip | null> {
  const orientation = opts.aspect_ratio === '16:9' ? 'landscape'
    : opts.aspect_ratio === '1:1' ? 'square'
    : 'portrait';

  const allClips: VisualClip[] = [];

  // Try Pexels with each keyword
  for (const kw of opts.stock_keywords.slice(0, 3)) {
    const pexels = await searchPexels(kw, { orientation: orientation as any, perPage: 8, minDuration: 3, maxDuration: 30 });
    for (const c of pexels) {
      allClips.push({
        provider: 'pexels',
        clip_id: c.id,
        clip_url: c.clip_url,
        thumbnail_url: c.thumbnail_url,
        duration_sec: c.duration_sec,
        width: c.width,
        height: c.height,
        photographer: c.photographer,
        license: c.license,
      });
    }
    if (allClips.length >= 5) break;  // Enough options
  }

  // Fallback to Pixabay if not enough
  if (allClips.length < 3) {
    const pixabayOrient = orientation === 'portrait' ? 'vertical' : orientation === 'landscape' ? 'horizontal' : 'all';
    for (const kw of opts.stock_keywords.slice(0, 3)) {
      const pixabay = await searchPixabay(kw, { orientation: pixabayOrient as any, perPage: 5 });
      for (const c of pixabay) {
        allClips.push({
          provider: 'pixabay',
          clip_id: c.id,
          clip_url: c.clip_url,
          thumbnail_url: c.thumbnail_url,
          duration_sec: c.duration_sec,
          width: c.width,
          height: c.height,
          photographer: c.photographer,
          license: c.license,
        });
      }
      if (allClips.length >= 5) break;
    }
  }

  if (allClips.length === 0) {
    console.warn(`[vs-visual] no clip found for keywords: ${opts.stock_keywords.join(', ')}`);
    return null;
  }

  // Pick clip closest to target duration (prefer slightly longer so we can trim)
  allClips.sort((a, b) => {
    const aDiff = Math.abs(a.duration_sec - opts.duration_sec);
    const bDiff = Math.abs(b.duration_sec - opts.duration_sec);
    // Bonus: slight preference for longer (can trim) over shorter (would need to loop)
    const aBonus = a.duration_sec >= opts.duration_sec ? -0.5 : 0;
    const bBonus = b.duration_sec >= opts.duration_sec ? -0.5 : 0;
    return (aDiff + aBonus) - (bDiff + bBonus);
  });

  const chosen = allClips[0];

  // Mark used
  if (chosen.provider === 'pexels') {
    markPexelsUsed('pexels', chosen.clip_id);
  }

  return chosen;
}

/**
 * Fetch clips for ALL scenes in parallel.
 * Failed scenes marked with null — caller can retry or use admin fallback.
 */
export async function fetchVisualsForScenes(
  scenes: Array<{ stock_keywords: string[]; visual_prompt?: string; duration_sec: number }>,
  aspectRatio: string = '9:16',
): Promise<Array<VisualClip | null>> {
  return Promise.all(scenes.map(s =>
    fetchVisualForScene({
      stock_keywords: s.stock_keywords,
      visual_prompt: s.visual_prompt,
      duration_sec: s.duration_sec,
      aspect_ratio: aspectRatio,
    }),
  ));
}

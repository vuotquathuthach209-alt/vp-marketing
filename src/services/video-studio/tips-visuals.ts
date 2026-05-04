/**
 * Tips Visuals — fetch Pexels stock cho từng tip + filter chất lượng VN-aesthetic.
 *
 * Strategy:
 *   1. Search Pexels per tip's visual_query
 *   2. Filter: portrait orientation, ≥3s duration, 1080p+ resolution
 *   3. Avoid duplicates within same video
 *   4. Cache via existing video_stock_cache table
 *
 * Future V2.3:
 *   - Auto-detect Western faces → reject
 *   - Inject FLUX-generated images cho hero shots
 */

import * as fs from 'fs';
import * as path from 'path';
import axios from 'axios';
import { db } from '../../db';
import { searchPexels } from './providers/pexels';
import type { TipScene } from './tips-engine';

const MEDIA_DIR = '/opt/vp-marketing/data/media';
const TIPS_VISUALS_DIR = path.join(MEDIA_DIR, 'tips-visuals');

if (!fs.existsSync(TIPS_VISUALS_DIR)) fs.mkdirSync(TIPS_VISUALS_DIR, { recursive: true });

export interface TipVisual {
  tip_index: number;             // 0-4
  type: 'video' | 'image';
  local_path: string;
  duration_sec: number;
  source_id: string;             // pexels clip ID for tracking
}

const usedClipIds = new Set<string>();

/** Reset between videos để tránh duplicates ngang cross-video. */
export function resetUsedClips(): void {
  usedClipIds.clear();
}

/**
 * Fetch 1 visual clip cho tip.
 *
 * Quality filters:
 *   - Portrait orientation
 *   - Duration 3-30s (avoid ultra-short / ultra-long)
 *   - Resolution 1080p+ preferred
 */
export async function fetchVisualForTip(
  tip: TipScene,
  tipIndex: number,
  hookContext?: string,
): Promise<TipVisual | null> {
  // Build search queries with fallbacks
  const queries = [
    tip.visual_query,
    // Fallback: specific keywords from tip text (extract nouns)
    ...extractKeywords(tip.text).slice(0, 2),
  ].filter(q => q && q.length >= 4);

  for (const query of queries) {
    const clips = await searchPexels(query, {
      orientation: 'portrait',
      perPage: 8,
      minDuration: 3,
      maxDuration: 30,
    });

    if (!clips || clips.length === 0) continue;

    // Pick first non-duplicate that has decent resolution
    const eligible = clips
      .filter(c => !usedClipIds.has(String(c.id)))
      .filter(c => c.height >= 1080 || c.width >= 1080)  // 1080p+ either dim
      .sort((a, b) => {
        // Prefer ~10s duration (sweet spot for 12s tip with overlap)
        const aDiff = Math.abs(a.duration_sec - 10);
        const bDiff = Math.abs(b.duration_sec - 10);
        return aDiff - bDiff;
      });

    const clip = eligible[0] || clips.find(c => !usedClipIds.has(String(c.id))) || clips[0];
    if (!clip) continue;

    usedClipIds.add(String(clip.id));

    // Download clip if not cached
    const filename = `tip-${clip.id}.mp4`;
    const localPath = path.join(TIPS_VISUALS_DIR, filename);

    if (!fs.existsSync(localPath)) {
      try {
        const resp = await axios.get(clip.clip_url, {
          responseType: 'arraybuffer',
          timeout: 90_000,
          maxContentLength: 50 * 1024 * 1024,
        });
        fs.writeFileSync(localPath, Buffer.from(resp.data));
        console.log(`[tips-visuals] tip ${tipIndex + 1} — Pexels "${query.slice(0, 30)}": ${(resp.data.length / 1024 / 1024).toFixed(1)}MB, ${clip.duration_sec}s`);
      } catch (e: any) {
        console.warn(`[tips-visuals] download fail ${clip.id}:`, e?.message);
        continue;
      }
    } else {
      console.log(`[tips-visuals] tip ${tipIndex + 1} — Pexels "${query.slice(0, 30)}": cached`);
    }

    return {
      tip_index: tipIndex,
      type: 'video',
      local_path: localPath,
      duration_sec: clip.duration_sec,
      source_id: String(clip.id),
    };
  }

  console.warn(`[tips-visuals] tip ${tipIndex + 1} ALL queries failed: ${queries.join(' | ')}`);
  return null;
}

/**
 * Fetch visuals for ALL tips (parallel where possible, with rate limit).
 */
export async function fetchAllTipsVisuals(tips: TipScene[]): Promise<Array<TipVisual | null>> {
  resetUsedClips();
  const results: Array<TipVisual | null> = [];

  // Sequential to avoid Pexels rate limit + ensure dedup tracking works
  for (let i = 0; i < tips.length; i++) {
    const v = await fetchVisualForTip(tips[i], i);
    results.push(v);
  }

  return results;
}

/** Extract Vietnamese keywords from tip text → candidates for fallback Pexels search.
 *  Note: Pexels mostly returns English-tagged results, so this fallback is best-effort. */
function extractKeywords(text: string): string[] {
  // Common travel-related VN→EN mapping
  const mapping: Record<string, string> = {
    'phòng': 'hotel room',
    'khách sạn': 'hotel',
    'homestay': 'homestay',
    'sân bay': 'airport',
    'vé máy bay': 'airplane ticket',
    'du lịch': 'travel',
    'sài gòn': 'saigon',
    'hà nội': 'hanoi',
    'đà nẵng': 'da nang',
    'biển': 'beach',
    'núi': 'mountain',
    'cafe': 'coffee shop',
    'ăn uống': 'food',
    'ẩm thực': 'cuisine',
    'check-in': 'check in',
    'đặt phòng': 'booking',
    'review': 'review',
    'tip': 'travel tip',
    'mẹo': 'travel tip',
  };

  const lower = text.toLowerCase();
  const keywords: string[] = [];

  for (const [vn, en] of Object.entries(mapping)) {
    if (lower.includes(vn)) keywords.push(en);
  }

  // Add generic travel context if nothing matched
  if (keywords.length === 0) keywords.push('travel vietnam', 'vietnamese tourism');

  return keywords.slice(0, 3);
}

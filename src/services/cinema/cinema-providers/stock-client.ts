/**
 * Stock video provider — TIER 0 (FREE).
 *
 * Searches Pexels for free stock footage matching shot's visual_query.
 * Falls through to next tier if no match found (Wan/Seedance/Hailuo).
 *
 * Pexels integration đã có sẵn từ Anthology — wrap with cinema-specific
 * download dir + dedup tracking.
 *
 * Cost: $0 forever. Pexels API rate limit 200/hour free tier.
 */

import * as fs from 'fs';
import * as path from 'path';
import axios from 'axios';
import { searchPexels } from '../../video-studio/providers/pexels';
import { logCost } from '../cinema-cost-tracker';
import type { VideoGenResult } from './fal-base';

const MEDIA_DIR = '/opt/vp-marketing/data/media';
const CINEMA_VIDEOS_DIR = path.join(MEDIA_DIR, 'cinema-shots');

if (!fs.existsSync(CINEMA_VIDEOS_DIR)) fs.mkdirSync(CINEMA_VIDEOS_DIR, { recursive: true });

// Track used Pexels IDs per session to avoid duplicate clips in same episode
const usedPexelsIds = new Set<string>();

export function resetStockUsedIds(): void {
  usedPexelsIds.clear();
}

export interface StockShotOpts {
  episode_id?: number;
  shot_id?: number;
  visual_query: string;          // ENG keywords for Pexels search
  duration_target_sec?: number;
  aspect_ratio?: '9:16' | '16:9' | '1:1';
}

/**
 * Try fetch a stock clip matching shot's visual_query.
 * Returns null if no match — caller falls through to next tier.
 */
export async function generateStockShot(opts: StockShotOpts): Promise<VideoGenResult | null> {
  const query = (opts.visual_query || '').trim();
  if (query.length < 4) {
    console.warn(`[stock] query too short, skip: "${query}"`);
    return null;
  }

  const orientation = opts.aspect_ratio === '16:9' ? 'landscape' : 'portrait';
  console.log(`[stock] searching Pexels: "${query.slice(0, 80)}"`);

  let clips: any[] = [];
  try {
    clips = await searchPexels(query, {
      orientation,
      perPage: 10,
      minDuration: opts.duration_target_sec ? Math.max(2, opts.duration_target_sec - 4) : 4,
      maxDuration: 30,
    });
  } catch (e: any) {
    console.warn(`[stock] Pexels search err: ${e?.message}`);
    return null;
  }

  if (!clips || clips.length === 0) {
    console.log(`[stock] no Pexels match for "${query}"`);
    return null;
  }

  // Pick first non-duplicated clip with adequate resolution
  let chosen = clips.find(
    (c) => !usedPexelsIds.has(String(c.id)) && (c.height >= 1080 || c.width >= 1080),
  );
  if (!chosen) chosen = clips.find((c) => !usedPexelsIds.has(String(c.id)));
  if (!chosen) chosen = clips[0];           // last resort: allow dup

  if (!chosen?.clip_url) {
    console.warn(`[stock] no usable clip URL`);
    return null;
  }

  usedPexelsIds.add(String(chosen.id));

  // Download to local
  const ts = Date.now();
  const filename = `stock-pexels-ep${opts.episode_id || 'X'}-shot${opts.shot_id || 'X'}-${chosen.id}-${ts}.mp4`;
  const localPath = path.join(CINEMA_VIDEOS_DIR, filename);

  try {
    const resp = await axios.get(chosen.clip_url, {
      responseType: 'arraybuffer',
      timeout: 90000,
      maxContentLength: 100 * 1024 * 1024,
    });
    fs.writeFileSync(localPath, Buffer.from(resp.data));
  } catch (e: any) {
    console.warn(`[stock] download fail: ${e?.message}`);
    return null;
  }

  console.log(`[stock] ✅ Pexels ${chosen.id} (${chosen.duration_sec}s, ${chosen.width}x${chosen.height}) → ${path.basename(localPath)}`);

  // Log $0 cost (FREE!) — still track for analytics
  logCost({
    episode_id: opts.episode_id || null,
    shot_id: opts.shot_id || null,
    provider: 'seedance',                    // tracker doesn't have 'pexels' enum, log as 0-cost line
    operation: 'video_gen',
    duration_sec: chosen.duration_sec,
    units: 1,
    cost_cents: 0,
    notes: `pexels-stock-${chosen.id} FREE (${chosen.width}x${chosen.height})`,
  });

  return {
    ok: true,
    video_url: chosen.clip_url,
    local_path: localPath,
    duration_sec: chosen.duration_sec,
    cost_cents: 0,
    request_id: `pexels-${chosen.id}`,
  };
}

export function estimateStockCost(): number {
  return 0;        // always free
}

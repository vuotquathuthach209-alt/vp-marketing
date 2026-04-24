/**
 * Pexels provider — free stock video.
 *
 * API docs: https://www.pexels.com/api/documentation/#videos
 * Rate limit: 200 req/hour free tier. Register key: https://www.pexels.com/api/new/
 *
 * Env: PEXELS_API_KEY OR setting pexels_api_key
 */

import axios from 'axios';
import { db } from '../../../db';
import { getApiKey } from '../feature-flag';

export interface PexelsClip {
  id: string;                    // Pexels video ID
  clip_url: string;              // Direct MP4 URL
  thumbnail_url: string;
  duration_sec: number;
  width: number;
  height: number;
  photographer: string;
  photographer_url: string;
  license: string;               // "Pexels"
  tags: string[];
}

const API_BASE = 'https://api.pexels.com/videos';

/**
 * Search Pexels for videos matching query.
 *
 * @param query e.g. "vietnamese street food"
 * @param opts  orientation: 'portrait' for 9:16, 'landscape' for 16:9
 */
export async function searchPexels(
  query: string,
  opts: { orientation?: 'portrait' | 'landscape' | 'square'; perPage?: number; minDuration?: number; maxDuration?: number } = {},
): Promise<PexelsClip[]> {
  const key = getApiKey('pexels');
  if (!key) {
    console.warn('[vs-pexels] no API key configured (set PEXELS_API_KEY or setting pexels_api_key)');
    return [];
  }

  // Check cache first
  const cacheKey = `pexels:${query}:${opts.orientation || 'any'}`;
  const cached = getCachedClips(cacheKey, opts.perPage || 10);
  if (cached.length >= (opts.perPage || 5)) {
    console.log(`[vs-pexels] cache hit for "${query}" (${cached.length} clips)`);
    return cached;
  }

  try {
    const resp = await axios.get(`${API_BASE}/search`, {
      params: {
        query,
        orientation: opts.orientation || 'portrait',  // Default vertical for Reels
        size: 'medium',                                 // Prefer medium-quality (faster)
        per_page: Math.min(20, opts.perPage || 10),
      },
      headers: { Authorization: key },
      timeout: 15000,
    });

    const videos = resp.data?.videos || [];
    const clips: PexelsClip[] = [];

    for (const v of videos) {
      const duration = Number(v.duration) || 0;
      if (opts.minDuration && duration < opts.minDuration) continue;
      if (opts.maxDuration && duration > opts.maxDuration) continue;

      // Pick best quality file for our target resolution
      const files = v.video_files || [];
      // Prefer portrait 1080p or closest
      const targetHeight = opts.orientation === 'portrait' ? 1920 : 1080;
      files.sort((a: any, b: any) => Math.abs(a.height - targetHeight) - Math.abs(b.height - targetHeight));
      const chosen = files[0];
      if (!chosen?.link) continue;

      clips.push({
        id: String(v.id),
        clip_url: chosen.link,
        thumbnail_url: v.image || '',
        duration_sec: duration,
        width: chosen.width,
        height: chosen.height,
        photographer: v.user?.name || 'Unknown',
        photographer_url: v.user?.url || '',
        license: 'Pexels (free commercial)',
        tags: (v.tags || []).slice(0, 10),
      });
    }

    // Save to cache
    cacheClips(query, 'pexels', clips);

    console.log(`[vs-pexels] search "${query}" → ${clips.length} clips`);
    return clips;
  } catch (e: any) {
    console.warn(`[vs-pexels] search "${query}" err:`, e?.message);
    return [];
  }
}

// ═══════════════════════════════════════════════════════════
// Cache helpers
// ═══════════════════════════════════════════════════════════

function getCachedClips(cacheKey: string, limit: number): PexelsClip[] {
  try {
    const rows = db.prepare(`
      SELECT clip_id, clip_url, thumbnail_url, duration_sec, width, height,
        photographer, photographer_url, license, tags
      FROM video_stock_cache
      WHERE query = ? AND provider = 'pexels' AND cached_at > ?
      ORDER BY used_count ASC
      LIMIT ?
    `).all(cacheKey, Date.now() - 30 * 24 * 3600 * 1000, limit) as any[];

    return rows.map(r => ({
      id: r.clip_id,
      clip_url: r.clip_url,
      thumbnail_url: r.thumbnail_url || '',
      duration_sec: r.duration_sec,
      width: r.width,
      height: r.height,
      photographer: r.photographer || '',
      photographer_url: r.photographer_url || '',
      license: r.license || 'Pexels',
      tags: r.tags ? r.tags.split(',') : [],
    }));
  } catch { return []; }
}

function cacheClips(query: string, provider: string, clips: PexelsClip[]): void {
  const now = Date.now();
  for (const c of clips) {
    try {
      db.prepare(`
        INSERT OR IGNORE INTO video_stock_cache
          (query, provider, clip_id, clip_url, thumbnail_url, duration_sec,
           width, height, license, photographer, photographer_url, tags, cached_at, used_count)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
      `).run(
        query, provider, c.id, c.clip_url, c.thumbnail_url, c.duration_sec,
        c.width, c.height, c.license, c.photographer, c.photographer_url,
        c.tags.join(','), now,
      );
    } catch {}
  }
}

/**
 * Mark clip used (for load balancing — prefer less-used clips next time).
 */
export function markClipUsed(provider: string, clipId: string): void {
  try {
    db.prepare(`
      UPDATE video_stock_cache
      SET used_count = used_count + 1, last_used_at = ?
      WHERE provider = ? AND clip_id = ?
    `).run(Date.now(), provider, clipId);
  } catch {}
}

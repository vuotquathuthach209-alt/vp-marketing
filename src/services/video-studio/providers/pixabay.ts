/**
 * Pixabay provider — free stock video fallback khi Pexels không có clip.
 *
 * API: https://pixabay.com/api/docs/#api_videos
 * Free tier: 100 req/60s. Register: https://pixabay.com/api/docs/
 */

import axios from 'axios';
import { db } from '../../../db';
import { getApiKey } from '../feature-flag';

export interface PixabayClip {
  id: string;
  clip_url: string;
  thumbnail_url: string;
  duration_sec: number;
  width: number;
  height: number;
  photographer: string;
  license: string;
  tags: string[];
}

const API_BASE = 'https://pixabay.com/api/videos/';

export async function searchPixabay(
  query: string,
  opts: { orientation?: 'portrait' | 'landscape' | 'square'; perPage?: number } = {},
): Promise<PixabayClip[]> {
  const key = getApiKey('pixabay');
  if (!key) {
    console.warn('[vs-pixabay] no API key configured');
    return [];
  }

  // Cache check
  const cached = getCachedClips(query, opts.perPage || 10);
  if (cached.length >= (opts.perPage || 5)) {
    return cached;
  }

  try {
    const resp = await axios.get(API_BASE, {
      params: {
        key,
        q: query,
        video_type: 'film',                           // Only video clips, not animations
        orientation: opts.orientation || 'vertical',
        per_page: Math.min(20, opts.perPage || 10),
      },
      timeout: 15000,
    });

    const hits = resp.data?.hits || [];
    const clips: PixabayClip[] = [];

    for (const h of hits) {
      // Pixabay gives 4 sizes: large, medium, small, tiny
      const videos = h.videos || {};
      const chosen = videos.medium || videos.large || videos.small;
      if (!chosen?.url) continue;

      clips.push({
        id: String(h.id),
        clip_url: chosen.url,
        thumbnail_url: h.picture_id ? `https://i.vimeocdn.com/video/${h.picture_id}_640x360.jpg` : '',
        duration_sec: Number(h.duration) || 0,
        width: chosen.width || 1080,
        height: chosen.height || 1920,
        photographer: h.user || 'Unknown',
        license: 'Pixabay (free commercial)',
        tags: (h.tags || '').split(',').map((t: string) => t.trim()).slice(0, 10),
      });
    }

    cacheClips(query, 'pixabay', clips);
    return clips;
  } catch (e: any) {
    console.warn(`[vs-pixabay] search "${query}" err:`, e?.message);
    return [];
  }
}

function getCachedClips(query: string, limit: number): PixabayClip[] {
  try {
    const rows = db.prepare(`
      SELECT clip_id, clip_url, thumbnail_url, duration_sec, width, height,
        photographer, license, tags
      FROM video_stock_cache
      WHERE query = ? AND provider = 'pixabay' AND cached_at > ?
      ORDER BY used_count ASC
      LIMIT ?
    `).all(query, Date.now() - 30 * 24 * 3600 * 1000, limit) as any[];

    return rows.map(r => ({
      id: r.clip_id,
      clip_url: r.clip_url,
      thumbnail_url: r.thumbnail_url || '',
      duration_sec: r.duration_sec,
      width: r.width,
      height: r.height,
      photographer: r.photographer || '',
      license: r.license || 'Pixabay',
      tags: r.tags ? r.tags.split(',') : [],
    }));
  } catch { return []; }
}

function cacheClips(query: string, provider: string, clips: PixabayClip[]): void {
  const now = Date.now();
  for (const c of clips) {
    try {
      db.prepare(`
        INSERT OR IGNORE INTO video_stock_cache
          (query, provider, clip_id, clip_url, thumbnail_url, duration_sec,
           width, height, license, photographer, tags, cached_at, used_count)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
      `).run(
        query, provider, c.id, c.clip_url, c.thumbnail_url, c.duration_sec,
        c.width, c.height, c.license, c.photographer, c.tags.join(','), now,
      );
    } catch {}
  }
}

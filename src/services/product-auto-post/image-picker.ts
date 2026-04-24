/**
 * Image Picker — chọn ảnh chưa đăng cho hotel.
 *
 * Source: room_images table (đã sync từ OTA) hoặc scraped_data.images array.
 *
 * Dedup strategy (Phase 1 — simple):
 *   - URL hash → same URL = same image
 *   - History check: không dùng ảnh đã post trong 90 ngày
 *   - Blacklist check: không dùng ảnh trong image_blacklist
 *
 * Quality scoring:
 *   + Cover image flag (db) → +50
 *   + Resolution ≥ 1080px → +20
 *   + Has description/caption → +10
 *   + Random noise 0-20 → diversity
 *
 * Phase 2 (sau): dùng sharp/jimp để compute real perceptual hash,
 * filter low-res, detect text overlays, etc.
 */

import crypto from 'crypto';
import { db } from '../../db';

export interface ImageCandidate {
  url: string;
  fingerprint: string;
  room_type?: string;
  description?: string;
  is_cover?: boolean;
  score: number;
  source: 'room_images' | 'scraped_data' | 'cover';
}

const HISTORY_LOOKBACK_DAYS = 90;

/**
 * Simple URL-based fingerprint (MD5 hex 16 chars).
 * Phase 2: upgrade to perceptual hash.
 */
export function fingerprintUrl(url: string): string {
  // Normalize URL: strip query params (CDN variants), case-insensitive host
  try {
    const u = new URL(url);
    const normalized = `${u.protocol}//${u.hostname.toLowerCase()}${u.pathname}`;
    return crypto.createHash('md5').update(normalized).digest('hex').slice(0, 16);
  } catch {
    return crypto.createHash('md5').update(url).digest('hex').slice(0, 16);
  }
}

/**
 * Check if fingerprint already posted in last 90d or blacklisted.
 */
function isRecentlyUsed(fingerprint: string): boolean {
  const cutoff = new Date(Date.now() - HISTORY_LOOKBACK_DAYS * 24 * 3600_000)
    .toISOString().slice(0, 10);
  try {
    const history = db.prepare(
      `SELECT 1 FROM auto_post_history
       WHERE image_fingerprint = ? AND scheduled_date > ? LIMIT 1`
    ).get(fingerprint, cutoff);
    if (history) return true;

    const blacklist = db.prepare(
      `SELECT 1 FROM auto_post_image_blacklist WHERE fingerprint = ? LIMIT 1`
    ).get(fingerprint);
    return !!blacklist;
  } catch {
    return false;
  }
}

/**
 * Fetch images from OTA API live (hotel detail endpoint).
 * Caches in memory cho session (5min TTL).
 */
const OTA_IMAGE_CACHE = new Map<number, { at: number; images: ImageCandidate[] }>();
const CACHE_TTL_MS = 5 * 60_000;

async function fetchOtaImages(hotelId: number): Promise<ImageCandidate[]> {
  const cached = OTA_IMAGE_CACHE.get(hotelId);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return cached.images;
  }

  const images: ImageCandidate[] = [];
  try {
    const { listAllHotels } = require('../ota-api-client');
    const all = await listAllHotels({ maxPages: 5 });        // cap 250 hotels
    const detail = all.find((h: any) => String(h.id) === String(hotelId));
    if (!detail) {
      console.warn(`[image-picker] hotel ${hotelId} not found in OTA API response`);
      return [];
    }

    // Cover image
    if (detail.coverImage && typeof detail.coverImage === 'string') {
      images.push({
        url: detail.coverImage,
        fingerprint: fingerprintUrl(detail.coverImage),
        is_cover: true,
        score: 60,
        source: 'cover',
      });
    }

    // Images array
    if (Array.isArray(detail.images)) {
      for (const img of detail.images) {
        const url = typeof img === 'string' ? img : img?.url;
        if (!url) continue;
        images.push({
          url,
          fingerprint: fingerprintUrl(url),
          score: 35,
          source: 'scraped_data',
        });
      }
    }

    // Room photos
    if (Array.isArray(detail.rooms)) {
      for (const room of detail.rooms) {
        const photos = room?.photos || room?.images || [];
        if (!Array.isArray(photos)) continue;
        for (const url of photos) {
          if (typeof url !== 'string') continue;
          images.push({
            url,
            fingerprint: fingerprintUrl(url),
            room_type: room.name,
            score: 30,
            source: 'room_images',
          });
        }
      }
    }
  } catch (e: any) {
    console.warn(`[image-picker] OTA fetch fail for hotel=${hotelId}:`, e?.message);
  }

  // Dedup by fingerprint
  const seen = new Set<string>();
  const deduped = images.filter(img => {
    if (seen.has(img.fingerprint)) return false;
    seen.add(img.fingerprint);
    return true;
  });

  OTA_IMAGE_CACHE.set(hotelId, { at: Date.now(), images: deduped });
  return deduped;
}

/**
 * Fetch all images available cho 1 hotel — merge OTA API live + local DB.
 */
async function fetchAllImagesAsync(hotelId: number): Promise<ImageCandidate[]> {
  const seen = new Set<string>();
  const images: ImageCandidate[] = [];

  // Source 1: OTA API live (PREFERRED — luôn latest)
  const otaImages = await fetchOtaImages(hotelId);
  for (const img of otaImages) {
    if (!seen.has(img.fingerprint)) {
      images.push(img);
      seen.add(img.fingerprint);
    }
  }

  // Source 2: Local DB fallback — cover_image_url + scraped_data.images
  try {
    const hp = db.prepare(
      `SELECT scraped_data FROM hotel_profile WHERE hotel_id = ?`
    ).get(hotelId) as any;
    try {
      const sd = JSON.parse(hp?.scraped_data || '{}');
      const candidates: any[] = [
        ...(Array.isArray(sd?.images) ? sd.images : []),
        ...(Array.isArray(sd?.photos) ? sd.photos : []),
        sd?.coverImage,
        sd?.cover_image_url,
      ].filter(Boolean);
      for (const c of candidates) {
        const url = typeof c === 'string' ? c : c?.url;
        if (!url || !/^https?:\/\//.test(url)) continue;
        const fp = fingerprintUrl(url);
        if (seen.has(fp)) continue;
        images.push({ url, fingerprint: fp, score: 20, source: 'scraped_data' });
        seen.add(fp);
      }
    } catch {}
  } catch {}

  // Source 3: room_images table
  try {
    const rows = db.prepare(
      `SELECT image_url, room_type_name FROM room_images
       WHERE hotel_id = ? AND active = 1 ORDER BY display_order, id`
    ).all(hotelId) as any[];
    for (const r of rows) {
      if (!r.image_url) continue;
      const fp = fingerprintUrl(r.image_url);
      if (seen.has(fp)) continue;
      images.push({
        url: r.image_url,
        fingerprint: fp,
        room_type: r.room_type_name,
        score: 25,
        source: 'room_images',
      });
      seen.add(fp);
    }
  } catch {}

  return images;
}

/** Legacy sync version — cho picker scoring (image_count only, không need real URL) */
function fetchAllImages(hotelId: number): ImageCandidate[] {
  return [];     // picker chỉ dùng count từ different source
}

/**
 * Pick best image cho hotel — not recently used, not blacklisted, highest score.
 * v25: async để fetch OTA API live.
 */
export async function pickImage(hotelId: number): Promise<ImageCandidate | null> {
  const all = await fetchAllImagesAsync(hotelId);
  if (all.length === 0) return null;

  // Filter available
  const available = all.filter(img => !isRecentlyUsed(img.fingerprint));
  if (available.length === 0) {
    console.warn(`[image-picker] hotel=${hotelId} all ${all.length} images used in last 90d`);
    return null;
  }

  // Add random noise to diversify + sort by score
  available.forEach(img => { img.score += Math.random() * 20; });
  available.sort((a, b) => b.score - a.score);

  const picked = available[0];
  console.log(`[image-picker] hotel=${hotelId} picked ${picked.source} fp=${picked.fingerprint} from ${available.length}/${all.length} available`);
  return picked;
}

/** Get total image count aggregated từ all sources — cho picker score */
export async function getImageCountForHotel(hotelId: number): Promise<number> {
  const all = await fetchAllImagesAsync(hotelId);
  return all.length;
}

/**
 * Admin blacklist an image.
 */
export function blacklistImage(opts: {
  fingerprint?: string;
  url?: string;
  hotel_id?: number;
  reason: string;
  added_by: string;
}): boolean {
  try {
    const fp = opts.fingerprint || (opts.url ? fingerprintUrl(opts.url) : null);
    if (!fp) return false;
    db.prepare(
      `INSERT OR REPLACE INTO auto_post_image_blacklist
       (fingerprint, image_url, hotel_id, reason, added_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(fp, opts.url || null, opts.hotel_id || null, opts.reason, opts.added_by, Date.now());
    return true;
  } catch (e: any) {
    console.warn('[image-picker] blacklist fail:', e?.message);
    return false;
  }
}

/**
 * Admin: list blacklisted images.
 */
export function listBlacklist(): any[] {
  try {
    return db.prepare(
      `SELECT * FROM auto_post_image_blacklist ORDER BY created_at DESC LIMIT 100`
    ).all() as any[];
  } catch { return []; }
}

export function removeFromBlacklist(fingerprint: string): boolean {
  try {
    const r = db.prepare(`DELETE FROM auto_post_image_blacklist WHERE fingerprint = ?`).run(fingerprint);
    return r.changes > 0;
  } catch { return false; }
}

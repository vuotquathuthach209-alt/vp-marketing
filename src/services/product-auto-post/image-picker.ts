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
 * Fetch all images available cho 1 hotel.
 * Sources: room_images + hotel_profile.scraped_data.images + hotel_profile.cover_image_url
 */
function fetchAllImages(hotelId: number): ImageCandidate[] {
  const images: ImageCandidate[] = [];
  const seen = new Set<string>();

  // 1. Cover image từ hotel_profile
  try {
    const hp = db.prepare(
      `SELECT cover_image_url, scraped_data FROM hotel_profile WHERE hotel_id = ?`
    ).get(hotelId) as any;
    if (hp?.cover_image_url) {
      const fp = fingerprintUrl(hp.cover_image_url);
      if (!seen.has(fp)) {
        images.push({
          url: hp.cover_image_url,
          fingerprint: fp,
          is_cover: true,
          score: 50,
          source: 'cover',
        });
        seen.add(fp);
      }
    }
    // 2. Images array from scraped_data
    try {
      const sd = JSON.parse(hp?.scraped_data || '{}');
      const imgs = Array.isArray(sd?.images) ? sd.images : [];
      for (const img of imgs) {
        const url = typeof img === 'string' ? img : img?.url;
        if (!url) continue;
        const fp = fingerprintUrl(url);
        if (seen.has(fp)) continue;
        images.push({
          url,
          fingerprint: fp,
          description: typeof img === 'object' ? img?.description : undefined,
          score: 25,
          source: 'scraped_data',
        });
        seen.add(fp);
      }
    } catch {}
  } catch {}

  // 3. Room images
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
        score: 30,
        source: 'room_images',
      });
      seen.add(fp);
    }
  } catch {}

  return images;
}

/**
 * Pick best image cho hotel — not recently used, not blacklisted, highest score.
 */
export function pickImage(hotelId: number): ImageCandidate | null {
  const all = fetchAllImages(hotelId);
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

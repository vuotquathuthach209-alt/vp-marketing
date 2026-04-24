/**
 * Review Sync — nhận review data từ OTA qua webhook hoặc manual push.
 *
 * Use cases:
 *   - OTA admin submit review → POST /api/sync/webhook/reviews với HMAC
 *   - Batch pull: getReviewsFromOta() (future — khi OTA expose review API)
 *
 * Privacy:
 *   - Khi dùng cho marketing, mask name: "Nguyễn Văn A" → "Nguyễn A."
 *   - Stay date → "tháng 4/2026" (không ngày cụ thể)
 */

import crypto from 'crypto';
import { db } from '../../db';

export interface ReviewInput {
  review_ota_id: string;                   // Unique ID từ OTA
  hotel_id: number;                        // OTA hotel_id
  reviewer_name: string;
  reviewer_avatar_url?: string;
  rating: number;                          // 1.0 - 5.0
  review_text: string;
  review_highlights?: string[];            // Extracted features ["sạch", "vị trí"]
  language?: string;                       // 'vi' | 'en'
  verified?: boolean;
  stay_duration_nights?: number;
  stay_date?: string;                      // ISO 'YYYY-MM-DD' → converted to month/year
  source_channel?: string;                 // 'direct' | 'booking.com' | 'agoda'
  images?: string[];
}

/**
 * Upsert 1 review từ OTA.
 */
export function upsertReview(input: ReviewInput): 'created' | 'updated' | 'skipped' {
  if (!input.review_ota_id || !input.hotel_id || !input.review_text) return 'skipped';
  if (input.rating < 1 || input.rating > 5) return 'skipped';

  const existing = db.prepare(
    `SELECT id FROM hotel_reviews WHERE review_ota_id = ?`
  ).get(input.review_ota_id) as any;

  // Convert stay_date → "tháng 4/2026" format
  let stayMonthYear: string | null = null;
  if (input.stay_date) {
    try {
      const d = new Date(input.stay_date);
      if (!isNaN(d.getTime())) {
        stayMonthYear = `${d.getMonth() + 1}/${d.getFullYear()}`;
      }
    } catch {}
  }

  const now = Date.now();
  if (existing) {
    db.prepare(`
      UPDATE hotel_reviews SET
        reviewer_name = ?, reviewer_avatar_url = ?, rating = ?,
        review_text = ?, review_highlights = ?, language = ?,
        verified = ?, stay_duration_nights = ?, stay_month_year = ?,
        source_channel = ?, images_json = ?, synced_at = ?
      WHERE id = ?
    `).run(
      input.reviewer_name,
      input.reviewer_avatar_url || null,
      input.rating,
      input.review_text.slice(0, 5000),
      JSON.stringify(input.review_highlights || []),
      input.language || 'vi',
      input.verified ? 1 : 0,
      input.stay_duration_nights || null,
      stayMonthYear,
      input.source_channel || 'direct',
      JSON.stringify(input.images || []),
      now,
      existing.id,
    );
    return 'updated';
  }

  db.prepare(`
    INSERT INTO hotel_reviews (
      review_ota_id, hotel_id, reviewer_name, reviewer_avatar_url, rating,
      review_text, review_highlights, language, verified,
      stay_duration_nights, stay_month_year, source_channel, images_json,
      created_at, synced_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.review_ota_id,
    input.hotel_id,
    input.reviewer_name,
    input.reviewer_avatar_url || null,
    input.rating,
    input.review_text.slice(0, 5000),
    JSON.stringify(input.review_highlights || []),
    input.language || 'vi',
    input.verified ? 1 : 0,
    input.stay_duration_nights || null,
    stayMonthYear,
    input.source_channel || 'direct',
    JSON.stringify(input.images || []),
    now, now,
  );
  return 'created';
}

/**
 * Batch upsert từ webhook payload.
 */
export function upsertBatch(reviews: ReviewInput[]): { created: number; updated: number; skipped: number } {
  const result = { created: 0, updated: 0, skipped: 0 };
  for (const r of reviews) {
    const outcome = upsertReview(r);
    result[outcome]++;
  }
  console.log(`[review-sync] batch: ${result.created} created, ${result.updated} updated, ${result.skipped} skipped`);
  return result;
}

/**
 * Privacy mask: "Nguyễn Văn A" → "Nguyễn A."
 * Tách họ đầu + giữ chữ cái đầu tên.
 */
export function maskReviewerName(fullName: string): string {
  if (!fullName) return 'Khách';
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return 'Khách';
  if (parts.length === 1) {
    // Chỉ 1 từ: "Anna" → "Anna"
    return parts[0];
  }
  if (parts.length === 2) {
    // "Anna Smith" → "Anna S."
    return `${parts[0]} ${parts[1][0]}.`;
  }
  // VN: "Nguyễn Văn A" → "Nguyễn A."
  const lastName = parts[0];
  const firstInitial = parts[parts.length - 1][0];
  return `${lastName} ${firstInitial}.`;
}

/**
 * Pick review tốt nhất cho testimonial angle.
 * Filter: rating ≥ 4.0, verified, approved, text length ≥ 40 chars,
 *         không dùng trong 30 ngày qua.
 */
export function pickTestimonialReview(hotelId: number): {
  id: number;
  reviewer_name: string;
  masked_name: string;
  rating: number;
  text: string;
  stay_month_year: string | null;
  verified: boolean;
  source_channel: string;
} | null {
  const cooldown = Date.now() - 30 * 24 * 3600_000;

  const row = db.prepare(`
    SELECT id, reviewer_name, rating, review_text, stay_month_year,
           verified, source_channel
    FROM hotel_reviews
    WHERE hotel_id = ?
      AND rating >= 4.0
      AND approved_for_marketing = 1
      AND length(review_text) >= 40
      AND (last_used_at IS NULL OR last_used_at < ?)
    ORDER BY
      (rating * 10 + CASE WHEN verified = 1 THEN 5 ELSE 0 END) DESC,   -- priority: high rating + verified
      used_in_posts ASC,                                                  -- prefer less-used
      synced_at DESC
    LIMIT 1
  `).get(hotelId, cooldown) as any;

  if (!row) return null;

  return {
    id: row.id,
    reviewer_name: row.reviewer_name,
    masked_name: maskReviewerName(row.reviewer_name),
    rating: row.rating,
    text: row.review_text,
    stay_month_year: row.stay_month_year,
    verified: !!row.verified,
    source_channel: row.source_channel,
  };
}

/** Mark review đã dùng (update counter + last_used_at). */
export function markReviewUsed(reviewId: number): void {
  try {
    db.prepare(
      `UPDATE hotel_reviews SET used_in_posts = used_in_posts + 1, last_used_at = ? WHERE id = ?`
    ).run(Date.now(), reviewId);
  } catch {}
}

/** Admin: disable review khỏi marketing pool. */
export function disableReviewForMarketing(reviewId: number, reason: string): boolean {
  try {
    const r = db.prepare(
      `UPDATE hotel_reviews SET approved_for_marketing = 0 WHERE id = ?`
    ).run(reviewId);
    console.log(`[review-sync] disabled review #${reviewId}: ${reason}`);
    return r.changes > 0;
  } catch { return false; }
}

/** Admin stats. */
export function getReviewStats(hotelId?: number): {
  total: number;
  by_hotel: Array<{ hotel_id: number; total: number; avg_rating: number; usable: number }>;
} {
  const where = hotelId ? 'WHERE hotel_id = ?' : '';
  const params = hotelId ? [hotelId] : [];

  const total = (db.prepare(`SELECT COUNT(*) as n FROM hotel_reviews ${where}`).get(...params) as any).n;

  const byHotel = db.prepare(`
    SELECT hotel_id, COUNT(*) as total,
           AVG(rating) as avg_rating,
           SUM(CASE WHEN rating >= 4.0 AND approved_for_marketing = 1 THEN 1 ELSE 0 END) as usable
    FROM hotel_reviews ${where}
    GROUP BY hotel_id
    ORDER BY total DESC
  `).all(...params) as any[];

  return {
    total,
    by_hotel: byHotel.map(r => ({
      hotel_id: r.hotel_id,
      total: r.total,
      avg_rating: Math.round(r.avg_rating * 10) / 10,
      usable: r.usable,
    })),
  };
}

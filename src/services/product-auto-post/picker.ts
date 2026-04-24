/**
 * Product Post Picker — chọn hotel cho bài đăng hôm nay.
 *
 * Composite score (0-100):
 *   0.30 × rating_normalized   (rating vs network avg)
 *   0.20 × review_count_log    (log để tránh top-heavy)
 *   0.20 × freshness           (days since last posted, cap 30)
 *   0.15 × image_quality       (# HD images available)
 *   0.10 × availability_urgency (% rooms left < 30% → boost)
 *   0.05 × seasonal_match      (tháng hiện tại match property type)
 *
 * Luật loại (blacklist):
 *   - verified=1 AND rating < (network_avg - 0.5)  → anh/chị specified
 *   - review_count < 3                              → chưa đủ social proof
 *   - images.length < 3                             → thiếu visual
 *   - đã đăng trong 14 ngày qua                      → cooldown (anti-repeat)
 *   - status != 'active'                             → hotel tạm ngưng
 */

import { db } from '../../db';

export interface HotelCandidate {
  hotel_id: number;
  name: string;
  property_type: string;
  district?: string;
  rating?: number;
  review_count?: number;
  verified?: boolean;
  image_count: number;
  monthly_price_from?: number;
  min_nightly_price?: number;
  usp_top3?: string[];
  last_posted_days_ago?: number;       // Infinity if never
  score: number;
  score_breakdown: Record<string, number>;
  reject_reason?: string;
}

const COOLDOWN_DAYS = 14;
const MIN_REVIEWS = 3;
const MIN_IMAGES = 3;
const RATING_THRESHOLD_DELTA = 0.5;    // verified < (avg - 0.5) → loại

/**
 * Get network average rating (chỉ tính hotel có rating).
 */
function getNetworkAvgRating(): number {
  try {
    const row = db.prepare(
      `SELECT AVG(CAST(json_extract(scraped_data, '$.review_avg') AS REAL)) as avg
       FROM hotel_profile
       WHERE scraped_data IS NOT NULL
         AND json_extract(scraped_data, '$.review_avg') > 0`
    ).get() as any;
    return row?.avg || 4.0;             // fallback nếu chưa có data
  } catch {
    return 4.0;
  }
}

/**
 * Days since last auto-posted. Infinity if never.
 */
function getDaysSinceLastPost(hotelId: number): number {
  try {
    const row = db.prepare(
      `SELECT scheduled_date FROM auto_post_history
       WHERE hotel_id = ? AND status IN ('published', 'generated')
       ORDER BY scheduled_date DESC LIMIT 1`
    ).get(hotelId) as any;
    if (!row?.scheduled_date) return Infinity;
    const last = new Date(row.scheduled_date).getTime();
    return (Date.now() - last) / (24 * 3600_000);
  } catch {
    return Infinity;
  }
}

/**
 * Image count từ room_images + hotel_profile cover.
 */
function getImageCount(hotelId: number): number {
  try {
    const row = db.prepare(
      `SELECT COUNT(*) as n FROM room_images WHERE hotel_id = ? AND active = 1`
    ).get(hotelId) as any;
    return row?.n || 0;
  } catch {
    return 0;
  }
}

/**
 * Compute score + breakdown cho 1 hotel candidate.
 */
function scoreHotel(h: any, networkAvg: number): HotelCandidate {
  let score = 0;
  const breakdown: Record<string, number> = {};

  // 1. Rating normalized (vs network avg) — max 30 points
  const rating = h.review_avg || 0;
  const ratingNorm = Math.max(0, Math.min(1, (rating - 3.0) / 2.0));    // map 3-5 → 0-1
  breakdown.rating = ratingNorm * 30;
  score += breakdown.rating;

  // 2. Review count (log scale) — max 20 points
  const reviewCount = h.review_count || 0;
  const reviewLog = Math.min(1, Math.log10(reviewCount + 1) / Math.log10(101));   // log scale, 100 reviews = max
  breakdown.review_count = reviewLog * 20;
  score += breakdown.review_count;

  // 3. Freshness (days since posted, cap 30) — max 20 points
  const daysSince = h.last_posted_days_ago;
  const freshness = Math.min(1, daysSince / 30);
  breakdown.freshness = freshness * 20;
  score += breakdown.freshness;

  // 4. Image quality (count) — max 15 points
  const imgBonus = Math.min(1, h.image_count / 10);
  breakdown.images = imgBonus * 15;
  score += breakdown.images;

  // 5. Availability urgency (% rooms left) — max 10 points
  let urgency = 0;
  try {
    const avail = db.prepare(
      `SELECT AVG(CAST(available_rooms AS REAL) / NULLIF(total_rooms, 0)) as avg_pct
       FROM sync_availability WHERE hotel_id = ? AND date_str >= date('now')`
    ).get(h.hotel_id) as any;
    if (avail?.avg_pct && avail.avg_pct < 0.3) urgency = 1;      // < 30% left → boost
    else if (avail?.avg_pct && avail.avg_pct < 0.5) urgency = 0.5;
  } catch {}
  breakdown.availability = urgency * 10;
  score += breakdown.availability;

  // 6. Seasonal match — max 5 points
  const month = new Date().getMonth() + 1;
  let seasonal = 0;
  // Mùa hè (5-8): ưu tiên property type 'resort', 'villa', 'hotel' gần biển
  if (month >= 5 && month <= 8) {
    if (['resort', 'villa'].includes(h.property_type)) seasonal = 1;
    else if (h.property_type === 'hotel') seasonal = 0.5;
  }
  // Tết (1-2, 12): ưu tiên 'apartment' (long-stay), 'homestay' (gia đình)
  else if (month === 1 || month === 2 || month === 12) {
    if (['apartment', 'homestay'].includes(h.property_type)) seasonal = 1;
  }
  // Mùa mưa HCM (9-11): mọi loại OK, nhẹ ưu tiên apartment (có bếp)
  else if (month >= 9 && month <= 11) {
    if (h.property_type === 'apartment') seasonal = 0.5;
  }
  breakdown.seasonal = seasonal * 5;
  score += breakdown.seasonal;

  return {
    hotel_id: h.hotel_id,
    name: h.name_canonical,
    property_type: h.property_type,
    district: h.district,
    rating,
    review_count: reviewCount,
    verified: !!h.verified,
    image_count: h.image_count,
    monthly_price_from: h.monthly_price_from,
    min_nightly_price: h.min_nightly_price,
    usp_top3: h.usp_top3,
    last_posted_days_ago: daysSince,
    score: Math.round(score),
    score_breakdown: Object.fromEntries(
      Object.entries(breakdown).map(([k, v]) => [k, Math.round(v * 10) / 10])
    ),
  };
}

/**
 * Apply reject rules. Returns null if passes, reason string if rejected.
 */
function checkRejectRules(h: any, networkAvg: number): string | null {
  // 1. Verified + low rating → reject (anh/chị rule)
  if (h.verified && h.review_avg > 0 && h.review_avg < (networkAvg - RATING_THRESHOLD_DELTA)) {
    return `verified_low_rating:${h.review_avg.toFixed(1)}<${(networkAvg - RATING_THRESHOLD_DELTA).toFixed(1)}`;
  }
  // 2. Too few reviews
  if (h.review_count < MIN_REVIEWS) {
    return `too_few_reviews:${h.review_count}<${MIN_REVIEWS}`;
  }
  // 3. Not enough images
  if (h.image_count < MIN_IMAGES) {
    return `too_few_images:${h.image_count}<${MIN_IMAGES}`;
  }
  // 4. Cooldown
  if (h.last_posted_days_ago < COOLDOWN_DAYS) {
    return `cooldown:${Math.floor(h.last_posted_days_ago)}d<${COOLDOWN_DAYS}d`;
  }
  return null;
}

/**
 * Main picker — return list of eligible candidates sorted by score (desc).
 *
 * @param limit top N to return (default 5 for tie-breaker random)
 */
export function pickEligibleHotels(opts: { limit?: number; skipRejects?: boolean } = {}): HotelCandidate[] {
  const limit = opts.limit || 5;

  const networkAvg = getNetworkAvgRating();
  console.log(`[product-picker] network avg rating: ${networkAvg.toFixed(2)}`);

  // Fetch all active hotels — compute min_nightly_price từ room_catalog
  const rows = db.prepare(`
    SELECT hp.hotel_id, hp.name_canonical, hp.property_type, hp.district, hp.city,
           hp.monthly_price_from, hp.usp_top3 as usp_json,
           CAST(json_extract(hp.scraped_data, '$.review_avg') AS REAL) as review_avg,
           CAST(json_extract(hp.scraped_data, '$.review_count') AS INTEGER) as review_count,
           CAST(json_extract(hp.scraped_data, '$.is_verified') AS INTEGER) as verified,
           (SELECT MIN(price_weekday) FROM hotel_room_catalog WHERE hotel_id = hp.hotel_id AND price_weekday > 0) as min_nightly_price
    FROM hotel_profile hp
    WHERE EXISTS (
      SELECT 1 FROM mkt_hotels mh
      WHERE mh.ota_hotel_id = hp.hotel_id AND mh.status = 'active'
    )
  `).all() as any[];

  console.log(`[product-picker] active hotels in network: ${rows.length}`);

  const candidates: HotelCandidate[] = [];
  const rejected: HotelCandidate[] = [];

  for (const h of rows) {
    h.image_count = getImageCount(h.hotel_id);
    h.last_posted_days_ago = getDaysSinceLastPost(h.hotel_id);
    // Parse usp_json
    try { h.usp_top3 = JSON.parse(h.usp_json || '[]'); } catch { h.usp_top3 = []; }

    const reject = checkRejectRules(h, networkAvg);
    if (reject) {
      const c = scoreHotel(h, networkAvg);
      c.reject_reason = reject;
      rejected.push(c);
      continue;
    }

    candidates.push(scoreHotel(h, networkAvg));
  }

  candidates.sort((a, b) => b.score - a.score);
  console.log(`[product-picker] eligible: ${candidates.length} / rejected: ${rejected.length}`);

  return opts.skipRejects ? candidates.slice(0, limit) : candidates.slice(0, limit);
}

/**
 * Pick ONE hotel for today — tie-break random trong top 3.
 */
export function pickHotelForToday(): HotelCandidate | null {
  const top = pickEligibleHotels({ limit: 5 });
  if (top.length === 0) return null;

  // Tie-break: random trong top 3 (tránh deterministic)
  const poolSize = Math.min(3, top.length);
  const idx = Math.floor(Math.random() * poolSize);
  return top[idx];
}

/**
 * For admin dashboard — full list with scores + reasons.
 */
export function getAllHotelsScored(): { eligible: HotelCandidate[]; rejected: HotelCandidate[] } {
  const networkAvg = getNetworkAvgRating();
  const rows = db.prepare(`
    SELECT hp.hotel_id, hp.name_canonical, hp.property_type, hp.district, hp.city,
           hp.monthly_price_from, hp.usp_top3 as usp_json,
           CAST(json_extract(hp.scraped_data, '$.review_avg') AS REAL) as review_avg,
           CAST(json_extract(hp.scraped_data, '$.review_count') AS INTEGER) as review_count,
           CAST(json_extract(hp.scraped_data, '$.is_verified') AS INTEGER) as verified,
           (SELECT MIN(price_weekday) FROM hotel_room_catalog WHERE hotel_id = hp.hotel_id AND price_weekday > 0) as min_nightly_price
    FROM hotel_profile hp
    WHERE EXISTS (SELECT 1 FROM mkt_hotels mh WHERE mh.ota_hotel_id = hp.hotel_id AND mh.status = 'active')
  `).all() as any[];

  const eligible: HotelCandidate[] = [];
  const rejected: HotelCandidate[] = [];

  for (const h of rows) {
    h.image_count = getImageCount(h.hotel_id);
    h.last_posted_days_ago = getDaysSinceLastPost(h.hotel_id);
    try { h.usp_top3 = JSON.parse(h.usp_json || '[]'); } catch { h.usp_top3 = []; }

    const reject = checkRejectRules(h, networkAvg);
    const c = scoreHotel(h, networkAvg);
    if (reject) {
      c.reject_reason = reject;
      rejected.push(c);
    } else {
      eligible.push(c);
    }
  }

  eligible.sort((a, b) => b.score - a.score);
  rejected.sort((a, b) => b.score - a.score);
  return { eligible, rejected };
}

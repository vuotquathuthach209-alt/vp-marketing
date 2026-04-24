/**
 * Engagement Feedback Loop — v26 Phase B
 *
 * Sau khi bài product-auto-post đăng 24h/48h/7d:
 *   1. Fetch FB metrics (reactions, comments, shares, impressions)
 *   2. Compute engagement_score = reactions + comments*3 + shares*5
 *   3. Store vào auto_post_history.engagement_json
 *   4. Adjust picker score của hotel+angle combination:
 *      - High engagement → boost future picks (priority)
 *      - Low engagement → de-boost (cooldown longer)
 *
 * Learning horizon:
 *   - 24h: immediate read (~70% final engagement)
 *   - 48h: refine (~90% final)
 *   - 7d: final (100%)
 *
 * Effect on picker:
 *   score_multiplier = 0.5 + (normalized_engagement × 1.0)
 *   range: 0.5x (weak) to 1.5x (strong)
 *   applied lên composite score hiện tại.
 */

import { db } from '../../db';

interface EngagementData {
  post_id: number;
  fb_post_id: string;
  hotel_id: number;
  angle: string;
  impressions: number;
  reactions: number;
  comments: number;
  shares: number;
  clicks: number;
  engagement_score: number;
  engagement_rate: number;     // % reach
  captured_at: number;
}

/**
 * Compute engagement score — weighted combination.
 * Shares > Comments > Reactions (shares = strongest signal).
 */
function computeScore(reactions: number, comments: number, shares: number, clicks: number = 0): number {
  return reactions + (comments * 3) + (shares * 5) + (clicks * 2);
}

/**
 * Fetch latest metrics từ post_metrics table (populated by fb-metrics-puller cron).
 */
function fetchPostMetrics(postId: number): any | null {
  try {
    const row = db.prepare(
      `SELECT reactions, comments, shares, clicks, impressions, reach, engagement_rate, snapshot_at
       FROM post_metrics WHERE post_id = ? ORDER BY snapshot_at DESC LIMIT 1`
    ).get(postId) as any;
    return row;
  } catch {
    return null;
  }
}

/**
 * Cron job: scan recent auto-post history, fetch metrics, update engagement.
 */
export async function updateEngagementFeedback(): Promise<{
  scanned: number;
  updated: number;
  high_perform: Array<{ hotel_id: number; angle: string; score: number }>;
  low_perform: Array<{ hotel_id: number; angle: string; score: number }>;
}> {
  const result = {
    scanned: 0,
    updated: 0,
    high_perform: [] as any[],
    low_perform: [] as any[],
  };

  try {
    // Focus on posts đăng trong 7d qua (fresh enough để có metrics)
    const cutoff = Date.now() - 7 * 24 * 3600_000;
    const posts = db.prepare(
      `SELECT h.id as history_id, h.post_id, h.hotel_id, h.angle_used, h.published_at,
              p.fb_post_id
       FROM auto_post_history h
       LEFT JOIN posts p ON p.id = h.post_id
       WHERE h.status = 'published'
         AND h.post_id IS NOT NULL
         AND h.published_at > ?
       ORDER BY h.published_at DESC`
    ).all(cutoff) as any[];

    result.scanned = posts.length;

    for (const p of posts) {
      const metrics = fetchPostMetrics(p.post_id);
      if (!metrics) continue;

      const score = computeScore(
        metrics.reactions || 0,
        metrics.comments || 0,
        metrics.shares || 0,
        metrics.clicks || 0,
      );

      const data: EngagementData = {
        post_id: p.post_id,
        fb_post_id: p.fb_post_id,
        hotel_id: p.hotel_id,
        angle: p.angle_used,
        impressions: metrics.impressions || 0,
        reactions: metrics.reactions || 0,
        comments: metrics.comments || 0,
        shares: metrics.shares || 0,
        clicks: metrics.clicks || 0,
        engagement_score: score,
        engagement_rate: metrics.engagement_rate || 0,
        captured_at: Date.now(),
      };

      // Update auto_post_history với JSON
      db.prepare(
        `UPDATE auto_post_history SET engagement_json = ? WHERE id = ?`
      ).run(JSON.stringify(data), p.history_id);
      result.updated++;

      // Classify high / low
      if (score >= 50) {
        result.high_perform.push({ hotel_id: p.hotel_id, angle: p.angle_used, score });
      } else if (score < 5 && (Date.now() - p.published_at) > 48 * 3600_000) {
        // Chỉ low nếu >48h (đủ thời gian hấp thụ)
        result.low_perform.push({ hotel_id: p.hotel_id, angle: p.angle_used, score });
      }
    }

    if (result.updated > 0) {
      console.log(`[engagement] updated ${result.updated}/${result.scanned} posts. High perform: ${result.high_perform.length}, Low: ${result.low_perform.length}`);
    }
  } catch (e: any) {
    console.warn('[engagement] feedback fail:', e?.message);
  }

  return result;
}

/**
 * Get engagement-based multiplier cho hotel+angle combo.
 * Usage trong picker: final_score = base_score × multiplier.
 * Range: 0.5 (weak history) to 1.5 (strong history).
 *
 * Lookback 30 ngày — new hotels chưa có history → 1.0 (neutral).
 */
export function getEngagementMultiplier(hotelId: number, angle?: string): number {
  const cutoff = Date.now() - 30 * 24 * 3600_000;
  try {
    const where = angle
      ? `hotel_id = ? AND angle_used = ? AND engagement_json IS NOT NULL AND published_at > ?`
      : `hotel_id = ? AND engagement_json IS NOT NULL AND published_at > ?`;
    const params = angle ? [hotelId, angle, cutoff] : [hotelId, cutoff];

    const rows = db.prepare(
      `SELECT engagement_json FROM auto_post_history WHERE ${where}`
    ).all(...params) as any[];

    if (rows.length === 0) return 1.0;   // neutral — no data

    // Avg score
    let totalScore = 0, count = 0;
    for (const r of rows) {
      try {
        const d = JSON.parse(r.engagement_json);
        totalScore += d.engagement_score || 0;
        count++;
      } catch {}
    }
    if (count === 0) return 1.0;
    const avg = totalScore / count;

    // Normalize: 0 posts score → 0.5x multiplier, 100+ score → 1.5x multiplier
    // Formula: 0.5 + (min(avg, 100) / 100)
    const mult = 0.5 + Math.min(avg, 100) / 100;
    return Math.max(0.5, Math.min(1.5, mult));
  } catch {
    return 1.0;
  }
}

/**
 * Stats per hotel + per angle cho admin dashboard.
 */
export function getEngagementStats(lookbackDays: number = 30): {
  by_hotel: Array<{ hotel_id: number; posts: number; avg_score: number; best_angle: string }>;
  by_angle: Array<{ angle: string; posts: number; avg_score: number; avg_reactions: number; avg_comments: number }>;
  top_posts: Array<{ post_id: number; hotel_id: number; angle: string; score: number; fb_post_id: string }>;
} {
  const cutoff = Date.now() - lookbackDays * 24 * 3600_000;
  const rows = db.prepare(
    `SELECT h.post_id, h.hotel_id, h.angle_used, h.engagement_json, p.fb_post_id, hp.name_canonical
     FROM auto_post_history h
     LEFT JOIN posts p ON p.id = h.post_id
     LEFT JOIN hotel_profile hp ON hp.hotel_id = h.hotel_id
     WHERE h.status = 'published' AND h.engagement_json IS NOT NULL AND h.published_at > ?`
  ).all(cutoff) as any[];

  const parseEng = (row: any): any | null => {
    try { return JSON.parse(row.engagement_json); } catch { return null; }
  };

  // By hotel
  const byHotel = new Map<number, { posts: number; totalScore: number; angleScores: Record<string, number> }>();
  const byAngle = new Map<string, { posts: number; totalScore: number; totalReactions: number; totalComments: number }>();
  const allScored: Array<{ post_id: number; hotel_id: number; angle: string; score: number; fb_post_id: string }> = [];

  for (const r of rows) {
    const d = parseEng(r);
    if (!d) continue;

    const h = byHotel.get(r.hotel_id) || { posts: 0, totalScore: 0, angleScores: {} };
    h.posts++;
    h.totalScore += d.engagement_score;
    h.angleScores[r.angle_used] = (h.angleScores[r.angle_used] || 0) + d.engagement_score;
    byHotel.set(r.hotel_id, h);

    const a = byAngle.get(r.angle_used) || { posts: 0, totalScore: 0, totalReactions: 0, totalComments: 0 };
    a.posts++;
    a.totalScore += d.engagement_score;
    a.totalReactions += d.reactions;
    a.totalComments += d.comments;
    byAngle.set(r.angle_used, a);

    allScored.push({
      post_id: r.post_id,
      hotel_id: r.hotel_id,
      angle: r.angle_used,
      score: d.engagement_score,
      fb_post_id: r.fb_post_id,
    });
  }

  return {
    by_hotel: Array.from(byHotel.entries()).map(([hotel_id, v]) => ({
      hotel_id,
      posts: v.posts,
      avg_score: Math.round(v.totalScore / v.posts),
      best_angle: Object.entries(v.angleScores).sort((a, b) => b[1] - a[1])[0]?.[0] || '',
    })).sort((a, b) => b.avg_score - a.avg_score),
    by_angle: Array.from(byAngle.entries()).map(([angle, v]) => ({
      angle,
      posts: v.posts,
      avg_score: Math.round(v.totalScore / v.posts),
      avg_reactions: Math.round(v.totalReactions / v.posts),
      avg_comments: Math.round(v.totalComments / v.posts),
    })).sort((a, b) => b.avg_score - a.avg_score),
    top_posts: allScored.sort((a, b) => b.score - a.score).slice(0, 10),
  };
}

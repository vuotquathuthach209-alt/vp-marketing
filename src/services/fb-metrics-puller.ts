/**
 * Facebook Post Metrics Puller — v22.
 *
 * Hourly cron: pull insights cho posts published trong 7 ngày qua.
 * Updates post_metrics với snapshot.
 *
 * FB Graph API: GET /{post-id}?fields=reactions.summary(total_count),
 *                                      comments.summary(total_count),
 *                                      shares,insights.metric(post_impressions,post_reach,post_clicks)
 *
 * Analytics uses snapshot_at để track growth theo time.
 */

import axios from 'axios';
import { db } from '../db';
import { redactSecrets } from './text-utils';

const GRAPH = 'https://graph.facebook.com/v21.0';

export interface PostInsight {
  post_id: number;
  fb_post_id: string;
  reach: number;
  impressions: number;
  reactions: number;
  comments: number;
  shares: number;
  clicks: number;
  engagement_rate: number;
  snapshot_at: number;
}

async function fetchPostInsights(fbPostId: string, accessToken: string): Promise<Partial<PostInsight>> {
  // Fetch engagement counts + insights separately.
  // ⚠️ FIX 2026-05-20 (verified live on Graph v21): Meta KHAI TỬ các metric:
  //   ❌ post_impressions      → #100 invalid
  //   ❌ post_engaged_users    → #100 invalid
  //   ✅ post_impressions_unique (reach) → CÒN hoạt động
  // Trước đây request cả 3 trong 1 call → 2 cái invalid làm CẢ request fail #100
  //   → reach luôn = 0. Giờ chỉ request metric valid.

  let reactions = 0, comments = 0, shares = 0;
  let impressions = 0, reach = 0, clicks = 0;

  // Pass 1: engagement counts (cheap, always works on Page posts)
  try {
    const r = await axios.get(`${GRAPH}/${fbPostId}`, {
      params: {
        fields: 'reactions.summary(total_count),comments.summary(total_count),shares',
        access_token: accessToken,
      },
      timeout: 15_000,
    });
    const data = r.data || {};
    reactions = data.reactions?.summary?.total_count || 0;
    comments = data.comments?.summary?.total_count || 0;
    shares = data.shares?.count || 0;
  } catch (e: any) {
    const errMsg = e?.response?.data?.error?.message || e?.message || 'unknown';
    console.warn(`[fb-metrics] engagement ${fbPostId} fail:`, redactSecrets(errMsg).slice(0, 120));
    // If even engagement fails, the post is likely deleted/inaccessible — return empty
    return {};
  }

  // Pass 2: insights — CHỈ request metric còn valid (post_impressions_unique = reach).
  try {
    const r = await axios.get(`${GRAPH}/${fbPostId}/insights`, {
      params: {
        metric: 'post_impressions_unique',
        access_token: accessToken,
      },
      timeout: 15_000,
    });
    const metricsArr = r.data?.data || [];
    const findMetric = (name: string) => {
      const m = metricsArr.find((x: any) => x.name === name);
      return m?.values?.[0]?.value || 0;
    };
    reach = findMetric('post_impressions_unique');
    // post_impressions (total) đã bị Meta bỏ → dùng unique reach làm impressions luôn.
    impressions = reach;
    // post_engaged_users deprecated → clicks không lấy qua insights nữa (engagement
    // counts từ Pass 1 đã đủ: reactions/comments/shares). Để 0.
    clicks = 0;
  } catch (e: any) {
    // Insights endpoint may return 100 (deprecated metric) or 17 (rate limit).
    // Don't fail the whole record — engagement counts are still useful.
    const errMsg = e?.response?.data?.error?.message || e?.message || 'unknown';
    if (!errMsg.includes('rate')) {
      console.warn(`[fb-metrics] insights ${fbPostId} fail:`, redactSecrets(errMsg).slice(0, 120));
    }
  }

  const engagementScore = reactions + 3 * comments + 5 * shares;
  // If insights worked we have reach → ER vs reach. Otherwise fallback to ER vs impressions or
  // raw engagement count (Reach=0 dashboard will at least show reactions).
  const denom = reach || impressions || 0;
  const engagementRate = denom > 0 ? engagementScore / denom : 0;

  return {
    impressions,
    reach,
    reactions,
    comments,
    shares,
    clicks,
    engagement_rate: +engagementRate.toFixed(4),
  };
}

/** Main cron job: pull insights for all recent published posts. */
export async function pullFbMetricsBatch(): Promise<{ processed: number; updated: number; errors: number }> {
  const result = { processed: 0, updated: 0, errors: 0 };
  const since = Date.now() - 7 * 24 * 3600_000;   // Last 7 days

  // Get posts + remix_drafts published với fb_post_id
  const posts = db.prepare(
    `SELECT p.id as post_id, p.fb_post_id, p.page_id, pg.access_token
     FROM posts p
     JOIN pages pg ON pg.id = p.page_id
     WHERE p.fb_post_id IS NOT NULL
       AND p.published_at > ?
       AND p.status = 'published'
     ORDER BY p.published_at DESC
     LIMIT 50`
  ).all(since) as any[];

  // Also include remix_drafts (v14 CI auto-weekly)
  const remixes = db.prepare(
    `SELECT rd.id as post_id, rd.fb_post_id, p.access_token
     FROM remix_drafts rd
     JOIN mkt_hotels mh ON mh.id = rd.hotel_id
     JOIN pages p ON p.hotel_id = mh.id
     WHERE rd.fb_post_id IS NOT NULL
       AND rd.published_at > ?
       AND rd.status = 'published'
     ORDER BY rd.published_at DESC
     LIMIT 20`
  ).all(since) as any[];

  // ⚠️ FIX 2026-05-20: include V5T posts (kênh FB chính đang chạy).
  // Trước đây puller chỉ track `posts` + `remix_drafts` → bỏ sót toàn bộ v5t_posts
  // → metrics V5T không bao giờ được pull → dashboard hiện 0.
  const v5tPosts = db.prepare(
    `SELECT vp.id as post_id, vp.fb_post_id, pg.access_token
     FROM v5t_posts vp
     JOIN pages pg ON pg.id = 1
     WHERE vp.fb_post_id IS NOT NULL
       AND vp.posted_at > ?
       AND vp.status = 'posted'
     ORDER BY vp.posted_at DESC
     LIMIT 30`
  ).all(since) as any[];

  const allPosts = [
    ...posts,
    ...remixes.map(r => ({ ...r, is_remix: true })),
    ...v5tPosts.map(r => ({ ...r, is_v5t: true })),
  ];

  for (const post of allPosts) {
    if (!post.fb_post_id || !post.access_token) continue;
    result.processed++;

    const insights = await fetchPostInsights(post.fb_post_id, post.access_token);
    // Skip only when fetch completely failed (no fields populated at all).
    // Posts with 0 engagement are still valid snapshots — they prove the post got 0.
    const hasAnyField = insights.impressions !== undefined
                     || insights.reach !== undefined
                     || insights.reactions !== undefined
                     || insights.comments !== undefined;
    if (!hasAnyField) {
      result.errors++;
      continue;
    }

    // Insert snapshot
    try {
      db.prepare(
        `INSERT INTO post_metrics
         (post_id, fb_post_id, impressions, reach, reactions, comments, shares, clicks, engagement_rate, snapshot_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        post.post_id,
        post.fb_post_id,
        insights.impressions || 0,
        insights.reach || 0,
        insights.reactions || 0,
        insights.comments || 0,
        insights.shares || 0,
        insights.clicks || 0,
        insights.engagement_rate || 0,
        Date.now(),
      );
      result.updated++;
    } catch (e: any) {
      result.errors++;
      console.warn('[fb-metrics] insert fail:', redactSecrets(e?.message || ''));
    }

    // Throttle: 200ms giữa calls để không hit rate limit
    await new Promise(r => setTimeout(r, 200));
  }

  if (result.processed > 0) {
    console.log(`[fb-metrics] pulled: processed=${result.processed} updated=${result.updated} errors=${result.errors}`);
  }
  return result;
}

/** Return latest snapshot cho 1 post (for dashboard). */
export function getLatestMetrics(postId: number): PostInsight | null {
  const row = db.prepare(
    `SELECT * FROM post_metrics WHERE post_id = ? ORDER BY snapshot_at DESC LIMIT 1`
  ).get(postId) as any;
  return row || null;
}

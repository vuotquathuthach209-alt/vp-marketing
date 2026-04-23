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

const GRAPH = 'https://graph.facebook.com/v18.0';

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
  try {
    const r = await axios.get(`${GRAPH}/${fbPostId}`, {
      params: {
        fields: 'reactions.summary(total_count),comments.summary(total_count),shares,insights.metric(post_impressions,post_impressions_unique,post_clicks)',
        access_token: accessToken,
      },
      timeout: 15_000,
    });

    const data = r.data || {};
    const reactions = data.reactions?.summary?.total_count || 0;
    const comments = data.comments?.summary?.total_count || 0;
    const shares = data.shares?.count || 0;

    // Insights returned as array of metrics
    const metricsArr = data.insights?.data || [];
    const findMetric = (name: string) => {
      const m = metricsArr.find((x: any) => x.name === name);
      return m?.values?.[0]?.value || 0;
    };
    const impressions = findMetric('post_impressions');
    const reach = findMetric('post_impressions_unique');
    const clicks = findMetric('post_clicks');

    const engagementScore = reactions + 3 * comments + 5 * shares;
    const engagementRate = reach > 0 ? engagementScore / reach : 0;

    return {
      impressions,
      reach,
      reactions,
      comments,
      shares,
      clicks,
      engagement_rate: +engagementRate.toFixed(4),
    };
  } catch (e: any) {
    const errMsg = e?.response?.data?.error?.message || e?.message || 'unknown';
    console.warn(`[fb-metrics] fetch ${fbPostId} fail:`, redactSecrets(errMsg).slice(0, 120));
    return {};
  }
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

  const allPosts = [...posts, ...remixes.map(r => ({ ...r, is_remix: true }))];

  for (const post of allPosts) {
    if (!post.fb_post_id || !post.access_token) continue;
    result.processed++;

    const insights = await fetchPostInsights(post.fb_post_id, post.access_token);
    if (!insights.reach && !insights.reactions) {
      // Empty or error
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

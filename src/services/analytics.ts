import axios from 'axios';
import { db } from '../db';

const GRAPH = 'https://graph.facebook.com/v21.0';

interface PublishedPost {
  id: number;
  fb_post_id: string;
  page_id: number;
  page_fb_id: string;
  access_token: string;
}

/**
 * Pull FB insights cho những post published trong 7 ngày qua.
 * Gọi /{post_id}?fields=reactions.summary,comments.summary,shares + /{post_id}/insights
 * Lưu snapshot vào post_metrics.
 */
export async function pullMetrics(): Promise<{ ok: number; fail: number }> {
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const rows = db
    .prepare(
      `SELECT p.id, p.fb_post_id, p.page_id, pg.fb_page_id as page_fb_id, pg.access_token
       FROM posts p JOIN pages pg ON pg.id = p.page_id
       WHERE p.status = 'published'
         AND p.fb_post_id IS NOT NULL
         AND p.published_at >= ?
       ORDER BY p.published_at DESC
       LIMIT 100`
    )
    .all(cutoff) as PublishedPost[];

  let ok = 0;
  let fail = 0;

  for (const r of rows) {
    try {
      // Basic engagement
      const basic = await axios.get(`${GRAPH}/${r.fb_post_id}`, {
        params: {
          fields: 'reactions.summary(true).limit(0),comments.summary(true).limit(0),shares',
          access_token: r.access_token,
        },
        timeout: 15000,
      });
      const reactions = basic.data?.reactions?.summary?.total_count || 0;
      const comments = basic.data?.comments?.summary?.total_count || 0;
      const shares = basic.data?.shares?.count || 0;

      // Insights metrics (có thể thiếu tùy loại page/token scope)
      let impressions = 0;
      let reach = 0;
      let clicks = 0;
      try {
        const ins = await axios.get(`${GRAPH}/${r.fb_post_id}/insights`, {
          params: {
            metric: 'post_impressions,post_impressions_unique,post_clicks',
            access_token: r.access_token,
          },
          timeout: 15000,
        });
        const data: any[] = ins.data?.data || [];
        for (const m of data) {
          const val = m?.values?.[0]?.value || 0;
          if (m.name === 'post_impressions') impressions = val;
          if (m.name === 'post_impressions_unique') reach = val;
          if (m.name === 'post_clicks') clicks = val;
        }
      } catch (_e) {
        // Insights yêu cầu quyền pages_read_engagement, có thể thiếu — bỏ qua
      }

      const engagementTotal = reactions + comments + shares;
      const engagement_rate = reach > 0 ? engagementTotal / reach : 0;

      db.prepare(
        `INSERT INTO post_metrics
         (post_id, fb_post_id, impressions, reach, reactions, comments, shares, clicks, engagement_rate, snapshot_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        r.id,
        r.fb_post_id,
        impressions,
        reach,
        reactions,
        comments,
        shares,
        clicks,
        engagement_rate,
        Date.now()
      );

      ok++;
    } catch (e: any) {
      fail++;
      const msg = e?.response?.data?.error?.message || e?.message;
      console.warn(`[analytics] post #${r.id} fail: ${msg}`);
    }
  }

  return { ok, fail };
}

/**
 * Lấy metric mới nhất của từng post (dùng cho list UI).
 */
export function getLatestMetrics(limit = 50) {
  return db
    .prepare(
      `SELECT p.id as post_id, p.caption, p.published_at, p.fb_post_id, pg.name as page_name,
              m.impressions, m.reach, m.reactions, m.comments, m.shares, m.clicks, m.engagement_rate,
              m.snapshot_at
       FROM posts p
       JOIN pages pg ON pg.id = p.page_id
       LEFT JOIN post_metrics m ON m.id = (
         SELECT id FROM post_metrics WHERE post_id = p.id ORDER BY snapshot_at DESC LIMIT 1
       )
       WHERE p.status = 'published'
       ORDER BY p.published_at DESC
       LIMIT ?`
    )
    .all(limit);
}

/**
 * Tổng quan dashboard: tổng số post, tổng reach, avg engagement rate, top post.
 */
export function getOverview(days = 30) {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;

  const totals = db
    .prepare(
      `SELECT
         COUNT(DISTINCT p.id) as total_posts,
         COALESCE(SUM(m.reach), 0) as total_reach,
         COALESCE(SUM(m.reactions + m.comments + m.shares), 0) as total_engagement,
         COALESCE(AVG(m.engagement_rate), 0) as avg_engagement_rate
       FROM posts p
       LEFT JOIN post_metrics m ON m.id = (
         SELECT id FROM post_metrics WHERE post_id = p.id ORDER BY snapshot_at DESC LIMIT 1
       )
       WHERE p.status = 'published' AND p.published_at >= ?`
    )
    .get(cutoff) as Record<string, any>;

  const top = db
    .prepare(
      `SELECT p.id, p.caption, m.reach, m.reactions, m.comments, m.shares,
              (m.reactions + m.comments + m.shares) as engagement
       FROM posts p
       JOIN post_metrics m ON m.id = (
         SELECT id FROM post_metrics WHERE post_id = p.id ORDER BY snapshot_at DESC LIMIT 1
       )
       WHERE p.status = 'published' AND p.published_at >= ?
       ORDER BY engagement DESC
       LIMIT 5`
    )
    .all(cutoff);

  return { ...totals, top_posts: top, period_days: days };
}

/**
 * Best posting time: group metric snapshots theo giờ trong ngày và thứ trong tuần,
 * tính avg engagement score = (reactions + comments*2 + shares*3) / max(reach,1).
 * Trả về top slot (hour 0-23) và day (0=CN..6=T7) có engagement cao nhất.
 */
export function getBestPostingTime(days = 60) {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const rows = db
    .prepare(
      `SELECT p.published_at, m.reach, m.reactions, m.comments, m.shares
       FROM posts p
       JOIN post_metrics m ON m.id = (
         SELECT id FROM post_metrics WHERE post_id = p.id ORDER BY snapshot_at DESC LIMIT 1
       )
       WHERE p.status = 'published'
         AND p.published_at >= ?
         AND p.published_at IS NOT NULL`
    )
    .all(cutoff) as {
    published_at: number;
    reach: number;
    reactions: number;
    comments: number;
    shares: number;
  }[];

  const byHour: Record<number, { score: number; n: number }> = {};
  const byDow: Record<number, { score: number; n: number }> = {};
  for (let i = 0; i < 24; i++) byHour[i] = { score: 0, n: 0 };
  for (let i = 0; i < 7; i++) byDow[i] = { score: 0, n: 0 };

  for (const r of rows) {
    const d = new Date(r.published_at);
    const h = d.getHours();
    const dow = d.getDay();
    const engScore = (r.reactions + r.comments * 2 + r.shares * 3) / Math.max(r.reach, 1);
    byHour[h].score += engScore;
    byHour[h].n++;
    byDow[dow].score += engScore;
    byDow[dow].n++;
  }

  const hours = Object.entries(byHour).map(([h, v]) => ({
    hour: parseInt(h, 10),
    avg_score: v.n > 0 ? v.score / v.n : 0,
    samples: v.n,
  }));
  const dows = Object.entries(byDow).map(([d, v]) => ({
    dow: parseInt(d, 10),
    avg_score: v.n > 0 ? v.score / v.n : 0,
    samples: v.n,
  }));

  const bestHour = [...hours].sort((a, b) => b.avg_score - a.avg_score)[0];
  const bestDow = [...dows].sort((a, b) => b.avg_score - a.avg_score)[0];

  return {
    hours,
    dows,
    best_hour: bestHour,
    best_dow: bestDow,
    total_samples: rows.length,
    period_days: days,
  };
}

/**
 * KPI chi tiết: trend theo ngày (reach & engagement) trong N ngày gần nhất.
 */
export function getDailyTrend(days = 14) {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const rows = db
    .prepare(
      `SELECT p.published_at, m.reach, m.reactions, m.comments, m.shares
       FROM posts p
       JOIN post_metrics m ON m.id = (
         SELECT id FROM post_metrics WHERE post_id = p.id ORDER BY snapshot_at DESC LIMIT 1
       )
       WHERE p.status = 'published' AND p.published_at >= ?`
    )
    .all(cutoff) as any[];

  const byDay: Record<string, { reach: number; engagement: number; posts: number }> = {};
  for (const r of rows) {
    const d = new Date(r.published_at);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    if (!byDay[key]) byDay[key] = { reach: 0, engagement: 0, posts: 0 };
    byDay[key].reach += r.reach || 0;
    byDay[key].engagement += (r.reactions || 0) + (r.comments || 0) + (r.shares || 0);
    byDay[key].posts += 1;
  }

  return Object.entries(byDay)
    .map(([date, v]) => ({ date, ...v }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

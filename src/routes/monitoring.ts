import { Router } from 'express';
import { db } from '../db';
import { authMiddleware, AuthRequest, getHotelId, superadminOnly } from '../middleware/auth';
import { getAiCacheStats } from '../services/ai-cache';
import { getLearningStats, pruneLearned } from '../services/learning';

const router = Router();
router.use(authMiddleware);

/**
 * Phase 3 — Monitoring Dashboard
 * Track AI costs, response times, error rates, usage per hotel
 */

// GET /api/monitoring/overview — hotel-specific or global (admin)
router.get('/overview', (req: AuthRequest, res) => {
  const hotelId = getHotelId(req);
  const isAdmin = req.user?.admin && req.user?.role === 'superadmin';
  const days = parseInt(req.query.days as string) || 7;
  const since = Date.now() - days * 86400000;

  const whereHotel = isAdmin ? '' : 'AND hotel_id = ?';
  const params = isAdmin ? [since] : [since, hotelId];

  // AI usage stats
  const aiStats = db.prepare(`
    SELECT
      COUNT(*) as total_calls,
      SUM(CASE WHEN input_tokens > 0 THEN input_tokens + output_tokens ELSE 0 END) as total_tokens,
      ROUND(AVG(CASE WHEN input_tokens > 0 THEN input_tokens + output_tokens ELSE NULL END), 0) as avg_tokens,
      SUM(CASE WHEN cost_usd > 0 THEN cost_usd ELSE 0 END) as total_cost
    FROM ai_usage_log
    WHERE created_at > ? ${whereHotel}
  `).get(...params) as any;

  // Posts stats
  const postStats = db.prepare(`
    SELECT
      COUNT(*) as total_posts,
      SUM(CASE WHEN status = 'published' THEN 1 ELSE 0 END) as published,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed
    FROM posts
    WHERE created_at > ? ${whereHotel}
  `).get(...params) as any;

  // Auto-reply stats
  const replyStats = db.prepare(`
    SELECT
      COUNT(*) as total_replies,
      SUM(CASE WHEN type = 'message' THEN 1 ELSE 0 END) as message_replies,
      SUM(CASE WHEN type = 'comment' THEN 1 ELSE 0 END) as comment_replies
    FROM auto_reply_log
    WHERE created_at > ? ${whereHotel}
  `).get(...params) as any;

  // Active hotels count (admin only)
  const activeHotels = isAdmin
    ? (db.prepare(`SELECT COUNT(*) as n FROM mkt_hotels WHERE status = 'active'`).get() as any)?.n || 0
    : null;

  res.json({
    period_days: days,
    ai: {
      total_calls: aiStats?.total_calls || 0,
      total_tokens: aiStats?.total_tokens || 0,
      avg_tokens_per_call: aiStats?.avg_tokens || 0,
      estimated_cost_usd: Number((aiStats?.total_cost || 0).toFixed(4)),
    },
    posts: {
      total: postStats?.total_posts || 0,
      published: postStats?.published || 0,
      failed: postStats?.failed || 0,
      success_rate: postStats?.total_posts > 0
        ? Math.round((postStats.published / postStats.total_posts) * 100)
        : 0,
    },
    replies: {
      total: replyStats?.total_replies || 0,
      messages: replyStats?.message_replies || 0,
      comments: replyStats?.comment_replies || 0,
    },
    ...(activeHotels !== null ? { active_hotels: activeHotels } : {}),
    ai_cache: getAiCacheStats(),
  });
});

// GET /api/monitoring/ai-daily — AI usage breakdown by day
router.get('/ai-daily', (req: AuthRequest, res) => {
  const hotelId = getHotelId(req);
  const isAdmin = req.user?.admin && req.user?.role === 'superadmin';
  const days = parseInt(req.query.days as string) || 30;
  const since = Date.now() - days * 86400000;

  const whereHotel = isAdmin ? '' : 'AND hotel_id = ?';
  const params = isAdmin ? [since] : [since, hotelId];

  const rows = db.prepare(`
    SELECT
      DATE(created_at / 1000, 'unixepoch') as day,
      COUNT(*) as calls,
      SUM(COALESCE(input_tokens + output_tokens, 0)) as tokens,
      SUM(COALESCE(cost_usd, 0)) as cost
    FROM ai_usage_log
    WHERE created_at > ? ${whereHotel}
    GROUP BY day ORDER BY day DESC
  `).all(...params);

  res.json(rows);
});

// GET /api/monitoring/per-hotel — admin: breakdown per hotel
router.get('/per-hotel', superadminOnly, (req: AuthRequest, res) => {
  const days = parseInt(req.query.days as string) || 7;
  const since = Date.now() - days * 86400000;

  const rows = db.prepare(`
    SELECT
      h.id as hotel_id,
      h.name as hotel_name,
      h.plan,
      COUNT(DISTINCT a.id) as ai_calls,
      SUM(COALESCE(a.input_tokens + a.output_tokens, 0)) as total_tokens,
      SUM(COALESCE(a.cost_usd, 0)) as total_cost,
      (SELECT COUNT(*) FROM posts WHERE hotel_id = h.id AND created_at > ?) as posts_count,
      (SELECT COUNT(*) FROM auto_reply_log WHERE hotel_id = h.id AND created_at > ?) as replies_count
    FROM mkt_hotels h
    LEFT JOIN ai_usage_log a ON a.hotel_id = h.id AND a.created_at > ?
    WHERE h.status = 'active'
    GROUP BY h.id
    ORDER BY total_cost DESC
  `).all(since, since, since);

  res.json(rows);
});

// GET /api/monitoring/errors — recent errors
router.get('/errors', (req: AuthRequest, res) => {
  const hotelId = getHotelId(req);
  const isAdmin = req.user?.admin && req.user?.role === 'superadmin';
  const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);

  if (isAdmin) {
    const rows = db.prepare(`
      SELECT p.id, p.hotel_id, h.name as hotel_name, p.status, p.error, p.created_at
      FROM posts p LEFT JOIN mkt_hotels h ON h.id = p.hotel_id
      WHERE p.status = 'failed'
      ORDER BY p.id DESC LIMIT ?
    `).all(limit);
    res.json(rows);
  } else {
    const rows = db.prepare(`
      SELECT id, status, error, created_at
      FROM posts WHERE status = 'failed' AND hotel_id = ?
      ORDER BY id DESC LIMIT ?
    `).all(hotelId, limit);
    res.json(rows);
  }
});

// Learning loop — learned Q-A cache stats + manual prune
router.get('/learning', (req: AuthRequest, res) => {
  try {
    res.json(getLearningStats(getHotelId(req)));
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/learning/prune', (_req, res) => {
  try {
    const deleted = pruneLearned();
    res.json({ ok: true, deleted });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

export default router;

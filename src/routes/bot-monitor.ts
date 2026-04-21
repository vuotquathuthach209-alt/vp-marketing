/**
 * Bot Monitor — dashboard metrics để admin xem bot health realtime.
 *
 * Endpoints:
 *   GET /api/bot-monitor/overview      — KPIs last 24h/7d
 *   GET /api/bot-monitor/intents       — intent distribution
 *   GET /api/bot-monitor/latency       — p50/p95 latency per intent
 *   GET /api/bot-monitor/problems      — câu bot trả không tốt (signals)
 *   GET /api/bot-monitor/providers     — AI provider usage + errors
 */
import { Router } from 'express';
import { db } from '../db';
import { authMiddleware, AuthRequest, getHotelId } from '../middleware/auth';

const router = Router();
router.use(authMiddleware);

function getTimeRange(req: AuthRequest): { since: number; label: string } {
  const days = Math.min(30, Math.max(1, parseInt((req.query.days as string) || '7', 10)));
  return { since: Date.now() - days * 24 * 3600_000, label: `${days}d` };
}

// ═══════════════════════════════════════════════════════════
// OVERVIEW — KPIs cards
// ═══════════════════════════════════════════════════════════
router.get('/overview', (req: AuthRequest, res) => {
  try {
    const { since } = getTimeRange(req);
    const now = Date.now();
    const last24h = now - 24 * 3600_000;

    const sum = (sql: string, ...args: any[]): number =>
      (db.prepare(sql).get(...args) as any)?.n || 0;

    // Messages
    const totalMsgs = sum(`SELECT COUNT(*) as n FROM conversation_memory WHERE created_at >= ?`, since);
    const userMsgs = sum(`SELECT COUNT(*) as n FROM conversation_memory WHERE created_at >= ? AND role='user'`, since);
    const botMsgs = sum(`SELECT COUNT(*) as n FROM conversation_memory WHERE created_at >= ? AND role='bot'`, since);
    const uniqueUsers = sum(`SELECT COUNT(DISTINCT sender_id) as n FROM conversation_memory WHERE created_at >= ?`, since);

    // Recent activity (last 24h)
    const msgs24h = sum(`SELECT COUNT(*) as n FROM conversation_memory WHERE created_at >= ?`, last24h);

    // Cache hit rate (qa_cached)
    const cacheHits = sum(`SELECT COUNT(*) as n FROM conversation_memory WHERE created_at >= ? AND intent='qa_cached'`, since);
    const hitRate = botMsgs > 0 ? (cacheHits / botMsgs) : 0;

    // Phone captures
    const phones = sum(`SELECT COUNT(*) as n FROM customer_contacts WHERE created_at >= ?`, since);

    // Auto-replies
    const autoReplies = sum(`SELECT COUNT(*) as n FROM auto_reply_log WHERE created_at >= ? AND status='sent'`, since);
    const autoFailed = sum(`SELECT COUNT(*) as n FROM auto_reply_log WHERE created_at >= ? AND status!='sent' AND status!='blocked_spam'`, since);

    // AI cost
    const ai = db.prepare(
      `SELECT COUNT(*) as calls, COALESCE(SUM(cost_usd), 0) as cost,
              COALESCE(SUM(input_tokens + output_tokens), 0) as tokens
       FROM ai_usage_log WHERE created_at >= ?`
    ).get(since) as any;

    // Training + News
    const pending = sum(`SELECT COUNT(*) as n FROM qa_training_cache WHERE tier='pending'`);
    const approved = sum(`SELECT COUNT(*) as n FROM qa_training_cache WHERE tier IN ('approved', 'trusted')`);
    const newsDrafts = sum(`SELECT COUNT(*) as n FROM news_post_drafts WHERE status='pending'`);
    const newsPub7d = sum(`SELECT COUNT(*) as n FROM news_post_drafts WHERE status='published' AND published_at >= ?`, since);

    res.json({
      period_days: Math.round((now - since) / 86400_000),
      messages: {
        total: totalMsgs,
        user: userMsgs,
        bot: botMsgs,
        unique_users: uniqueUsers,
        last_24h: msgs24h,
      },
      cache: {
        hits: cacheHits,
        hit_rate: +hitRate.toFixed(3),
      },
      conversions: {
        phones: phones,
      },
      auto_reply: {
        sent: autoReplies,
        failed: autoFailed,
        success_rate: autoReplies + autoFailed > 0 ? +((autoReplies / (autoReplies + autoFailed))).toFixed(3) : 1,
      },
      ai_cost: {
        calls: ai?.calls || 0,
        tokens: ai?.tokens || 0,
        cost_usd: +(ai?.cost || 0).toFixed(4),
      },
      training: {
        pending: pending,
        approved_or_trusted: approved,
      },
      news: {
        pending: newsDrafts,
        published_last_period: newsPub7d,
      },
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════
// INTENT DISTRIBUTION
// ═══════════════════════════════════════════════════════════
router.get('/intents', (req: AuthRequest, res) => {
  try {
    const { since } = getTimeRange(req);
    const rows = db.prepare(
      `SELECT intent, COUNT(*) as n FROM conversation_memory
       WHERE role='bot' AND intent IS NOT NULL AND created_at >= ?
       GROUP BY intent ORDER BY n DESC`
    ).all(since);
    res.json({ intents: rows });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════
// PROBLEM DETECTION — câu bot trả không tốt
// ═══════════════════════════════════════════════════════════
router.get('/problems', (req: AuthRequest, res) => {
  try {
    const { since } = getTimeRange(req);
    // Signals of bad bot behavior:
    const problemIntents = [
      'negative_phone_request',    // fallback "chưa hiểu ý"
      'auto_handoff',              // bot gave up
      'bot_paused',
    ];

    const byIntent = db.prepare(
      `SELECT intent, COUNT(*) as n FROM conversation_memory
       WHERE role='bot' AND intent IN (${problemIntents.map(() => '?').join(',')})
         AND created_at >= ?
       GROUP BY intent ORDER BY n DESC`
    ).all(...problemIntents, since);

    // Recent examples of each
    const examples = db.prepare(
      `SELECT cm.sender_id, cm.intent, cm.message as bot_msg,
              (SELECT message FROM conversation_memory cm2
                WHERE cm2.sender_id = cm.sender_id AND cm2.role='user' AND cm2.id < cm.id
                ORDER BY cm2.id DESC LIMIT 1) as user_msg,
              cm.created_at
       FROM conversation_memory cm
       WHERE cm.role='bot' AND cm.intent IN (${problemIntents.map(() => '?').join(',')})
         AND cm.created_at >= ?
       ORDER BY cm.id DESC LIMIT 20`
    ).all(...problemIntents, since);

    // Users who asked same question multiple times (bot failed to answer)
    const repeaters = db.prepare(
      `SELECT sender_id, COUNT(DISTINCT message) as unique_msgs, COUNT(*) as total_msgs
       FROM conversation_memory
       WHERE role='user' AND created_at >= ?
       GROUP BY sender_id
       HAVING total_msgs >= 5 AND (unique_msgs * 1.0 / total_msgs) < 0.5
       ORDER BY total_msgs DESC LIMIT 10`
    ).all(since);

    res.json({
      problem_intents: byIntent,
      recent_examples: examples,
      confused_users: repeaters,   // khả năng bot trả lời không giải quyết
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════
// AI PROVIDER USAGE
// ═══════════════════════════════════════════════════════════
router.get('/providers', (req: AuthRequest, res) => {
  try {
    const { since } = getTimeRange(req);
    const rows = db.prepare(
      `SELECT provider, model, COUNT(*) as calls,
              SUM(CASE WHEN ok=0 THEN 1 ELSE 0 END) as failures,
              COALESCE(SUM(input_tokens), 0) as in_tok,
              COALESCE(SUM(output_tokens), 0) as out_tok,
              COALESCE(SUM(cost_usd), 0) as cost_usd
       FROM ai_usage_log WHERE created_at >= ?
       GROUP BY provider, model ORDER BY calls DESC`
    ).all(since);
    for (const r of rows as any[]) {
      r.cost_usd = +Number(r.cost_usd).toFixed(6);
    }
    res.json({ providers: rows });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════
// TIMELINE — messages per hour last 24h
// ═══════════════════════════════════════════════════════════
router.get('/timeline', (req: AuthRequest, res) => {
  try {
    const days = Math.min(7, Math.max(1, parseInt((req.query.days as string) || '1', 10)));
    const since = Date.now() - days * 24 * 3600_000;
    // Bucket per hour
    const rows = db.prepare(
      `SELECT CAST(created_at / (3600 * 1000) AS INTEGER) as hour_bucket,
              COUNT(*) as total,
              SUM(CASE WHEN role='user' THEN 1 ELSE 0 END) as user_msgs,
              SUM(CASE WHEN role='bot' THEN 1 ELSE 0 END) as bot_msgs
       FROM conversation_memory WHERE created_at >= ?
       GROUP BY hour_bucket ORDER BY hour_bucket DESC`
    ).all(since);
    res.json({ timeline: rows });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

export default router;

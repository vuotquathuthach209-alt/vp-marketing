/**
 * Feedback Loop Dashboard API — v13.
 * Cung cấp data để UI / admin xem bot đang tốt hay xấu.
 */

import { Router } from 'express';
import { db } from '../db';
import { authMiddleware, AuthRequest, getHotelId } from '../middleware/auth';
import { getOutcomeStats, getTopPerformingSources } from '../services/reply-outcome-logger';

const router = Router();
router.use(authMiddleware);

/** GET /feedback-loop/stats?days=7 — outcome distribution + funnel drop-off */
router.get('/stats', (req: AuthRequest, res) => {
  try {
    const hotelId = getHotelId(req);
    const days = Math.min(90, Math.max(1, parseInt(String(req.query.days || '7'), 10)));

    const outcome = getOutcomeStats(hotelId, days);
    const topSources = getTopPerformingSources(hotelId, days, 3);

    // Funnel: stage drop-off analysis — đếm unique senders qua each stage transition
    const since = Date.now() - days * 24 * 3600_000;
    const stageFlow = db.prepare(
      `SELECT to_stage as stage, COUNT(DISTINCT sender_id) as senders
       FROM funnel_stage_transitions
       WHERE hotel_id = ? AND created_at > ?
       GROUP BY to_stage
       ORDER BY senders DESC`
    ).all(hotelId, since) as any[];

    // Replies / outcomes timeline (daily buckets)
    const daily = db.prepare(
      `SELECT DATE(created_at/1000, 'unixepoch', '+7 hours') as date,
              COUNT(*) as replies,
              SUM(CASE WHEN outcome IN ('converted_to_lead', 'booked', 'closed_won') THEN 1 ELSE 0 END) as converted,
              SUM(CASE WHEN outcome = 'misunderstood' THEN 1 ELSE 0 END) as misunderstood,
              SUM(CASE WHEN outcome = 'ghosted' THEN 1 ELSE 0 END) as ghosted,
              SUM(CASE WHEN outcome = 'rage_quit' THEN 1 ELSE 0 END) as rage
       FROM bot_reply_outcomes
       WHERE hotel_id = ? AND created_at > ?
       GROUP BY date
       ORDER BY date DESC
       LIMIT ?`
    ).all(hotelId, since, days) as any[];

    // Bad replies (latest 10) — để admin review
    const badReplies = db.prepare(
      `SELECT id, sender_id, substr(user_message, 1, 100) as user_msg,
              substr(bot_reply, 1, 200) as bot_reply,
              intent, stage, reply_source, outcome, outcome_evidence, created_at
       FROM bot_reply_outcomes
       WHERE hotel_id = ? AND outcome IN ('misunderstood', 'rage_quit', 'ghosted')
         AND created_at > ?
       ORDER BY created_at DESC LIMIT 10`
    ).all(hotelId, since) as any[];

    res.json({
      period_days: days,
      outcome_distribution: outcome,
      top_performing_sources: topSources,
      funnel_stage_flow: stageFlow,
      daily_timeline: daily,
      recent_bad_replies: badReplies,
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

/** GET /feedback-loop/outcomes?outcome=misunderstood&limit=50 — list replies của 1 outcome */
router.get('/outcomes', (req: AuthRequest, res) => {
  try {
    const hotelId = getHotelId(req);
    const outcome = (req.query.outcome as string) || 'all';
    const limit = Math.min(200, Math.max(10, parseInt(String(req.query.limit || '50'), 10)));

    const where = outcome === 'all' ? '' : 'AND outcome = ?';
    const params: any[] = [hotelId];
    if (outcome !== 'all') params.push(outcome);
    params.push(limit);

    const rows = db.prepare(
      `SELECT id, sender_id, user_message, bot_reply, intent, stage, reply_source,
              outcome, outcome_evidence, latency_ms, created_at
       FROM bot_reply_outcomes
       WHERE hotel_id = ? ${where}
       ORDER BY created_at DESC LIMIT ?`
    ).all(...params) as any[];

    for (const r of rows) {
      try { r.outcome_evidence = r.outcome_evidence ? JSON.parse(r.outcome_evidence) : null; } catch {}
    }
    res.json({ items: rows, total: rows.length });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

/** POST /feedback-loop/label — admin gắn label 'good'/'bad'/'wrong_info' cho 1 reply */
router.post('/label', (req: AuthRequest, res) => {
  try {
    const hotelId = getHotelId(req);
    const { outcome_id, label, corrected_reply, notes } = req.body || {};
    if (!outcome_id || !label) {
      return res.status(400).json({ error: 'outcome_id + label required' });
    }
    if (!['good', 'bad', 'wrong_info', 'off_topic', 'needs_rewrite'].includes(label)) {
      return res.status(400).json({ error: 'invalid label' });
    }

    // Verify ownership
    const owns = db.prepare(
      `SELECT id FROM bot_reply_outcomes WHERE id = ? AND hotel_id = ?`
    ).get(outcome_id, hotelId);
    if (!owns) return res.status(404).json({ error: 'outcome not found' });

    const r = db.prepare(
      `INSERT INTO conversation_labels
       (hotel_id, outcome_id, label, corrected_reply, notes, labeled_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(hotelId, outcome_id, label, corrected_reply || null, notes || null, req.user?.userId || 0, Date.now());

    res.json({ ok: true, id: Number(r.lastInsertRowid) });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

/** GET /feedback-loop/labeled — xem labels đã gán */
router.get('/labeled', (req: AuthRequest, res) => {
  try {
    const hotelId = getHotelId(req);
    const rows = db.prepare(
      `SELECT cl.*, bro.user_message, bro.bot_reply, bro.reply_source, bro.outcome
       FROM conversation_labels cl
       LEFT JOIN bot_reply_outcomes bro ON bro.id = cl.outcome_id
       WHERE cl.hotel_id = ?
       ORDER BY cl.created_at DESC LIMIT 100`
    ).all(hotelId) as any[];
    res.json({ items: rows });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

/** GET /feedback-loop/health — quick sanity check */
router.get('/health', (req: AuthRequest, res) => {
  try {
    const hotelId = getHotelId(req);
    const since24h = Date.now() - 24 * 3600_000;
    const replies24h = db.prepare(
      `SELECT COUNT(*) as n FROM bot_reply_outcomes WHERE hotel_id = ? AND created_at > ?`
    ).get(hotelId, since24h) as any;
    const transitions24h = db.prepare(
      `SELECT COUNT(*) as n FROM funnel_stage_transitions WHERE hotel_id = ? AND created_at > ?`
    ).get(hotelId, since24h) as any;
    const pending = db.prepare(
      `SELECT COUNT(*) as n FROM bot_reply_outcomes WHERE hotel_id = ? AND outcome = 'pending'`
    ).get(hotelId) as any;

    res.json({
      hotel_id: hotelId,
      last_24h: {
        bot_replies_logged: replies24h.n,
        stage_transitions: transitions24h.n,
      },
      pending_classification: pending.n,
      feedback_loop_healthy: replies24h.n > 0 || transitions24h.n > 0,
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

export default router;

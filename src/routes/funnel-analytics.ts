/**
 * Funnel Analytics — admin dashboard cho FSM conversation stats.
 *
 * Endpoints (all authed):
 *   GET /stats         — summary (total, handoff, conv rate, stage breakdown)
 *   GET /funnel        — conversion funnel per stage (entered → exited → next)
 *   GET /bookings      — recent booking drafts
 *   GET /handoffs      — handed-off conversations (bot paused)
 *   POST /resume/:sid  — admin resume bot for sender
 *   GET /conversation/:sid — full conversation + state
 */

import { Router } from 'express';
import { db } from '../db';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { getFsmStats, resumeBot } from '../services/conversation-fsm';

const router = Router();
router.use(authMiddleware);

/** Summary stats */
router.get('/stats', (_req: AuthRequest, res) => {
  try {
    const stats = getFsmStats();
    res.json(stats);
  } catch (e: any) {
    res.status(500).json({ error: e?.message });
  }
});

/** Conversion funnel — entry/exit counts per stage */
router.get('/funnel', (_req: AuthRequest, res) => {
  try {
    // Stage order (theo FSM flow)
    const STAGE_ORDER = [
      'INIT', 'PROPERTY_TYPE_ASK',
      'DATES_ASK', 'MONTHS_ASK',
      'GUESTS_ASK', 'BUDGET_ASK', 'AREA_ASK',
      'CHDV_EXTRAS_ASK', 'CHDV_STARTDATE_ASK',
      'SHOW_RESULTS', 'PROPERTY_PICKED', 'SHOW_ROOMS',
      'CONFIRMATION_BEFORE_CLOSE', 'CLOSING_CONTACT',
      'BOOKING_DRAFT_CREATED',
      'UNCLEAR_FALLBACK', 'HANDED_OFF',
    ];

    // Count conversations that REACHED each stage (last_bot_stage chain counted)
    // For simplicity: count unique senders currently at each stage OR past it
    // Approach: count total convs ≥ each stage in order of flow
    const total = (db.prepare(`SELECT COUNT(*) as n FROM bot_conversation_state`).get() as any).n;

    const stagesWithCounts = STAGE_ORDER.map((stage, idx) => {
      // "reached" = stage_index current >= idx, i.e., current stage is later than or equal to this one
      // Use simple approach: count where stage = this stage
      const currentCount = (db.prepare(`SELECT COUNT(*) as n FROM bot_conversation_state WHERE stage = ?`).get(stage) as any).n;
      // "Reached" = currentCount + all who moved past
      const reachedCount = stage === 'INIT' ? total : STAGE_ORDER.slice(idx).map(s =>
        (db.prepare(`SELECT COUNT(*) as n FROM bot_conversation_state WHERE stage = ?`).get(s) as any).n
      ).reduce((a, b) => a + b, 0);

      return {
        stage,
        current: currentCount,
        reached: reachedCount,
        conversion_rate: total > 0 ? Math.round((reachedCount / total) * 1000) / 10 : 0,
      };
    });

    res.json({ total_conversations: total, funnel: stagesWithCounts });
  } catch (e: any) {
    res.status(500).json({ error: e?.message });
  }
});

/** Recent booking drafts */
router.get('/bookings', (req: AuthRequest, res) => {
  try {
    const limit = Math.min(200, parseInt((req.query.limit as string) || '50', 10));
    const status = (req.query.status as string) || '';
    let sql = `SELECT * FROM bot_booking_drafts`;
    const params: any[] = [];
    if (status) { sql += ` WHERE status = ?`; params.push(status); }
    sql += ` ORDER BY created_at DESC LIMIT ?`;
    params.push(limit);
    const rows = db.prepare(sql).all(...params);
    res.json({ items: rows });
  } catch (e: any) {
    res.status(500).json({ error: e?.message });
  }
});

/** Update booking status (admin sau khi gọi xác nhận) */
router.put('/bookings/:id', (req: AuthRequest, res) => {
  try {
    const id = parseInt(String(req.params.id), 10);
    const { status, notes } = req.body || {};
    const valid = ['new', 'contacted', 'confirmed', 'paid', 'cancelled', 'no_response'];
    if (status && !valid.includes(status)) {
      return res.status(400).json({ error: `status must be: ${valid.join(', ')}` });
    }
    db.prepare(`UPDATE bot_booking_drafts SET status = COALESCE(?, status) WHERE id = ?`)
      .run(status || null, id);
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e?.message });
  }
});

/** Handed-off conversations */
router.get('/handoffs', (_req: AuthRequest, res) => {
  try {
    const rows = db.prepare(
      `SELECT sender_id, hotel_id, stage, slots, turn_count, last_user_msg, updated_at
       FROM bot_conversation_state
       WHERE handed_off = 1 OR stage = 'UNCLEAR_FALLBACK' OR stage = 'HANDED_OFF'
       ORDER BY updated_at DESC LIMIT 100`
    ).all() as any[];
    for (const r of rows) { try { r.slots = JSON.parse(r.slots); } catch {} }
    res.json({ items: rows });
  } catch (e: any) {
    res.status(500).json({ error: e?.message });
  }
});

/** Admin resume bot cho sender bị handed-off */
router.post('/resume/:sid', (req: AuthRequest, res) => {
  try {
    const sid = String(req.params.sid);
    resumeBot(sid);
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e?.message });
  }
});

/** Admin force-takeover (pause bot) */
router.post('/takeover/:sid', (req: AuthRequest, res) => {
  try {
    const sid = String(req.params.sid);
    const { takeoverConversation } = require('../services/funnel-dispatcher');
    const ok = takeoverConversation(sid);
    res.json({ ok });
  } catch (e: any) {
    res.status(500).json({ error: e?.message });
  }
});

/** Get single conversation with state + messages */
router.get('/conversation/:sid', (req: AuthRequest, res) => {
  try {
    const sid = String(req.params.sid);
    const state = db.prepare(`SELECT * FROM bot_conversation_state WHERE sender_id = ?`).get(sid) as any;
    if (state) { try { state.slots = JSON.parse(state.slots); } catch {} }
    const messages = db.prepare(
      `SELECT role, message, intent, created_at FROM conversation_memory
       WHERE sender_id = ? ORDER BY id ASC LIMIT 100`
    ).all(sid);
    const booking = db.prepare(
      `SELECT * FROM bot_booking_drafts WHERE sender_id = ? ORDER BY created_at DESC LIMIT 1`
    ).get(sid);
    res.json({ state, messages, booking });
  } catch (e: any) {
    res.status(500).json({ error: e?.message });
  }
});

/** Per-day breakdown for last 30 days */
router.get('/daily', (_req: AuthRequest, res) => {
  try {
    const sql = `
      SELECT
        date(created_at / 1000, 'unixepoch', 'localtime') as day,
        COUNT(*) as total_started,
        SUM(CASE WHEN stage = 'BOOKING_DRAFT_CREATED' THEN 1 ELSE 0 END) as bookings,
        SUM(CASE WHEN handed_off = 1 OR stage = 'HANDED_OFF' THEN 1 ELSE 0 END) as handoffs
      FROM bot_conversation_state
      WHERE created_at > ?
      GROUP BY day
      ORDER BY day DESC
      LIMIT 30
    `;
    const cutoff = Date.now() - 30 * 24 * 3600 * 1000;
    const rows = db.prepare(sql).all(cutoff);
    res.json({ items: rows });
  } catch (e: any) {
    res.status(500).json({ error: e?.message });
  }
});

/** Feature flag status */
router.get('/feature-flag', (_req: AuthRequest, res) => {
  res.json({
    USE_NEW_FUNNEL: process.env.USE_NEW_FUNNEL === 'true' || process.env.USE_NEW_FUNNEL === '1',
    env_value: process.env.USE_NEW_FUNNEL || '(unset)',
  });
});

export default router;

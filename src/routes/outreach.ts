/**
 * Proactive Outreach admin routes.
 */

import { Router } from 'express';
import { db } from '../db';
import { authMiddleware, AuthRequest, getHotelId } from '../middleware/auth';
import {
  scanAndQueueOutreach, sendQueuedOutreach, OUTREACH_TRIGGERS,
} from '../services/proactive-outreach';

const router = Router();
router.use(authMiddleware);

/** List triggers supported */
router.get('/triggers', (_req: AuthRequest, res) => {
  try {
    res.json({
      items: OUTREACH_TRIGGERS.map(t => ({ type: t.type, description: t.description })),
    });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

/** Trigger scan manually → queue new outreach */
router.post('/scan', (req: AuthRequest, res) => {
  try {
    const hotelId = getHotelId(req);
    const results = scanAndQueueOutreach(hotelId);
    res.json({
      total_queued: results.reduce((s, r) => s + r.queued, 0),
      by_trigger: results,
    });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

/** Trigger send queued */
router.post('/send-queued', async (req: AuthRequest, res) => {
  try {
    const dryRun = req.query.dry_run === '1' || req.body?.dry_run === true;
    const limit = parseInt(String(req.query.limit || req.body?.limit || '20'), 10);
    const result = await sendQueuedOutreach({ dryRun, limit });
    res.json(result);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

/** List queued/sent outreach */
router.get('/list', (req: AuthRequest, res) => {
  try {
    const hotelId = getHotelId(req);
    const status = req.query.status as string | undefined;
    const limit = Math.min(500, parseInt(String(req.query.limit || '100'), 10));
    const where = status ? 'AND status = ?' : '';
    const params: any[] = [hotelId];
    if (status) params.push(status);
    params.push(limit);

    const rows = db.prepare(
      `SELECT id, trigger_type, sender_id, customer_phone, customer_name,
              channel, template_key, substr(message_content, 1, 100) as preview,
              status, scheduled_at, sent_at, replied_at, converted_at, error, created_at
       FROM scheduled_outreach
       WHERE hotel_id = ? ${where}
       ORDER BY id DESC LIMIT ?`
    ).all(...params) as any[];

    const stats = db.prepare(
      `SELECT status, COUNT(*) as n FROM scheduled_outreach WHERE hotel_id = ? GROUP BY status`
    ).all(hotelId) as any[];

    res.json({
      items: rows,
      stats: Object.fromEntries(stats.map((s: any) => [s.status, s.n])),
    });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

/** Detail 1 outreach row — v23: tenant-scoped */
router.get('/:id', (req: AuthRequest, res) => {
  try {
    const hotelId = getHotelId(req);
    const id = parseInt(String(req.params.id), 10);
    if (isNaN(id) || id <= 0) return res.status(400).json({ error: 'invalid id' });
    const row = db.prepare(
      `SELECT * FROM scheduled_outreach WHERE id = ? AND hotel_id = ?`
    ).get(id, hotelId) as any;
    if (!row) return res.status(404).json({ error: 'not found' });
    try { row.context_json = JSON.parse(row.context_json || '{}'); } catch {}
    res.json(row);
  } catch (e: any) {
    console.error('[outreach] detail fail:', e);
    res.status(500).json({ error: 'internal error' });
  }
});

/** v23: tenant-scoped cancel */
router.post('/:id/cancel', (req: AuthRequest, res) => {
  try {
    const hotelId = getHotelId(req);
    const id = parseInt(String(req.params.id), 10);
    if (isNaN(id) || id <= 0) return res.status(400).json({ error: 'invalid id' });
    const r = db.prepare(
      `UPDATE scheduled_outreach
       SET status = 'skipped', error = 'admin_cancel'
       WHERE id = ? AND hotel_id = ? AND status = 'queued'`
    ).run(id, hotelId);
    res.json({ ok: true, cancelled: r.changes > 0 });
  } catch (e: any) {
    console.error('[outreach] cancel fail:', e);
    res.status(500).json({ error: 'internal error' });
  }
});

/** Performance metrics */
router.get('/stats/summary', (req: AuthRequest, res) => {
  try {
    const hotelId = getHotelId(req);
    const days = Math.min(90, parseInt(String(req.query.days || '30'), 10));
    const since = Date.now() - days * 24 * 3600_000;

    const byTrigger = db.prepare(
      `SELECT trigger_type,
              COUNT(*) as total,
              SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END) as sent,
              SUM(CASE WHEN status = 'replied' THEN 1 ELSE 0 END) as replied,
              SUM(CASE WHEN status = 'converted' THEN 1 ELSE 0 END) as converted,
              SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed
       FROM scheduled_outreach
       WHERE hotel_id = ? AND created_at > ?
       GROUP BY trigger_type
       ORDER BY total DESC`
    ).all(hotelId, since) as any[];

    byTrigger.forEach((t: any) => {
      t.reply_rate = t.sent > 0 ? +(t.replied / t.sent).toFixed(3) : 0;
      t.conversion_rate = t.sent > 0 ? +(t.converted / t.sent).toFixed(3) : 0;
    });

    res.json({
      period_days: days,
      by_trigger: byTrigger,
      total: byTrigger.reduce((s: number, t: any) => s + t.total, 0),
      total_converted: byTrigger.reduce((s: number, t: any) => s + t.converted, 0),
    });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

export default router;

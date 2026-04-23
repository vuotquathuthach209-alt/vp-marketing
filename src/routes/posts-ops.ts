/**
 * Posts Ops — admin routes for metrics + DLQ.
 * v22
 */

import { Router } from 'express';
import { db } from '../db';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { pullFbMetricsBatch, getLatestMetrics } from '../services/fb-metrics-puller';
import { getDlqItems, resolveDlqItem, scanAndMoveFailures } from '../services/posts-dlq';

const router = Router();
router.use(authMiddleware);

/* ═══════ METRICS ═══════ */

/** Manual trigger pull metrics batch */
router.post('/metrics/pull', async (_req: AuthRequest, res) => {
  try {
    res.json(await pullFbMetricsBatch());
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

/** Latest metrics for a post */
router.get('/metrics/post/:id', (req: AuthRequest, res) => {
  try {
    const id = parseInt(String(req.params.id), 10);
    const m = getLatestMetrics(id);
    res.json(m || { message: 'no metrics yet' });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

/** Time series — all snapshots for a post */
router.get('/metrics/post/:id/series', (req: AuthRequest, res) => {
  try {
    const id = parseInt(String(req.params.id), 10);
    const rows = db.prepare(
      `SELECT snapshot_at, impressions, reach, reactions, comments, shares, clicks, engagement_rate
       FROM post_metrics WHERE post_id = ? ORDER BY snapshot_at ASC LIMIT 200`
    ).all(id) as any[];
    res.json({ items: rows });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

/* ═══════ DEAD LETTER QUEUE ═══════ */

router.get('/dlq', (_req: AuthRequest, res) => {
  try {
    res.json({ items: getDlqItems(100) });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.get('/dlq/:id', (req: AuthRequest, res) => {
  try {
    const id = parseInt(String(req.params.id), 10);
    const row = db.prepare(`SELECT * FROM failed_posts_dlq WHERE id = ?`).get(id);
    if (!row) return res.status(404).json({ error: 'not found' });
    res.json(row);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.post('/dlq/:id/resolve', (req: AuthRequest, res) => {
  try {
    const id = parseInt(String(req.params.id), 10);
    const { note } = req.body || {};
    const ok = resolveDlqItem(id, note || 'admin manual');
    res.json({ ok });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.post('/dlq/scan', (_req: AuthRequest, res) => {
  try {
    res.json(scanAndMoveFailures());
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

export default router;

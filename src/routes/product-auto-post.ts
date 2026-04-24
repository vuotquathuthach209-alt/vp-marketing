/**
 * Admin routes for v25 Product-First Auto Post.
 *
 * Endpoints:
 *   GET  /api/auto-post/plan            — upcoming 7-day plan
 *   POST /api/auto-post/generate        — manual trigger generate for today
 *   POST /api/auto-post/publish         — manual trigger publish today's plan
 *   PATCH /api/auto-post/plan/:id       — edit caption/image/hotel before publish
 *   POST /api/auto-post/plan/:id/skip   — skip today (manual override)
 *   GET  /api/auto-post/history         — last 30 posts
 *   GET  /api/auto-post/candidates      — preview eligible hotels + scores
 *   GET  /api/auto-post/blacklist       — list blacklisted images
 *   POST /api/auto-post/blacklist       — blacklist 1 image
 *   DELETE /api/auto-post/blacklist/:fp — un-blacklist
 */

import { Router } from 'express';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { db } from '../db';

const router = Router();
router.use(authMiddleware);

/** GET upcoming plan */
router.get('/plan', (req: AuthRequest, res) => {
  try {
    const { getUpcomingPlan } = require('../services/product-auto-post/orchestrator');
    const days = Math.min(30, Math.max(1, parseInt(String(req.query.days || '7'), 10)));
    res.json({ items: getUpcomingPlan(days), days });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

/** POST generate (manual trigger) */
router.post('/generate', async (_req: AuthRequest, res) => {
  try {
    const { generateTodayPlan } = require('../services/product-auto-post/orchestrator');
    const result = await generateTodayPlan();
    res.json(result);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

/** POST publish (manual trigger) */
router.post('/publish', async (_req: AuthRequest, res) => {
  try {
    const { publishTodayPlan } = require('../services/product-auto-post/orchestrator');
    const result = await publishTodayPlan();
    res.json(result);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

/** PATCH edit plan (admin can change caption/hotel before 9h publish) */
router.patch('/plan/:id', (req: AuthRequest, res) => {
  try {
    const id = parseInt(String(req.params.id), 10);
    if (isNaN(id)) return res.status(400).json({ error: 'invalid id' });
    const { caption_draft, hotel_id, image_url, angle, admin_note } = req.body || {};

    const sets: string[] = ['updated_at = ?'];
    const vals: any[] = [Date.now()];
    if (caption_draft !== undefined) { sets.push('caption_draft = ?'); vals.push(caption_draft); }
    if (hotel_id !== undefined) { sets.push('hotel_id = ?'); vals.push(parseInt(hotel_id, 10)); }
    if (image_url !== undefined) { sets.push('image_url = ?'); vals.push(image_url); }
    if (angle !== undefined) { sets.push('angle = ?'); vals.push(angle); }
    if (admin_note !== undefined) { sets.push('admin_note = ?'); vals.push(admin_note); }
    vals.push(id);

    db.prepare(`UPDATE auto_post_plan SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
    const updated = db.prepare(`SELECT * FROM auto_post_plan WHERE id = ?`).get(id);
    res.json(updated);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

/** POST skip today */
router.post('/plan/:id/skip', (req: AuthRequest, res) => {
  try {
    const { skipPlan } = require('../services/product-auto-post/orchestrator');
    const id = parseInt(String(req.params.id), 10);
    const { note } = req.body || {};
    const ok = skipPlan(id, note || 'admin_skip');
    res.json({ ok });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

/** GET history */
router.get('/history', (req: AuthRequest, res) => {
  try {
    const { getHistory } = require('../services/product-auto-post/orchestrator');
    const limit = Math.min(200, Math.max(1, parseInt(String(req.query.limit || '30'), 10)));
    res.json({ items: getHistory(limit) });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

/** GET candidates — preview scoring + rejection for ALL hotels */
router.get('/candidates', (_req: AuthRequest, res) => {
  try {
    const { getAllHotelsScored } = require('../services/product-auto-post/picker');
    res.json(getAllHotelsScored());
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

/** GET blacklist */
router.get('/blacklist', (_req: AuthRequest, res) => {
  try {
    const { listBlacklist } = require('../services/product-auto-post/image-picker');
    res.json({ items: listBlacklist() });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

/** POST blacklist — add image to blacklist */
router.post('/blacklist', (req: AuthRequest, res) => {
  try {
    const { blacklistImage, fingerprintUrl } = require('../services/product-auto-post/image-picker');
    const { url, fingerprint, hotel_id, reason } = req.body || {};
    if (!url && !fingerprint) return res.status(400).json({ error: 'url or fingerprint required' });
    const ok = blacklistImage({
      url,
      fingerprint: fingerprint || (url ? fingerprintUrl(url) : undefined),
      hotel_id,
      reason: reason || 'manual_admin',
      added_by: String(req.user?.email || 'admin'),
    });
    res.json({ ok });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

/** DELETE blacklist */
router.delete('/blacklist/:fp', (req: AuthRequest, res) => {
  try {
    const { removeFromBlacklist } = require('../services/product-auto-post/image-picker');
    const ok = removeFromBlacklist(String(req.params.fp));
    res.json({ ok });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

/* ═══════════════════════════════════════════
   v26 Phase A: Vector endpoints
   ═══════════════════════════════════════════ */

/** POST /api/auto-post/vectorize — manual trigger vectorize all */
router.post('/vectorize', async (_req: AuthRequest, res) => {
  try {
    const { vectorizeAllActiveHotels } = require('../services/product-auto-post/hotel-vectorizer');
    const r = await vectorizeAllActiveHotels();
    res.json(r);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

/** GET /api/auto-post/semantic-search?q=... — natural language hotel search */
router.get('/semantic-search', async (req: AuthRequest, res) => {
  try {
    const q = String(req.query.q || '').trim();
    if (!q) return res.status(400).json({ error: 'missing q' });
    const { semanticSearchHotels } = require('../services/product-auto-post/hotel-vectorizer');
    const results = await semanticSearchHotels(q, 10);
    res.json({ query: q, results });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

/** GET /api/auto-post/similar/:hotelId — find N similar hotels by vector */
router.get('/similar/:hotelId', async (req: AuthRequest, res) => {
  try {
    const id = parseInt(String(req.params.hotelId), 10);
    const { findSimilarHotels, getDistinctiveAspects } = require('../services/product-auto-post/hotel-vectorizer');
    const similar = await findSimilarHotels(id, 5);
    const distinctive = await getDistinctiveAspects(id);
    res.json({ hotel_id: id, similar, distinctive });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

/* ═══════════════════════════════════════════
   v26 Phase B: Engagement feedback endpoints
   ═══════════════════════════════════════════ */

/** POST /api/auto-post/engagement/refresh — manual trigger update engagement */
router.post('/engagement/refresh', async (_req: AuthRequest, res) => {
  try {
    const { updateEngagementFeedback } = require('../services/product-auto-post/engagement-feedback');
    const r = await updateEngagementFeedback();
    res.json(r);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

/** GET /api/auto-post/engagement/stats?days=30 — dashboard stats */
router.get('/engagement/stats', (req: AuthRequest, res) => {
  try {
    const { getEngagementStats } = require('../services/product-auto-post/engagement-feedback');
    const days = Math.min(90, Math.max(1, parseInt(String(req.query.days || '30'), 10)));
    res.json(getEngagementStats(days));
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

export default router;

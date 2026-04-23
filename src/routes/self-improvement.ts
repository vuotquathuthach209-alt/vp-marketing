/**
 * Self-Improvement admin routes.
 * - /templates CRUD + seed
 * - /experiments manage
 * - /winner-select trigger
 * - /report weekly
 * - /lessons manage
 */

import { Router } from 'express';
import { db } from '../db';
import { authMiddleware, AuthRequest, getHotelId } from '../middleware/auth';
import { seedReplyTemplates } from '../services/reply-template-seed';
import { getActiveVariants, pickVariant, recordImpression } from '../services/reply-variant-selector';
import { selectWinnerForExperiment, selectAllWinners } from '../services/winner-selector';
import { generateWeeklyReport, formatReportForTelegram, sendWeeklyPerformanceReport } from '../services/weekly-performance-report';
import { extractLessonsFromLabels, getLessonsForContext, formatLessonsForPrompt } from '../services/prompt-lessons';

const router = Router();
router.use(authMiddleware);

/* ═══════════════════════════════════════════
   TEMPLATES
   ═══════════════════════════════════════════ */

router.post('/templates/seed', (_req: AuthRequest, res) => {
  try {
    res.json(seedReplyTemplates());
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.get('/templates', (req: AuthRequest, res) => {
  try {
    const hotelId = getHotelId(req);
    const key = req.query.template_key as string | undefined;
    const where = key ? 'AND template_key = ?' : '';
    const params: any[] = [hotelId];
    if (key) params.push(key);
    const rows = db.prepare(
      `SELECT id, template_key, variant_name, content, weight, active, is_winner,
              impressions, conversions, misunderstood, ghosted, converted_to_lead, booked,
              ROUND(CASE WHEN impressions > 0 THEN conversions * 1.0 / impressions ELSE 0 END, 4) as conversion_rate
       FROM reply_templates
       WHERE (hotel_id = ? OR hotel_id = 0) ${where}
       ORDER BY template_key, is_winner DESC, variant_name`
    ).all(...params) as any[];
    res.json({ items: rows });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.post('/templates', (req: AuthRequest, res) => {
  try {
    const hotelId = getHotelId(req);
    const b = req.body || {};
    if (!b.template_key || !b.variant_name || !b.content) {
      return res.status(400).json({ error: 'template_key + variant_name + content required' });
    }
    const now = Date.now();
    const r = db.prepare(
      `INSERT INTO reply_templates
       (hotel_id, template_key, variant_name, content, weight, active, is_winner,
        impressions, conversions, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, 0, 0, 0, ?, ?)`
    ).run(b.global ? 0 : hotelId, b.template_key, b.variant_name, b.content, b.weight || 100, now, now);
    res.json({ ok: true, id: Number(r.lastInsertRowid) });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.put('/templates/:id', (req: AuthRequest, res) => {
  try {
    const id = parseInt(String(req.params.id), 10);
    const { content, weight, active } = req.body || {};
    db.prepare(
      `UPDATE reply_templates SET
         content = COALESCE(?, content),
         weight = COALESCE(?, weight),
         active = COALESCE(?, active),
         updated_at = ?
       WHERE id = ?`
    ).run(content, weight, active !== undefined ? (active ? 1 : 0) : null, Date.now(), id);
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.delete('/templates/:id', (req: AuthRequest, res) => {
  try {
    const id = parseInt(String(req.params.id), 10);
    const r = db.prepare(`DELETE FROM reply_templates WHERE id = ?`).run(id);
    res.json({ ok: true, deleted: r.changes });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.get('/templates/preview/:template_key', (req: AuthRequest, res) => {
  try {
    const hotelId = getHotelId(req);
    const key = String(req.params.template_key);
    const senderId = (req.query.sender_id as string) || `preview_${Date.now()}`;
    const variant = pickVariant(senderId, hotelId, key);
    res.json({ variant, sender_id: senderId });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

/* ═══════════════════════════════════════════
   EXPERIMENTS + WINNER SELECTION
   ═══════════════════════════════════════════ */

router.get('/experiments', (req: AuthRequest, res) => {
  try {
    const hotelId = getHotelId(req);
    const rows = db.prepare(
      `SELECT re.*, rt.variant_name as winner_name
       FROM reply_experiments re
       LEFT JOIN reply_templates rt ON rt.id = re.winner_variant_id
       WHERE (re.hotel_id = ? OR re.hotel_id = 0)
       ORDER BY re.status = 'running' DESC, re.id DESC`
    ).all(hotelId) as any[];
    res.json({ items: rows });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.post('/experiments/:id/select-winner', (req: AuthRequest, res) => {
  try {
    const id = parseInt(String(req.params.id), 10);
    const result = selectWinnerForExperiment(id);
    res.json(result);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.post('/experiments/select-all-winners', (_req: AuthRequest, res) => {
  try {
    const results = selectAllWinners();
    res.json({ total: results.length, results });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

/* ═══════════════════════════════════════════
   WEEKLY REPORT
   ═══════════════════════════════════════════ */

router.get('/report/weekly', (req: AuthRequest, res) => {
  try {
    const hotelId = getHotelId(req);
    const report = generateWeeklyReport(hotelId);
    const formatted = formatReportForTelegram(report);
    res.json({ report, formatted });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.post('/report/send-weekly', async (req: AuthRequest, res) => {
  try {
    const hotelId = getHotelId(req);
    await sendWeeklyPerformanceReport(hotelId);
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

/* ═══════════════════════════════════════════
   PROMPT LESSONS
   ═══════════════════════════════════════════ */

router.post('/lessons/extract', (_req: AuthRequest, res) => {
  try {
    res.json(extractLessonsFromLabels());
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.get('/lessons', (req: AuthRequest, res) => {
  try {
    const hotelId = getHotelId(req);
    const context = (req.query.context as string) || undefined;
    const rows = context
      ? getLessonsForContext(context, hotelId, 20)
      : db.prepare(
          `SELECT id, lesson_type, context, description, injected_count, active
           FROM prompt_lessons
           WHERE (hotel_id = ? OR hotel_id = 0) AND active = 1
           ORDER BY id DESC LIMIT 100`
        ).all(hotelId);
    res.json({ items: rows });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.put('/lessons/:id', (req: AuthRequest, res) => {
  try {
    const id = parseInt(String(req.params.id), 10);
    const { active } = req.body || {};
    db.prepare(`UPDATE prompt_lessons SET active = ?, updated_at = ? WHERE id = ?`)
      .run(active ? 1 : 0, Date.now(), id);
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.get('/lessons/preview/:context', (req: AuthRequest, res) => {
  try {
    const hotelId = getHotelId(req);
    const context = String(req.params.context);
    const lessons = getLessonsForContext(context, hotelId, 5);
    const formatted = formatLessonsForPrompt(lessons);
    res.json({ context, lessons, formatted_prompt_block: formatted });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

export default router;

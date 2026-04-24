/**
 * Agentic Templates Admin API — v27
 *
 * CRUD cho `agentic_templates`:
 *   GET    /api/agentic-templates             — list all
 *   GET    /api/agentic-templates/:id         — get one
 *   POST   /api/agentic-templates             — create
 *   PUT    /api/agentic-templates/:id         — update (lưu history row)
 *   DELETE /api/agentic-templates/:id         — deactivate (soft delete)
 *   POST   /api/agentic-templates/:id/reset   — reset về default từ seeder
 *   POST   /api/agentic-templates/:id/preview — preview render với ctx mock
 *   GET    /api/agentic-templates/:id/history — version history
 *
 * Admin-only (superadmin + hotel_admin cho templates của hotel đó).
 */

import { Router } from 'express';
import { authMiddleware, superadminOnly, AuthRequest } from '../middleware/auth';
import { db } from '../db';
import { invalidateCache, renderString, listAllTemplates, loadTemplates } from '../services/agentic/template-engine';
import { DEFAULT_TEMPLATES, seedTemplates } from '../services/agentic/template-seeder';

const router = Router();
router.use(authMiddleware);

/**
 * GET /api/agentic-templates
 * List all templates (admin view — include inactive).
 */
router.get('/', (_req, res) => {
  try {
    const rows = listAllTemplates(true);
    res.json({ success: true, data: rows, count: rows.length });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e?.message });
  }
});

/**
 * GET /api/agentic-templates/categories
 * Summary by category.
 */
router.get('/categories', (_req, res) => {
  try {
    const rows = db.prepare(`
      SELECT category, COUNT(*) as total, SUM(active) as active_count, SUM(hits) as total_hits, SUM(conversions) as total_conversions
      FROM agentic_templates
      GROUP BY category
      ORDER BY category
    `).all();
    res.json({ success: true, data: rows });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e?.message });
  }
});

/**
 * GET /api/agentic-templates/:id
 */
router.get('/:id', (req, res) => {
  try {
    const row = db.prepare(`SELECT * FROM agentic_templates WHERE id = ?`).get(req.params.id);
    if (!row) return res.status(404).json({ success: false, error: 'Template not found' });
    const parsed: any = {
      ...(row as any),
      trigger_conditions: (row as any).trigger_conditions ? JSON.parse((row as any).trigger_conditions) : null,
      quick_replies: (row as any).quick_replies ? JSON.parse((row as any).quick_replies) : null,
    };
    res.json({ success: true, data: parsed });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e?.message });
  }
});

/**
 * POST /api/agentic-templates
 * Create new (custom) template.
 * Body: { id, category, description?, content, trigger_conditions?, quick_replies?, confidence?, hotel_id? }
 */
router.post('/', superadminOnly, (req: AuthRequest, res) => {
  try {
    const { id, category, description, content, trigger_conditions, quick_replies, confidence, hotel_id } = req.body || {};
    if (!id || !category || !content) {
      return res.status(400).json({ success: false, error: 'id, category, content là bắt buộc' });
    }

    const existing = db.prepare(`SELECT id FROM agentic_templates WHERE id = ?`).get(id);
    if (existing) return res.status(409).json({ success: false, error: 'Template ID đã tồn tại' });

    const now = Date.now();
    db.prepare(`
      INSERT INTO agentic_templates
        (id, category, description, trigger_conditions, content, quick_replies, confidence, active, hotel_id, version, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, 1, ?, ?)
    `).run(
      id,
      category,
      description || '',
      trigger_conditions ? JSON.stringify(trigger_conditions) : null,
      content,
      quick_replies ? JSON.stringify(quick_replies) : null,
      Number(confidence) || 0.9,
      Number(hotel_id) || 0,
      now, now,
    );

    invalidateCache();
    res.json({ success: true, id });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e?.message });
  }
});

/**
 * PUT /api/agentic-templates/:id
 * Update existing. Lưu snapshot vào agentic_templates_history trước.
 */
router.put('/:id', superadminOnly, (req: AuthRequest, res) => {
  try {
    const id = req.params.id;
    const cur = db.prepare(`SELECT * FROM agentic_templates WHERE id = ?`).get(id) as any;
    if (!cur) return res.status(404).json({ success: false, error: 'Template not found' });

    // Save history snapshot
    db.prepare(`
      INSERT INTO agentic_templates_history
        (template_id, version, content, trigger_conditions, quick_replies, changed_by, changed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      cur.version,
      cur.content,
      cur.trigger_conditions,
      cur.quick_replies,
      req.user?.email || 'admin',
      Date.now(),
    );

    const { category, description, content, trigger_conditions, quick_replies, confidence, active } = req.body || {};
    const now = Date.now();
    db.prepare(`
      UPDATE agentic_templates
      SET category = COALESCE(?, category),
          description = COALESCE(?, description),
          content = COALESCE(?, content),
          trigger_conditions = CASE WHEN ? IS NULL THEN trigger_conditions ELSE ? END,
          quick_replies = CASE WHEN ? IS NULL THEN quick_replies ELSE ? END,
          confidence = COALESCE(?, confidence),
          active = COALESCE(?, active),
          version = version + 1,
          updated_at = ?
      WHERE id = ?
    `).run(
      category ?? null,
      description ?? null,
      content ?? null,
      trigger_conditions === undefined ? null : 'x',
      trigger_conditions === undefined ? null : JSON.stringify(trigger_conditions),
      quick_replies === undefined ? null : 'x',
      quick_replies === undefined ? null : JSON.stringify(quick_replies),
      confidence ?? null,
      active ?? null,
      now,
      id,
    );

    invalidateCache();
    res.json({ success: true, id });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e?.message });
  }
});

/**
 * DELETE /api/agentic-templates/:id
 * Soft delete (active = 0). Admin có thể re-activate bằng PUT active=1.
 */
router.delete('/:id', superadminOnly, (req: AuthRequest, res) => {
  try {
    const result = db.prepare(`UPDATE agentic_templates SET active = 0, updated_at = ? WHERE id = ?`)
      .run(Date.now(), req.params.id);
    if (result.changes === 0) return res.status(404).json({ success: false, error: 'Not found' });
    invalidateCache();
    res.json({ success: true, deactivated: req.params.id });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e?.message });
  }
});

/**
 * POST /api/agentic-templates/:id/reset
 * Reset về default từ seeder (chỉ áp dụng cho template có trong DEFAULT_TEMPLATES).
 */
router.post('/:id/reset', superadminOnly, (req: AuthRequest, res) => {
  try {
    const id = req.params.id;
    const def = DEFAULT_TEMPLATES.find(t => t.id === id);
    if (!def) return res.status(404).json({ success: false, error: 'Không có default cho template này' });

    // Save history trước
    const cur = db.prepare(`SELECT * FROM agentic_templates WHERE id = ?`).get(id) as any;
    if (cur) {
      db.prepare(`
        INSERT INTO agentic_templates_history
          (template_id, version, content, trigger_conditions, quick_replies, changed_by, changed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(id, cur.version, cur.content, cur.trigger_conditions, cur.quick_replies, `${req.user?.email || 'admin'} (RESET)`, Date.now());
    }

    seedTemplates(true);  // force re-seed
    invalidateCache();
    res.json({ success: true, id, note: 'Reset về default' });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e?.message });
  }
});

/**
 * POST /api/agentic-templates/:id/preview
 * Preview render với ctx mock.
 * Body: { customerName?, customerTier?, missingSlots?, topic?, ... }
 */
router.post('/:id/preview', (req: AuthRequest, res) => {
  try {
    const row = db.prepare(`SELECT content, quick_replies FROM agentic_templates WHERE id = ?`)
      .get(req.params.id) as any;
    if (!row) return res.status(404).json({ success: false, error: 'Not found' });

    const rendered = renderString(row.content, req.body || {});
    res.json({
      success: true,
      rendered,
      quick_replies: row.quick_replies ? JSON.parse(row.quick_replies) : null,
    });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e?.message });
  }
});

/**
 * GET /api/agentic-templates/:id/history
 * Version history — list snapshot cũ.
 */
router.get('/:id/history', (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT id, version, content, trigger_conditions, quick_replies, changed_by, changed_at
      FROM agentic_templates_history
      WHERE template_id = ?
      ORDER BY changed_at DESC
      LIMIT 50
    `).all(req.params.id);
    res.json({ success: true, data: rows });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e?.message });
  }
});

/**
 * POST /api/agentic-templates/cache/invalidate
 * Force refresh cache (sau khi edit trực tiếp DB).
 */
router.post('/cache/invalidate', superadminOnly, (_req, res) => {
  try {
    invalidateCache();
    loadTemplates(true);
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e?.message });
  }
});

/**
 * GET /api/agentic-templates/analytics/overview
 * Top templates by hits + conversions.
 */
router.get('/analytics/overview', (_req, res) => {
  try {
    const topHits = db.prepare(`
      SELECT id, category, description, hits, conversions,
        CASE WHEN hits > 0 THEN ROUND(1.0 * conversions / hits, 3) ELSE 0 END as conv_rate,
        last_used_at
      FROM agentic_templates
      WHERE active = 1
      ORDER BY hits DESC
      LIMIT 20
    `).all();

    const totals = db.prepare(`
      SELECT COUNT(*) as templates_active, SUM(hits) as total_hits, SUM(conversions) as total_conversions
      FROM agentic_templates WHERE active = 1
    `).get();

    res.json({ success: true, data: { top_hits: topHits, totals } });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e?.message });
  }
});

export default router;

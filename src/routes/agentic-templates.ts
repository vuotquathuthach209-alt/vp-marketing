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
import {
  runTemplateSuggestionAnalysis,
  listPendingSuggestions,
  listAllSuggestions,
  approveSuggestion,
  rejectSuggestion,
} from '../services/agentic/template-suggester';

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
 * POST /api/agentic-templates/:id/clone
 * Clone existing template với new_id.
 * Body: { new_id: string }
 */
router.post('/:id/clone', superadminOnly, (req: AuthRequest, res) => {
  try {
    const src = db.prepare(`SELECT * FROM agentic_templates WHERE id = ?`).get(req.params.id) as any;
    if (!src) return res.status(404).json({ success: false, error: 'Source not found' });

    const newId = (req.body?.new_id || '').toString().trim();
    if (!newId || !/^[a-z0-9_]+$/.test(newId)) {
      return res.status(400).json({ success: false, error: 'new_id chỉ chứa a-z 0-9 _' });
    }

    const existing = db.prepare(`SELECT id FROM agentic_templates WHERE id = ?`).get(newId);
    if (existing) return res.status(409).json({ success: false, error: 'new_id đã tồn tại' });

    const now = Date.now();
    db.prepare(`
      INSERT INTO agentic_templates
        (id, category, description, trigger_conditions, content, quick_replies, confidence, active, hotel_id, version, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, 1, ?, ?)
    `).run(
      newId,
      src.category,
      `${src.description} (cloned from ${src.id})`,
      src.trigger_conditions,
      src.content,
      src.quick_replies,
      src.confidence,
      src.hotel_id,
      now, now,
    );
    invalidateCache();
    res.json({ success: true, new_id: newId });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e?.message });
  }
});

/**
 * GET /api/agentic-templates/export
 * Export all active templates as JSON array (backup / share).
 */
router.get('/export', (req, res) => {
  try {
    const includeInactive = req.query.include_inactive === 'true';
    const rows = db.prepare(`
      SELECT id, category, description, trigger_conditions, content, quick_replies, confidence, active, hotel_id
      FROM agentic_templates
      ${includeInactive ? '' : 'WHERE active = 1'}
      ORDER BY category, id
    `).all() as any[];

    const exported = rows.map(r => ({
      id: r.id,
      category: r.category,
      description: r.description,
      trigger_conditions: r.trigger_conditions ? JSON.parse(r.trigger_conditions) : null,
      content: r.content,
      quick_replies: r.quick_replies ? JSON.parse(r.quick_replies) : null,
      confidence: r.confidence,
      active: !!r.active,
      hotel_id: r.hotel_id,
    }));

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="agentic-templates-${new Date().toISOString().slice(0, 10)}.json"`);
    res.json({ version: '1.0', exported_at: Date.now(), templates: exported });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e?.message });
  }
});

/**
 * POST /api/agentic-templates/import
 * Import templates from JSON backup.
 * Body: { templates: [...], overwrite?: boolean }
 * - overwrite=false (default): skip templates đã tồn tại
 * - overwrite=true: update + save history cho existing
 */
router.post('/import', superadminOnly, (req: AuthRequest, res) => {
  try {
    const templates = req.body?.templates;
    const overwrite = req.body?.overwrite === true;
    if (!Array.isArray(templates)) {
      return res.status(400).json({ success: false, error: 'templates phải là array' });
    }

    const now = Date.now();
    let inserted = 0, updated = 0, skipped = 0, errors = [];

    for (const t of templates) {
      try {
        if (!t.id || !t.category || !t.content) {
          errors.push({ id: t.id || '?', error: 'Missing required fields' });
          continue;
        }

        const existing = db.prepare(`SELECT * FROM agentic_templates WHERE id = ?`).get(t.id) as any;

        if (existing && !overwrite) {
          skipped++;
          continue;
        }

        if (existing) {
          // Save history then update
          db.prepare(`
            INSERT INTO agentic_templates_history (template_id, version, content, trigger_conditions, quick_replies, changed_by, changed_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
          `).run(t.id, existing.version, existing.content, existing.trigger_conditions, existing.quick_replies, `${req.user?.email || 'admin'} (IMPORT)`, now);

          db.prepare(`
            UPDATE agentic_templates
            SET category = ?, description = ?, trigger_conditions = ?, content = ?, quick_replies = ?,
                confidence = ?, active = ?, hotel_id = ?, version = version + 1, updated_at = ?
            WHERE id = ?
          `).run(
            t.category,
            t.description || '',
            t.trigger_conditions ? JSON.stringify(t.trigger_conditions) : null,
            t.content,
            t.quick_replies ? JSON.stringify(t.quick_replies) : null,
            Number(t.confidence) || 0.9,
            t.active === false ? 0 : 1,
            Number(t.hotel_id) || 0,
            now,
            t.id,
          );
          updated++;
        } else {
          db.prepare(`
            INSERT INTO agentic_templates
              (id, category, description, trigger_conditions, content, quick_replies, confidence, active, hotel_id, version, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
          `).run(
            t.id,
            t.category,
            t.description || '',
            t.trigger_conditions ? JSON.stringify(t.trigger_conditions) : null,
            t.content,
            t.quick_replies ? JSON.stringify(t.quick_replies) : null,
            Number(t.confidence) || 0.9,
            t.active === false ? 0 : 1,
            Number(t.hotel_id) || 0,
            now, now,
          );
          inserted++;
        }
      } catch (e: any) {
        errors.push({ id: t.id, error: e?.message });
      }
    }

    invalidateCache();
    res.json({ success: true, inserted, updated, skipped, errors });
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
 * GET /api/agentic-templates/analytics/timeseries
 * Last N days hits + conversions grouped by category, daily buckets.
 * Query: ?days=7
 */
router.get('/analytics/timeseries', (req, res) => {
  try {
    const days = Math.min(30, Math.max(1, Number(req.query.days) || 7));
    const sinceTs = Date.now() - days * 24 * 3600 * 1000;

    // Use agentic_template_selections for per-day hit count
    const rows = db.prepare(`
      SELECT
        t.category,
        strftime('%Y-%m-%d', datetime(s.created_at/1000, 'unixepoch')) as day,
        COUNT(*) as hits
      FROM agentic_template_selections s
      JOIN agentic_templates t ON t.id = s.template_id
      WHERE s.created_at > ?
      GROUP BY t.category, day
      ORDER BY day ASC, t.category ASC
    `).all(sinceTs) as any[];

    // Build ordered dates list
    const dates: string[] = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(Date.now() - i * 24 * 3600 * 1000);
      dates.push(d.toISOString().slice(0, 10));
    }

    // Pivot: category → date → hits
    const cats = ['discovery', 'gathering', 'info', 'objection', 'decision', 'handoff', 'misc'];
    const series: Record<string, number[]> = {};
    for (const cat of cats) series[cat] = dates.map(() => 0);

    for (const r of rows) {
      const idx = dates.indexOf(r.day);
      if (idx >= 0 && series[r.category]) series[r.category][idx] = r.hits;
    }

    res.json({
      success: true,
      data: {
        dates,
        categories: cats,
        series,
        total_hits: rows.reduce((sum, r) => sum + r.hits, 0),
      },
    });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e?.message });
  }
});

/**
 * GET /api/agentic-templates/:id/selections
 * Recent selection logs for a specific template (debug: why picked, top competitors).
 */
router.get('/:id/selections', (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT sender_id, candidates_json, confidence_score, turn_number, intent, created_at
      FROM agentic_template_selections
      WHERE template_id = ?
      ORDER BY created_at DESC
      LIMIT 20
    `).all(req.params.id) as any[];
    const parsed = rows.map(r => ({
      ...r,
      sender_id: (r.sender_id || '').substring(0, 14) + '...',
      candidates: r.candidates_json ? JSON.parse(r.candidates_json) : [],
    }));
    res.json({ success: true, data: parsed });
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

// ═══════════════════════════════════════════════════════════
// AI-PROPOSED SUGGESTIONS (v27B) — admin duyệt
// ═══════════════════════════════════════════════════════════

/**
 * GET /api/agentic-templates/suggestions/pending
 * List pending suggestions (admin review queue).
 */
router.get('/suggestions/pending', (_req, res) => {
  try {
    const rows = listPendingSuggestions(100);
    const counts = db.prepare(`
      SELECT status, COUNT(*) as n FROM agentic_template_suggestions GROUP BY status
    `).all();
    res.json({ success: true, data: rows, counts });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e?.message });
  }
});

/**
 * GET /api/agentic-templates/suggestions/all?status=
 */
router.get('/suggestions/all', (req, res) => {
  try {
    const rows = listAllSuggestions(req.query.status as string, 200);
    res.json({ success: true, data: rows });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e?.message });
  }
});

/**
 * POST /api/agentic-templates/suggestions/analyze
 * On-demand: chạy analyzer NGAY → gọi Gemini → save suggestions.
 */
router.post('/suggestions/analyze', superadminOnly, async (_req, res) => {
  try {
    const r = await runTemplateSuggestionAnalysis();
    res.json({ success: true, ...r });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e?.message });
  }
});

/**
 * POST /api/agentic-templates/suggestions/:id/approve
 * Duyệt suggestion → insert vào agentic_templates.
 * Body có thể override: { content?, trigger_conditions?, quick_replies?, description?, category? }
 */
router.post('/suggestions/:id/approve', superadminOnly, (req: AuthRequest, res) => {
  try {
    const id = Number(req.params.id);
    const reviewedBy = req.user?.email || 'admin';
    const r = approveSuggestion(id, reviewedBy, req.body || {});
    if (!r.success) return res.status(400).json(r);
    res.json(r);
  } catch (e: any) {
    res.status(500).json({ success: false, error: e?.message });
  }
});

/**
 * POST /api/agentic-templates/suggestions/:id/reject
 * Body: { note?: string }
 */
router.post('/suggestions/:id/reject', superadminOnly, (req: AuthRequest, res) => {
  try {
    const id = Number(req.params.id);
    const reviewedBy = req.user?.email || 'admin';
    const r = rejectSuggestion(id, reviewedBy, req.body?.note || '');
    if (!r.success) return res.status(400).json(r);
    res.json(r);
  } catch (e: any) {
    res.status(500).json({ success: false, error: e?.message });
  }
});

export default router;

/**
 * Video Studio Admin API — module RIÊNG BIỆT với chatbot/agentic.
 *
 * All endpoints prefixed /api/video-studio/*
 * Gated by isVideoStudioEnabled() feature flag.
 * Admin auth required (superadmin for writes, admin for reads).
 */

import { Router, Response, NextFunction } from 'express';
import { authMiddleware, superadminOnly, AuthRequest } from '../middleware/auth';
import { db } from '../db';
import { isVideoStudioEnabled, getVSSetting, setVSSetting } from '../services/video-studio/feature-flag';
import {
  ensureDefaultBrandKit, getDefaultBrandKit, getBrandKit, listBrandKits, updateBrandKit, exportBrandKit,
} from '../services/video-studio/brand-kit';
import {
  runDiscovery, listUnusedIdeas, brainstormTopicsViaAI,
} from '../services/video-studio/content-discovery';
import {
  createProject, generateScriptStep, approveScriptStep, generateVisualsStep,
  getProject, listProjects, getProjectScenes, deleteProject,
} from '../services/video-studio/studio-orchestrator';

const router = Router();
router.use(authMiddleware);

// Feature flag middleware
function requireEnabled(req: AuthRequest, res: Response, next: NextFunction) {
  if (!isVideoStudioEnabled()) {
    return res.status(403).json({
      success: false,
      error: 'Video Studio module chưa được bật. Superadmin vào Settings → bật video_studio_enabled',
    });
  }
  next();
}

// ═══════════════════════════════════════════════════════════
// Feature flag + settings
// ═══════════════════════════════════════════════════════════

router.get('/status', (_req, res) => {
  try {
    res.json({
      success: true,
      enabled: isVideoStudioEnabled(),
      has_default_brand_kit: !!getDefaultBrandKit(),
      settings: {
        target_duration_sec: Number(getVSSetting('target_duration_sec', '90')),
        auto_publish: getVSSetting('auto_publish') === 'true',
        review_required: getVSSetting('review_required', 'true') === 'true',
      },
      api_keys: {
        pexels: !!(process.env.PEXELS_API_KEY || getVSSetting('pexels_api_key')),
        pixabay: !!(process.env.PIXABAY_API_KEY || getVSSetting('pixabay_api_key')),
        elevenlabs: !!(process.env.ELEVENLABS_API_KEY || getVSSetting('elevenlabs_api_key')),
      },
    });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e?.message });
  }
});

router.post('/toggle', superadminOnly, (req: AuthRequest, res) => {
  try {
    const enabled = Boolean(req.body?.enabled);
    const { setSetting } = require('../db');
    setSetting('video_studio_enabled', enabled ? 'true' : 'false');

    // Ensure default brand kit exists khi bật lần đầu
    if (enabled) {
      try {
        const { ensureDefaultBrandKit } = require('../services/video-studio/brand-kit');
        ensureDefaultBrandKit();
      } catch (e: any) { console.warn('[vs-route] brand kit init:', e?.message); }
    }

    res.json({ success: true, enabled });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e?.message });
  }
});

router.post('/settings', superadminOnly, (req: AuthRequest, res) => {
  try {
    const allowed = [
      'target_duration_sec', 'auto_publish', 'review_required',
      'pexels_api_key', 'pixabay_api_key', 'elevenlabs_api_key', 'elevenlabs_voice_id',
    ];
    for (const k of allowed) {
      if (req.body?.[k] !== undefined) {
        setVSSetting(k, String(req.body[k]));
      }
    }
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e?.message });
  }
});

// ═══════════════════════════════════════════════════════════
// Brand Kit
// ═══════════════════════════════════════════════════════════

router.get('/brand-kits', requireEnabled, (_req, res) => {
  res.json({ success: true, data: listBrandKits() });
});

router.get('/brand-kits/default', requireEnabled, (_req, res) => {
  let kit = getDefaultBrandKit();
  if (!kit) {
    const created = ensureDefaultBrandKit();
    kit = created.brand_kit;
  }
  res.json({ success: true, data: kit });
});

router.get('/brand-kits/:id', requireEnabled, (req, res) => {
  const kit = getBrandKit(Number(req.params.id));
  if (!kit) return res.status(404).json({ success: false, error: 'Not found' });
  res.json({ success: true, data: kit });
});

router.put('/brand-kits/:id', requireEnabled, superadminOnly, (req: AuthRequest, res) => {
  const r = updateBrandKit(Number(req.params.id), req.body || {});
  res.json(r);
});

router.get('/brand-kits/:id/export', requireEnabled, (req, res) => {
  const data = exportBrandKit(Number(req.params.id));
  if (!data) return res.status(404).json({ success: false, error: 'Not found' });
  res.json({ success: true, data });
});

// ═══════════════════════════════════════════════════════════
// Content ideas
// ═══════════════════════════════════════════════════════════

router.get('/ideas', requireEnabled, (req, res) => {
  try {
    const ideas = listUnusedIdeas(Number(req.query.limit) || 50);
    res.json({ success: true, data: ideas, count: ideas.length });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e?.message });
  }
});

router.post('/ideas/discover', requireEnabled, superadminOnly, async (_req, res) => {
  try {
    const r = await runDiscovery();
    res.json({ success: true, ...r });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e?.message });
  }
});

router.post('/ideas/brainstorm', requireEnabled, superadminOnly, async (req: AuthRequest, res) => {
  try {
    const count = Math.min(20, Number(req.body?.count) || 10);
    const ideas = await brainstormTopicsViaAI(count);

    let saved = 0;
    for (const idea of ideas) {
      try {
        db.prepare(`
          INSERT INTO video_content_ideas
            (topic, description, target_audience, source_type,
             relevance_score, trending_score, seasonal_tag, discovered_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          idea.topic, idea.description || null, idea.target_audience || null,
          idea.source_type, idea.relevance_score, idea.trending_score,
          idea.seasonal_tag || null, idea.discovered_at,
        );
        saved++;
      } catch {}
    }
    res.json({ success: true, ideas, saved });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e?.message });
  }
});

router.post('/ideas', requireEnabled, superadminOnly, (req: AuthRequest, res) => {
  try {
    const { topic, description, target_audience } = req.body || {};
    if (!topic) return res.status(400).json({ success: false, error: 'topic required' });

    const result = db.prepare(`
      INSERT INTO video_content_ideas
        (topic, description, target_audience, source_type, relevance_score, trending_score, discovered_at)
      VALUES (?, ?, ?, 'manual', 0.8, 0.5, ?)
    `).run(topic, description || null, target_audience || null, Date.now());

    res.json({ success: true, id: result.lastInsertRowid });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e?.message });
  }
});

router.delete('/ideas/:id', requireEnabled, superadminOnly, (req, res) => {
  try {
    db.prepare(`DELETE FROM video_content_ideas WHERE id = ?`).run(Number(req.params.id));
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e?.message });
  }
});

// ═══════════════════════════════════════════════════════════
// Projects
// ═══════════════════════════════════════════════════════════

router.get('/projects', requireEnabled, (req, res) => {
  try {
    const projects = listProjects({
      status: req.query.status as string,
      limit: Number(req.query.limit) || 50,
    });
    res.json({ success: true, data: projects });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e?.message });
  }
});

router.get('/projects/:id', requireEnabled, (req, res) => {
  try {
    const proj = getProject(Number(req.params.id));
    if (!proj) return res.status(404).json({ success: false, error: 'Not found' });

    const scenes = getProjectScenes(proj.id);
    const script = (proj as any).script_json ? JSON.parse((proj as any).script_json) : null;
    const publishes = db.prepare(`SELECT * FROM video_publish_log WHERE project_id = ?`).all(proj.id);
    const costs = db.prepare(`
      SELECT SUM(cost_cents) as total, COUNT(*) as ops
      FROM video_cost_ledger WHERE project_id = ?
    `).get(proj.id);

    res.json({
      success: true,
      data: { ...proj, script, scenes, publishes, costs },
    });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e?.message });
  }
});

router.post('/projects', requireEnabled, (req: AuthRequest, res) => {
  try {
    const r = createProject({
      ...(req.body || {}),
      generated_by: req.user?.email || 'admin',
    });
    if ('error' in r) return res.status(400).json({ success: false, error: r.error });
    res.json({ success: true, id: r.id, project: r.project });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e?.message });
  }
});

router.post('/projects/:id/generate-script', requireEnabled, async (req: AuthRequest, res) => {
  try {
    const r = await generateScriptStep(Number(req.params.id), req.body || {});
    if (!r.success) return res.status(400).json(r);
    const proj = getProject(Number(req.params.id));
    const scenes = getProjectScenes(Number(req.params.id));
    res.json({ success: true, project: proj, scenes });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e?.message });
  }
});

router.post('/projects/:id/approve-script', requireEnabled, (req: AuthRequest, res) => {
  try {
    const r = approveScriptStep(Number(req.params.id), req.body?.edited_scenes);
    if (!r.success) return res.status(400).json(r);
    res.json(r);
  } catch (e: any) {
    res.status(500).json({ success: false, error: e?.message });
  }
});

router.post('/projects/:id/generate-visuals', requireEnabled, async (req: AuthRequest, res) => {
  try {
    const r = await generateVisualsStep(Number(req.params.id));
    const scenes = getProjectScenes(Number(req.params.id));
    res.json({ success: r.success, fetched: r.fetched, failed: r.failed, scenes, error: r.error });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e?.message });
  }
});

router.delete('/projects/:id', requireEnabled, superadminOnly, (req, res) => {
  const r = deleteProject(Number(req.params.id));
  res.json(r);
});

// ═══════════════════════════════════════════════════════════
// Dashboard / analytics
// ═══════════════════════════════════════════════════════════

router.get('/dashboard/summary', requireEnabled, (_req, res) => {
  try {
    const counts = db.prepare(`
      SELECT status, COUNT(*) as n FROM video_projects GROUP BY status
    `).all();
    const totalCost = db.prepare(`SELECT SUM(cost_cents) as total FROM video_cost_ledger`).get() as any;
    const recent = db.prepare(`SELECT id, title, status, updated_at FROM video_projects ORDER BY updated_at DESC LIMIT 10`).all();
    const ideasCount = db.prepare(`SELECT COUNT(*) as n FROM video_content_ideas WHERE used_project_id IS NULL`).get() as any;

    res.json({
      success: true,
      data: {
        status_counts: counts,
        total_cost_cents: totalCost?.total || 0,
        recent_projects: recent,
        unused_ideas: ideasCount?.n || 0,
      },
    });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e?.message });
  }
});

export default router;

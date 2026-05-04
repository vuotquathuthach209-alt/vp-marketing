/**
 * Anthology Admin API — Sonder Stories management.
 *
 * Endpoints prefixed /api/anthology/*
 * Admin auth required (superadmin for writes, admin for reads).
 *
 * Reference skill: sonder-storytelling
 */

import { Router } from 'express';
import { authMiddleware, superadminOnly, AuthRequest } from '../middleware/auth';
import { db, getSetting, setSetting } from '../db';
import {
  pickTodayCharacter,
  type CharacterSlug,
  type TodayPick,
} from '../services/anthology/anthology-engine';
import {
  runFullAnthologyPipeline,
  approveEpisode,
  markPublished,
  listAnthologyEpisodes,
  getAnthologyEpisodeDetail,
  getAnthologyStats,
} from '../services/anthology/anthology-orchestrator';
import { publishEpisodeNow, publishNextScheduledEpisode } from '../services/anthology/anthology-publisher';
import { isYoutubeConnected } from '../services/youtube-publisher';

const router = Router();
router.use(authMiddleware);

// ═══════════════════════════════════════════════════════════
// Status / settings
// ═══════════════════════════════════════════════════════════

router.get('/status', (_req, res) => {
  try {
    const cronEnabled = (getSetting('vs_anthology_cron_enabled') || 'true') !== 'false';
    const fbPages = db.prepare(`SELECT id, name, fb_page_id FROM pages ORDER BY id ASC`).all() as any[];
    const fbPageId = getSetting('vs_anthology_fb_page_id') || (fbPages[0]?.fb_page_id || null);
    res.json({
      success: true,
      cron_enabled: cronEnabled,
      cron_schedule: 'generate 17h → publish 19h VN (Asia/Ho_Chi_Minh)',
      tips_cron_enabled: getSetting('vs_tips_cron_enabled') === 'true',
      weekend_cron_enabled: getSetting('vs_weekend_cron_enabled') === 'true',
      publish_fb_enabled: (getSetting('vs_anthology_publish_fb_enabled') || 'true') !== 'false',
      publish_yt_enabled: (getSetting('vs_anthology_publish_yt_enabled') || 'true') !== 'false',
      yt_connected: isYoutubeConnected(),
      yt_privacy: getSetting('vs_anthology_yt_privacy') || 'public',
      fb_pages: fbPages,
      fb_page_id_selected: fbPageId,
      today_pick: pickTodayCharacter(),
    });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e?.message });
  }
});

router.post('/toggle-cron', superadminOnly, (req: AuthRequest, res) => {
  try {
    const enabled = Boolean(req.body?.enabled);
    setSetting('vs_anthology_cron_enabled', enabled ? 'true' : 'false');
    res.json({ success: true, cron_enabled: enabled, note: 'Restart pm2 vp-mkt để cron mới apply' });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e?.message });
  }
});

router.post('/publish-settings', superadminOnly, (req: AuthRequest, res) => {
  try {
    const body = req.body || {};
    if (typeof body.publish_fb_enabled === 'boolean') {
      setSetting('vs_anthology_publish_fb_enabled', body.publish_fb_enabled ? 'true' : 'false');
    }
    if (typeof body.publish_yt_enabled === 'boolean') {
      setSetting('vs_anthology_publish_yt_enabled', body.publish_yt_enabled ? 'true' : 'false');
    }
    if (body.fb_page_id !== undefined) {
      setSetting('vs_anthology_fb_page_id', String(body.fb_page_id || ''));
    }
    if (body.yt_privacy && ['public', 'unlisted', 'private'].includes(body.yt_privacy)) {
      setSetting('vs_anthology_yt_privacy', body.yt_privacy);
    }
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e?.message });
  }
});

// ═══════════════════════════════════════════════════════════
// Stats dashboard
// ═══════════════════════════════════════════════════════════

router.get('/stats', (_req, res) => {
  try {
    const stats = getAnthologyStats();
    res.json({ success: true, ...stats });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e?.message });
  }
});

// ═══════════════════════════════════════════════════════════
// Episodes list + detail
// ═══════════════════════════════════════════════════════════

router.get('/episodes', (req: AuthRequest, res) => {
  try {
    const limit = Number(req.query.limit) || 30;
    const status = req.query.status ? String(req.query.status) : undefined;
    const eps = listAnthologyEpisodes({ limit, status });
    res.json({ success: true, episodes: eps, count: eps.length });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e?.message });
  }
});

router.get('/episodes/:id', (req: AuthRequest, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ success: false, error: 'invalid id' });
    const detail = getAnthologyEpisodeDetail(id);
    if (!detail) return res.status(404).json({ success: false, error: 'not found' });
    res.json({ success: true, episode: detail });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e?.message });
  }
});

// ═══════════════════════════════════════════════════════════
// Generate new episode (manual trigger)
// ═══════════════════════════════════════════════════════════

router.post('/generate', superadminOnly, async (req: AuthRequest, res) => {
  try {
    const body = req.body || {};

    // Optional manual character override
    let pick: TodayPick | undefined;
    if (body.character_slug) {
      const validChars: CharacterSlug[] = ['linh', 'tuan', 'vy', 'khanh', 'ha', 'tai'];
      if (!validChars.includes(body.character_slug)) {
        return res.status(400).json({ success: false, error: `invalid character_slug, must be: ${validChars.join('|')}` });
      }
      pick = {
        primary: body.character_slug,
        is_crossover: Boolean(body.is_crossover),
        secondary: Array.isArray(body.secondary) ? body.secondary : undefined,
        arc_slug: body.arc_slug,
        reason: 'manual override',
      };
    }

    const r = await runFullAnthologyPipeline({
      pick,
      episodeIdeaSeed: body.episode_idea_seed,
      generatedBy: req.user?.email || 'admin-manual',
    });

    res.json({ success: r.ok, ...r });
  } catch (e: any) {
    console.error('[anthology-admin] generate err:', e);
    res.status(500).json({ success: false, error: e?.message });
  }
});

// ═══════════════════════════════════════════════════════════
// Approve / Re-generate / Mark published
// ═══════════════════════════════════════════════════════════

router.post('/episodes/:id/approve', superadminOnly, (req: AuthRequest, res) => {
  try {
    const id = Number(req.params.id);
    const r = approveEpisode(id, req.user?.email || 'admin');
    res.json({ success: r.ok, error: r.error });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e?.message });
  }
});

router.post('/episodes/:id/mark-published', superadminOnly, (req: AuthRequest, res) => {
  try {
    const id = Number(req.params.id);
    const fbPostIds = Array.isArray(req.body?.fb_post_ids) ? req.body.fb_post_ids : undefined;
    const r = markPublished(id, fbPostIds);
    res.json({ success: r.ok, error: r.error });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e?.message });
  }
});

router.post('/episodes/:id/publish-now', superadminOnly, async (req: AuthRequest, res) => {
  try {
    const id = Number(req.params.id);
    const result = await publishEpisodeNow(id);
    res.json({ success: result.any_published, ...result });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e?.message });
  }
});

router.post('/publish-next', superadminOnly, async (_req: AuthRequest, res) => {
  try {
    const r = await publishNextScheduledEpisode();
    res.json({ success: r.ok, ...r });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e?.message });
  }
});

router.delete('/episodes/:id', superadminOnly, (req: AuthRequest, res) => {
  try {
    const id = Number(req.params.id);
    const ep = db.prepare(`SELECT * FROM story_episodes WHERE id = ?`).get(id) as any;
    if (!ep) return res.status(404).json({ success: false, error: 'not found' });
    if (ep.status === 'published') {
      return res.status(400).json({ success: false, error: 'cannot delete published episode — mark as failed instead' });
    }
    db.prepare(`DELETE FROM story_episodes WHERE id = ?`).run(id);
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e?.message });
  }
});

// ═══════════════════════════════════════════════════════════
// Browse: characters / locations / arcs / facts
// ═══════════════════════════════════════════════════════════

router.get('/characters', (_req, res) => {
  try {
    const chars = db.prepare(`SELECT * FROM story_characters ORDER BY appearance_count DESC`).all() as any[];
    res.json({ success: true, characters: chars });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e?.message });
  }
});

router.get('/locations', (_req, res) => {
  try {
    const locs = db.prepare(`SELECT * FROM story_locations`).all() as any[];
    res.json({ success: true, locations: locs });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e?.message });
  }
});

router.get('/arcs', (_req, res) => {
  try {
    const arcs = db.prepare(`
      SELECT * FROM story_arcs
      ORDER BY status DESC, started_at ASC
    `).all() as any[];
    res.json({ success: true, arcs });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e?.message });
  }
});

router.get('/values', (_req, res) => {
  try {
    const values = db.prepare(`SELECT * FROM story_brand_values ORDER BY appearance_count ASC`).all() as any[];
    res.json({ success: true, values });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e?.message });
  }
});

router.get('/logos', (_req, res) => {
  try {
    const logos = db.prepare(`SELECT * FROM story_logo_placements`).all() as any[];
    res.json({ success: true, logos });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e?.message });
  }
});

router.get('/facts', (req: AuthRequest, res) => {
  try {
    const limit = Number(req.query.limit) || 50;
    const charSlug = req.query.character ? String(req.query.character) : undefined;

    const facts = charSlug
      ? db.prepare(`
          SELECT * FROM story_continuity
          WHERE fact_key LIKE ? AND superseded_at IS NULL
          ORDER BY established_at DESC LIMIT ?
        `).all(`${charSlug}.%`, limit) as any[]
      : db.prepare(`
          SELECT * FROM story_continuity
          WHERE superseded_at IS NULL
          ORDER BY established_at DESC LIMIT ?
        `).all(limit) as any[];

    res.json({ success: true, facts });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e?.message });
  }
});

// ═══════════════════════════════════════════════════════════
// Today pick preview (no generation)
// ═══════════════════════════════════════════════════════════

router.get('/today-pick', (_req, res) => {
  try {
    const pick = pickTodayCharacter();
    res.json({ success: true, pick });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e?.message });
  }
});

export default router;

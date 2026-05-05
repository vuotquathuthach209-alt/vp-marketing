/**
 * Cinema Admin API — Sonder Cinema (long-form 5-7 phút).
 *
 * Endpoints prefixed /api/cinema/*
 * Admin auth required (superadmin for writes).
 *
 * Reference skill: sonder-cinema
 */

import { Router } from 'express';
import { authMiddleware, superadminOnly, AuthRequest } from '../middleware/auth';
import { db, getSetting, setSetting } from '../db';
import {
  runFullCinemaPipeline,
  approveCinemaEpisode,
  listCinemaEpisodes,
  getCinemaEpisodeDetail,
} from '../services/cinema/cinema-orchestrator';
import {
  publishCinemaEpisode,
  publishNextScheduledCinemaEpisode,
} from '../services/cinema/cinema-publisher';
import {
  getMonthlyBudgetReport,
  estimateEpisodeCost,
  type Provider,
} from '../services/cinema/cinema-cost-tracker';
import { isYoutubeConnected } from '../services/youtube-publisher';

const router = Router();
router.use(authMiddleware);

// ═══════════════════════════════════════════════════════════
// Status
// ═══════════════════════════════════════════════════════════

router.get('/status', (_req, res) => {
  try {
    const cronEnabled = (getSetting('cinema_cron_enabled') || 'true') !== 'false';
    const fbPages = db.prepare(`SELECT id, name, fb_page_id FROM pages ORDER BY id ASC`).all() as any[];

    res.json({
      success: true,
      cron_enabled: cronEnabled,
      cron_schedule: 'T7 12h generate → T7 20h30 publish VN (Asia/Ho_Chi_Minh)',
      publish_yt_enabled: (getSetting('cinema_publish_yt_enabled') || 'true') !== 'false',
      publish_fb_enabled: (getSetting('cinema_publish_fb_enabled') || 'true') !== 'false',
      yt_connected: isYoutubeConnected(),
      yt_privacy: getSetting('cinema_yt_privacy') || 'public',
      fb_pages: fbPages,
      fb_page_id_selected: getSetting('cinema_fb_page_id') || (fbPages[0]?.fb_page_id || null),
      max_cost_per_ep_usd: parseFloat(getSetting('cinema_max_cost_per_episode_usd') || '80'),
      max_monthly_budget_usd: parseFloat(getSetting('cinema_max_monthly_budget_usd') || '400'),
      veo_use_fast: getSetting('cinema_veo_use_fast') === 'true',
      target_duration_sec: parseInt(getSetting('cinema_target_duration_sec') || '60', 10),
      fal_api_key_set: !!getSetting('fal_api_key'),
      hedra_api_key_set: !!getSetting('hedra_api_key'),
    });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e?.message });
  }
});

router.get('/budget-report', (_req, res) => {
  try {
    const report = getMonthlyBudgetReport();
    res.json({ success: true, ...report });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e?.message });
  }
});

// ═══════════════════════════════════════════════════════════
// Settings
// ═══════════════════════════════════════════════════════════

router.post('/toggle-cron', superadminOnly, (req: AuthRequest, res) => {
  try {
    const enabled = Boolean(req.body?.enabled);
    setSetting('cinema_cron_enabled', enabled ? 'true' : 'false');
    res.json({ success: true, note: 'Restart pm2 vp-mkt để cron áp dụng' });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e?.message });
  }
});

router.post('/settings', superadminOnly, (req: AuthRequest, res) => {
  try {
    const body = req.body || {};
    const updates: Record<string, string> = {};

    if (typeof body.publish_yt_enabled === 'boolean') {
      updates.cinema_publish_yt_enabled = body.publish_yt_enabled ? 'true' : 'false';
    }
    if (typeof body.publish_fb_enabled === 'boolean') {
      updates.cinema_publish_fb_enabled = body.publish_fb_enabled ? 'true' : 'false';
    }
    if (typeof body.veo_use_fast === 'boolean') {
      updates.cinema_veo_use_fast = body.veo_use_fast ? 'true' : 'false';
    }
    if (body.fb_page_id !== undefined) {
      updates.cinema_fb_page_id = String(body.fb_page_id || '');
    }
    if (body.yt_privacy && ['public', 'unlisted', 'private'].includes(body.yt_privacy)) {
      updates.cinema_yt_privacy = body.yt_privacy;
    }
    if (typeof body.max_cost_per_ep_usd === 'number' && body.max_cost_per_ep_usd > 0) {
      updates.cinema_max_cost_per_episode_usd = String(body.max_cost_per_ep_usd);
    }
    if (typeof body.max_monthly_budget_usd === 'number' && body.max_monthly_budget_usd > 0) {
      updates.cinema_max_monthly_budget_usd = String(body.max_monthly_budget_usd);
    }
    if (typeof body.target_duration_sec === 'number' && body.target_duration_sec >= 30 && body.target_duration_sec <= 600) {
      updates.cinema_target_duration_sec = String(body.target_duration_sec);
    }
    if (body.fal_api_key !== undefined && typeof body.fal_api_key === 'string') {
      updates.fal_api_key = body.fal_api_key;
    }
    if (body.hedra_api_key !== undefined && typeof body.hedra_api_key === 'string') {
      updates.hedra_api_key = body.hedra_api_key;
    }

    for (const [k, v] of Object.entries(updates)) setSetting(k, v);

    res.json({ success: true, updated: Object.keys(updates) });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e?.message });
  }
});

// ═══════════════════════════════════════════════════════════
// Episodes
// ═══════════════════════════════════════════════════════════

router.get('/episodes', (req: AuthRequest, res) => {
  try {
    const limit = Number(req.query.limit) || 20;
    const status = req.query.status ? String(req.query.status) : undefined;
    const eps = listCinemaEpisodes({ limit, status });
    res.json({ success: true, episodes: eps, count: eps.length });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e?.message });
  }
});

router.get('/episodes/:id', (req: AuthRequest, res) => {
  try {
    const id = Number(req.params.id);
    const detail = getCinemaEpisodeDetail(id);
    if (!detail) return res.status(404).json({ success: false, error: 'not_found' });
    res.json({ success: true, episode: detail });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e?.message });
  }
});

router.post('/generate', superadminOnly, async (req: AuthRequest, res) => {
  try {
    const body = req.body || {};
    if (!body.primary_character || !body.episode_idea) {
      return res.status(400).json({ success: false, error: 'primary_character + episode_idea required' });
    }

    const r = await runFullCinemaPipeline({
      primary_character: body.primary_character,
      secondary_characters: body.secondary_characters,
      episode_idea: body.episode_idea,
      target_duration_sec: typeof body.target_duration_sec === 'number' ? body.target_duration_sec : undefined,
      generatedBy: req.user?.email || 'admin-manual',
      autoApprove: false,
    });

    res.json({ success: r.ok, ...r });
  } catch (e: any) {
    console.error('[cinema-admin] generate err:', e);
    res.status(500).json({ success: false, error: e?.message });
  }
});

router.post('/estimate', superadminOnly, (req: AuthRequest, res) => {
  try {
    const targetSec = Number(req.body?.target_duration_sec)
      || parseInt(getSetting('cinema_target_duration_sec') || '60', 10);

    // Build typical shot list scaled by duration
    let typicalShots: Array<{ shot_no: number; provider: Provider; duration_sec: number }>;
    let words: number;

    if (targetSec <= 90) {
      // PILOT MODE: 5-7 shots
      typicalShots = [
        { shot_no: 1, provider: 'veo' as Provider, duration_sec: 6 },        // hero cold open
        { shot_no: 2, provider: 'hailuo' as Provider, duration_sec: 8 },      // act1 character
        { shot_no: 3, provider: 'seedance' as Provider, duration_sec: 6 },    // act1 broll
        { shot_no: 4, provider: 'hailuo' as Provider, duration_sec: 10 },     // act2 encounter
        { shot_no: 5, provider: 'hedra' as Provider, duration_sec: 10 },      // act2 talking head
        { shot_no: 6, provider: 'seedance' as Provider, duration_sec: 8 },    // act3 closing
      ];
      words = 140;
    } else if (targetSec <= 220) {
      // MID MODE: 10-12 shots
      typicalShots = [
        { shot_no: 1, provider: 'veo' as Provider, duration_sec: 10 },
        { shot_no: 2, provider: 'seedance' as Provider, duration_sec: 6 },
        ...Array.from({ length: 3 }, (_, i) => ({ shot_no: 3 + i, provider: 'hailuo' as Provider, duration_sec: 10 })),
        ...Array.from({ length: 2 }, (_, i) => ({ shot_no: 6 + i, provider: 'seedance' as Provider, duration_sec: 8 })),
        { shot_no: 8, provider: 'hedra' as Provider, duration_sec: 12 },
        ...Array.from({ length: 2 }, (_, i) => ({ shot_no: 9 + i, provider: 'hailuo' as Provider, duration_sec: 10 })),
        { shot_no: 11, provider: 'veo' as Provider, duration_sec: 10 },
      ];
      words = 380;
    } else {
      // FULL MODE: 18-23 shots (default 360s)
      typicalShots = [
        { shot_no: 1, provider: 'veo' as Provider, duration_sec: 12 },
        { shot_no: 2, provider: 'seedance' as Provider, duration_sec: 6 },
        ...Array.from({ length: 4 }, (_, i) => ({ shot_no: 3 + i, provider: 'hailuo' as Provider, duration_sec: 8 })),
        { shot_no: 7, provider: 'veo' as Provider, duration_sec: 10 },
        { shot_no: 8, provider: 'seedance' as Provider, duration_sec: 6 },
        ...Array.from({ length: 4 }, (_, i) => ({ shot_no: 9 + i, provider: 'hailuo' as Provider, duration_sec: 8 })),
        ...Array.from({ length: 2 }, (_, i) => ({ shot_no: 13 + i, provider: 'hedra' as Provider, duration_sec: 12 })),
        ...Array.from({ length: 2 }, (_, i) => ({ shot_no: 15 + i, provider: 'seedance' as Provider, duration_sec: 6 })),
        { shot_no: 17, provider: 'veo' as Provider, duration_sec: 10 },
        ...Array.from({ length: 3 }, (_, i) => ({ shot_no: 18 + i, provider: 'hailuo' as Provider, duration_sec: 8 })),
        { shot_no: 21, provider: 'seedance' as Provider, duration_sec: 6 },
        { shot_no: 22, provider: 'veo' as Provider, duration_sec: 12 },
      ];
      words = 720;
    }

    const estimate = estimateEpisodeCost({
      shots: typicalShots,
      total_words_vn: words,
      script_input_chars: 8000,
    });

    res.json({
      success: true,
      target_duration_sec: targetSec,
      mode: targetSec <= 90 ? 'PILOT' : targetSec <= 220 ? 'MID' : 'FULL',
      ...estimate,
    });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e?.message });
  }
});

router.post('/episodes/:id/approve', superadminOnly, (req: AuthRequest, res) => {
  try {
    const r = approveCinemaEpisode(Number(req.params.id));
    res.json({ success: r.ok, error: r.error });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e?.message });
  }
});

router.post('/episodes/:id/publish-now', superadminOnly, async (req: AuthRequest, res) => {
  try {
    const r = await publishCinemaEpisode(Number(req.params.id));
    res.json({ success: r.any_published, ...r });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e?.message });
  }
});

router.delete('/episodes/:id', superadminOnly, (req: AuthRequest, res) => {
  try {
    const id = Number(req.params.id);
    const ep = db.prepare(`SELECT status FROM cinema_episodes WHERE id = ?`).get(id) as any;
    if (!ep) return res.status(404).json({ success: false, error: 'not_found' });
    if (ep.status === 'published') {
      return res.status(400).json({ success: false, error: 'cannot delete published episode' });
    }
    db.prepare(`DELETE FROM cinema_shots WHERE episode_id = ?`).run(id);
    db.prepare(`DELETE FROM cinema_episodes WHERE id = ?`).run(id);
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e?.message });
  }
});

export default router;

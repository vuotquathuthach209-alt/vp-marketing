/**
 * Routes for Series Story admin tab.
 * Mounted at /api/stories
 */
import { Router } from 'express';
import { db } from '../db';
import {
  generateEpisodeImage,
  regenerateEpisode,
  publishEpisodeToAllPages,
  buildAndScheduleMonth,
} from '../services/story-engine';

const router = Router();

// ─── List all series (newest first) ───
router.get('/', (_req, res) => {
  const series = db.prepare(`
    SELECT s.id, s.month_slug, s.title, s.subtitle, s.status, s.start_date, s.created_at,
      (SELECT COUNT(*) FROM story_episodes WHERE series_id = s.id) AS episodes_count,
      (SELECT COUNT(*) FROM story_episodes WHERE series_id = s.id AND status = 'published') AS published_count,
      (SELECT MIN(scheduled_at) FROM story_episodes WHERE series_id = s.id) AS first_sched,
      (SELECT MAX(scheduled_at) FROM story_episodes WHERE series_id = s.id) AS last_sched
    FROM story_series s ORDER BY s.id DESC
  `).all();
  res.json({ ok: true, series });
});

// ─── Episodes of one series ───
router.get('/:id/episodes', (req, res) => {
  const sid = parseInt(req.params.id);
  const series = db.prepare(`SELECT * FROM story_series WHERE id = ?`).get(sid) as any;
  if (!series) return res.status(404).json({ ok: false, error: 'series not found' });
  const episodes = db.prepare(`
    SELECT id, episode_no, beat, title, caption, image_url, image_prompt,
      scheduled_at, published_at, fb_post_ids, blog_slug, status, error
    FROM story_episodes WHERE series_id = ? ORDER BY episode_no
  `).all(sid);
  res.json({ ok: true, series, episodes });
});

// ─── Regen caption (longer/deeper) ───
router.post('/:id/episodes/:n/regen-caption', async (req, res) => {
  try {
    const sid = parseInt(req.params.id); const n = parseInt(req.params.n);
    const { minChars, maxChars, extraInstruction } = req.body || {};
    const r = await regenerateEpisode(sid, n, { minChars, maxChars, extraInstruction });
    res.json(r);
  } catch (e: any) { res.status(500).json({ ok: false, error: e?.message }); }
});

// ─── Regen image ───
router.post('/:id/episodes/:n/regen-image', async (req, res) => {
  try {
    const sid = parseInt(req.params.id); const n = parseInt(req.params.n);
    const r = await generateEpisodeImage(sid, n, { force: true });
    res.json(r);
  } catch (e: any) { res.status(500).json({ ok: false, error: e?.message }); }
});

// ─── Publish ngay (override schedule) ───
router.post('/:id/episodes/:n/publish-now', async (req, res) => {
  try {
    const sid = parseInt(req.params.id); const n = parseInt(req.params.n);
    const ep = db.prepare(`SELECT id FROM story_episodes WHERE series_id = ? AND episode_no = ?`).get(sid, n) as any;
    if (!ep) return res.status(404).json({ ok: false, error: 'episode not found' });
    const r = await publishEpisodeToAllPages(ep.id);
    res.json(r);
  } catch (e: any) { res.status(500).json({ ok: false, error: e?.message }); }
});

// ─── Manual trigger build next month ───
router.post('/build-month/:monthSlug', async (req, res) => {
  try {
    const r = await buildAndScheduleMonth(req.params.monthSlug);
    res.json(r);
  } catch (e: any) { res.status(500).json({ ok: false, error: e?.message }); }
});

// ─── Delete episode FB posts (rollback) ───
router.post('/:id/episodes/:n/unpublish', async (req, res) => {
  try {
    const sid = parseInt(req.params.id); const n = parseInt(req.params.n);
    const ep = db.prepare(`SELECT id, fb_post_ids, blog_slug FROM story_episodes WHERE series_id = ? AND episode_no = ?`).get(sid, n) as any;
    if (!ep) return res.status(404).json({ ok: false, error: 'episode not found' });

    const axios = (await import('axios')).default;
    const pages = db.prepare(`SELECT id, fb_page_id, access_token, name FROM pages`).all() as any[];
    const fbIds = JSON.parse(ep.fb_post_ids || '[]');
    const deleted: string[] = [];
    const failed: string[] = [];
    for (const entry of fbIds) {
      const [pageId, fbPostId] = entry.split(':');
      const page = pages.find((p: any) => String(p.id) === pageId);
      if (!page) continue;
      try {
        await axios.delete(`https://graph.facebook.com/v18.0/${fbPostId}`, {
          params: { access_token: page.access_token }, timeout: 30000,
        });
        deleted.push(fbPostId);
      } catch (e: any) {
        failed.push(`${fbPostId}: ${e?.response?.data?.error?.message || e?.message}`);
      }
    }

    db.prepare(`UPDATE story_episodes SET status='approved', fb_post_ids=NULL, published_at=NULL, blog_slug=NULL, error=NULL WHERE id = ?`).run(ep.id);
    res.json({ ok: true, deleted, failed });
  } catch (e: any) { res.status(500).json({ ok: false, error: e?.message }); }
});

export default router;

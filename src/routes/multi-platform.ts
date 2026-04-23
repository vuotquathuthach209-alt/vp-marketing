/**
 * Multi-platform Publishing admin routes.
 * v21: Instagram + FB Crosspost + Share Helper
 */

import { Router } from 'express';
import { db } from '../db';
import { authMiddleware, AuthRequest, getHotelId } from '../middleware/auth';
import {
  addIgAccount, getIgAccountsForHotel, publishToHotel, verifyIgAccount,
} from '../services/instagram-publisher';
import {
  getCrossPostLinks, addCrossPostLink, scheduleCrossPost, publishToTargetPage,
} from '../services/fb-crosspost';
import {
  createSharePackage, pushPackageToTelegram, markShared, dismissPackage,
  getPendingPackages, addSuggestedGroup, seedDefaultGroups,
} from '../services/share-helper';

const router = Router();
router.use(authMiddleware);

/* ═══════════════════════════════════════════
   INSTAGRAM
   ═══════════════════════════════════════════ */

router.get('/ig/accounts', (req: AuthRequest, res) => {
  try {
    const hotelId = getHotelId(req);
    res.json({ items: getIgAccountsForHotel(hotelId) });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.post('/ig/accounts', (req: AuthRequest, res) => {
  try {
    const hotelId = getHotelId(req);
    const { ig_business_id, ig_username, linked_fb_page_id, access_token } = req.body || {};
    if (!ig_business_id) return res.status(400).json({ error: 'ig_business_id required' });
    const id = addIgAccount({ hotel_id: hotelId, ig_business_id, ig_username, linked_fb_page_id, access_token });
    res.json({ ok: true, id });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.post('/ig/verify', async (req: AuthRequest, res) => {
  try {
    const { ig_business_id, access_token } = req.body || {};
    if (!ig_business_id || !access_token) {
      return res.status(400).json({ error: 'ig_business_id + access_token required' });
    }
    res.json(await verifyIgAccount(ig_business_id, access_token));
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.post('/ig/publish', async (req: AuthRequest, res) => {
  try {
    const hotelId = getHotelId(req);
    const { image_url, caption } = req.body || {};
    if (!image_url || !caption) return res.status(400).json({ error: 'image_url + caption required' });
    const results = await publishToHotel(hotelId, image_url, caption);
    res.json({ results });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

/* ═══════════════════════════════════════════
   FB CROSS-POST
   ═══════════════════════════════════════════ */

router.get('/fb/crosspost-links', (req: AuthRequest, res) => {
  try {
    const hotelId = getHotelId(req);
    const rows = db.prepare(
      `SELECT pl.*, sp.name as source_name, tp.name as target_name
       FROM page_crosspost_links pl
       JOIN pages sp ON sp.id = pl.source_page_id
       JOIN pages tp ON tp.id = pl.target_page_id
       WHERE sp.hotel_id = ? OR tp.hotel_id = ?
       ORDER BY pl.id DESC`
    ).all(hotelId, hotelId) as any[];
    res.json({ items: rows });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.post('/fb/crosspost-links', (req: AuthRequest, res) => {
  try {
    const { source_page_id, target_page_id, delay_minutes, modify_caption } = req.body || {};
    if (!source_page_id || !target_page_id) {
      return res.status(400).json({ error: 'source_page_id + target_page_id required' });
    }
    if (source_page_id === target_page_id) {
      return res.status(400).json({ error: 'source and target must differ' });
    }
    const id = addCrossPostLink({ source_page_id, target_page_id, delay_minutes, modify_caption });
    res.json({ ok: true, id });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.delete('/fb/crosspost-links/:id', (req: AuthRequest, res) => {
  try {
    const id = parseInt(String(req.params.id), 10);
    const r = db.prepare(`UPDATE page_crosspost_links SET active = 0 WHERE id = ?`).run(id);
    res.json({ ok: true, deleted: r.changes });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.post('/fb/crosspost-now', async (req: AuthRequest, res) => {
  try {
    const { target_page_id, caption, image_url } = req.body || {};
    if (!target_page_id || !caption) return res.status(400).json({ error: 'target_page_id + caption required' });
    const result = await publishToTargetPage(target_page_id, { caption, image_url });
    res.json(result);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

/* ═══════════════════════════════════════════
   SHARE PACKAGES
   ═══════════════════════════════════════════ */

router.get('/share/packages', (req: AuthRequest, res) => {
  try {
    const hotelId = getHotelId(req);
    const limit = Math.min(100, parseInt(String(req.query.limit || '20'), 10));
    const packages = getPendingPackages(hotelId, limit);
    res.json({ items: packages });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.post('/share/packages', (req: AuthRequest, res) => {
  try {
    const hotelId = getHotelId(req);
    const { source_post_id, source_type, caption, image_url } = req.body || {};
    if (!caption) return res.status(400).json({ error: 'caption required' });
    const pkg = createSharePackage({
      hotel_id: hotelId,
      source_post_id,
      source_type: source_type || 'manual',
      caption,
      image_url,
    });
    res.json({ ok: true, package: pkg });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.post('/share/packages/:id/push-telegram', async (req: AuthRequest, res) => {
  try {
    const id = parseInt(String(req.params.id), 10);
    const ok = await pushPackageToTelegram(id);
    res.json({ ok });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.post('/share/packages/:id/mark-shared', (req: AuthRequest, res) => {
  try {
    const id = parseInt(String(req.params.id), 10);
    const { groups } = req.body || {};
    const ok = markShared(id, Array.isArray(groups) ? groups : []);
    res.json({ ok });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.post('/share/packages/:id/dismiss', (req: AuthRequest, res) => {
  try {
    const id = parseInt(String(req.params.id), 10);
    res.json({ ok: dismissPackage(id) });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

/* ═══════════════════════════════════════════
   SUGGESTED GROUPS
   ═══════════════════════════════════════════ */

router.get('/share/suggested-groups', (req: AuthRequest, res) => {
  try {
    const hotelId = getHotelId(req);
    const rows = db.prepare(
      `SELECT * FROM suggested_fb_groups WHERE (hotel_id = ? OR hotel_id = 0) AND active = 1 ORDER BY member_count DESC`
    ).all(hotelId) as any[];
    res.json({ items: rows });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.post('/share/suggested-groups', (req: AuthRequest, res) => {
  try {
    const hotelId = getHotelId(req);
    const { name, url, category, member_count, notes } = req.body || {};
    if (!name) return res.status(400).json({ error: 'name required' });
    const id = addSuggestedGroup({ hotel_id: hotelId, name, url, category, member_count, notes });
    res.json({ ok: true, id });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.post('/share/suggested-groups/seed', (_req: AuthRequest, res) => {
  try {
    const created = seedDefaultGroups();
    res.json({ ok: true, created });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

export default router;

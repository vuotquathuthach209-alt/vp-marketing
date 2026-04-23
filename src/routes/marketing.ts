/**
 * Marketing routes — audiences + campaigns CRUD + trigger.
 */

import { Router } from 'express';
import { db } from '../db';
import { authMiddleware, AuthRequest, getHotelId } from '../middleware/auth';
import {
  refreshAudience, refreshAllAudiences, getAudienceMembers, evaluateCustomerForAudiences,
  BUILTIN_AUDIENCES,
} from '../services/marketing-audience-engine';
import { seedAudiences } from '../services/audience-seed';
import { sendCampaign, sendDueCampaigns, recordConversion } from '../services/broadcast-sender';

const router = Router();
router.use(authMiddleware);

/* ═══════════════════════════════════════════
   AUDIENCES
   ═══════════════════════════════════════════ */

router.post('/audiences/seed', (_req: AuthRequest, res) => {
  try {
    res.json(seedAudiences());
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.get('/audiences', (req: AuthRequest, res) => {
  try {
    const hotelId = getHotelId(req);
    const rows = db.prepare(
      `SELECT * FROM marketing_audiences
       WHERE (hotel_id = ? OR hotel_id = 0)
       ORDER BY active DESC, audience_name`
    ).all(hotelId) as any[];
    for (const r of rows) {
      try { r.filter_criteria = JSON.parse(r.filter_criteria || '{}'); } catch {}
    }
    res.json({ items: rows });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.post('/audiences', (req: AuthRequest, res) => {
  try {
    const hotelId = getHotelId(req);
    const b = req.body || {};
    if (!b.audience_name || !b.display_name || !b.filter_type) {
      return res.status(400).json({ error: 'audience_name + display_name + filter_type required' });
    }
    const now = Date.now();
    const r = db.prepare(
      `INSERT INTO marketing_audiences
       (hotel_id, audience_name, display_name, description, filter_type, filter_criteria, sql_query,
        refresh_interval_min, active, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`
    ).run(
      b.global ? 0 : hotelId,
      b.audience_name, b.display_name, b.description || '',
      b.filter_type,
      JSON.stringify(b.filter_criteria || {}),
      b.sql_query || null,
      b.refresh_interval_min || 1440,
      String(req.user?.userId || 'admin'),
      now, now,
    );
    res.json({ ok: true, id: Number(r.lastInsertRowid) });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.post('/audiences/:id/refresh', (req: AuthRequest, res) => {
  try {
    const id = parseInt(String(req.params.id), 10);
    const result = refreshAudience(id);
    res.json(result);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.post('/audiences/refresh-all', (req: AuthRequest, res) => {
  try {
    const force = req.query.force === '1' || req.body?.force === true;
    const results = refreshAllAudiences(force);
    res.json({
      total: results.length,
      succeeded: results.filter(r => !r.error).length,
      failed: results.filter(r => !!r.error).length,
      results,
    });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.get('/audiences/:id/members', (req: AuthRequest, res) => {
  try {
    const id = parseInt(String(req.params.id), 10);
    const limit = Math.min(1000, parseInt(String(req.query.limit || '100'), 10));
    const members = getAudienceMembers(id, limit);
    for (const m of members) {
      try { m.metadata = JSON.parse(m.metadata || '{}'); } catch {}
    }
    res.json({ items: members });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.delete('/audiences/:id', (req: AuthRequest, res) => {
  try {
    const hotelId = getHotelId(req);
    const id = parseInt(String(req.params.id), 10);
    const r = db.prepare(`DELETE FROM marketing_audiences WHERE id = ? AND (hotel_id = ? OR hotel_id = 0)`).run(id, hotelId);
    res.json({ ok: true, deleted: r.changes });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.get('/audiences/built-in', (_req: AuthRequest, res) => {
  try {
    const list = Object.entries(BUILTIN_AUDIENCES).map(([name, def]) => ({
      audience_name: name,
      description: def.description,
    }));
    res.json({ items: list });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

/** Evaluate current customer: which audiences do they belong to */
router.get('/customer/:sender_id/audiences', (req: AuthRequest, res) => {
  try {
    const senderId = String(req.params.sender_id);
    const audiences = evaluateCustomerForAudiences(senderId);
    for (const a of audiences) {
      try { a.metadata = JSON.parse(a.metadata || '{}'); } catch {}
    }
    res.json({ sender_id: senderId, audiences });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

/* ═══════════════════════════════════════════
   CAMPAIGNS
   ═══════════════════════════════════════════ */

router.get('/campaigns', (req: AuthRequest, res) => {
  try {
    const hotelId = getHotelId(req);
    const status = req.query.status as string | undefined;
    const where = status ? 'AND status = ?' : '';
    const params: any[] = [hotelId];
    if (status) params.push(status);
    const rows = db.prepare(
      `SELECT c.*, a.audience_name, a.display_name as audience_display_name, a.member_count
       FROM broadcast_campaigns c
       LEFT JOIN marketing_audiences a ON a.id = c.audience_id
       WHERE c.hotel_id = ? ${where}
       ORDER BY c.id DESC LIMIT 100`
    ).all(...params) as any[];
    res.json({ items: rows });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.post('/campaigns', (req: AuthRequest, res) => {
  try {
    const hotelId = getHotelId(req);
    const b = req.body || {};
    if (!b.audience_id || !b.name || !b.channel) {
      return res.status(400).json({ error: 'audience_id + name + channel required' });
    }
    if (b.channel === 'zalo_zns' && !b.template_id) {
      return res.status(400).json({ error: 'zalo_zns requires template_id' });
    }
    const now = Date.now();
    const r = db.prepare(
      `INSERT INTO broadcast_campaigns
       (hotel_id, audience_id, name, channel, template_id, template_params, message_content,
        status, scheduled_at, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      hotelId, b.audience_id, b.name, b.channel,
      b.template_id || null,
      JSON.stringify(b.template_params || {}),
      b.message_content || null,
      b.scheduled_at ? 'scheduled' : 'draft',
      b.scheduled_at || null,
      String(req.user?.userId || 'admin'),
      now, now,
    );
    res.json({ ok: true, id: Number(r.lastInsertRowid) });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.post('/campaigns/:id/send-now', async (req: AuthRequest, res) => {
  try {
    const id = parseInt(String(req.params.id), 10);
    const dryRun = req.query.dry_run === '1' || req.body?.dry_run === true;
    const result = await sendCampaign(id, { dryRun });
    res.json(result);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.get('/campaigns/:id/sends', (req: AuthRequest, res) => {
  try {
    const id = parseInt(String(req.params.id), 10);
    const rows = db.prepare(
      `SELECT id, sender_id, customer_phone, customer_name, status, sent_at, delivered_at,
              opened_at, clicked_at, converted_at, error
       FROM broadcast_sends WHERE campaign_id = ? ORDER BY id DESC LIMIT 1000`
    ).all(id) as any[];
    const stats = db.prepare(
      `SELECT status, COUNT(*) as n FROM broadcast_sends WHERE campaign_id = ? GROUP BY status`
    ).all(id) as any[];
    res.json({
      items: rows,
      stats: Object.fromEntries(stats.map((s: any) => [s.status, s.n])),
    });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.post('/campaigns/:id/cancel', (req: AuthRequest, res) => {
  try {
    const hotelId = getHotelId(req);
    const id = parseInt(String(req.params.id), 10);
    const r = db.prepare(
      `UPDATE broadcast_campaigns SET status='cancelled', updated_at=? WHERE id=? AND hotel_id=? AND status IN ('draft','scheduled')`
    ).run(Date.now(), id, hotelId);
    res.json({ ok: true, cancelled: r.changes > 0 });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

export default router;

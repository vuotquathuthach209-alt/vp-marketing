/**
 * Zalo OA routes
 *  - Public webhook: POST /webhook/zalo  (mounted as /webhook/zalo in index.ts)
 *  - Authed CRUD:   /api/zalo/*
 */
import { Router } from 'express';
import axios from 'axios';
import { authMiddleware, AuthRequest, getHotelId } from '../middleware/auth';
import {
  getZaloByOaId, listZaloForHotel, saveZaloOA,
  zaloSendText, zaloSendImage, zaloSendQuickReply, zaloGetUserProfile,
  zaloSendZNS, verifyZaloSignature, refreshZaloToken, ZaloOA,
} from '../services/zalo';
import { smartReplyWithSender } from '../services/smartreply';
import { db } from '../db';

// ── Public webhook (no auth) ─────────────────────────────────────────────
export const zaloWebhookRouter = Router();

zaloWebhookRouter.post('/webhook/zalo', async (req, res) => {
  // Acknowledge fast — Zalo retries if >5s
  res.status(200).json({ ok: true });

  try {
    const body = req.body || {};
    const oaId = String(body.oa_id || body.recipient?.id || '');
    if (!oaId) return;
    const oa = getZaloByOaId(oaId);
    if (!oa) { console.warn('[zalo] webhook for unknown OA', oaId); return; }

    // Optional signature verify
    const mac = String(req.headers['x-zevent-signature'] || req.headers['mac'] || '');
    const ts = String(req.headers['x-zevent-timestamp'] || body.timestamp || '');
    if (oa.app_secret && mac) {
      const raw = JSON.stringify(body);
      if (!verifyZaloSignature(oa.app_secret, ts, raw, mac)) {
        console.warn('[zalo] bad signature');
        return;
      }
    }

    const event = body.event_name || body.event;
    if (event !== 'user_send_text' && event !== 'user_send_message') return;

    const userId = String(body.sender?.id || '');
    const text = String(body.message?.text || '').trim();
    if (!userId || !text) return;

    const senderKey = `zalo:${userId}`;
    const result = await smartReplyWithSender(text, senderKey, undefined, false, oa.hotel_id, 0);
    if (result?.reply) {
      try {
        await zaloSendText(oa, userId, result.reply);
      } catch (e: any) {
        // Token may be expired — try refresh once
        if (await refreshZaloToken(oa)) {
          const fresh = getZaloByOaId(oaId);
          if (fresh) await zaloSendText(fresh, userId, result.reply);
        }
      }
    }
  } catch (e: any) {
    console.error('[zalo] webhook error:', e?.message);
  }
});

// ── Authed CRUD ─────────────────────────────────────────────────────────
const router = Router();
router.use(authMiddleware);

router.get('/list', (req: AuthRequest, res) => {
  const hotelId = getHotelId(req);
  const rows = listZaloForHotel(hotelId).map(r => ({
    ...r,
    access_token: r.access_token ? r.access_token.slice(0, 8) + '…' : null,
    refresh_token: r.refresh_token ? '***' : null,
    app_secret: r.app_secret ? '***' : null,
  }));
  res.json({ items: rows });
});

router.post('/save', (req: AuthRequest, res) => {
  const hotelId = getHotelId(req);
  const { oa_id, oa_name, access_token, refresh_token, app_secret } = req.body || {};
  if (!oa_id || !access_token) return res.status(400).json({ error: 'oa_id + access_token required' });
  const id = saveZaloOA({ hotel_id: hotelId, oa_id, oa_name, access_token, refresh_token, app_secret });
  res.json({ ok: true, id });
});

router.post('/disable', (req: AuthRequest, res) => {
  const hotelId = getHotelId(req);
  const { oa_id } = req.body || {};
  db.prepare(`UPDATE zalo_oa SET enabled = 0 WHERE hotel_id = ? AND oa_id = ?`).run(hotelId, oa_id);
  res.json({ ok: true });
});

router.post('/test', async (req: AuthRequest, res) => {
  const hotelId = getHotelId(req);
  const { oa_id } = req.body || {};
  const oa = listZaloForHotel(hotelId).find(o => o.oa_id === oa_id) as ZaloOA | undefined;
  if (!oa) return res.status(404).json({ error: 'OA not found' });
  try {
    const r = await axios.get('https://openapi.zalo.me/v2.0/oa/getoa', {
      headers: { access_token: oa.access_token }, timeout: 10000,
    });
    if (r.data?.error && r.data.error !== 0) {
      return res.json({ ok: false, error: r.data.message, code: r.data.error });
    }
    res.json({ ok: true, data: r.data?.data });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e?.response?.data?.message || e?.message });
  }
});

router.post('/send-test', async (req: AuthRequest, res) => {
  const hotelId = getHotelId(req);
  const { oa_id, user_id, text } = req.body || {};
  const oa = listZaloForHotel(hotelId).find(o => o.oa_id === oa_id) as ZaloOA | undefined;
  if (!oa) return res.status(404).json({ error: 'OA not found' });
  try {
    const r = await zaloSendText(oa, user_id, text || 'Test từ VP Marketing');
    res.json({ ok: true, data: r });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e?.message });
  }
});

// ═══════════════════════════════════════════════════════════
// Advanced Zalo features
// ═══════════════════════════════════════════════════════════

/** Send image message with caption */
router.post('/send-image', async (req: AuthRequest, res) => {
  const hotelId = getHotelId(req);
  const { oa_id, user_id, image_url, caption } = req.body || {};
  if (!user_id || !image_url) return res.status(400).json({ error: 'user_id + image_url required' });
  const oa = listZaloForHotel(hotelId).find(o => o.oa_id === oa_id);
  if (!oa) return res.status(404).json({ error: 'OA not found' });
  try {
    const r = await zaloSendImage(oa, user_id, image_url, caption);
    res.json({ ok: true, data: r });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e?.message });
  }
});

/** Send quick reply message with inline buttons */
router.post('/send-quickreply', async (req: AuthRequest, res) => {
  const hotelId = getHotelId(req);
  const { oa_id, user_id, text, buttons } = req.body || {};
  if (!user_id || !text || !Array.isArray(buttons) || buttons.length === 0) {
    return res.status(400).json({ error: 'user_id + text + buttons[] required' });
  }
  const oa = listZaloForHotel(hotelId).find(o => o.oa_id === oa_id);
  if (!oa) return res.status(404).json({ error: 'OA not found' });
  try {
    const r = await zaloSendQuickReply(oa, user_id, text, buttons);
    res.json({ ok: true, data: r });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e?.message });
  }
});

/** Get user profile (name, avatar) */
router.get('/user/:userId', async (req: AuthRequest, res) => {
  const hotelId = getHotelId(req);
  const userId = String(req.params.userId);
  const oaId = req.query.oa_id as string;
  const oa = oaId
    ? listZaloForHotel(hotelId).find(o => o.oa_id === oaId)
    : listZaloForHotel(hotelId)[0];
  if (!oa) return res.status(404).json({ error: 'OA not found' });
  try {
    const profile = await zaloGetUserProfile(oa, userId);
    res.json({ ok: true, profile });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e?.message });
  }
});

// ═══════════════════════════════════════════════════════════
// ZNS (Zalo Notification Service) templates & send
// ═══════════════════════════════════════════════════════════

/** List ZNS templates */
router.get('/zns/templates', (req: AuthRequest, res) => {
  const hotelId = getHotelId(req);
  const rows = db.prepare(
    `SELECT id, template_id, template_name, template_type, variables, description, status, created_at
     FROM zalo_zns_templates WHERE hotel_id = ? ORDER BY created_at DESC`
  ).all(hotelId) as any[];
  for (const r of rows) {
    try { r.variables = r.variables ? JSON.parse(r.variables) : []; } catch { r.variables = []; }
  }
  res.json({ items: rows });
});

/** Create/update ZNS template */
router.post('/zns/templates', (req: AuthRequest, res) => {
  const hotelId = getHotelId(req);
  const { template_id, template_name, template_type, variables, description } = req.body || {};
  if (!template_id || !template_name || !template_type) {
    return res.status(400).json({ error: 'template_id + template_name + template_type required' });
  }
  const existing = db.prepare(`SELECT id FROM zalo_zns_templates WHERE hotel_id = ? AND template_id = ?`)
    .get(hotelId, template_id) as any;
  const varsJson = Array.isArray(variables) ? JSON.stringify(variables) : '[]';
  if (existing) {
    db.prepare(
      `UPDATE zalo_zns_templates SET template_name=?, template_type=?, variables=?, description=?, status='active' WHERE id=?`
    ).run(template_name, template_type, varsJson, description || null, existing.id);
    return res.json({ ok: true, id: existing.id, updated: true });
  }
  const r = db.prepare(
    `INSERT INTO zalo_zns_templates (hotel_id, template_id, template_name, template_type, variables, description, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'active', ?)`
  ).run(hotelId, template_id, template_name, template_type, varsJson, description || null, Date.now());
  res.json({ ok: true, id: Number(r.lastInsertRowid), created: true });
});

router.delete('/zns/templates/:id', (req: AuthRequest, res) => {
  const hotelId = getHotelId(req);
  const id = parseInt(String(req.params.id), 10);
  db.prepare(`DELETE FROM zalo_zns_templates WHERE id = ? AND hotel_id = ?`).run(id, hotelId);
  res.json({ ok: true });
});

/** Send ZNS notification */
router.post('/zns/send', async (req: AuthRequest, res) => {
  const hotelId = getHotelId(req);
  const { template_id, phone, data, oa_id } = req.body || {};
  if (!template_id || !phone || !data) {
    return res.status(400).json({ error: 'template_id + phone + data required' });
  }
  const oa = oa_id
    ? listZaloForHotel(hotelId).find(o => o.oa_id === oa_id)
    : listZaloForHotel(hotelId)[0];
  if (!oa) return res.status(404).json({ error: 'OA not found' });

  const trackingId = `zns_${hotelId}_${Date.now()}`;
  try {
    const r = await zaloSendZNS(oa, phone, template_id, data, { trackingId });
    db.prepare(
      `INSERT INTO zalo_zns_log (hotel_id, template_id, phone, tracking_id, data_json, status, zalo_msg_id, sent_at)
       VALUES (?, ?, ?, ?, ?, 'sent', ?, ?)`
    ).run(hotelId, template_id, phone, trackingId, JSON.stringify(data), r?.data?.msg_id || null, Date.now());
    res.json({ ok: true, tracking_id: trackingId, data: r });
  } catch (e: any) {
    db.prepare(
      `INSERT INTO zalo_zns_log (hotel_id, template_id, phone, tracking_id, data_json, status, error, sent_at)
       VALUES (?, ?, ?, ?, ?, 'failed', ?, ?)`
    ).run(hotelId, template_id, phone, trackingId, JSON.stringify(data), e?.message, Date.now());
    res.status(500).json({ ok: false, error: e?.message });
  }
});

/** ZNS send history */
router.get('/zns/log', (req: AuthRequest, res) => {
  const hotelId = getHotelId(req);
  const limit = Math.min(200, parseInt((req.query.limit as string) || '50', 10));
  const rows = db.prepare(
    `SELECT id, template_id, phone, tracking_id, status, error, zalo_msg_id, sent_at, data_json
     FROM zalo_zns_log WHERE hotel_id = ? ORDER BY sent_at DESC LIMIT ?`
  ).all(hotelId, limit) as any[];
  for (const r of rows) {
    try { r.data_json = r.data_json ? JSON.parse(r.data_json) : {}; } catch { r.data_json = {}; }
  }
  res.json({ items: rows });
});

// ═══════════════════════════════════════════════════════════
// Simulator — fake Zalo webhook event để test bot logic offline
// (không cần real Zalo OA)
// ═══════════════════════════════════════════════════════════

/** POST a fake Zalo webhook event để test bot */
router.post('/simulate', async (req: AuthRequest, res) => {
  const hotelId = getHotelId(req);
  const { text, user_id, user_name } = req.body || {};
  if (!text) return res.status(400).json({ error: 'text required' });
  const senderId = user_id || `zalo_sim_${req.user?.userId || 0}`;
  const senderKey = `zalo:${senderId}`;
  try {
    const t0 = Date.now();
    const result = await smartReplyWithSender(text, senderKey, user_name || 'ZaloSimUser', false, hotelId, 0);
    res.json({
      ok: true,
      sender_key: senderKey,
      reply: result?.reply,
      intent: result?.intent,
      tier: result?.tier,
      latency_ms: result?.latency_ms,
      total_latency_ms: Date.now() - t0,
    });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e?.message });
  }
});

router.post('/simulate/reset', (req: AuthRequest, res) => {
  const userId = req.user?.userId || 0;
  const senderKey = `zalo:zalo_sim_${userId}`;
  const r = db.prepare(`DELETE FROM conversation_memory WHERE sender_id = ?`).run(senderKey);
  res.json({ ok: true, deleted: r.changes });
});

export default router;

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
  zaloSendText, verifyZaloSignature, refreshZaloToken, ZaloOA,
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

export default router;

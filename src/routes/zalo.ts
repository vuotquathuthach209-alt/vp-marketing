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
  zaloCreateArticle, textToZaloBodyBlocks,
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

    // Detect OA — Zalo webhook có thể có OA ID ở nhiều field khác nhau:
    // - body.oa_id (some events)
    // - body.recipient.id (user_send_* events, recipient = OA)
    // - body.sender.id (oa_send_* events, sender = OA)
    // - body.app_id → lookup via zalo_oa.app_id (future field)
    // Fallback: nếu chỉ có 1 OA trong DB, dùng luôn
    let oaId = String(body.oa_id || body.recipient?.id || '');
    let oa = oaId ? getZaloByOaId(oaId) : null;

    if (!oa) {
      // Try via sender.id (for OA-initiated events)
      const senderId = String(body.sender?.id || '');
      if (senderId) {
        const tryOa = getZaloByOaId(senderId);
        if (tryOa) { oa = tryOa; oaId = senderId; }
      }
    }

    if (!oa) {
      // Fallback: if DB has exactly 1 OA, use it (common case for single-hotel setup)
      const all = db.prepare(`SELECT oa_id FROM zalo_oa WHERE enabled = 1`).all() as any[];
      if (all.length === 1) {
        oa = getZaloByOaId(all[0].oa_id);
        oaId = all[0].oa_id;
        console.log(`[zalo] webhook fallback to sole OA ${oaId} (orig: oa=${body.oa_id} recip=${body.recipient?.id} sender=${body.sender?.id})`);
      }
    }

    if (!oa) {
      console.warn('[zalo] webhook unresolvable OA. body keys:', Object.keys(body).join(','),
        'oa=', body.oa_id, 'recip=', body.recipient?.id, 'sender=', body.sender?.id);
      return;
    }

    // Optional signature verify — use RAW body bytes (not re-serialized JSON)
    const mac = String(req.headers['x-zevent-signature'] || req.headers['mac'] || '');
    const ts = String(req.headers['x-zevent-timestamp'] || body.timestamp || '');
    const rawBody = (req as any).rawBody || JSON.stringify(body);
    if (oa.app_secret && mac) {
      if (!verifyZaloSignature(oa.app_secret, ts, rawBody, mac)) {
        // Soft-fail: log and continue (Zalo signature formats vary; don't drop valid events)
        console.warn(`[zalo] signature mismatch (soft-accept). mac=${mac.slice(0, 16)}... ts=${ts}`);
      }
    }

    const event = body.event_name || body.event;
    const userId = String(body.sender?.id || '');

    // Log all events for debugging (giúp debug khi customer chat mà bot không nhận)
    console.log(`[zalo] event=${event} oa=${oaId} user=${userId} text="${String(body.message?.text || '').slice(0, 80)}"`);

    // Welcome message khi khách follow OA
    if (event === 'follow' || event === 'user_follow_oa') {
      if (!userId) return;
      try {
        await zaloSendText(oa, userId,
          `Xin chào! 👋 Cảm ơn anh/chị đã quan tâm ${oa.oa_name || 'Sonder'}.\n\n` +
          `Sonder là hệ thống tư vấn phòng lưu trú tại HCM — hỗ trợ tìm khách sạn, homestay, căn hộ dịch vụ phù hợp nhu cầu. ` +
          `Anh/chị cần hỗ trợ:\n` +
          `• 🏨 Tư vấn chỗ ở phù hợp / check giá / còn phòng\n` +
          `• 📍 Tìm chỗ theo khu vực + ngân sách\n` +
          `• 💳 Hỗ trợ đặt phòng nhanh\n\n` +
          `Nhắn em để được hỗ trợ ngay ạ!`
        );
      } catch (e: any) { console.error('[zalo] follow welcome fail:', e?.message); }
      return;
    }

    // Text message events (follower + anonymous đều xử lý giống nhau)
    const textEvents = new Set([
      'user_send_text',
      'user_send_message',
      'anonymous_send_text',
      'user_submit_info',
      'user_send_image',          // v14: Zalo image event
    ]);
    if (!textEvents.has(event)) return;

    const text = String(body.message?.text || '').trim();
    // v14 Phase 3: detect image attachment từ Zalo
    let imageUrl: string | undefined;
    try {
      const attachments = body.message?.attachments || [];
      const firstImg = attachments.find((a: any) => a.type === 'image' || a.payload?.url);
      if (firstImg) {
        imageUrl = firstImg.payload?.url || firstImg.url;
      }
    } catch {}

    if (!userId) return;
    if (!text && !imageUrl) return;  // nothing to process

    const senderKey = `zalo:${userId}`;

    // v20 FIX: Spam-guard — block abusive senders/messages
    try {
      const { checkSpam, logSpamEvent } = require('../services/spam-guard');
      const spam = checkSpam({
        senderId: senderKey,
        pageId: 0,
        message: text || '(image)',
        hotelId: oa.hotel_id || 1,
      });
      if (spam.block) {
        logSpamEvent(senderKey, 0, oa.hotel_id || 1, spam.reason || 'unknown', spam.detail || '', text || '(image)');
        console.log(`[zalo] spam blocked ${senderKey}: ${spam.reason}`);
        return;
      }
    } catch (e: any) {
      console.warn('[zalo] spam-guard fail:', e?.message);
    }

    const result = await smartReplyWithSender(
      text || '(image)',
      senderKey, undefined, !!imageUrl,
      oa.hotel_id, 0, imageUrl,
    );
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

// ── v24: Zalo OAuth callback — PUBLIC (no auth, called by Zalo redirect) ────
// Handle: GET /api/zalo/oauth/callback?code=XXX&oa_id=YYY&state=ZZZ
// Exchange authorization code → access_token + refresh_token và lưu DB.
//
// v24 fix: mounted ON zaloRouter BEFORE authMiddleware (see bottom) để tránh
//          collision với `/api/zalo/*` auth route. Moved handler xuống dưới.
async function zaloOAuthCallback(req: any, res: any) {
  try {
    const code = String(req.query.code || '');
    const oaId = String(req.query.oa_id || '');
    const state = String(req.query.state || '');
    if (!code || !oaId) {
      return res.status(400).send(`<h2>❌ Missing code or oa_id</h2><p>code=${code || '(empty)'}</p><p>oa_id=${oaId || '(empty)'}</p>`);
    }

    // Fetch app credentials
    const { getSetting } = require('../db');
    const appId = getSetting('zalo_app_id');
    const appSecret = getSetting('zalo_app_secret');
    if (!appId || !appSecret) {
      return res.status(500).send('<h2>❌ Missing zalo_app_id or zalo_app_secret in settings</h2>');
    }

    // Exchange code → token (Zalo OA v4 API)
    const tokenResp = await axios.post(
      'https://oauth.zaloapp.com/v4/oa/access_token',
      new URLSearchParams({
        code,
        app_id: String(appId),
        grant_type: 'authorization_code',
      }),
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'secret_key': String(appSecret),
        },
        timeout: 15000,
      }
    );

    const data = tokenResp.data;
    if (!data?.access_token) {
      return res.status(500).send(`<h2>❌ Zalo exchange error</h2><pre>${JSON.stringify(data, null, 2)}</pre>`);
    }

    // Get OA info
    const existingOa = getZaloByOaId(oaId);
    const hotelId = existingOa?.hotel_id || 1;
    const expiresAt = Date.now() + (parseInt(String(data.expires_in || 90000), 10) * 1000);

    saveZaloOA({
      hotel_id: hotelId,
      oa_id: oaId,
      oa_name: existingOa?.oa_name || 'Sonder',
      access_token: data.access_token,
      refresh_token: data.refresh_token || undefined,
      app_secret: existingOa?.app_secret || undefined,
    });

    // Save expiry
    db.prepare(`UPDATE zalo_oa SET token_expires_at = ? WHERE oa_id = ?`).run(expiresAt, oaId);

    console.log(`[zalo-oauth] ✅ exchanged code → new token for oa=${oaId}, expires in ${Math.round((expiresAt - Date.now())/3600_000)}h`);

    return res.send(`
      <!DOCTYPE html>
      <html><head><meta charset="utf-8"><title>Zalo OA re-authorized</title></head>
      <body style="font-family: sans-serif; max-width: 600px; margin: 40px auto; padding: 20px;">
        <h1>✅ Zalo OA đã được re-authorize</h1>
        <p><strong>OA:</strong> ${existingOa?.oa_name || 'Sonder'} (${oaId})</p>
        <p><strong>Token mới:</strong> ${data.access_token.slice(0, 20)}...${data.access_token.slice(-10)}</p>
        <p><strong>Refresh token:</strong> ${data.refresh_token ? '✅ có' : '❌ không'}</p>
        <p><strong>Expires:</strong> ${new Date(expiresAt).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })}</p>
        <p><strong>State:</strong> ${state}</p>
        <hr>
        <p>Có thể đóng tab này. Bot sẽ tự động dùng token mới.</p>
        <p style="color:#888">Next step: verify bằng <code>python scripts/diag-zalo-upload.py</code></p>
      </body></html>
    `);
  } catch (e: any) {
    console.error('[zalo-oauth] callback fail:', e?.response?.data || e?.message);
    return res.status(500).send(`<h2>❌ Exchange error</h2><pre>${e?.response?.data ? JSON.stringify(e.response.data, null, 2) : e?.message}</pre>`);
  }
}

// ── Authed CRUD ─────────────────────────────────────────────────────────
const router = Router();

// v24 FIX: PUBLIC OAuth callback — MUST be registered BEFORE authMiddleware
//          để Zalo redirect không bị 401.
router.get('/oauth/callback', zaloOAuthCallback);

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

/** v22: Set Zalo App credentials (saved in settings table) + immediate token refresh.
 *  Call endpoint này sau khi có App ID + App Secret từ Zalo Developer Console.
 *  Body: { app_id: "1234...", app_secret: "abc..." }
 *  Response: { set: true, refresh_results: [...] }
 */
router.post('/set-credentials', async (req: AuthRequest, res) => {
  try {
    const { app_id, app_secret } = req.body || {};
    if (!app_id || !app_secret) {
      return res.status(400).json({ error: 'app_id + app_secret required (lấy từ Zalo Developer Console)' });
    }

    // Save vào settings table
    const { setSetting } = require('../db');
    setSetting('zalo_app_id', String(app_id));
    setSetting('zalo_app_secret', String(app_secret));

    // Trigger refresh cho tất cả OAs của hotel
    const hotelId = getHotelId(req);
    const oas = listZaloForHotel(hotelId);
    const refreshResults: any[] = [];

    for (const oa of oas) {
      try {
        const refreshed = await refreshZaloToken(oa);
        refreshResults.push({
          oa_id: oa.oa_id,
          oa_name: oa.oa_name,
          refreshed,
        });
      } catch (e: any) {
        refreshResults.push({
          oa_id: oa.oa_id,
          oa_name: oa.oa_name,
          refreshed: false,
          error: e?.message || 'unknown',
        });
      }
    }

    res.json({
      ok: true,
      credentials_saved: true,
      oas_processed: oas.length,
      refresh_results: refreshResults,
      hint: refreshResults.every((r: any) => r.refreshed)
        ? '✅ All tokens refreshed! Bot should respond now.'
        : '⚠️ Some refresh failed — check credentials or re-authorize via OAuth.',
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

/** v22: Force refresh tất cả Zalo OA tokens (manual trigger). */
router.post('/force-refresh', async (req: AuthRequest, res) => {
  try {
    const hotelId = getHotelId(req);
    const oas = listZaloForHotel(hotelId);
    const results: any[] = [];
    for (const oa of oas) {
      const refreshed = await refreshZaloToken(oa).catch((e: any) => {
        console.error('[zalo] force-refresh fail:', e?.message);
        return false;
      });
      results.push({
        oa_id: oa.oa_id,
        oa_name: oa.oa_name,
        refreshed,
      });
    }
    res.json({ ok: true, results });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

/** v22: Debug endpoint — show token expiry status cho all OAs. */
router.get('/token-status', (req: AuthRequest, res) => {
  try {
    const hotelId = getHotelId(req);
    const { getSetting } = require('../db');
    const appId = getSetting('zalo_app_id');
    const appSecret = getSetting('zalo_app_secret');

    const rows = db.prepare(
      `SELECT oa_id, oa_name, token_expires_at, LENGTH(access_token) as token_len,
              LENGTH(refresh_token) as refresh_len, enabled
       FROM zalo_oa WHERE hotel_id = ?`
    ).all(hotelId) as any[];

    const now = Date.now();
    const items = rows.map((r: any) => ({
      oa_id: r.oa_id,
      oa_name: r.oa_name,
      token_len: r.token_len,
      refresh_token_present: !!r.refresh_len,
      expires_at: r.token_expires_at ? new Date(r.token_expires_at).toISOString() : null,
      expired: r.token_expires_at ? r.token_expires_at < now : null,
      hours_until_expiry: r.token_expires_at ? +((r.token_expires_at - now) / 3600_000).toFixed(1) : null,
      enabled: !!r.enabled,
    }));

    res.json({
      credentials_set: !!(appId && appSecret),
      app_id_preview: appId ? appId.slice(0, 8) + '...' : null,
      app_secret_preview: appSecret ? '***' : null,
      oas: items,
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

/** Test OA connection + probe tier/send capability */
router.post('/test', async (req: AuthRequest, res) => {
  const hotelId = getHotelId(req);
  const { oa_id } = req.body || {};
  const oa = listZaloForHotel(hotelId).find(o => o.oa_id === oa_id) as ZaloOA | undefined;
  if (!oa) return res.status(404).json({ error: 'OA not found' });

  const result: any = {
    ok: false,
    oa_info: null,
    send_capability: null,
    tier: null,
    webhook_ready: false,
    app_approved: null,
  };

  // Test 1: get OA info (works on all tiers)
  try {
    const r = await axios.get('https://openapi.zalo.me/v2.0/oa/getoa', {
      headers: { access_token: oa.access_token }, timeout: 10000,
    });
    if (r.data?.error && r.data.error !== 0) {
      result.error = r.data.message;
      result.error_code = r.data.error;
      if (r.data.error === -216 || r.data.error === -213) result.error_hint = 'Token invalid/expired — refresh via Zalo dev console';
      if (r.data.error === -209) { result.error_hint = 'App chưa được Zalo approve'; result.app_approved = false; }
      return res.json(result);
    }
    result.oa_info = r.data?.data;
    result.app_approved = true;
    result.webhook_ready = true;
  } catch (e: any) {
    result.error = e?.response?.data?.message || e?.message;
    return res.status(500).json(result);
  }

  // Test 2: probe send capability với dummy recipient (sẽ fail nhưng biết error code)
  // Zalo trả -224 nếu tier free, -32 nếu recipient không tồn tại (tức send API work)
  try {
    const probe = await axios.post(
      'https://openapi.zalo.me/v3.0/oa/message/cs',
      { recipient: { user_id: '0' }, message: { text: 'probe' } },
      { headers: { access_token: oa.access_token, 'Content-Type': 'application/json' }, timeout: 10000 }
    );
    const errCode = probe.data?.error;
    if (errCode === -224) {
      result.tier = 'free';
      result.send_capability = 'blocked';
      result.tier_hint = 'OA Sonder đang ở tier miễn phí. Cần upgrade Zalo OA Premium (99k-1M/tháng) để bot gửi tin tự động. Xem https://zalo.cloud/oa/pricing';
    } else if (errCode === -32 || errCode === -200) {
      result.tier = 'paid';
      result.send_capability = 'ok';
    } else if (errCode === 0) {
      result.tier = 'paid';
      result.send_capability = 'ok_sent';
    } else {
      result.tier = 'unknown';
      result.send_capability = 'error';
      result.send_error = probe.data?.message;
      result.send_error_code = errCode;
    }
  } catch (e: any) {
    result.send_capability = 'unreachable';
    result.send_error = e?.response?.data?.message || e?.message;
  }

  result.ok = true;
  res.json(result);
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

// ═══════════════════════════════════════════════════════════
// Zalo OA Articles — đăng bài lên feed OA (như FB post)
// ═══════════════════════════════════════════════════════════

/** List articles (có filter status) */
router.get('/articles', (req: AuthRequest, res) => {
  const hotelId = getHotelId(req);
  const status = req.query.status as string | undefined;
  const limit = Math.min(100, parseInt((req.query.limit as string) || '30', 10));
  let sql = `SELECT id, hotel_id, oa_id, title, description, cover_url, status,
             zalo_article_id, zalo_article_url, scheduled_at, published_at, error, created_at, updated_at
             FROM zalo_articles WHERE hotel_id = ?`;
  const params: any[] = [hotelId];
  if (status) { sql += ` AND status = ?`; params.push(status); }
  sql += ` ORDER BY created_at DESC LIMIT ?`;
  params.push(limit);
  const rows = db.prepare(sql).all(...params);
  res.json({ items: rows });
});

/** Get 1 article full (bao gồm body_html) */
router.get('/articles/:id', (req: AuthRequest, res) => {
  const hotelId = getHotelId(req);
  const id = parseInt(String(req.params.id), 10);
  const row = db.prepare(`SELECT * FROM zalo_articles WHERE id = ? AND hotel_id = ?`).get(id, hotelId);
  if (!row) return res.status(404).json({ error: 'not found' });
  res.json(row);
});

/** Create draft or scheduled article */
router.post('/articles', (req: AuthRequest, res) => {
  const hotelId = getHotelId(req);
  const { title, description, cover_url, body_html, oa_id, scheduled_at } = req.body || {};
  if (!title || !body_html || !cover_url) {
    return res.status(400).json({ error: 'title + cover_url + body_html required' });
  }
  // Resolve OA: nếu không truyền oa_id, lấy OA đầu tiên của hotel
  const oa = oa_id
    ? listZaloForHotel(hotelId).find(o => o.oa_id === oa_id)
    : listZaloForHotel(hotelId)[0];
  if (!oa) return res.status(400).json({ error: 'No Zalo OA configured for this hotel' });

  const now = Date.now();
  const status = scheduled_at && scheduled_at > now ? 'scheduled' : 'draft';
  const r = db.prepare(
    `INSERT INTO zalo_articles
     (hotel_id, oa_id, title, description, cover_url, body_html, status,
      scheduled_at, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    hotelId, oa.oa_id, title, description || null, cover_url, body_html, status,
    scheduled_at || null, req.user?.userId || null, now, now
  );
  res.json({ ok: true, id: Number(r.lastInsertRowid), status });
});

/** Update article (only draft/scheduled) */
router.put('/articles/:id', (req: AuthRequest, res) => {
  const hotelId = getHotelId(req);
  const id = parseInt(String(req.params.id), 10);
  const existing = db.prepare(`SELECT status FROM zalo_articles WHERE id = ? AND hotel_id = ?`).get(id, hotelId) as any;
  if (!existing) return res.status(404).json({ error: 'not found' });
  if (existing.status === 'published') return res.status(400).json({ error: 'cannot edit published article' });

  const { title, description, cover_url, body_html, scheduled_at } = req.body || {};
  const updates: string[] = [];
  const params: any[] = [];
  if (title !== undefined) { updates.push('title = ?'); params.push(title); }
  if (description !== undefined) { updates.push('description = ?'); params.push(description); }
  if (cover_url !== undefined) { updates.push('cover_url = ?'); params.push(cover_url); }
  if (body_html !== undefined) { updates.push('body_html = ?'); params.push(body_html); }
  if (scheduled_at !== undefined) {
    updates.push('scheduled_at = ?, status = ?');
    params.push(scheduled_at || null);
    params.push(scheduled_at && scheduled_at > Date.now() ? 'scheduled' : 'draft');
  }
  if (!updates.length) return res.json({ ok: true, changed: 0 });
  updates.push('updated_at = ?'); params.push(Date.now());
  params.push(id, hotelId);
  const r = db.prepare(`UPDATE zalo_articles SET ${updates.join(', ')} WHERE id = ? AND hotel_id = ?`).run(...params);
  res.json({ ok: true, changed: r.changes });
});

/** Delete draft/scheduled article */
router.delete('/articles/:id', (req: AuthRequest, res) => {
  const hotelId = getHotelId(req);
  const id = parseInt(String(req.params.id), 10);
  const existing = db.prepare(`SELECT status FROM zalo_articles WHERE id = ? AND hotel_id = ?`).get(id, hotelId) as any;
  if (!existing) return res.status(404).json({ error: 'not found' });
  if (existing.status === 'published') return res.status(400).json({ error: 'cannot delete published article' });
  db.prepare(`DELETE FROM zalo_articles WHERE id = ? AND hotel_id = ?`).run(id, hotelId);
  res.json({ ok: true });
});

/** Publish article ngay (either draft → published, hoặc scheduled bị force) */
router.post('/articles/:id/publish', async (req: AuthRequest, res) => {
  const hotelId = getHotelId(req);
  const id = parseInt(String(req.params.id), 10);
  const art = db.prepare(`SELECT * FROM zalo_articles WHERE id = ? AND hotel_id = ?`).get(id, hotelId) as any;
  if (!art) return res.status(404).json({ error: 'not found' });
  if (art.status === 'published') return res.status(400).json({ error: 'already published', url: art.zalo_article_url });

  const oa = listZaloForHotel(hotelId).find(o => o.oa_id === art.oa_id);
  if (!oa) return res.status(400).json({ error: 'OA not found for this article' });

  db.prepare(`UPDATE zalo_articles SET status='publishing', updated_at=? WHERE id=?`).run(Date.now(), id);

  try {
    // body_html may be plain text with paragraphs, or full HTML.
    // textToZaloBodyBlocks converts plain text → blocks. If user passed HTML, it'll still be wrapped.
    const blocks = textToZaloBodyBlocks(art.body_html);
    const result = await zaloCreateArticle(oa, {
      title: art.title,
      description: art.description,
      cover: art.cover_url,
      bodyBlocks: blocks,
      status: 'show',
      comment: 'enable',
    });
    db.prepare(
      `UPDATE zalo_articles SET status='published', zalo_article_id=?, zalo_article_url=?,
       published_at=?, error=NULL, updated_at=? WHERE id=?`
    ).run(result.article_id || null, result.url || null, Date.now(), Date.now(), id);
    res.json({ ok: true, article_id: result.article_id, url: result.url, raw: result.raw });
  } catch (e: any) {
    const errMsg = e?.message || 'unknown';
    db.prepare(`UPDATE zalo_articles SET status='failed', error=?, updated_at=? WHERE id=?`)
      .run(errMsg, Date.now(), id);
    res.status(500).json({ ok: false, error: errMsg });
  }
});

/** Generate AI content cho Zalo article (title + description + body) */
router.post('/articles/generate', async (req: AuthRequest, res) => {
  const { prompt, hotel_name } = req.body || {};
  if (!prompt) return res.status(400).json({ error: 'prompt required' });
  try {
    const { smartCascade } = require('../services/smart-cascade');
    const system = `Bạn là copywriter cho OA Zalo của khách sạn Sonder. Viết 1 bài đăng (~200-400 từ) phong cách thân thiện, có emoji phù hợp. Tuân thủ:
- Tiêu đề ngắn <60 ký tự
- Description ngắn <150 ký tự (tóm tắt)
- Body: 2-4 đoạn, mỗi đoạn cách nhau 1 dòng trống
- Kết bằng CTA rõ (gọi hotline, đặt phòng, inbox)
- Không dùng hashtag (Zalo không support)
- Dùng tone thân thiện, có emoji
Output JSON schema: {"title":"...", "description":"...", "body":"..."}`;
    const user = `Hotel: ${hotel_name || 'Sonder Airport'}\nTopic: ${prompt}`;
    const result = await smartCascade({ system, user, json: true, temperature: 0.7, maxTokens: 1500 });
    let content: any = null;
    try {
      content = JSON.parse(result.text);
    } catch {
      // If AI didn't return valid JSON, fallback: treat all as body
      content = { title: prompt.slice(0, 60), description: prompt.slice(0, 150), body: result.text };
    }
    res.json({ ok: true, content, provider: result.provider, latency_ms: result.latency_ms });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e?.message });
  }
});

export default router;

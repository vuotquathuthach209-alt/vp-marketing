/**
 * Sync Hub Routes — v14.
 * /api/sync/* — 6 endpoints cho OTA team + Bot internal.
 *
 * Auth: HMAC SHA256 signature
 *   Headers:
 *     X-Key-Id: <key_id>                  // vd: 'ota-web-prod'
 *     X-Signature: sha256=<hex-digest>    // HMAC(body, secret)
 *     X-Timestamp: <unix-seconds>         // chống replay attack
 */

import { Router } from 'express';
import express from 'express';
import {
  getApiKey, verifyHmac, hasPermission, trackKeyUsage, logEvent,
  upsertAvailability, getAvailability, getAnyAvailable, findNextAvailableDate,
  createHoldBooking, confirmBooking, getPendingPmsSync, markSynced,
  cleanupExpiredHolds, getSyncStats, provisionApiKey,
} from '../services/sync-hub';
import { db } from '../db';
import { authMiddleware, AuthRequest, getHotelId } from '../middleware/auth';

const router = Router();

// Note: Express global body parser đã populate req.rawBody (index.ts line 70-72).
// Middleware này pass-through.
function rawBodyMiddleware(_req: any, _res: any, next: any) {
  next();
}

/** Middleware: verify HMAC + permission. */
function authSyncHub(requiredPerm: string) {
  return (req: any, res: any, next: any) => {
    const keyId = req.header('x-key-id');
    const sig = req.header('x-signature');
    const tsHeader = req.header('x-timestamp');

    if (!keyId || !sig) {
      logEvent({ event_type: 'auth_fail', direction: 'inbound', error: 'missing_headers', http_status: 401 });
      return res.status(401).json({ error: 'missing auth headers' });
    }

    const key = getApiKey(keyId);
    if (!key) {
      logEvent({ event_type: 'auth_fail', direction: 'inbound', actor: keyId, error: 'unknown_key', http_status: 401 });
      return res.status(401).json({ error: 'invalid key' });
    }

    // Timestamp check (chống replay, ±5 min window)
    if (tsHeader) {
      const ts = parseInt(tsHeader, 10);
      if (!isNaN(ts) && Math.abs(Date.now() / 1000 - ts) > 300) {
        logEvent({ event_type: 'auth_fail', direction: 'inbound', actor: keyId, error: 'timestamp_skew', http_status: 401 });
        return res.status(401).json({ error: 'timestamp skew too large (>5min)' });
      }
    }

    // Verify HMAC
    if (!verifyHmac(req.rawBody || '', sig, key.secret)) {
      logEvent({ event_type: 'auth_fail', direction: 'inbound', actor: keyId, error: 'bad_signature', http_status: 401 });
      return res.status(401).json({ error: 'bad signature' });
    }

    // Check permission
    if (!hasPermission(key, requiredPerm)) {
      logEvent({ event_type: 'auth_fail', direction: 'inbound', actor: keyId, error: `no_perm:${requiredPerm}`, http_status: 403 });
      return res.status(403).json({ error: `missing permission: ${requiredPerm}` });
    }

    req.apiKey = key;
    trackKeyUsage(keyId);
    next();
  };
}

/* ═══════════════════════════════════════════
   1. OTA TEAM — push availability
   ═══════════════════════════════════════════ */

router.post('/availability', rawBodyMiddleware, authSyncHub('write_availability'), (req: any, res) => {
  const t0 = Date.now();
  try {
    const { hotel_id, room_type_code, date_str, total_rooms, available_rooms, base_price, stop_sell } = req.body || {};

    // Validate
    if (!hotel_id || !room_type_code || !date_str) {
      return res.status(400).json({ error: 'hotel_id + room_type_code + date_str required' });
    }
    if (typeof total_rooms !== 'number' || typeof available_rooms !== 'number') {
      return res.status(400).json({ error: 'total_rooms + available_rooms must be numbers' });
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date_str)) {
      return res.status(400).json({ error: 'date_str must be YYYY-MM-DD' });
    }
    if (available_rooms > total_rooms) {
      return res.status(400).json({ error: 'available_rooms cannot exceed total_rooms' });
    }

    upsertAvailability({
      hotel_id, room_type_code, date_str,
      total_rooms, available_rooms,
      base_price, stop_sell,
      source: req.apiKey.key_id.includes('ota') ? 'ota' : 'manual',
    });

    logEvent({
      event_type: 'availability_push', direction: 'inbound',
      actor: req.apiKey.key_id, hotel_id, payload: req.body,
      hmac_verified: true, http_status: 200, duration_ms: Date.now() - t0,
    });

    res.json({ ok: true, hotel_id, room_type_code, date_str, available_rooms });
  } catch (e: any) {
    logEvent({
      event_type: 'availability_push', direction: 'inbound',
      actor: req.apiKey?.key_id, payload: req.body,
      error: e.message, http_status: 500,
    });
    res.status(500).json({ error: e.message });
  }
});

/** Bulk push — OTA team có thể push 100 rows/call để sync nhanh */
router.post('/availability/bulk', rawBodyMiddleware, authSyncHub('write_availability'), (req: any, res) => {
  const t0 = Date.now();
  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  if (items.length === 0) return res.status(400).json({ error: 'items[] required' });
  if (items.length > 500) return res.status(400).json({ error: 'max 500 items per call' });

  let ok = 0, failed = 0;
  const errors: string[] = [];
  for (const item of items) {
    try {
      if (!item.hotel_id || !item.room_type_code || !item.date_str) {
        failed++; errors.push('missing fields'); continue;
      }
      upsertAvailability({
        hotel_id: item.hotel_id,
        room_type_code: item.room_type_code,
        date_str: item.date_str,
        total_rooms: item.total_rooms || 0,
        available_rooms: item.available_rooms || 0,
        base_price: item.base_price,
        stop_sell: !!item.stop_sell,
        source: 'ota_bulk',
      });
      ok++;
    } catch (e: any) {
      failed++; errors.push(e.message);
    }
  }

  logEvent({
    event_type: 'availability_bulk_push', direction: 'inbound',
    actor: req.apiKey.key_id, payload: { count: items.length, ok, failed },
    hmac_verified: true, http_status: 200, duration_ms: Date.now() - t0,
  });

  res.json({ ok: true, total: items.length, succeeded: ok, failed, errors: errors.slice(0, 10) });
});

/* ═══════════════════════════════════════════
   2. QUERY availability (bot internal OR OTA read)
   ═══════════════════════════════════════════ */

router.get('/availability', rawBodyMiddleware, authSyncHub('read_availability'), (req: any, res) => {
  try {
    const hotelId = parseInt(String(req.query.hotel_id), 10);
    const dateStr = String(req.query.date_str || '');
    const roomTypeCode = req.query.room_type_code as string | undefined;

    if (!hotelId || !dateStr) {
      return res.status(400).json({ error: 'hotel_id + date_str required' });
    }

    const rows = getAvailability(hotelId, dateStr, roomTypeCode);
    res.json({ hotel_id: hotelId, date_str: dateStr, items: rows });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

/** Aggregate: any hotel available on date? — cho bot tìm alternatives */
router.get('/availability/any', rawBodyMiddleware, authSyncHub('read_availability'), (req: any, res) => {
  try {
    const dateStr = String(req.query.date_str || '');
    if (!dateStr) return res.status(400).json({ error: 'date_str required' });
    const rows = getAnyAvailable(dateStr);
    res.json({ date_str: dateStr, hotels: rows });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

/* ═══════════════════════════════════════════
   3. BOT — push booking hold (internal)
   ═══════════════════════════════════════════ */

router.post('/bookings/hold', rawBodyMiddleware, authSyncHub('write_bookings'), (req: any, res) => {
  const t0 = Date.now();
  try {
    const body = req.body || {};
    if (!body.hotel_id || !body.room_type_code || !body.checkin_date || !body.checkout_date) {
      return res.status(400).json({ error: 'hotel_id + room_type_code + checkin_date + checkout_date required' });
    }

    const booking = createHoldBooking({
      hotel_id: body.hotel_id,
      source: body.source || 'bot',
      source_ref: body.source_ref,
      room_type_code: body.room_type_code,
      checkin_date: body.checkin_date,
      checkout_date: body.checkout_date,
      nights: body.nights || 1,
      guests: body.guests,
      total_price: body.total_price,
      deposit_amount: body.deposit_amount,
      customer_name: body.customer_name,
      customer_phone: body.customer_phone,
      sender_id: body.sender_id,
      created_by: req.apiKey.key_id,
      notes: body.notes,
    });

    logEvent({
      event_type: 'booking_hold', direction: 'inbound',
      actor: req.apiKey.key_id, hotel_id: body.hotel_id, payload: body,
      hmac_verified: true, http_status: 200, duration_ms: Date.now() - t0,
    });

    res.json({ ok: true, booking_id: booking.id, expires_at: booking.expires_at });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

/** Confirm booking (sau khi OCR match) — decrement availability tự động */
router.post('/bookings/:id/confirm', rawBodyMiddleware, authSyncHub('write_bookings'), (req: any, res) => {
  const t0 = Date.now();
  try {
    const id = parseInt(req.params.id, 10);
    const body = req.body || {};
    const ok = confirmBooking(id, { deposit_proof_url: body.deposit_proof_url });
    if (!ok) return res.status(400).json({ error: 'booking not found or not in hold status' });

    logEvent({
      event_type: 'booking_confirm', direction: 'inbound',
      actor: req.apiKey.key_id, payload: { booking_id: id, ...body },
      hmac_verified: true, http_status: 200, duration_ms: Date.now() - t0,
    });

    res.json({ ok: true, booking_id: id });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

/* ═══════════════════════════════════════════
   4. OTA TEAM — poll bookings to sync to PMS
   ═══════════════════════════════════════════ */

router.get('/bookings/pending-sync', rawBodyMiddleware, authSyncHub('read_bookings'), (req: any, res) => {
  try {
    const since = parseInt(String(req.query.since || '0'), 10);
    const limit = Math.min(200, Math.max(1, parseInt(String(req.query.limit || '50'), 10)));
    const rows = getPendingPmsSync(since, limit);
    res.json({ since, count: rows.length, items: rows });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

/** OTA team confirm đã note vào PMS */
router.post('/bookings/:id/synced', rawBodyMiddleware, authSyncHub('write_bookings'), (req: any, res) => {
  const t0 = Date.now();
  try {
    const id = parseInt(req.params.id, 10);
    const { pms_booking_id } = req.body || {};
    if (!pms_booking_id) return res.status(400).json({ error: 'pms_booking_id required' });

    const ok = markSynced(id, pms_booking_id);
    if (!ok) return res.status(404).json({ error: 'booking not found' });

    logEvent({
      event_type: 'pms_sync_done', direction: 'inbound',
      actor: req.apiKey.key_id, payload: { booking_id: id, pms_booking_id },
      hmac_verified: true, http_status: 200, duration_ms: Date.now() - t0,
    });

    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

/* ═══════════════════════════════════════════
   5. Admin routes (authMiddleware, NOT HMAC — cho UI admin)
   ═══════════════════════════════════════════ */

const adminRouter = Router();
adminRouter.use(authMiddleware);

adminRouter.get('/stats', (_req: AuthRequest, res) => {
  try {
    res.json(getSyncStats());
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

adminRouter.get('/events', (req: AuthRequest, res) => {
  try {
    const limit = Math.min(500, Math.max(10, parseInt(String(req.query.limit || '50'), 10)));
    const rows = db.prepare(
      `SELECT * FROM sync_events_log ORDER BY id DESC LIMIT ?`
    ).all(limit) as any[];
    res.json({ items: rows });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

adminRouter.post('/keys/provision', (req: AuthRequest, res) => {
  try {
    const { key_id, team_name, permissions } = req.body || {};
    if (!key_id || !team_name || !Array.isArray(permissions)) {
      return res.status(400).json({ error: 'key_id + team_name + permissions[] required' });
    }
    const result = provisionApiKey(key_id, team_name, permissions);
    res.json({
      ok: true,
      key_id: result.key_id,
      secret: result.secret,
      note: 'Lưu secret này cẩn thận — sẽ không hiển thị lại!',
    });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

adminRouter.get('/availability-debug', (req: AuthRequest, res) => {
  try {
    const rows = db.prepare(
      `SELECT hotel_id, room_type_code, date_str, total_rooms, available_rooms, base_price, source, updated_at
       FROM sync_availability ORDER BY date_str ASC, hotel_id ASC LIMIT 500`
    ).all() as any[];
    res.json({ count: rows.length, items: rows });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

adminRouter.post('/seed', (req: AuthRequest, res) => {
  try {
    const { seedAvailability } = require('../services/sync-hub-seed');
    const result = seedAvailability(req.body || {});
    res.json({ ok: true, ...result });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

adminRouter.post('/seed/clear', (req: AuthRequest, res) => {
  try {
    const { clearSeedData } = require('../services/sync-hub-seed');
    const deleted = clearSeedData();
    res.json({ ok: true, deleted });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

/* ═══════════════════════════════════════════
   6. Docs page (public, no auth)
   ═══════════════════════════════════════════ */

const docsRouter = Router();
docsRouter.get('/docs', (_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(getDocsHtml());
});

function getDocsHtml(): string {
  return `<!DOCTYPE html>
<html lang="vi"><head><meta charset="utf-8"><title>VP MKT Sync Hub API</title>
<style>
body{font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;max-width:900px;margin:2em auto;padding:0 1em;line-height:1.6;color:#333}
h1{border-bottom:3px solid #0066cc;padding-bottom:.3em;color:#0066cc}
h2{color:#0066cc;margin-top:2em}h3{color:#444}
code{background:#f4f4f4;padding:2px 6px;border-radius:3px;font-family:Menlo,monospace;font-size:.9em}
pre{background:#1e1e1e;color:#d4d4d4;padding:1em;border-radius:6px;overflow-x:auto;font-size:.85em}
.method{display:inline-block;padding:2px 10px;border-radius:3px;color:#fff;font-weight:600;font-size:.85em;margin-right:.5em}
.POST{background:#49cc90}.GET{background:#61affe}
.endpoint{background:#f8f9fa;border-left:4px solid #0066cc;padding:1em;margin:1em 0;border-radius:4px}
.note{background:#fff3cd;border-left:4px solid #ffc107;padding:.8em;margin:1em 0;border-radius:4px}
.warn{background:#f8d7da;border-left:4px solid #dc3545;padding:.8em;margin:1em 0;border-radius:4px}
table{border-collapse:collapse;width:100%;margin:1em 0}
th,td{border:1px solid #ddd;padding:8px;text-align:left}
th{background:#0066cc;color:#fff}
</style></head>
<body>

<h1>🔄 VP MKT Sync Hub API</h1>

<p><strong>Base URL:</strong> <code>https://mkt.sondervn.com/api/sync</code></p>

<div class="note">
<strong>📋 Mục đích:</strong> Event broker giữa <strong>OTA Web team</strong> (source of availability) và <strong>VP MKT Bot</strong> (sales channel qua Zalo/FB).
<ul>
<li>OTA push availability updates khi inventory thay đổi (có khách book trên Booking.com, PMS, ...)</li>
<li>Bot push bookings khi khách đặt cọc qua social → OTA sync về PMS</li>
</ul>
</div>

<h2>🔐 Authentication (HMAC SHA256)</h2>

<p>Mỗi request CẦN 3 headers:</p>

<table>
<tr><th>Header</th><th>Value</th><th>Note</th></tr>
<tr><td><code>X-Key-Id</code></td><td>Key ID (vd: <code>ota-web-prod</code>)</td><td>Do admin provision</td></tr>
<tr><td><code>X-Signature</code></td><td><code>sha256=&lt;hex digest&gt;</code></td><td>HMAC của RAW body với secret</td></tr>
<tr><td><code>X-Timestamp</code></td><td>Unix seconds</td><td>Chống replay, ±5 min window</td></tr>
</table>

<h3>Ví dụ ký HMAC (Node.js):</h3>
<pre>const crypto = require('crypto');
const body = JSON.stringify(payload);
const ts = Math.floor(Date.now() / 1000);
const signature = 'sha256=' + crypto.createHmac('sha256', SECRET).update(body).digest('hex');

fetch('https://mkt.sondervn.com/api/sync/availability', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-Key-Id': 'ota-web-prod',
    'X-Signature': signature,
    'X-Timestamp': String(ts),
  },
  body,
});</pre>

<h3>Ví dụ ký HMAC (Python):</h3>
<pre>import hmac, hashlib, json, time, requests

body = json.dumps(payload, separators=(',', ':'))
ts = str(int(time.time()))
sig = 'sha256=' + hmac.new(SECRET.encode(), body.encode(), hashlib.sha256).hexdigest()

requests.post('https://mkt.sondervn.com/api/sync/availability',
  data=body,
  headers={
    'Content-Type': 'application/json',
    'X-Key-Id': 'ota-web-prod',
    'X-Signature': sig,
    'X-Timestamp': ts,
  })</pre>

<h2>📤 Endpoints cho OTA Team</h2>

<div class="endpoint">
<h3><span class="method POST">POST</span> /availability</h3>
<p>Push 1 update availability cho 1 room type × 1 date.</p>
<p><strong>Permission:</strong> <code>write_availability</code></p>

<h4>Request body:</h4>
<pre>{
  "hotel_id": 6,
  "room_type_code": "DELUXE",
  "date_str": "2026-04-25",
  "total_rooms": 10,
  "available_rooms": 3,
  "base_price": 800000,
  "stop_sell": false
}</pre>

<h4>Response:</h4>
<pre>{ "ok": true, "hotel_id": 6, "room_type_code": "DELUXE", "date_str": "2026-04-25", "available_rooms": 3 }</pre>
</div>

<div class="endpoint">
<h3><span class="method POST">POST</span> /availability/bulk</h3>
<p>Push batch. Tối đa 500 items/call.</p>
<p><strong>Permission:</strong> <code>write_availability</code></p>

<h4>Request body:</h4>
<pre>{
  "items": [
    { "hotel_id": 6, "room_type_code": "DELUXE", "date_str": "2026-04-25", "total_rooms": 10, "available_rooms": 3, "base_price": 800000 },
    { "hotel_id": 6, "room_type_code": "SUITE",  "date_str": "2026-04-25", "total_rooms": 4,  "available_rooms": 1, "base_price": 1500000 }
  ]
}</pre>
</div>

<div class="endpoint">
<h3><span class="method GET">GET</span> /bookings/pending-sync?since=&lt;timestamp&gt;&amp;limit=50</h3>
<p>Poll bookings cần OTA/PMS cập nhật. <strong>Poll mỗi 1-5 phút.</strong></p>
<p><strong>Permission:</strong> <code>read_bookings</code></p>

<h4>Query params:</h4>
<ul>
<li><code>since</code> — timestamp (ms) của lần poll trước</li>
<li><code>limit</code> — default 50, max 200</li>
</ul>

<h4>Response:</h4>
<pre>{
  "since": 1776801000000,
  "count": 2,
  "items": [
    {
      "id": 123,
      "hotel_id": 6,
      "source": "bot",
      "room_type_code": "DELUXE",
      "checkin_date": "2026-04-25",
      "checkout_date": "2026-04-27",
      "nights": 2,
      "guests": 2,
      "total_price": 1600000,
      "deposit_amount": 500000,
      "deposit_paid": 1,
      "customer_name": "Nguyễn Văn A",
      "customer_phone": "0909123456",
      "status": "confirmed",
      "created_at": 1776801234567,
      "updated_at": 1776802345678
    }
  ]
}</pre>
</div>

<div class="endpoint">
<h3><span class="method POST">POST</span> /bookings/:id/synced</h3>
<p>Confirm đã note booking vào PMS.</p>
<p><strong>Permission:</strong> <code>write_bookings</code></p>

<h4>Request body:</h4>
<pre>{ "pms_booking_id": "PMS-XYZ-123" }</pre>
</div>

<h2>🤝 Flow khuyến nghị cho OTA team</h2>

<ol>
<li>Khi PMS báo inventory thay đổi → call <code>POST /availability</code></li>
<li>Hoặc batch 1x/10 phút: gom updates → <code>POST /availability/bulk</code></li>
<li>Cron mỗi 3 phút: <code>GET /bookings/pending-sync?since=&lt;last_poll_ts&gt;</code></li>
<li>Với mỗi booking returned:
  <ul>
  <li>Create trong PMS</li>
  <li>Call <code>POST /bookings/:id/synced</code> với PMS booking ID</li>
  </ul>
</li>
</ol>

<h2>📊 Response codes</h2>

<table>
<tr><th>Code</th><th>Meaning</th></tr>
<tr><td>200</td><td>OK</td></tr>
<tr><td>400</td><td>Validation fail (thiếu field, format sai)</td></tr>
<tr><td>401</td><td>HMAC invalid / key unknown / timestamp skew</td></tr>
<tr><td>403</td><td>Key không có permission</td></tr>
<tr><td>500</td><td>Internal error</td></tr>
</table>

<div class="warn">
<strong>🚨 Lưu ý:</strong>
<ul>
<li>Secret KHÔNG bao giờ expose trong client-side code (browser)</li>
<li>Gọi từ backend OTA Web server → VP MKT thôi</li>
<li>Nếu secret bị lộ → liên hệ admin để rotate</li>
</ul>
</div>

<hr>
<p style="text-align:center;color:#999;font-size:.85em">VP MKT Sync Hub v14 · Sonder Việt Nam</p>
</body></html>`;
}

/* ═══════════════════════════════════════════
   v24 — WEBHOOK INBOUND (real-time from OTA)
   ═══════════════════════════════════════════ */

/**
 * POST /api/sync/webhook/:event
 *   event ∈ booking | availability | payment | stop-sell
 *
 * Không dùng authSyncHub middleware (HMAC verify bên trong receiveWebhook
 * để lấy raw body). Thay vào đó verify HMAC với shared secret từ settings.
 */
router.post('/webhook/:event', rawBodyMiddleware, async (req: any, res) => {
  const sig = req.header('x-signature') || '';
  const eventName = req.params.event;
  // Shared secret — khác với các API key per-team
  const { getSetting } = require('../db');
  const secret = getSetting('ota_webhook_secret');
  if (!secret) {
    return res.status(500).json({ error: 'webhook_secret not configured yet' });
  }

  try {
    const { receiveWebhook } = require('../services/sync-webhook');
    const rawBody = req.rawBody || JSON.stringify(req.body);
    const result = await receiveWebhook(rawBody, sig, secret);

    if (!result.ok && result.error === 'invalid_signature') return res.status(401).json(result);
    if (!result.ok) return res.status(400).json(result);
    return res.json(result);
  } catch (e: any) {
    console.error('[webhook] route error:', e?.message);
    return res.status(500).json({ error: 'webhook_processing_failed' });
  }
});

/* ═══════════════════════════════════════════
   v24 — SYNC STATUS (internal dashboard)
   ═══════════════════════════════════════════ */

/** GET /api/sync/status — unified health dashboard */
router.get('/status', authMiddleware, (_req: AuthRequest, res) => {
  try {
    const { getOutboxStats } = require('../services/sync-outbox');
    const outboxStats = getOutboxStats();

    // Last pull times (from sync_events_log)
    const lastPull = db.prepare(
      `SELECT event_type, MAX(created_at) as last_at
       FROM sync_events_log
       WHERE event_type LIKE 'pull_%' OR event_type LIKE 'ota_sync_%'
       GROUP BY event_type`
    ).all() as any[];

    // Webhook stats (last 24h)
    const day = Date.now() - 24 * 3600_000;
    const webhookStats = db.prepare(
      `SELECT event_type,
              COUNT(*) as total,
              SUM(CASE WHEN processed = 1 THEN 1 ELSE 0 END) as processed,
              SUM(CASE WHEN error IS NOT NULL THEN 1 ELSE 0 END) as errors
       FROM sync_webhook_inbound
       WHERE received_at > ?
       GROUP BY event_type`
    ).all(day) as any[];

    // Conflicts pending
    const pendingConflicts = (db.prepare(
      `SELECT COUNT(*) as n FROM sync_conflicts WHERE resolution = 'manual_pending'`
    ).get() as any)?.n || 0;

    // Bot bookings not yet pushed
    const unpushed = (db.prepare(
      `SELECT COUNT(*) as n FROM sync_bookings
       WHERE source = 'bot' AND status = 'confirmed' AND synced_to_pms_at IS NULL`
    ).get() as any)?.n || 0;

    res.json({
      outbox: outboxStats,
      last_pulls: lastPull,
      webhooks_24h: webhookStats,
      pending_conflicts: pendingConflicts,
      bot_bookings_awaiting_push: unpushed,
      now: Date.now(),
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

/** GET /api/sync/outbox — list items (admin) */
router.get('/outbox', authMiddleware, (req: AuthRequest, res) => {
  try {
    const status = String(req.query.status || 'all');
    const limit = Math.min(200, parseInt(String(req.query.limit || '50'), 10));
    const where = status === 'all' ? '' : `WHERE status = ?`;
    const sql = `SELECT id, idempotency_key, op_type, hotel_id, aggregate_id,
                        status, attempts, last_error, next_retry_at, ota_ref,
                        created_at, pushed_at
                 FROM sync_outbox ${where}
                 ORDER BY created_at DESC LIMIT ?`;
    const rows = status === 'all'
      ? db.prepare(sql).all(limit) as any[]
      : db.prepare(sql).all(status, limit) as any[];
    res.json({ items: rows });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

/** GET /api/sync/dlq — Dead letter queue items */
router.get('/dlq', authMiddleware, (_req: AuthRequest, res) => {
  try {
    const { listDlq } = require('../services/sync-outbox');
    res.json({ items: listDlq(100) });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

/** POST /api/sync/dlq/:id/retry — Admin manual retry */
router.post('/dlq/:id/retry', authMiddleware, (req: AuthRequest, res) => {
  try {
    const { retryDlq } = require('../services/sync-outbox');
    const id = parseInt(String(req.params.id), 10);
    if (isNaN(id)) return res.status(400).json({ error: 'invalid id' });
    const ok = retryDlq(id);
    res.json({ ok });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

/** POST /api/sync/outbox/process — Force worker tick */
router.post('/outbox/process', authMiddleware, async (_req: AuthRequest, res) => {
  try {
    const { processOutbox } = require('../services/sync-outbox');
    const result = await processOutbox(50);
    res.json(result);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

/** GET /api/sync/conflicts — List pending manual conflicts */
router.get('/conflicts', authMiddleware, (_req: AuthRequest, res) => {
  try {
    const { listManualConflicts } = require('../services/sync-conflict-resolver');
    res.json({ items: listManualConflicts(50) });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

/** POST /api/sync/conflicts/:id/resolve — Admin resolve a conflict */
router.post('/conflicts/:id/resolve', authMiddleware, (req: AuthRequest, res) => {
  try {
    const { resolveManually } = require('../services/sync-conflict-resolver');
    const id = parseInt(String(req.params.id), 10);
    const { winner } = req.body || {};
    if (!['mkt', 'ota'].includes(winner)) {
      return res.status(400).json({ error: 'winner must be mkt or ota' });
    }
    const ok = resolveManually(id, winner, String(req.user?.email || 'admin'));
    res.json({ ok });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

export { router as syncHubRouter, adminRouter as syncHubAdminRouter, docsRouter as syncHubDocsRouter };

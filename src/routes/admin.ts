import { Router } from 'express';
import { authMiddleware, superadminOnly, AuthRequest } from '../middleware/auth';
import { db, getSetting, setSetting } from '../db';
import { getOtaHotels } from '../services/ota-db';
import { autoGenWikiFromOta } from '../services/ota-sync';
import { getCachedHotels } from '../services/ota-sync';
import { sendEmail, inviteHotelEmail, sendBulkInvites, sendAlertToAdmin } from '../services/email';
import { funnel, topEvents } from '../services/events';

const router = Router();
router.use(authMiddleware);
router.use(superadminOnly);

/**
 * Sprint 9 Phase 1 — Admin Panel API
 *
 * Super admin only — quản lý hotels, mở quyền, chọn plan.
 */

// GET /api/admin/hotels — list tất cả MKT hotels + trạng thái
router.get('/hotels', (_req, res) => {
  const hotels = db.prepare(`
    SELECT h.*,
      (SELECT COUNT(*) FROM mkt_users WHERE hotel_id = h.id AND status = 'active') as user_count,
      (SELECT COUNT(*) FROM pages WHERE hotel_id = h.id) as page_count,
      c.name as ota_name, c.city as ota_city, c.star_rating as ota_star, c.owner_email
    FROM mkt_hotels h
    LEFT JOIN mkt_hotels_cache c ON c.ota_hotel_id = h.ota_hotel_id
    ORDER BY h.id
  `).all();
  res.json(hotels);
});

// GET /api/admin/ota-hotels — list hotels từ OTA (chưa link)
router.get('/ota-hotels', async (_req, res) => {
  try {
    // Try cached first
    const cached = getCachedHotels();
    if (cached.length > 0) {
      // Mark which ones are already linked
      const linked = db.prepare(`SELECT ota_hotel_id FROM mkt_hotels WHERE ota_hotel_id IS NOT NULL`).all() as { ota_hotel_id: number }[];
      const linkedSet = new Set(linked.map(l => l.ota_hotel_id));
      const result = (cached as any[]).map(h => ({ ...h, already_linked: linkedSet.has(h.ota_hotel_id) }));
      return res.json(result);
    }
    // Fallback to live query
    const hotels = await getOtaHotels();
    const linked = db.prepare(`SELECT ota_hotel_id FROM mkt_hotels WHERE ota_hotel_id IS NOT NULL`).all() as { ota_hotel_id: number }[];
    const linkedSet = new Set(linked.map(l => l.ota_hotel_id));
    const result = hotels.map(h => ({ ...h, already_linked: linkedSet.has(h.id) }));
    res.json(result);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/admin/hotels — tạo/link MKT hotel từ OTA hotel
router.post('/hotels', async (req: AuthRequest, res) => {
  try {
    const { ota_hotel_id, name, plan, features } = req.body;
    if (!name) return res.status(400).json({ error: 'Cần name' });

    const now = Date.now();
    const r = db.prepare(`
      INSERT INTO mkt_hotels (ota_hotel_id, name, slug, plan, status, config, features, max_posts_per_day, max_pages, activated_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'active', '{}', ?, ?, ?, ?, ?, ?)
    `).run(
      ota_hotel_id || null,
      name,
      name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, ''),
      plan || 'free',
      JSON.stringify(features || { chatbot: true, autopilot: false, booking: true, analytics: true }),
      plan === 'pro' ? 5 : plan === 'starter' ? 3 : 1,
      plan === 'pro' ? 5 : plan === 'starter' ? 2 : 1,
      now, now, now
    );

    const hotelId = Number(r.lastInsertRowid);

    // Auto-provision: generate wiki from OTA data
    if (ota_hotel_id) {
      autoGenWikiFromOta(hotelId, ota_hotel_id).catch(e =>
        console.error('[admin] auto-provision wiki failed:', e.message)
      );
    }

    // Create default permissions
    const defaultFeatures = ['chatbot', 'autopilot', 'booking', 'analytics', 'ab_test'];
    for (const f of defaultFeatures) {
      db.prepare(`
        INSERT OR IGNORE INTO mkt_permissions (hotel_id, feature, enabled, updated_at)
        VALUES (?, ?, ?, ?)
      `).run(hotelId, f, plan === 'free' && f === 'autopilot' ? 0 : 1, now);
    }

    res.json({ ok: true, hotelId });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

// PUT /api/admin/hotels/:id — update hotel plan/status
// v23: enum validation + bounds check
const VALID_PLANS = new Set(['free', 'starter', 'pro', 'enterprise']);
const VALID_HOTEL_STATUS = new Set(['active', 'paused', 'cancelled', 'trial']);

router.put('/hotels/:id', (req: AuthRequest, res) => {
  const id = parseInt(req.params.id as string, 10);
  if (isNaN(id) || id <= 0) return res.status(400).json({ error: 'invalid id' });

  const { plan, status, features, max_posts_per_day, max_pages } = req.body || {};
  const now = Date.now();

  // v23: whitelist enums
  if (plan !== undefined && !VALID_PLANS.has(String(plan))) {
    return res.status(400).json({ error: `invalid plan (allowed: ${[...VALID_PLANS].join(', ')})` });
  }
  if (status !== undefined && !VALID_HOTEL_STATUS.has(String(status))) {
    return res.status(400).json({ error: `invalid status (allowed: ${[...VALID_HOTEL_STATUS].join(', ')})` });
  }

  const sets: string[] = ['updated_at = ?'];
  const vals: any[] = [now];

  if (plan) { sets.push('plan = ?'); vals.push(String(plan)); }
  if (status) { sets.push('status = ?'); vals.push(String(status)); }
  if (features) {
    // v23: strip obviously invalid feature payloads
    if (typeof features !== 'object' || Array.isArray(features)) {
      return res.status(400).json({ error: 'features must be object' });
    }
    sets.push('features = ?'); vals.push(JSON.stringify(features).slice(0, 4000));
  }
  if (max_posts_per_day !== undefined) {
    const n = Math.max(0, Math.min(100, parseInt(String(max_posts_per_day), 10) || 0));
    sets.push('max_posts_per_day = ?'); vals.push(n);
  }
  if (max_pages !== undefined) {
    const n = Math.max(0, Math.min(50, parseInt(String(max_pages), 10) || 0));
    sets.push('max_pages = ?'); vals.push(n);
  }

  vals.push(id);
  // Note: `sets` contains only hardcoded column names from the if-branches above
  // → no user input is interpolated into SQL. Parameters are all `?`.
  db.prepare(`UPDATE mkt_hotels SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  res.json({ ok: true });
});

// DELETE /api/admin/hotels/:id — soft delete (set status=cancelled)
router.delete('/hotels/:id', (req, res) => {
  const id = parseInt(req.params.id);
  if (id === 1) return res.status(400).json({ error: 'Không thể xoá hotel mặc định' });
  db.prepare(`UPDATE mkt_hotels SET status = 'cancelled', updated_at = ? WHERE id = ?`).run(Date.now(), id);
  res.json({ ok: true });
});

// GET /api/admin/hotels/:id/users — list users of a hotel
router.get('/hotels/:id/users', (req, res) => {
  const id = parseInt(req.params.id);
  const users = db.prepare(`SELECT * FROM mkt_users WHERE hotel_id = ? ORDER BY id`).all(id);
  res.json(users);
});

// POST /api/admin/hotels/:id/users — add user to hotel
router.post('/hotels/:id/users', (req, res) => {
  const hotelId = parseInt(req.params.id);
  const { email, role, display_name, ota_owner_id } = req.body;
  if (!email) return res.status(400).json({ error: 'Cần email' });

  const now = Date.now();
  try {
    const r = db.prepare(`
      INSERT INTO mkt_users (email, hotel_id, ota_owner_id, role, display_name, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'active', ?, ?)
    `).run(email, hotelId, ota_owner_id || null, role || 'owner', display_name || email, now, now);
    res.json({ ok: true, userId: Number(r.lastInsertRowid) });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

// GET /api/admin/stats — overview stats
router.get('/stats', (_req, res) => {
  const hotels = db.prepare(`SELECT
    COUNT(*) as total,
    COUNT(*) FILTER (WHERE status = 'active') as active,
    COUNT(*) FILTER (WHERE plan = 'free') as free_plan,
    COUNT(*) FILTER (WHERE plan = 'starter') as starter_plan,
    COUNT(*) FILTER (WHERE plan = 'pro') as pro_plan
  FROM mkt_hotels`).get() as any;

  const users = db.prepare(`SELECT COUNT(*) as total FROM mkt_users WHERE status = 'active'`).get() as any;
  const pages = db.prepare(`SELECT COUNT(*) as total FROM pages`).get() as any;
  const posts7d = db.prepare(`SELECT COUNT(*) as total FROM posts WHERE created_at > ?`).get(Date.now() - 7 * 86400000) as any;

  res.json({
    hotels: hotels || {},
    total_users: users?.total || 0,
    total_pages: pages?.total || 0,
    posts_last_7d: posts7d?.total || 0,
  });
});

// GET /api/admin/permissions/:hotelId
router.get('/permissions/:hotelId', (req, res) => {
  const hotelId = parseInt(req.params.hotelId);
  const perms = db.prepare(`SELECT * FROM mkt_permissions WHERE hotel_id = ?`).all(hotelId);
  res.json(perms);
});

// POST /api/admin/permissions/:hotelId — update permissions
router.post('/permissions/:hotelId', (req, res) => {
  const hotelId = parseInt(req.params.hotelId);
  const { feature, enabled } = req.body;
  if (!feature) return res.status(400).json({ error: 'Cần feature' });

  db.prepare(`
    INSERT INTO mkt_permissions (hotel_id, feature, enabled, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(hotel_id, feature) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at
  `).run(hotelId, feature, enabled ? 1 : 0, Date.now());

  res.json({ ok: true });
});

// POST /api/admin/invite-hotel — gửi email mời 1 hotel
router.post('/invite-hotel', async (req: AuthRequest, res) => {
  const { hotel_id, email } = req.body;
  if (!hotel_id || !email) return res.status(400).json({ error: 'Thieu hotel_id hoac email' });

  const hotel = db.prepare(`SELECT name FROM mkt_hotels WHERE id = ?`).get(hotel_id) as any;
  if (!hotel) return res.status(404).json({ error: 'Hotel not found' });

  const cache = db.prepare(`SELECT owner_name FROM mkt_hotels_cache WHERE ota_hotel_id = (SELECT ota_hotel_id FROM mkt_hotels WHERE id = ?)`).get(hotel_id) as any;
  const loginUrl = `${req.protocol}://${req.get('host')}`;
  const template = inviteHotelEmail(hotel.name, cache?.owner_name || 'Anh/Chi', loginUrl);
  const ok = await sendEmail({ ...template, to: email });
  res.json({ ok, email });
});

// POST /api/admin/invite-all — gửi bulk invite tới tất cả hotels
router.post('/invite-all', async (req: AuthRequest, res) => {
  const loginUrl = `${req.protocol}://${req.get('host')}`;
  const result = await sendBulkInvites(loginUrl);
  res.json(result);
});

// GET /api/admin/email-log — lịch sử gửi email
router.get('/email-log', (req: AuthRequest, res) => {
  const rows = db.prepare(`SELECT * FROM email_log ORDER BY id DESC LIMIT 200`).all();
  res.json(rows);
});

// POST /api/admin/test-alert — test alert system
router.post('/test-alert', async (req: AuthRequest, res) => {
  await sendAlertToAdmin('Test Alert', 'Day la email test tu VP Marketing admin panel.');
  res.json({ ok: true });
});

// GET /api/admin/payments — all payments (admin view)
router.get('/payments', (req: AuthRequest, res) => {
  const rows = db.prepare(`
    SELECT p.*, h.name as hotel_name
    FROM payments p LEFT JOIN mkt_hotels h ON h.id = p.hotel_id
    ORDER BY p.created_at DESC LIMIT 200
  `).all();
  res.json(rows);
});

// POST /api/admin/confirm-bank-transfer — xác nhận chuyển khoản manual
router.post('/confirm-bank-transfer', (req: AuthRequest, res) => {
  const { order_id } = req.body;
  if (!order_id) return res.status(400).json({ error: 'Thieu order_id' });

  const payment = db.prepare(`SELECT * FROM payments WHERE order_id = ? AND status = 'pending_verify'`).get(order_id) as any;
  if (!payment) return res.status(404).json({ error: 'Payment not found or already processed' });

  // Apply payment
  const PLAN_LIMITS: Record<string, number> = { free: 1, starter: 3, pro: 5 };
  db.prepare(`UPDATE payments SET status = 'success', updated_at = ? WHERE order_id = ?`).run(Date.now(), order_id);
  db.prepare(`UPDATE mkt_hotels SET plan = ?, max_posts_per_day = ?, updated_at = ? WHERE id = ?`)
    .run(payment.plan, PLAN_LIMITS[payment.plan] || 1, Date.now(), payment.hotel_id);

  if (payment.plan !== 'free') {
    db.prepare(`INSERT OR REPLACE INTO mkt_permissions (hotel_id, feature, enabled, updated_at) VALUES (?, 'autopilot', 1, ?)`)
      .run(payment.hotel_id, Date.now());
  }

  res.json({ ok: true, hotel_id: payment.hotel_id, plan: payment.plan });
});

// ============ System Config — quản lý từ UI, không cần Railway ============

const SYSTEM_CONFIGS = [
  // AI Keys
  'anthropic_api_key', 'deepseek_api_key', 'openai_api_key',
  'google_api_key', 'groq_api_key', 'mistral_api_key', 'fal_api_key',
  // Facebook
  'fb_app_id', 'fb_app_secret',
  // OTA DB
  'ota_db_host', 'ota_db_port', 'ota_db_name', 'ota_db_user', 'ota_db_password', 'ota_db_ssl',
  // Telegram (global)
  'telegram_bot_token', 'telegram_unlock_code',
  // SMTP Email
  'smtp_host', 'smtp_port', 'smtp_user', 'smtp_pass', 'smtp_from',
  // VNPay
  'vnp_tmn_code', 'vnp_hash_secret', 'vnp_return_url',
  // MoMo
  'momo_partner_code', 'momo_access_key', 'momo_secret_key', 'momo_return_url',
  // Bank transfer (VietQR dynamic)
  'bank_bin', 'bank_account', 'bank_holder', 'bank_name',
  // Admin contacts (public) + notifications
  'admin_zalo', 'admin_hotline', 'admin_telegram_chat_id',
  // Pricing (VND)
  'price_starter', 'price_pro', 'price_enterprise',
  // Zalo OA (platform-level)
  'zalo_app_id', 'zalo_app_secret',
  // Bank auto-approve webhook (SePay/Casso)
  'bank_webhook_secret',
  // Optional offsite DB backup
  'backup_webhook_url',
];

// GET /api/admin/system-config — lấy tất cả config (masked secrets)
router.get('/system-config', (req: AuthRequest, res) => {
  const SECRET_KEYS = ['password', 'secret', 'api_key', 'access_key', 'token', 'pass'];
  const configs: Record<string, any> = {};

  for (const key of SYSTEM_CONFIGS) {
    const val = getSetting(key) || '';
    const isSecret = SECRET_KEYS.some(s => key.includes(s));
    configs[key] = {
      value: isSecret && val ? '***' + val.slice(-6) : val,
      has_value: !!val,
      is_secret: isSecret,
    };
  }
  res.json(configs);
});

// POST /api/admin/system-config — lưu config
router.post('/system-config', (req: AuthRequest, res) => {
  const updates = req.body;
  let saved = 0;
  for (const [key, value] of Object.entries(updates)) {
    if (!SYSTEM_CONFIGS.includes(key)) continue;
    const val = String(value || '').trim();
    // Skip masked values (don't overwrite with ***)
    if (val.startsWith('***')) continue;
    if (val) {
      setSetting(key, val);
      saved++;
    }
  }
  res.json({ ok: true, saved });
});

// GET /api/admin/system-config/raw/:key — lấy giá trị thật (admin only)
router.get('/system-config/raw/:key', (req: AuthRequest, res) => {
  const key = req.params.key as string;
  if (!SYSTEM_CONFIGS.includes(key)) return res.status(400).json({ error: 'Invalid key' });
  res.json({ key, value: getSetting(key) || '' });
});

// ── Funnel + events analytics ──────────────────────────────────────────
router.get('/funnel', (req: AuthRequest, res) => {
  const days = Math.max(1, Math.min(90, parseInt(String(req.query.days || '30'), 10) || 30));
  const sinceMs = Date.now() - days * 24 * 3600_000;
  const steps = ['pricing_view', 'plan_selected', 'proof_submitted', 'plan_approved'];
  res.json({ days, since: sinceMs, funnel: funnel(steps, sinceMs) });
});

router.get('/events/top', (req: AuthRequest, res) => {
  const days = Math.max(1, Math.min(90, parseInt(String(req.query.days || '7'), 10) || 7));
  const sinceMs = Date.now() - days * 24 * 3600_000;
  res.json({ days, top: topEvents(sinceMs, 30) });
});

// v6 Sprint 4: Manual QA promotion trigger (admin only)
router.post('/qa-promote', async (_req: AuthRequest, res) => {
  try {
    const { runDailyPromotion } = require('../services/qa-promoter');
    const stats = await runDailyPromotion();
    res.json({ ok: true, stats });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// v6 Sprint 8: Stalled-lead re-engagement manual trigger
router.post('/stalled-reengage', async (_req: AuthRequest, res) => {
  try {
    const { runReengagement } = require('../services/stalled-lead');
    const stats = await runReengagement();
    res.json({ ok: true, stats });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// v6 Sprint 8: Bot health report on demand
router.get('/health-report', async (req: AuthRequest, res) => {
  try {
    const { computeHealthReport } = require('../services/bot-health');
    const hours = Math.max(1, Math.min(168, parseInt(String(req.query.hours || '24'), 10) || 24));
    const report = computeHealthReport(hours);
    res.json(report);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// v7: Hotel Knowledge ETL
router.post('/etl/run', async (req: AuthRequest, res) => {
  try {
    const { runEtl } = require('../services/etl-runner');
    const { force, limit, targetHotelIds } = req.body || {};
    const result = await runEtl({
      force: !!force,
      limit: limit ? parseInt(limit, 10) : undefined,
      targetHotelIds: Array.isArray(targetHotelIds) ? targetHotelIds.map(Number) : undefined,
      trigger: 'api',
    });
    res.json({ ok: true, result });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/etl/stats', (req: AuthRequest, res) => {
  try {
    const { getEtlStats } = require('../services/etl-runner');
    const days = Math.max(1, Math.min(90, parseInt(String(req.query.days || '30'), 10) || 30));
    res.json(getEtlStats(days));
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/etl/knowledge/:hotelId', (req: AuthRequest, res) => {
  try {
    const { getProfile, getRooms, getAmenities, getPolicies } = require('../services/hotel-knowledge');
    const hid = parseInt(String(req.params.hotelId), 10);
    res.json({
      profile: getProfile(hid),
      rooms: getRooms(hid),
      amenities: getAmenities(hid),
      policies: getPolicies(hid),
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

export default router;

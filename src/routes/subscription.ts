import { Router } from 'express';
import { db } from '../db';
import { authMiddleware, AuthRequest, getHotelId, superadminOnly } from '../middleware/auth';

const router = Router();

/**
 * Phase 4 — Subscription & Plan Management (MVP 2026)
 *
 * Pricing (VND / tháng):
 *   free       — 0đ         — trial 7 ngày
 *   starter    — 300.000đ   — 1 FB page, chatbot + autopilot
 *   pro        — 600.000đ   — 3 FB pages, full features
 *   enterprise — 1.500.000đ — multi-page, priority support, white-label
 *
 * Luồng thanh toán:
 *   1. KS gọi POST /upgrade { plan } → tạo subscription_requests (status=pending)
 *   2. KS chuyển khoản → POST /submit-proof { request_id, proof_url }
 *   3. Admin xem /admin/requests → POST /admin/approve hoặc /admin/reject
 *   4. Khi approve → update mkt_hotels.plan + plan_expires_at (+30 ngày)
 */

const PLAN_LIMITS: Record<string, any> = {
  free:       { max_posts_per_day: 1, max_pages: 1, autopilot: false, campaigns: 1,  wiki: 20,   ai_calls_per_day: 50 },
  starter:    { max_posts_per_day: 3, max_pages: 1, autopilot: true,  campaigns: 5,  wiki: 100,  ai_calls_per_day: 200 },
  pro:        { max_posts_per_day: 5, max_pages: 3, autopilot: true,  campaigns: 20, wiki: 500,  ai_calls_per_day: 1000 },
  enterprise: { max_posts_per_day: 20,max_pages: 10,autopilot: true,  campaigns: 100,wiki: 5000, ai_calls_per_day: 10000 },
};

function getPrice(plan: string): number {
  const raw = db.prepare(`SELECT value FROM settings WHERE key = ?`).get(`price_${plan}`) as { value: string } | undefined;
  if (raw && raw.value) return parseInt(raw.value, 10);
  const defaults: Record<string, number> = { free: 0, starter: 300000, pro: 600000, enterprise: 1500000 };
  return defaults[plan] || 0;
}

// ========= Public (no auth) =========

// GET /api/subscription/plans — public pricing list
router.get('/plans', (_req, res) => {
  res.json({
    plans: ['free', 'starter', 'pro', 'enterprise'].map(id => ({
      id,
      name: id.charAt(0).toUpperCase() + id.slice(1),
      price_vnd: getPrice(id),
      ...PLAN_LIMITS[id],
    })),
  });
});

// ========= Authed (hotel users) =========

router.use(authMiddleware);

// GET /api/subscription/current
router.get('/current', (req: AuthRequest, res) => {
  const hotelId = getHotelId(req);
  const hotel = db.prepare(
    `SELECT id, name, plan, status, max_posts_per_day, activated_at, plan_expires_at, trial_ends_at FROM mkt_hotels WHERE id = ?`
  ).get(hotelId) as any;
  if (!hotel) return res.status(404).json({ error: 'Hotel not found' });

  const limits = PLAN_LIMITS[hotel.plan] || PLAN_LIMITS.free;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const todayMs = today.getTime();
  const postsToday = (db.prepare(`SELECT COUNT(*) as n FROM posts WHERE hotel_id = ? AND created_at > ?`).get(hotelId, todayMs) as any)?.n || 0;
  const aiToday = (db.prepare(`SELECT COUNT(*) as n FROM ai_usage_log WHERE hotel_id = ? AND created_at > ?`).get(hotelId, todayMs) as any)?.n || 0;
  const pagesCount = (db.prepare(`SELECT COUNT(*) as n FROM pages WHERE hotel_id = ?`).get(hotelId) as any)?.n || 0;
  const wikiCount = (db.prepare(`SELECT COUNT(*) as n FROM knowledge_wiki WHERE hotel_id = ? AND active = 1`).get(hotelId) as any)?.n || 0;

  // Trạng thái: active / expired / pending (chờ duyệt đơn nâng cấp)
  const now = Date.now();
  let banner: string | null = null;
  if (hotel.plan_expires_at && hotel.plan_expires_at < now) banner = 'expired';
  else if (hotel.trial_ends_at && hotel.trial_ends_at < now && hotel.plan === 'free') banner = 'trial_expired';

  const pendingReq = db.prepare(
    `SELECT id, requested_plan, status, created_at FROM subscription_requests
     WHERE hotel_id = ? AND status IN ('pending','awaiting_proof','proof_submitted') ORDER BY id DESC LIMIT 1`
  ).get(hotelId) as any;

  res.json({
    hotel_id: hotelId,
    hotel_name: hotel.name,
    plan: hotel.plan,
    status: hotel.status,
    plan_expires_at: hotel.plan_expires_at,
    trial_ends_at: hotel.trial_ends_at,
    banner,
    pending_request: pendingReq || null,
    limits,
    usage: {
      posts_today: postsToday,
      ai_calls_today: aiToday,
      pages: pagesCount,
      wiki_entries: wikiCount,
    },
    usage_percent: {
      posts: Math.round((postsToday / limits.max_posts_per_day) * 100),
      ai: Math.round((aiToday / limits.ai_calls_per_day) * 100),
      pages: Math.round((pagesCount / limits.max_pages) * 100),
      wiki: Math.round((wikiCount / limits.wiki) * 100),
    },
  });
});

// POST /api/subscription/upgrade — tạo request nâng cấp
router.post('/upgrade', (req: AuthRequest, res) => {
  const hotelId = getHotelId(req);
  const { plan } = req.body;
  if (!plan || !PLAN_LIMITS[plan]) {
    return res.status(400).json({ error: 'Plan không hợp lệ. Chọn: free, starter, pro, enterprise' });
  }
  const hotel = db.prepare(`SELECT plan FROM mkt_hotels WHERE id = ?`).get(hotelId) as any;
  if (!hotel) return res.status(404).json({ error: 'Hotel not found' });

  // Downgrade free → áp dụng ngay
  if (plan === 'free') {
    const limits = PLAN_LIMITS.free;
    db.prepare(`UPDATE mkt_hotels SET plan = ?, max_posts_per_day = ?, updated_at = ? WHERE id = ?`)
      .run(plan, limits.max_posts_per_day, Date.now(), hotelId);
    return res.json({ ok: true, applied: true, plan });
  }

  const price = getPrice(plan);
  const result = db.prepare(`
    INSERT INTO subscription_requests (hotel_id, current_plan, requested_plan, amount, status, created_at)
    VALUES (?, ?, ?, ?, 'awaiting_proof', ?)
  `).run(hotelId, hotel.plan, plan, price, Date.now());

  // Telegram notify admin (best effort)
  try {
    const { notifyAdmin } = require('../services/telegram');
    if (typeof notifyAdmin === 'function') {
      notifyAdmin(`🆕 Đơn nâng cấp mới\nHotel #${hotelId}\n${hotel.plan} → *${plan}* (${price.toLocaleString('vi')}đ)\nRequest ID: ${result.lastInsertRowid}`).catch(() => {});
    }
  } catch {}

  res.json({
    ok: true,
    request_id: result.lastInsertRowid,
    applied: false,
    plan,
    price_vnd: price,
    message: 'Chuyển khoản theo QR rồi submit ảnh bill để admin duyệt',
  });
});

// POST /api/subscription/submit-proof — KS gửi ảnh bill
router.post('/submit-proof', (req: AuthRequest, res) => {
  const hotelId = getHotelId(req);
  const { request_id, proof_url, note } = req.body;
  if (!request_id || !proof_url) return res.status(400).json({ error: 'Thiếu request_id hoặc proof_url' });

  const reqRow = db.prepare(`SELECT id, hotel_id FROM subscription_requests WHERE id = ? AND hotel_id = ?`).get(request_id, hotelId) as any;
  if (!reqRow) return res.status(404).json({ error: 'Không tìm thấy đơn' });

  db.prepare(
    `UPDATE subscription_requests SET proof_url = ?, admin_note = COALESCE(?, admin_note), status = 'proof_submitted' WHERE id = ?`
  ).run(proof_url, note || null, request_id);

  try {
    const { notifyAdmin } = require('../services/telegram');
    if (typeof notifyAdmin === 'function') {
      notifyAdmin(`💸 Bill đã gửi\nRequest #${request_id} (Hotel #${hotelId})\nProof: ${proof_url}`).catch(() => {});
    }
  } catch {}

  res.json({ ok: true });
});

// ========= Superadmin =========

// GET /api/subscription/admin/requests — all requests
router.get('/admin/requests', superadminOnly, (req: AuthRequest, res) => {
  const status = (req.query.status as string) || '';
  const where = status ? `WHERE r.status = ?` : '';
  const stmt = db.prepare(`
    SELECT r.*, h.name as hotel_name
    FROM subscription_requests r
    LEFT JOIN mkt_hotels h ON h.id = r.hotel_id
    ${where}
    ORDER BY r.created_at DESC LIMIT 200
  `);
  const rows = status ? stmt.all(status) : stmt.all();
  res.json(rows);
});

// POST /api/subscription/admin/approve
router.post('/admin/approve', superadminOnly, (req: AuthRequest, res) => {
  const { request_id, note } = req.body;
  if (!request_id) return res.status(400).json({ error: 'Thiếu request_id' });

  const r = db.prepare(`SELECT * FROM subscription_requests WHERE id = ?`).get(request_id) as any;
  if (!r) return res.status(404).json({ error: 'Không tìm thấy đơn' });

  const plan = r.requested_plan;
  const limits = PLAN_LIMITS[plan];
  if (!limits) return res.status(400).json({ error: 'Plan không hợp lệ' });

  const now = Date.now();
  const expires = now + 30 * 24 * 60 * 60 * 1000; // 30 ngày

  db.prepare(
    `UPDATE mkt_hotels SET plan = ?, max_posts_per_day = ?, max_pages = ?, status = 'active', plan_expires_at = ?, activated_at = COALESCE(activated_at, ?), updated_at = ? WHERE id = ?`
  ).run(plan, limits.max_posts_per_day, limits.max_pages, expires, now, now, r.hotel_id);

  db.prepare(
    `UPDATE subscription_requests SET status = 'approved', reviewed_by = ?, reviewed_at = ?, admin_note = ? WHERE id = ?`
  ).run((req as any).user?.id || null, now, note || null, request_id);

  try {
    const { notifyAdmin } = require('../services/telegram');
    if (typeof notifyAdmin === 'function') {
      notifyAdmin(`✅ Đã duyệt đơn #${request_id} — Hotel #${r.hotel_id} → ${plan}`).catch(() => {});
    }
  } catch {}

  res.json({ ok: true, hotel_id: r.hotel_id, plan, expires_at: expires });
});

// POST /api/subscription/admin/reject
router.post('/admin/reject', superadminOnly, (req: AuthRequest, res) => {
  const { request_id, reason } = req.body;
  if (!request_id) return res.status(400).json({ error: 'Thiếu request_id' });

  db.prepare(
    `UPDATE subscription_requests SET status = 'rejected', reviewed_by = ?, reviewed_at = ?, admin_note = ? WHERE id = ?`
  ).run((req as any).user?.id || null, Date.now(), reason || 'Từ chối', request_id);

  res.json({ ok: true });
});

export default router;

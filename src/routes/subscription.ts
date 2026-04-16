import { Router } from 'express';
import { db } from '../db';
import { authMiddleware, AuthRequest, getHotelId, superadminOnly } from '../middleware/auth';

const router = Router();
router.use(authMiddleware);

/**
 * Phase 4 — Subscription & Plan Management
 *
 * Plans:
 *   free    — 1 post/day, basic chatbot, no autopilot
 *   starter — 3 posts/day, chatbot + autopilot, 1 FB page
 *   pro     — 5 posts/day, full features, multi-page, priority support
 */

const PLAN_LIMITS: Record<string, any> = {
  free:    { max_posts_per_day: 1, max_pages: 1, autopilot: false, campaigns: 1, wiki: 20,  ai_calls_per_day: 50 },
  starter: { max_posts_per_day: 3, max_pages: 1, autopilot: true,  campaigns: 5, wiki: 100, ai_calls_per_day: 200 },
  pro:     { max_posts_per_day: 5, max_pages: 5, autopilot: true,  campaigns: 20, wiki: 500, ai_calls_per_day: 1000 },
};

// GET /api/subscription/plans — available plans
router.get('/plans', (req, res) => {
  res.json({
    plans: [
      { id: 'free',    name: 'Free',    price_vnd: 0,        ...PLAN_LIMITS.free },
      { id: 'starter', name: 'Starter', price_vnd: 499000,   ...PLAN_LIMITS.starter },
      { id: 'pro',     name: 'Pro',     price_vnd: 1299000,  ...PLAN_LIMITS.pro },
    ],
  });
});

// GET /api/subscription/current — current hotel's subscription
router.get('/current', (req: AuthRequest, res) => {
  const hotelId = getHotelId(req);
  const hotel = db.prepare(`SELECT id, name, plan, status, max_posts_per_day, activated_at FROM mkt_hotels WHERE id = ?`).get(hotelId) as any;
  if (!hotel) return res.status(404).json({ error: 'Hotel not found' });

  const limits = PLAN_LIMITS[hotel.plan] || PLAN_LIMITS.free;

  // Usage today
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const todayMs = today.getTime();
  const postsToday = (db.prepare(`SELECT COUNT(*) as n FROM posts WHERE hotel_id = ? AND created_at > ?`).get(hotelId, todayMs) as any)?.n || 0;
  const aiToday = (db.prepare(`SELECT COUNT(*) as n FROM ai_usage_log WHERE hotel_id = ? AND created_at > ?`).get(hotelId, todayMs) as any)?.n || 0;
  const pagesCount = (db.prepare(`SELECT COUNT(*) as n FROM pages WHERE hotel_id = ?`).get(hotelId) as any)?.n || 0;
  const wikiCount = (db.prepare(`SELECT COUNT(*) as n FROM knowledge_wiki WHERE hotel_id = ? AND active = 1`).get(hotelId) as any)?.n || 0;

  res.json({
    hotel_id: hotelId,
    hotel_name: hotel.name,
    plan: hotel.plan,
    status: hotel.status,
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

// POST /api/subscription/upgrade — request plan upgrade
router.post('/upgrade', (req: AuthRequest, res) => {
  const hotelId = getHotelId(req);
  const { plan } = req.body;

  if (!plan || !PLAN_LIMITS[plan]) {
    return res.status(400).json({ error: 'Plan khong hop le. Chon: free, starter, pro' });
  }

  const hotel = db.prepare(`SELECT plan FROM mkt_hotels WHERE id = ?`).get(hotelId) as any;
  if (!hotel) return res.status(404).json({ error: 'Hotel not found' });

  if (hotel.plan === plan) {
    return res.status(400).json({ error: 'Da su dung plan nay roi' });
  }

  // Log upgrade request (in real system, this would trigger payment flow)
  db.prepare(`
    INSERT INTO subscription_requests (hotel_id, current_plan, requested_plan, status, created_at)
    VALUES (?, ?, ?, 'pending', ?)
  `).run(hotelId, hotel.plan, plan, Date.now());

  // For free plan downgrade, apply immediately
  if (plan === 'free') {
    const limits = PLAN_LIMITS.free;
    db.prepare(`UPDATE mkt_hotels SET plan = ?, max_posts_per_day = ?, updated_at = ? WHERE id = ?`)
      .run(plan, limits.max_posts_per_day, Date.now(), hotelId);
    return res.json({ ok: true, applied: true, plan });
  }

  // For paid plans, return payment info (placeholder for VNPay/MoMo)
  res.json({
    ok: true,
    applied: false,
    plan,
    price_vnd: plan === 'starter' ? 499000 : 1299000,
    message: 'Vui long thanh toan de kich hoat plan',
    payment_methods: ['vnpay', 'momo', 'bank_transfer'],
  });
});

// POST /api/subscription/confirm-payment — admin confirms payment & applies plan
router.post('/confirm-payment', superadminOnly, (req: AuthRequest, res) => {
  const { hotel_id, plan, payment_ref } = req.body;

  if (!hotel_id || !plan || !PLAN_LIMITS[plan]) {
    return res.status(400).json({ error: 'Thieu hotel_id hoac plan' });
  }

  const limits = PLAN_LIMITS[plan];
  db.prepare(`UPDATE mkt_hotels SET plan = ?, max_posts_per_day = ?, updated_at = ? WHERE id = ?`)
    .run(plan, limits.max_posts_per_day, Date.now(), hotel_id);

  // Update request status
  db.prepare(`
    UPDATE subscription_requests SET status = 'confirmed', payment_ref = ?, confirmed_at = ?
    WHERE hotel_id = ? AND requested_plan = ? AND status = 'pending'
  `).run(payment_ref || '', Date.now(), hotel_id, plan);

  // Auto-enable features based on plan
  if (limits.autopilot) {
    db.prepare(`INSERT OR REPLACE INTO mkt_permissions (hotel_id, feature, enabled) VALUES (?, 'autopilot', 1)`).run(hotel_id);
  }

  res.json({ ok: true, hotel_id, plan, limits });
});

// GET /api/subscription/requests — admin: all pending upgrade requests
router.get('/requests', superadminOnly, (req: AuthRequest, res) => {
  const rows = db.prepare(`
    SELECT r.*, h.name as hotel_name
    FROM subscription_requests r
    LEFT JOIN mkt_hotels h ON h.id = r.hotel_id
    ORDER BY r.created_at DESC LIMIT 100
  `).all();
  res.json(rows);
});

export default router;

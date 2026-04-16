import { Router } from 'express';
import { db } from '../db';
import { authMiddleware, AuthRequest, getHotelId } from '../middleware/auth';
import { createVnpayUrl, verifyVnpayReturn, createMomoPayment, verifyMomoIpn, generateOrderId, parseOrderId } from '../services/payment';

const router = Router();

const PLAN_PRICES: Record<string, number> = {
  starter: 499000,
  pro: 1299000,
};

const PLAN_LIMITS: Record<string, any> = {
  free:    { max_posts_per_day: 1 },
  starter: { max_posts_per_day: 3 },
  pro:     { max_posts_per_day: 5 },
};

// POST /api/payment/create-vnpay — tạo link thanh toán VNPay
router.post('/create-vnpay', authMiddleware, async (req: AuthRequest, res) => {
  const hotelId = getHotelId(req);
  const { plan } = req.body;

  if (!plan || !PLAN_PRICES[plan]) {
    return res.status(400).json({ error: 'Plan khong hop le' });
  }

  const orderId = generateOrderId(hotelId, plan);
  const amount = PLAN_PRICES[plan];
  const ipAddr = (req.headers['x-forwarded-for'] as string || req.socket.remoteAddress || '127.0.0.1').split(',')[0].trim();

  // Save pending payment
  db.prepare(`
    INSERT INTO payments (order_id, hotel_id, plan, amount, method, status, created_at)
    VALUES (?, ?, ?, ?, 'vnpay', 'pending', ?)
  `).run(orderId, hotelId, plan, amount, Date.now());

  try {
    const paymentUrl = createVnpayUrl({
      orderId,
      amount,
      orderInfo: `Nang cap VP Marketing - Plan ${plan.toUpperCase()} - Hotel ${hotelId}`,
      ipAddr,
    });
    res.json({ ok: true, paymentUrl, orderId });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/payment/create-momo — tạo link thanh toán MoMo
router.post('/create-momo', authMiddleware, async (req: AuthRequest, res) => {
  const hotelId = getHotelId(req);
  const { plan } = req.body;

  if (!plan || !PLAN_PRICES[plan]) {
    return res.status(400).json({ error: 'Plan khong hop le' });
  }

  const orderId = generateOrderId(hotelId, plan);
  const amount = PLAN_PRICES[plan];

  db.prepare(`
    INSERT INTO payments (order_id, hotel_id, plan, amount, method, status, created_at)
    VALUES (?, ?, ?, ?, 'momo', 'pending', ?)
  `).run(orderId, hotelId, plan, amount, Date.now());

  try {
    const result = await createMomoPayment({
      orderId,
      amount,
      orderInfo: `VP Marketing - ${plan.toUpperCase()} - Hotel ${hotelId}`,
    });
    res.json({ ok: true, ...result, orderId });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/payment/vnpay-return — VNPay redirect callback
router.get('/vnpay-return', (req, res) => {
  const result = verifyVnpayReturn(req.query as Record<string, string>);

  if (!result.valid) {
    return res.send(paymentResultPage('error', 'Chu ky khong hop le'));
  }

  if (result.responseCode === '00') {
    // Payment success
    applyPayment(result.orderId, 'vnpay', req.query.vnp_TransactionNo as string || '');
    return res.send(paymentResultPage('success', 'Thanh toan thanh cong! Plan da duoc nang cap.'));
  }

  db.prepare(`UPDATE payments SET status = 'failed', updated_at = ? WHERE order_id = ?`).run(Date.now(), result.orderId);
  res.send(paymentResultPage('error', `Thanh toan that bai. Ma loi: ${result.responseCode}`));
});

// POST /api/payment/momo-ipn — MoMo IPN callback
router.post('/momo-ipn', (req, res) => {
  const result = verifyMomoIpn(req.body);

  if (!result.valid) {
    return res.status(400).json({ error: 'Invalid signature' });
  }

  if (result.resultCode === 0) {
    applyPayment(result.orderId, 'momo', req.body.transId || '');
  } else {
    db.prepare(`UPDATE payments SET status = 'failed', updated_at = ? WHERE order_id = ?`).run(Date.now(), result.orderId);
  }

  res.json({ ok: true });
});

// GET /api/payment/momo-return — MoMo redirect callback
router.get('/momo-return', (req, res) => {
  const resultCode = parseInt(req.query.resultCode as string);
  if (resultCode === 0) {
    res.send(paymentResultPage('success', 'Thanh toan MoMo thanh cong! Plan da duoc nang cap.'));
  } else {
    res.send(paymentResultPage('error', 'Thanh toan MoMo that bai.'));
  }
});

// GET /api/payment/history — lịch sử thanh toán
router.get('/history', authMiddleware, (req: AuthRequest, res) => {
  const hotelId = getHotelId(req);
  const rows = db.prepare(`
    SELECT order_id, plan, amount, method, status, transaction_ref, created_at, updated_at
    FROM payments WHERE hotel_id = ? ORDER BY created_at DESC LIMIT 50
  `).all(hotelId);
  res.json(rows);
});

// POST /api/payment/bank-transfer — ghi nhận chuyển khoản ngân hàng (manual)
router.post('/bank-transfer', authMiddleware, async (req: AuthRequest, res) => {
  const hotelId = getHotelId(req);
  const { plan, transfer_note } = req.body;

  if (!plan || !PLAN_PRICES[plan]) {
    return res.status(400).json({ error: 'Plan khong hop le' });
  }

  const orderId = generateOrderId(hotelId, plan);
  db.prepare(`
    INSERT INTO payments (order_id, hotel_id, plan, amount, method, status, transaction_ref, created_at)
    VALUES (?, ?, ?, ?, 'bank_transfer', 'pending_verify', ?, ?)
  `).run(orderId, hotelId, plan, PLAN_PRICES[plan], transfer_note || '', Date.now());

  res.json({
    ok: true,
    orderId,
    bank_info: {
      bank: 'Vietcombank',
      account: '1234567890',
      name: 'CONG TY SONDER VIETNAM',
      amount: PLAN_PRICES[plan],
      content: `VPM ${hotelId} ${plan.toUpperCase()}`,
    },
    message: 'Vui long chuyen khoan theo thong tin tren. Admin se xac nhan trong 24h.',
  });
});

// ============ Helpers ============

function applyPayment(orderId: string, method: string, transRef: string) {
  const parsed = parseOrderId(orderId);
  if (!parsed) return;

  const { hotelId, plan } = parsed;
  const limits = PLAN_LIMITS[plan];
  if (!limits) return;

  db.prepare(`UPDATE payments SET status = 'success', transaction_ref = ?, updated_at = ? WHERE order_id = ?`)
    .run(transRef, Date.now(), orderId);

  db.prepare(`UPDATE mkt_hotels SET plan = ?, max_posts_per_day = ?, updated_at = ? WHERE id = ?`)
    .run(plan, limits.max_posts_per_day, Date.now(), hotelId);

  // Update subscription request if exists
  db.prepare(`
    UPDATE subscription_requests SET status = 'confirmed', payment_ref = ?, confirmed_at = ?
    WHERE hotel_id = ? AND requested_plan = ? AND status = 'pending'
  `).run(transRef || orderId, Date.now(), hotelId, plan);

  // Auto-enable autopilot for paid plans
  if (plan !== 'free') {
    db.prepare(`INSERT OR REPLACE INTO mkt_permissions (hotel_id, feature, enabled, updated_at) VALUES (?, 'autopilot', 1, ?)`)
      .run(hotelId, Date.now());
  }
}

function paymentResultPage(status: 'success' | 'error', message: string): string {
  const color = status === 'success' ? '#22c55e' : '#ef4444';
  const icon = status === 'success' ? '✅' : '❌';
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Ket qua thanh toan</title>
    <style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f8fafc}
    .card{text-align:center;padding:3rem;background:#fff;border-radius:1rem;box-shadow:0 4px 24px rgba(0,0,0,.1);max-width:400px}
    h1{color:${color};font-size:3rem;margin:0}p{color:#475569;margin:1rem 0}
    a{display:inline-block;margin-top:1rem;padding:.75rem 2rem;background:#2563eb;color:#fff;border-radius:.5rem;text-decoration:none}</style>
    </head><body><div class="card"><h1>${icon}</h1><p>${message}</p><a href="/">Quay ve Dashboard</a></div></body></html>`;
}

export default router;

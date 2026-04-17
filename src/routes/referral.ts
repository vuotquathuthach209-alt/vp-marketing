/**
 * Referral Program — mỗi KS được 1 mã giới thiệu.
 * Hoa hồng: 20% tháng đầu của KS mới đăng ký qua mã đó.
 *
 * Flow:
 *  1. KS A mở tab "Gioi thieu" → lấy code (auto-gen) + link pricing kèm ?ref=CODE
 *  2. KS B mở /pricing.html?ref=CODE → lưu vào localStorage/cookie
 *  3. KS B upgrade → admin approve → nếu có ref code → tạo referral_commission record
 *  4. Admin xem danh sách commission, đánh dấu đã thanh toán
 */

import { Router } from 'express';
import { db } from '../db';
import { authMiddleware, AuthRequest, getHotelId, superadminOnly } from '../middleware/auth';
import crypto from 'crypto';

const router = Router();

// One-time schema
db.exec(`
CREATE TABLE IF NOT EXISTS referral_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hotel_id INTEGER NOT NULL UNIQUE,
  code TEXT NOT NULL UNIQUE,
  commission_percent INTEGER NOT NULL DEFAULT 20,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS referral_commissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  referrer_hotel_id INTEGER NOT NULL,
  referred_hotel_id INTEGER NOT NULL,
  request_id INTEGER,
  plan TEXT NOT NULL,
  amount INTEGER NOT NULL,
  commission INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',  -- pending | paid
  paid_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ref_comm_referrer ON referral_commissions(referrer_hotel_id);
`);

function genCode(): string {
  return 'VPM' + crypto.randomBytes(3).toString('hex').toUpperCase();
}

export function getOrCreateRefCode(hotelId: number): string {
  const row = db.prepare(`SELECT code FROM referral_codes WHERE hotel_id = ?`).get(hotelId) as { code: string } | undefined;
  if (row) return row.code;
  let code = genCode();
  // tránh đụng
  for (let i = 0; i < 5; i++) {
    const dup = db.prepare(`SELECT 1 FROM referral_codes WHERE code = ?`).get(code);
    if (!dup) break;
    code = genCode();
  }
  db.prepare(`INSERT INTO referral_codes (hotel_id, code, created_at) VALUES (?, ?, ?)`)
    .run(hotelId, code, Date.now());
  return code;
}

/**
 * Ghi nhận commission khi KS mới upgrade thành công.
 * Gọi từ subscription approve handler.
 */
export function recordReferralCommission(
  referredHotelId: number,
  refCode: string,
  plan: string,
  amount: number,
  requestId: number | null
): boolean {
  const ref = db.prepare(`SELECT hotel_id, commission_percent FROM referral_codes WHERE code = ?`)
    .get(refCode) as { hotel_id: number; commission_percent: number } | undefined;
  if (!ref || ref.hotel_id === referredHotelId) return false;

  // Đã ghi nhận rồi cho request này thì skip
  if (requestId) {
    const dup = db.prepare(`SELECT 1 FROM referral_commissions WHERE request_id = ?`).get(requestId);
    if (dup) return false;
  }

  const commission = Math.round((amount * ref.commission_percent) / 100);
  db.prepare(
    `INSERT INTO referral_commissions
     (referrer_hotel_id, referred_hotel_id, request_id, plan, amount, commission, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`
  ).run(ref.hotel_id, referredHotelId, requestId || null, plan, amount, commission, Date.now());
  return true;
}

// ========= Public (no auth) — validate code =========

router.get('/validate/:code', (req, res) => {
  const code = (req.params.code || '').toUpperCase();
  const row = db.prepare(
    `SELECT r.code, h.name as referrer_name FROM referral_codes r
     JOIN mkt_hotels h ON h.id = r.hotel_id WHERE r.code = ?`
  ).get(code) as any;
  if (!row) return res.status(404).json({ valid: false });
  res.json({ valid: true, code: row.code, referrer_name: row.referrer_name });
});

// ========= Authed =========
router.use(authMiddleware);

// GET /api/referral/my — KS xem mã + thống kê của mình
router.get('/my', (req: AuthRequest, res) => {
  const hotelId = getHotelId(req);
  const code = getOrCreateRefCode(hotelId);
  const stats = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN status = 'pending' THEN commission ELSE 0 END) as pending_amount,
      SUM(CASE WHEN status = 'paid' THEN commission ELSE 0 END) as paid_amount,
      SUM(commission) as total_amount
    FROM referral_commissions WHERE referrer_hotel_id = ?
  `).get(hotelId) as any;
  const recent = db.prepare(`
    SELECT c.*, h.name as referred_name FROM referral_commissions c
    LEFT JOIN mkt_hotels h ON h.id = c.referred_hotel_id
    WHERE c.referrer_hotel_id = ? ORDER BY c.id DESC LIMIT 20
  `).all(hotelId);
  res.json({ code, link: `/pricing.html?ref=${code}`, stats, recent });
});

// ========= Superadmin =========

router.get('/admin/commissions', superadminOnly, (req: AuthRequest, res) => {
  const status = (req.query.status as string) || '';
  const stmt = status
    ? db.prepare(`SELECT c.*, hr.name as referrer_name, hd.name as referred_name FROM referral_commissions c
                  LEFT JOIN mkt_hotels hr ON hr.id = c.referrer_hotel_id
                  LEFT JOIN mkt_hotels hd ON hd.id = c.referred_hotel_id
                  WHERE c.status = ? ORDER BY c.id DESC LIMIT 200`)
    : db.prepare(`SELECT c.*, hr.name as referrer_name, hd.name as referred_name FROM referral_commissions c
                  LEFT JOIN mkt_hotels hr ON hr.id = c.referrer_hotel_id
                  LEFT JOIN mkt_hotels hd ON hd.id = c.referred_hotel_id
                  ORDER BY c.id DESC LIMIT 200`);
  res.json(status ? stmt.all(status) : stmt.all());
});

router.post('/admin/mark-paid', superadminOnly, (req: AuthRequest, res) => {
  const { commission_id } = req.body;
  if (!commission_id) return res.status(400).json({ error: 'Thiếu commission_id' });
  db.prepare(
    `UPDATE referral_commissions SET status = 'paid', paid_at = ? WHERE id = ?`
  ).run(Date.now(), commission_id);
  res.json({ ok: true });
});

export default router;

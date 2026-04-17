/**
 * Bank webhook — auto-approve subscription khi nhận được chuyển khoản.
 *
 * Tương thích SePay (sepay.vn) và Casso — payload chuẩn VN.
 * Parse memo "VPMKT REQ{id}" → match request → approve + kích hoạt plan.
 *
 * Bảo mật: verify secret key gửi trong header hoặc query.
 * Cấu hình trong settings:
 *   - bank_webhook_secret  (chuỗi random KS set trên dashboard SePay)
 *
 * SePay payload ví dụ:
 *   {
 *     "id": 92704,
 *     "gateway": "TPBank",
 *     "transactionDate": "2024-04-17 12:13:45",
 *     "accountNumber": "xxx",
 *     "subAccount": null,
 *     "code": null,
 *     "content": "VPMKT REQ42 PRO",
 *     "transferType": "in",
 *     "transferAmount": 600000,
 *     "referenceCode": "FT...",
 *     "description": "VPMKT REQ42 PRO"
 *   }
 */
import { Router } from 'express';
import { db, getSetting } from '../db';

const router = Router();

const PLAN_LIMITS: Record<string, any> = {
  free:       { max_posts_per_day: 1, max_pages: 1 },
  starter:    { max_posts_per_day: 3, max_pages: 1 },
  pro:        { max_posts_per_day: 5, max_pages: 3 },
  enterprise: { max_posts_per_day: 20, max_pages: 10 },
};

router.post('/bank', async (req, res) => {
  try {
    const expectedSecret = getSetting('bank_webhook_secret');
    if (!expectedSecret) {
      return res.status(503).json({ error: 'bank webhook chưa được cấu hình (bank_webhook_secret)' });
    }
    const provided = req.headers['authorization']?.toString().replace(/^Apikey\s+/i, '')
      || req.headers['x-webhook-secret']?.toString()
      || (req.query.secret as string)
      || '';
    if (provided !== expectedSecret) {
      return res.status(401).json({ error: 'invalid secret' });
    }

    const body = req.body || {};
    const content: string = String(body.content || body.description || body.memo || '');
    const amount: number = Number(body.transferAmount || body.amount || 0);
    const txType: string = String(body.transferType || body.type || 'in').toLowerCase();

    if (txType && txType !== 'in' && txType !== 'credit') {
      return res.json({ ok: true, skipped: 'not incoming' });
    }

    // Parse "VPMKT REQ{id}" (case-insensitive, tolerant to dots/hyphens)
    const m = content.toUpperCase().match(/VPMKT[\s._-]*REQ[\s._-]*(\d+)/);
    if (!m) {
      console.log('[bank-webhook] memo không match VPMKT REQ:', content);
      return res.json({ ok: true, skipped: 'no_ref_in_memo', content });
    }
    const requestId = parseInt(m[1], 10);

    const r = db.prepare(`SELECT * FROM subscription_requests WHERE id = ?`).get(requestId) as any;
    if (!r) return res.json({ ok: true, skipped: 'request_not_found', request_id: requestId });
    if (r.status === 'approved') return res.json({ ok: true, skipped: 'already_approved' });

    const plan = r.requested_plan;
    const limits = PLAN_LIMITS[plan];
    if (!limits) return res.status(400).json({ error: 'unknown plan' });

    // Tolerance ±5% cho amount (phí chuyển khoản có thể trừ)
    const expected = Number(r.amount) || 0;
    if (expected > 0 && amount < expected * 0.95) {
      // Ghi nhận nhưng không approve — notify admin
      db.prepare(`UPDATE subscription_requests SET admin_note = ? WHERE id = ?`)
        .run(`Auto-webhook: nhận ${amount}đ < expected ${expected}đ — chờ admin xem`, requestId);
      try {
        const { notifyAdmin } = require('../services/telegram');
        notifyAdmin(`⚠️ Bank webhook: nhận thiếu ${amount}đ cho REQ#${requestId} (cần ${expected}đ). Cần duyệt tay.`).catch(() => {});
      } catch {}
      return res.json({ ok: true, skipped: 'amount_too_low', received: amount, expected });
    }

    const now = Date.now();
    const expires = now + 30 * 24 * 3600_000;

    db.prepare(
      `UPDATE mkt_hotels SET plan = ?, max_posts_per_day = ?, max_pages = ?, status = 'active',
       plan_expires_at = ?, activated_at = COALESCE(activated_at, ?), updated_at = ? WHERE id = ?`
    ).run(plan, limits.max_posts_per_day, limits.max_pages, expires, now, now, r.hotel_id);

    db.prepare(
      `UPDATE subscription_requests SET status = 'approved', reviewed_at = ?, admin_note = ? WHERE id = ?`
    ).run(now, `Auto-approved by bank webhook: ${body.referenceCode || body.id || ''}`, requestId);

    // Referral commission
    try {
      if (r.ref_code) {
        const { recordReferralCommission } = require('./referral');
        recordReferralCommission(r.hotel_id, r.ref_code, plan, r.amount, requestId);
      }
    } catch {}

    // Track event
    try {
      const { trackEvent } = require('../services/events');
      trackEvent({ event: 'plan_approved_auto', hotelId: r.hotel_id, meta: { plan, amount, request_id: requestId, bank_ref: body.referenceCode || body.id } });
    } catch {}

    // Notify
    try {
      const { notifyAdmin } = require('../services/telegram');
      notifyAdmin(`✅ Auto-approved REQ#${requestId} — Hotel #${r.hotel_id} → ${plan.toUpperCase()} (${amount.toLocaleString('vi')}đ)`).catch(() => {});
    } catch {}

    console.log(`[bank-webhook] ✅ REQ#${requestId} auto-approved: ${plan} for hotel ${r.hotel_id}`);
    res.json({ ok: true, approved: true, request_id: requestId, plan });
  } catch (e: any) {
    console.error('[bank-webhook] error:', e?.message);
    res.status(500).json({ error: e?.message });
  }
});

export default router;

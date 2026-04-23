/**
 * Revenue Attribution routes.
 */

import { Router } from 'express';
import { db } from '../db';
import { authMiddleware, AuthRequest, getHotelId } from '../middleware/auth';
import {
  recordBookingAttribution, attributionByType,
  topCustomersByLTV, getRevenueTotals,
} from '../services/attribution-tracker';

const router = Router();
router.use(authMiddleware);

/** Summary dashboard numbers */
router.get('/totals', (req: AuthRequest, res) => {
  try {
    const hotelId = getHotelId(req);
    const days = Math.min(90, parseInt(String(req.query.days || '30'), 10));
    res.json(getRevenueTotals(days, hotelId));
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

/** Attribution by touch type */
router.get('/by-type/:touch_type', (req: AuthRequest, res) => {
  try {
    const hotelId = getHotelId(req);
    const touchType = String(req.params.touch_type);
    const days = Math.min(90, parseInt(String(req.query.days || '30'), 10));
    res.json({ touch_type: touchType, items: attributionByType(touchType, { days, hotelId }) });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

/** Top customers by LTV */
router.get('/top-customers', (req: AuthRequest, res) => {
  try {
    const limit = Math.min(100, parseInt(String(req.query.limit || '20'), 10));
    res.json({ items: topCustomersByLTV(limit) });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

/** Customer LTV detail */
router.get('/customer/:sender_id', (req: AuthRequest, res) => {
  try {
    const senderId = String(req.params.sender_id);
    const ltv = db.prepare(`SELECT * FROM customer_ltv WHERE sender_id = ?`).get(senderId) as any;
    if (!ltv) return res.status(404).json({ error: 'not found' });

    const bookings = db.prepare(
      `SELECT id, amount_vnd, occurred_at, event_type
       FROM revenue_events WHERE sender_id = ? ORDER BY occurred_at DESC LIMIT 20`
    ).all(senderId) as any[];

    const attributions = db.prepare(
      `SELECT touch_type, touch_value, weight, touched_at
       FROM attribution_links WHERE sender_id = ? ORDER BY touched_at DESC LIMIT 30`
    ).all(senderId) as any[];

    res.json({ ltv, bookings, attributions });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

/** Manual trigger attribution for booking */
router.post('/recompute/:booking_id', (req: AuthRequest, res) => {
  try {
    const bookingId = parseInt(String(req.params.booking_id), 10);
    res.json(recordBookingAttribution(bookingId));
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

/** Recompute all confirmed bookings (one-time repair) */
router.post('/recompute-all', (req: AuthRequest, res) => {
  try {
    const hotelId = getHotelId(req);
    const bookings = db.prepare(
      `SELECT id FROM sync_bookings WHERE hotel_id = ? AND status IN ('confirmed', 'synced', 'checked_out') ORDER BY id DESC LIMIT 500`
    ).all(hotelId) as any[];
    let ok = 0, total = 0;
    for (const b of bookings) {
      try { recordBookingAttribution(b.id); ok++; } catch {}
      total++;
    }
    res.json({ processed: total, attributed: ok });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

export default router;

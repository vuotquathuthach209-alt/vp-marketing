/**
 * Admin routes cho v15 domain data: policies + pricing_rules + promotions.
 * Full CRUD + seed + preview pricing.
 */

import { Router } from 'express';
import { db } from '../db';
import { authMiddleware, AuthRequest, getHotelId } from '../middleware/auth';
import { calculatePrice, describeApplicableRules } from '../services/pricing-calculator';
import { getPoliciesByType, getAllPoliciesDisplay } from '../services/policy-lookup';
import { validatePromoCode, getActivePromotions } from '../services/promotion-service';
import { seedSonderDomainData } from '../services/domain-seed';

const router = Router();
router.use(authMiddleware);

/* ═══════════════════════════════════════════
   SEED
   ═══════════════════════════════════════════ */
router.post('/seed', (_req: AuthRequest, res) => {
  try {
    const result = seedSonderDomainData();
    res.json({ ok: true, ...result });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

/* ═══════════════════════════════════════════
   POLICIES
   ═══════════════════════════════════════════ */

router.get('/policies', (req: AuthRequest, res) => {
  try {
    const hotelId = getHotelId(req);
    const type = req.query.type as string | undefined;
    let rows: any[];
    if (type) {
      rows = getPoliciesByType(hotelId, type);
    } else {
      rows = db.prepare(
        `SELECT * FROM hotel_policy_rules
         WHERE (hotel_id = ? OR hotel_id = 0) AND active = 1
         ORDER BY policy_type, priority DESC`
      ).all(hotelId) as any[];
      for (const r of rows) {
        try { r.conditions_json = JSON.parse(r.conditions_json || '{}'); } catch {}
        try { r.effect_json = JSON.parse(r.effect_json || '{}'); } catch {}
      }
    }
    res.json({ items: rows });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.post('/policies', (req: AuthRequest, res) => {
  try {
    const hotelId = getHotelId(req);
    const { policy_type, rule_name, conditions, effect, description, priority, global } = req.body || {};
    if (!policy_type || !rule_name) {
      return res.status(400).json({ error: 'policy_type + rule_name required' });
    }
    const now = Date.now();
    const r = db.prepare(
      `INSERT INTO hotel_policy_rules
       (hotel_id, policy_type, rule_name, conditions_json, effect_json, description, priority, active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`
    ).run(
      global ? 0 : hotelId,
      policy_type, rule_name,
      JSON.stringify(conditions || {}),
      JSON.stringify(effect || {}),
      description || '',
      priority || 0, now, now,
    );
    res.json({ ok: true, id: Number(r.lastInsertRowid) });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.put('/policies/:id', (req: AuthRequest, res) => {
  try {
    const hotelId = getHotelId(req);
    const id = parseInt(String(req.params.id), 10);
    const owns = db.prepare(`SELECT id FROM hotel_policy_rules WHERE id = ? AND (hotel_id = ? OR hotel_id = 0)`).get(id, hotelId);
    if (!owns) return res.status(404).json({ error: 'not found' });
    const { conditions, effect, description, priority, active } = req.body || {};
    const now = Date.now();
    db.prepare(
      `UPDATE hotel_policy_rules
       SET conditions_json = COALESCE(?, conditions_json),
           effect_json = COALESCE(?, effect_json),
           description = COALESCE(?, description),
           priority = COALESCE(?, priority),
           active = COALESCE(?, active),
           updated_at = ?
       WHERE id = ?`
    ).run(
      conditions !== undefined ? JSON.stringify(conditions) : null,
      effect !== undefined ? JSON.stringify(effect) : null,
      description,
      priority,
      active !== undefined ? (active ? 1 : 0) : null,
      now, id,
    );
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.delete('/policies/:id', (req: AuthRequest, res) => {
  try {
    const hotelId = getHotelId(req);
    const id = parseInt(String(req.params.id), 10);
    const r = db.prepare(`DELETE FROM hotel_policy_rules WHERE id = ? AND hotel_id = ?`).run(id, hotelId);
    res.json({ ok: true, deleted: r.changes });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

/* ═══════════════════════════════════════════
   PRICING RULES
   ═══════════════════════════════════════════ */

router.get('/pricing-rules', (req: AuthRequest, res) => {
  try {
    const hotelId = getHotelId(req);
    const rows = db.prepare(
      `SELECT * FROM pricing_rules
       WHERE (hotel_id = ? OR hotel_id = 0) AND active = 1
       ORDER BY rule_type, priority DESC`
    ).all(hotelId) as any[];
    for (const r of rows) {
      try { r.conditions_json = JSON.parse(r.conditions_json || '{}'); } catch {}
    }
    res.json({ items: rows });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.post('/pricing-rules', (req: AuthRequest, res) => {
  try {
    const hotelId = getHotelId(req);
    const b = req.body || {};
    if (!b.rule_type || !b.rule_name || !b.modifier_type || b.modifier_value === undefined) {
      return res.status(400).json({ error: 'rule_type + rule_name + modifier_type + modifier_value required' });
    }
    const now = Date.now();
    const r = db.prepare(
      `INSERT INTO pricing_rules
       (hotel_id, room_type_code, rule_type, rule_name, conditions_json, modifier_type, modifier_value, priority, stackable, description, active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`
    ).run(
      b.global ? 0 : hotelId,
      b.room_type_code || null,
      b.rule_type, b.rule_name,
      JSON.stringify(b.conditions || {}),
      b.modifier_type, b.modifier_value,
      b.priority || 0, b.stackable ? 1 : 0,
      b.description || '', now, now,
    );
    res.json({ ok: true, id: Number(r.lastInsertRowid) });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

/** Preview pricing cho date + nights → bot / admin dùng để verify */
router.post('/pricing-preview', (req: AuthRequest, res) => {
  try {
    const hotelId = getHotelId(req);
    const { room_type_code, checkin_date, nights, guests, customer_tier, promo_code } = req.body || {};
    if (!room_type_code || !checkin_date || !nights) {
      return res.status(400).json({ error: 'room_type_code + checkin_date + nights required' });
    }
    const result = calculatePrice({
      hotel_id: hotelId, room_type_code, checkin_date,
      nights: parseInt(nights, 10),
      guests: guests ? parseInt(guests, 10) : undefined,
      customer_tier, promo_code,
    });
    res.json(result);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

/* ═══════════════════════════════════════════
   PROMOTIONS
   ═══════════════════════════════════════════ */

router.get('/promotions', (req: AuthRequest, res) => {
  try {
    const hotelId = getHotelId(req);
    res.json({ items: getActivePromotions(hotelId) });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.post('/promotions', (req: AuthRequest, res) => {
  try {
    const hotelId = getHotelId(req);
    const b = req.body || {};
    if (!b.code || !b.name || !b.discount_type || b.discount_value === undefined) {
      return res.status(400).json({ error: 'code + name + discount_type + discount_value required' });
    }
    const now = Date.now();
    const r = db.prepare(
      `INSERT INTO promotions
       (hotel_id, code, name, discount_type, discount_value, max_discount_vnd, min_order_vnd,
        eligibility_json, usage_limit, usage_per_customer, used_count,
        valid_from, valid_to, active, description, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, 1, ?, ?, ?)`
    ).run(
      b.global ? 0 : hotelId,
      String(b.code).toUpperCase(), b.name, b.discount_type, b.discount_value,
      b.max_discount_vnd || null, b.min_order_vnd || null,
      JSON.stringify(b.eligibility || {}),
      b.usage_limit || null, b.usage_per_customer || 1,
      b.valid_from || now, b.valid_to || null,
      b.description || '', now, now,
    );
    res.json({ ok: true, id: Number(r.lastInsertRowid) });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

/** Validate promo code — cho bot hoặc admin check */
router.post('/promotions/validate', (req: AuthRequest, res) => {
  try {
    const hotelId = getHotelId(req);
    const { code, customer_tier, sender_id, order_total_vnd } = req.body || {};
    if (!code || order_total_vnd === undefined) {
      return res.status(400).json({ error: 'code + order_total_vnd required' });
    }
    const result = validatePromoCode({
      code, hotel_id: hotelId, customer_tier, sender_id,
      order_total_vnd: parseInt(order_total_vnd, 10),
    });
    res.json(result);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.put('/promotions/:id', (req: AuthRequest, res) => {
  try {
    const hotelId = getHotelId(req);
    const id = parseInt(String(req.params.id), 10);
    const owns = db.prepare(`SELECT id FROM promotions WHERE id = ? AND (hotel_id = ? OR hotel_id = 0)`).get(id, hotelId);
    if (!owns) return res.status(404).json({ error: 'not found' });
    const b = req.body || {};
    const now = Date.now();
    db.prepare(
      `UPDATE promotions SET
         name = COALESCE(?, name),
         discount_value = COALESCE(?, discount_value),
         max_discount_vnd = COALESCE(?, max_discount_vnd),
         min_order_vnd = COALESCE(?, min_order_vnd),
         valid_from = COALESCE(?, valid_from),
         valid_to = COALESCE(?, valid_to),
         active = COALESCE(?, active),
         description = COALESCE(?, description),
         updated_at = ?
       WHERE id = ?`
    ).run(
      b.name, b.discount_value, b.max_discount_vnd, b.min_order_vnd,
      b.valid_from, b.valid_to,
      b.active !== undefined ? (b.active ? 1 : 0) : null,
      b.description, now, id,
    );
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.delete('/promotions/:id', (req: AuthRequest, res) => {
  try {
    const hotelId = getHotelId(req);
    const id = parseInt(String(req.params.id), 10);
    const r = db.prepare(`DELETE FROM promotions WHERE id = ? AND hotel_id = ?`).run(id, hotelId);
    res.json({ ok: true, deleted: r.changes });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

/** Get applicable rules preview (e.g., "cuối tuần này có markup không?") */
router.get('/pricing-rules/applicable', (req: AuthRequest, res) => {
  try {
    const hotelId = getHotelId(req);
    const checkinDate = req.query.checkin_date as string;
    const nights = parseInt(String(req.query.nights || '1'), 10);
    const roomTypeCode = req.query.room_type_code as string | undefined;
    if (!checkinDate) return res.status(400).json({ error: 'checkin_date required' });
    const rules = describeApplicableRules(hotelId, checkinDate, nights, roomTypeCode);
    res.json({ checkin_date: checkinDate, nights, applicable_rules: rules });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

export default router;

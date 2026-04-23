/**
 * Promotion Service — validate + apply + track usage.
 */

import { db } from '../db';

export interface Promotion {
  id: number;
  code: string;
  name: string;
  discount_type: 'percent' | 'fixed_vnd';
  discount_value: number;
  max_discount_vnd?: number;
  min_order_vnd?: number;
  usage_limit?: number;
  usage_per_customer: number;
  used_count: number;
  valid_from?: number;
  valid_to?: number;
  eligibility: any;
  description?: string;
}

function parseJSON(s: string | null): any {
  if (!s) return {};
  try { return JSON.parse(s); } catch { return {}; }
}

export interface PromoValidationResult {
  valid: boolean;
  reason?: string;
  promotion?: Promotion;
  calculated_discount_vnd?: number;
}

/** Check if promo code is valid for a specific scenario. */
export function validatePromoCode(opts: {
  code: string;
  hotel_id?: number;
  customer_tier?: string;
  sender_id?: string;
  order_total_vnd: number;
}): PromoValidationResult {
  const now = Date.now();
  const row = db.prepare(
    `SELECT * FROM promotions WHERE UPPER(code) = UPPER(?) AND active = 1`
  ).get(opts.code) as any;

  if (!row) return { valid: false, reason: 'not_found' };

  // Validity window
  if (row.valid_from && row.valid_from > now) return { valid: false, reason: 'not_yet_active' };
  if (row.valid_to && row.valid_to < now) return { valid: false, reason: 'expired' };

  // Usage cap
  if (row.usage_limit !== null && row.used_count >= row.usage_limit) {
    return { valid: false, reason: 'usage_limit_reached' };
  }

  // Hotel scope
  if (row.hotel_id > 0 && opts.hotel_id && row.hotel_id !== opts.hotel_id) {
    return { valid: false, reason: 'hotel_scope_mismatch' };
  }

  // Min order
  if (row.min_order_vnd && opts.order_total_vnd < row.min_order_vnd) {
    return { valid: false, reason: `min_order_${row.min_order_vnd}` };
  }

  // Eligibility checks
  const eligibility = parseJSON(row.eligibility_json);

  if (eligibility.first_time_only && opts.sender_id) {
    // Check if sender has any previous booking
    const hasPrev = db.prepare(
      `SELECT id FROM sync_bookings WHERE sender_id = ? AND status IN ('confirmed', 'synced', 'checked_in', 'checked_out') LIMIT 1`
    ).get(opts.sender_id);
    if (hasPrev) return { valid: false, reason: 'not_first_time' };
  }

  if (eligibility.customer_tier && opts.customer_tier) {
    const allowedTiers = Array.isArray(eligibility.customer_tier)
      ? eligibility.customer_tier
      : [eligibility.customer_tier];
    if (!allowedTiers.includes(opts.customer_tier)) {
      return { valid: false, reason: `tier_not_eligible(${allowedTiers.join(',')})` };
    }
  }

  // Per-customer cap
  if (opts.sender_id && row.usage_per_customer) {
    const usedByThisCustomer = db.prepare(
      `SELECT COUNT(*) as n FROM promotion_usage
       WHERE promotion_id = ? AND sender_id = ?`
    ).get(row.id, opts.sender_id) as any;
    if (usedByThisCustomer.n >= row.usage_per_customer) {
      return { valid: false, reason: 'customer_usage_limit' };
    }
  }

  // Compute discount
  let discount = 0;
  if (row.discount_type === 'percent') {
    discount = Math.round(opts.order_total_vnd * row.discount_value / 100);
    if (row.max_discount_vnd && discount > row.max_discount_vnd) {
      discount = row.max_discount_vnd;
    }
  } else if (row.discount_type === 'fixed_vnd') {
    discount = Math.round(row.discount_value);
  }

  return {
    valid: true,
    promotion: {
      id: row.id,
      code: row.code,
      name: row.name,
      discount_type: row.discount_type,
      discount_value: row.discount_value,
      max_discount_vnd: row.max_discount_vnd,
      min_order_vnd: row.min_order_vnd,
      usage_limit: row.usage_limit,
      usage_per_customer: row.usage_per_customer,
      used_count: row.used_count,
      valid_from: row.valid_from,
      valid_to: row.valid_to,
      eligibility,
      description: row.description,
    },
    calculated_discount_vnd: discount,
  };
}

/** Record promo usage (call after booking confirmed). */
export function recordPromoUsage(opts: {
  promotion_id: number;
  promotion_code: string;
  sender_id?: string;
  booking_id?: number;
  customer_phone?: string;
  discount_applied_vnd: number;
}): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO promotion_usage
     (promotion_id, promotion_code, sender_id, booking_id, customer_phone, discount_applied_vnd, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    opts.promotion_id, opts.promotion_code,
    opts.sender_id || null, opts.booking_id || null, opts.customer_phone || null,
    opts.discount_applied_vnd, now,
  );
  db.prepare(`UPDATE promotions SET used_count = used_count + 1, updated_at = ? WHERE id = ?`).run(now, opts.promotion_id);
}

/** List active promotions for a hotel (to show to admin or bot "khuyến mãi nào đang chạy"). */
export function getActivePromotions(hotelId?: number): Promotion[] {
  const now = Date.now();
  const where = hotelId
    ? `AND (hotel_id = ? OR hotel_id = 0)`
    : '';
  const params: any[] = [now, now];
  if (hotelId) params.unshift(hotelId);

  const rows = db.prepare(
    `SELECT * FROM promotions
     WHERE active = 1
       AND (valid_from IS NULL OR valid_from <= ?)
       AND (valid_to IS NULL OR valid_to >= ?)
       ${where}
     ORDER BY (valid_to IS NULL) ASC, valid_to ASC, id DESC`
  ).all(...params) as any[];

  return rows.map(r => ({
    id: r.id,
    code: r.code,
    name: r.name,
    discount_type: r.discount_type,
    discount_value: r.discount_value,
    max_discount_vnd: r.max_discount_vnd,
    min_order_vnd: r.min_order_vnd,
    usage_limit: r.usage_limit,
    usage_per_customer: r.usage_per_customer,
    used_count: r.used_count,
    valid_from: r.valid_from,
    valid_to: r.valid_to,
    eligibility: parseJSON(r.eligibility_json),
    description: r.description,
  }));
}

/**
 * Pricing Calculator — tính giá động dựa trên:
 *   1. Base price từ hotel_room_catalog (weekday/weekend)
 *   2. Pricing rules: weekend_markup, long_stay, early_bird, last_minute, seasonal, group
 *   3. VIP tier discount từ hotel_policy_rules (customer_tier)
 *   4. Applied promotion code
 *
 * Sử dụng đa lớp: base → rules apply in priority order → promo on top.
 */

import { db } from '../db';

export interface PricingInput {
  hotel_id: number;
  room_type_code: string;
  checkin_date: string;        // 'YYYY-MM-DD'
  nights: number;
  guests?: number;
  customer_tier?: 'new' | 'regular' | 'vip' | 'black_vip';
  promo_code?: string;
  booking_date?: string;       // default today
}

export interface AppliedRule {
  rule_id: number;
  rule_type: string;
  rule_name: string;
  description: string;
  modifier_type: string;
  modifier_value: number;
  amount_applied_vnd: number;  // signed: positive = add, negative = discount
}

export interface PricingResult {
  base_price_per_night: number;
  base_total: number;              // base × nights
  applied_rules: AppliedRule[];
  subtotal_after_rules: number;
  promo_discount_vnd: number;
  promo_code?: string;
  promo_name?: string;
  vip_discount_vnd: number;
  vip_tier?: string;
  final_total_vnd: number;
  nights: number;
  savings_vnd: number;           // base_total - final_total (if positive)
  markup_vnd: number;            // final_total - base_total (if positive)
  breakdown_text: string;        // human readable
}

/** Parse conditions JSON safely. */
function parseConditions(json: string | null): any {
  if (!json) return {};
  try { return JSON.parse(json); } catch { return {}; }
}

/** Check if date matches condition — supports days_of_week, date_from/to, days_ahead. */
function matchesDateCondition(conditions: any, checkinDate: string, bookingDate: string): boolean {
  const checkin = new Date(checkinDate);
  const booking = new Date(bookingDate);

  // days_of_week: 0=Sun, 1=Mon, ..., 5=Fri, 6=Sat
  if (Array.isArray(conditions.days_of_week)) {
    const dow = checkin.getUTCDay();
    if (!conditions.days_of_week.includes(dow)) return false;
  }

  // date_from / date_to (peak season)
  if (conditions.date_from && checkinDate < conditions.date_from) return false;
  if (conditions.date_to && checkinDate > conditions.date_to) return false;

  // days_ahead_min / days_ahead_max
  const daysAhead = Math.floor((checkin.getTime() - booking.getTime()) / (24 * 3600 * 1000));
  if (conditions.days_ahead_min !== undefined && daysAhead < conditions.days_ahead_min) return false;
  if (conditions.days_ahead_max !== undefined && daysAhead > conditions.days_ahead_max) return false;

  return true;
}

/** Lookup base price from hotel_room_catalog. Handles weekend fallback. */
function getBasePrice(hotelId: number, roomTypeCode: string, checkinDate: string): number | null {
  const room = db.prepare(
    `SELECT price_weekday, price_weekend FROM hotel_room_catalog
     WHERE hotel_id = ? AND room_key = ? LIMIT 1`
  ).get(hotelId, roomTypeCode) as any;

  if (!room) {
    // Try sync_availability as fallback
    const avail = db.prepare(
      `SELECT base_price FROM sync_availability
       WHERE hotel_id = ? AND room_type_code = ? AND date_str = ? LIMIT 1`
    ).get(hotelId, roomTypeCode, checkinDate) as any;
    return avail?.base_price || null;
  }

  const dow = new Date(checkinDate).getUTCDay();
  const isWeekend = dow === 5 || dow === 6;  // Fri/Sat
  return isWeekend ? (room.price_weekend || room.price_weekday) : room.price_weekday;
}

/** Main calculator. */
export function calculatePrice(input: PricingInput): PricingResult {
  const bookingDate = input.booking_date || new Date().toISOString().slice(0, 10);
  const nights = Math.max(1, input.nights);

  // 1. Base price (per-night average)
  const basePrice = getBasePrice(input.hotel_id, input.room_type_code, input.checkin_date) || 500_000;
  const baseTotal = basePrice * nights;

  // 2. Apply pricing rules trong order of priority
  const rules = db.prepare(
    `SELECT * FROM pricing_rules
     WHERE (hotel_id = ? OR hotel_id = 0)
       AND active = 1
       AND (room_type_code IS NULL OR room_type_code = ?)
     ORDER BY priority DESC, id ASC`
  ).all(input.hotel_id, input.room_type_code) as any[];

  const appliedRules: AppliedRule[] = [];
  let runningTotal = baseTotal;

  for (const rule of rules) {
    const conditions = parseConditions(rule.conditions_json);

    // Type-specific condition check
    let matches = false;
    switch (rule.rule_type) {
      case 'weekend_markup':
        matches = matchesDateCondition(conditions, input.checkin_date, bookingDate);
        break;
      case 'long_stay':
        matches = nights >= (conditions.nights_min || 1);
        break;
      case 'early_bird':
      case 'last_minute':
        matches = matchesDateCondition(conditions, input.checkin_date, bookingDate);
        break;
      case 'seasonal':
        matches = matchesDateCondition(conditions, input.checkin_date, bookingDate);
        break;
      case 'group':
        matches = (input.guests || 0) >= (conditions.min_guests || 4);
        break;
      default:
        matches = matchesDateCondition(conditions, input.checkin_date, bookingDate);
    }

    if (!matches) continue;

    // Compute delta
    let delta = 0;
    const modType = rule.modifier_type;
    const modVal = rule.modifier_value;
    switch (modType) {
      case 'percent_add':       delta = Math.round(runningTotal * modVal / 100); break;
      case 'percent_discount':  delta = -Math.round(runningTotal * modVal / 100); break;
      case 'fixed_add':         delta = Math.round(modVal); break;
      case 'fixed_discount':    delta = -Math.round(modVal); break;
    }

    appliedRules.push({
      rule_id: rule.id,
      rule_type: rule.rule_type,
      rule_name: rule.rule_name,
      description: rule.description || `${rule.rule_type}: ${modVal}${modType.includes('percent') ? '%' : 'đ'}`,
      modifier_type: modType,
      modifier_value: modVal,
      amount_applied_vnd: delta,
    });
    runningTotal += delta;

    // Non-stackable rule → stop here
    if (rule.stackable === 0) break;
  }

  // 3. VIP tier discount (from hotel_policy_rules type='vip_discount')
  let vipDiscount = 0;
  let vipTier = input.customer_tier;
  if (vipTier && vipTier !== 'new') {
    const vipRules = db.prepare(
      `SELECT * FROM hotel_policy_rules
       WHERE (hotel_id = ? OR hotel_id = 0)
         AND policy_type = 'vip_discount' AND active = 1
       ORDER BY priority DESC`
    ).all(input.hotel_id) as any[];

    for (const vr of vipRules) {
      const cond = parseConditions(vr.conditions_json);
      if (cond.customer_tier === vipTier || (Array.isArray(cond.customer_tier) && cond.customer_tier.includes(vipTier))) {
        const eff = parseConditions(vr.effect_json);
        if (eff.discount_percent) {
          vipDiscount = Math.round(runningTotal * eff.discount_percent / 100);
          runningTotal -= vipDiscount;
          break;
        }
      }
    }
  }

  // 4. Promotion code
  let promoDiscount = 0;
  let promoName: string | undefined;
  if (input.promo_code) {
    const promo = db.prepare(
      `SELECT * FROM promotions
       WHERE code = ? AND active = 1
         AND (valid_from IS NULL OR valid_from <= ?)
         AND (valid_to IS NULL OR valid_to >= ?)
         AND (usage_limit IS NULL OR used_count < usage_limit)`
    ).get(input.promo_code.toUpperCase(), Date.now(), Date.now()) as any;

    if (promo) {
      const minOrder = promo.min_order_vnd || 0;
      if (runningTotal >= minOrder) {
        let discount = 0;
        if (promo.discount_type === 'percent') {
          discount = Math.round(runningTotal * promo.discount_value / 100);
          if (promo.max_discount_vnd && discount > promo.max_discount_vnd) {
            discount = promo.max_discount_vnd;
          }
        } else if (promo.discount_type === 'fixed_vnd') {
          discount = Math.round(promo.discount_value);
        }
        promoDiscount = discount;
        promoName = promo.name;
        runningTotal -= discount;
      }
    }
  }

  const finalTotal = Math.max(0, runningTotal);

  // 5. Build breakdown text
  const lines: string[] = [];
  const fmt = (n: number) => n.toLocaleString('vi-VN') + 'đ';
  lines.push(`Giá gốc: ${fmt(basePrice)} × ${nights} đêm = ${fmt(baseTotal)}`);
  for (const r of appliedRules) {
    const sign = r.amount_applied_vnd >= 0 ? '+' : '';
    lines.push(`${r.description}: ${sign}${fmt(r.amount_applied_vnd)}`);
  }
  if (vipDiscount > 0) {
    lines.push(`Ưu đãi khách ${vipTier}: -${fmt(vipDiscount)}`);
  }
  if (promoDiscount > 0) {
    lines.push(`Mã ${input.promo_code}: -${fmt(promoDiscount)}`);
  }
  lines.push(`**Tổng: ${fmt(finalTotal)}**`);

  return {
    base_price_per_night: basePrice,
    base_total: baseTotal,
    applied_rules: appliedRules,
    subtotal_after_rules: runningTotal + vipDiscount + promoDiscount,
    promo_discount_vnd: promoDiscount,
    promo_code: input.promo_code,
    promo_name: promoName,
    vip_discount_vnd: vipDiscount,
    vip_tier: vipTier,
    final_total_vnd: finalTotal,
    nights,
    savings_vnd: Math.max(0, baseTotal - finalTotal),
    markup_vnd: Math.max(0, finalTotal - baseTotal),
    breakdown_text: lines.join('\n'),
  };
}

/** Quick query: áp dụng rule nào cho date này (cho bot mô tả "cuối tuần có đắt hơn không") */
export function describeApplicableRules(hotelId: number, checkinDate: string, nights: number = 1, roomTypeCode?: string): AppliedRule[] {
  const booking = new Date().toISOString().slice(0, 10);
  const rules = db.prepare(
    `SELECT * FROM pricing_rules
     WHERE (hotel_id = ? OR hotel_id = 0) AND active = 1
       AND (room_type_code IS NULL OR room_type_code = ?)
     ORDER BY priority DESC`
  ).all(hotelId, roomTypeCode || null) as any[];

  const applicable: AppliedRule[] = [];
  for (const rule of rules) {
    const conds = parseConditions(rule.conditions_json);
    let matches = false;
    switch (rule.rule_type) {
      case 'weekend_markup':
      case 'early_bird':
      case 'last_minute':
      case 'seasonal':
        matches = matchesDateCondition(conds, checkinDate, booking);
        break;
      case 'long_stay':
        matches = nights >= (conds.nights_min || 1);
        break;
    }
    if (matches) {
      applicable.push({
        rule_id: rule.id,
        rule_type: rule.rule_type,
        rule_name: rule.rule_name,
        description: rule.description || '',
        modifier_type: rule.modifier_type,
        modifier_value: rule.modifier_value,
        amount_applied_vnd: 0,
      });
    }
  }
  return applicable;
}

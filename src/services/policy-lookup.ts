/**
 * Policy Lookup — tìm policy phù hợp cho context.
 *
 * Use cases:
 *   - Khách hỏi "hủy trước 2 ngày có mất phí không?" → findPolicy('cancellation', {hours: 48})
 *   - Khách hỏi "check-in sớm 10h được không?" → findPolicy('early_checkin', {requested_hour: 10})
 *   - Khách hỏi "có giảm giá khách quen không?" → findPolicy('vip_discount', {customer_tier: 'vip'})
 *   - Khách hỏi "mang chó cảnh được không?" → findPolicy('pet', {pet_type: 'dog'})
 */

import { db } from '../db';

export interface PolicyRule {
  id: number;
  hotel_id: number;
  policy_type: string;
  rule_name: string;
  conditions: any;
  effect: any;
  description: string;
  priority: number;
}

function parseJSON(s: string | null): any {
  if (!s) return {};
  try { return JSON.parse(s); } catch { return {}; }
}

/** Load all active rules of a type for hotel (+ global). */
export function getPoliciesByType(hotelId: number, policyType: string): PolicyRule[] {
  const rows = db.prepare(
    `SELECT * FROM hotel_policy_rules
     WHERE (hotel_id = ? OR hotel_id = 0) AND policy_type = ? AND active = 1
     ORDER BY priority DESC, id ASC`
  ).all(hotelId, policyType) as any[];
  return rows.map(r => ({
    id: r.id,
    hotel_id: r.hotel_id,
    policy_type: r.policy_type,
    rule_name: r.rule_name,
    conditions: parseJSON(r.conditions_json),
    effect: parseJSON(r.effect_json),
    description: r.description || '',
    priority: r.priority || 0,
  }));
}

/** Find first matching cancellation rule based on hours before check-in. */
export function findCancellationPolicy(hotelId: number, hoursBeforeCheckin: number): PolicyRule | null {
  const rules = getPoliciesByType(hotelId, 'cancellation');
  for (const r of rules) {
    const minH = r.conditions.hours_before_checkin_min;
    const maxH = r.conditions.hours_before_checkin_max;
    if ((minH === undefined || hoursBeforeCheckin >= minH) &&
        (maxH === undefined || hoursBeforeCheckin < maxH)) {
      return r;
    }
  }
  return null;
}

/** Find early check-in policy based on requested hour (0-23). */
export function findEarlyCheckinPolicy(hotelId: number, requestedHour: number): PolicyRule | null {
  // Standard check-in = 14h. Early = < 14h.
  const rules = getPoliciesByType(hotelId, 'early_checkin');
  for (const r of rules) {
    const beforeHour = r.conditions.before_hour || 14;
    if (requestedHour < beforeHour) return r;
  }
  return null;
}

/** Find late check-out policy. */
export function findLateCheckoutPolicy(hotelId: number, requestedHour: number): PolicyRule | null {
  // Standard check-out = 12h. Late = > 12h.
  const rules = getPoliciesByType(hotelId, 'late_checkout');
  for (const r of rules) {
    const minHour = r.conditions.after_hour_min;
    const maxHour = r.conditions.after_hour_max;
    if ((minHour === undefined || requestedHour >= minHour) &&
        (maxHour === undefined || requestedHour <= maxHour)) {
      return r;
    }
  }
  return null;
}

/** Find VIP discount for tier. */
export function findVipDiscount(hotelId: number, tier: string): PolicyRule | null {
  const rules = getPoliciesByType(hotelId, 'vip_discount');
  for (const r of rules) {
    if (r.conditions.customer_tier === tier ||
        (Array.isArray(r.conditions.customer_tier) && r.conditions.customer_tier.includes(tier))) {
      return r;
    }
  }
  return null;
}

/** Get pet policy. */
export function findPetPolicy(hotelId: number, petType?: string): PolicyRule | null {
  const rules = getPoliciesByType(hotelId, 'pet');
  for (const r of rules) {
    if (!r.conditions.pet_type || r.conditions.pet_type === petType || petType === undefined) {
      return r;
    }
  }
  return null;
}

/** Get smoking policy. */
export function findSmokingPolicy(hotelId: number): PolicyRule | null {
  const rules = getPoliciesByType(hotelId, 'smoking');
  return rules[0] || null;
}

/** Get child / extra guest policy. */
export function findChildPolicy(hotelId: number): PolicyRule | null {
  const rules = getPoliciesByType(hotelId, 'child');
  return rules[0] || null;
}

/** Get all policies as display-ready list (for admin UI hoặc bot listing). */
export function getAllPoliciesDisplay(hotelId: number): Array<{ type: string; name: string; description: string }> {
  const rows = db.prepare(
    `SELECT policy_type, rule_name, description FROM hotel_policy_rules
     WHERE (hotel_id = ? OR hotel_id = 0) AND active = 1
     ORDER BY policy_type, priority DESC`
  ).all(hotelId) as any[];
  return rows.map(r => ({
    type: r.policy_type,
    name: r.rule_name,
    description: r.description || '',
  }));
}

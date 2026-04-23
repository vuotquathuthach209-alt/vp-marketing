/**
 * Seed realistic Sonder domain data.
 * Run khi: fresh install OR admin clicks "seed sample data" button.
 * Idempotent: SKIP row nếu (hotel_id, policy_type, rule_name) đã tồn tại.
 */

import { db } from '../db';

export function seedSonderDomainData(): { policies: number; pricing: number; promos: number } {
  const now = Date.now();
  let policies = 0, pricing = 0, promos = 0;

  /* ═══════════════════════════════════════════
     1. POLICY RULES (global — hotel_id = 0)
     ═══════════════════════════════════════════ */

  const policyRules = [
    // Cancellation tiers
    {
      type: 'cancellation', name: 'free_48h',
      conditions: { hours_before_checkin_min: 48 },
      effect: { refund_percent: 100 },
      description: 'Hủy trước 48h check-in: hoàn tiền 100%', priority: 30,
    },
    {
      type: 'cancellation', name: 'half_24_48h',
      conditions: { hours_before_checkin_min: 24, hours_before_checkin_max: 48 },
      effect: { refund_percent: 50 },
      description: 'Hủy 24-48h trước check-in: hoàn tiền 50%', priority: 20,
    },
    {
      type: 'cancellation', name: 'no_refund_under_24h',
      conditions: { hours_before_checkin_max: 24 },
      effect: { refund_percent: 0 },
      description: 'Hủy < 24h hoặc no-show: không hoàn cọc', priority: 10,
    },

    // Early check-in
    {
      type: 'early_checkin', name: 'free_if_available',
      conditions: { before_hour: 14, min_hour: 12 },
      effect: { allowed: true, surcharge_vnd: 0, condition_text: 'Miễn phí nếu phòng sẵn' },
      description: 'Check-in 12h-14h: miễn phí nếu phòng còn trống', priority: 20,
    },
    {
      type: 'early_checkin', name: 'paid_30_percent',
      conditions: { before_hour: 12, min_hour: 9 },
      effect: { allowed: true, surcharge_percent: 30 },
      description: 'Check-in sớm 9h-12h: phụ phí 30% giá đêm', priority: 10,
    },
    {
      type: 'early_checkin', name: 'full_night_before',
      conditions: { before_hour: 9 },
      effect: { allowed: true, surcharge_percent: 100 },
      description: 'Check-in trước 9h: tính thêm 1 đêm', priority: 5,
    },

    // Late check-out
    {
      type: 'late_checkout', name: 'free_until_13h',
      conditions: { after_hour_min: 12, after_hour_max: 13 },
      effect: { allowed: true, surcharge_vnd: 0 },
      description: 'Check-out đến 13h: miễn phí', priority: 20,
    },
    {
      type: 'late_checkout', name: 'paid_30_until_15h',
      conditions: { after_hour_min: 13, after_hour_max: 15 },
      effect: { allowed: true, surcharge_percent: 30 },
      description: 'Check-out 13h-15h: phụ phí 30% giá đêm', priority: 15,
    },
    {
      type: 'late_checkout', name: 'paid_50_until_18h',
      conditions: { after_hour_min: 15, after_hour_max: 18 },
      effect: { allowed: true, surcharge_percent: 50 },
      description: 'Check-out 15h-18h: phụ phí 50% giá đêm', priority: 10,
    },
    {
      type: 'late_checkout', name: 'full_night_after_18h',
      conditions: { after_hour_min: 18 },
      effect: { allowed: true, surcharge_percent: 100 },
      description: 'Check-out sau 18h: tính thêm 1 đêm', priority: 5,
    },

    // VIP discounts (tier-based)
    {
      type: 'vip_discount', name: 'regular_tier',
      conditions: { customer_tier: 'regular' },
      effect: { discount_percent: 5 },
      description: 'Khách quen (3+ booking): giảm 5% tổng hóa đơn', priority: 10,
    },
    {
      type: 'vip_discount', name: 'vip_tier',
      conditions: { customer_tier: 'vip' },
      effect: { discount_percent: 10 },
      description: 'Khách VIP (6+ booking): giảm 10% tổng hóa đơn', priority: 20,
    },
    {
      type: 'vip_discount', name: 'black_vip_tier',
      conditions: { customer_tier: 'black_vip' },
      effect: { discount_percent: 15 },
      description: 'Khách BLACK VIP (12+ booking): giảm 15% + welcome drink', priority: 30,
    },

    // Pet
    {
      type: 'pet', name: 'small_pet_allowed',
      conditions: { pet_type: 'small' },
      effect: { allowed: true, surcharge_vnd: 200_000, condition_text: 'Thú cưng nhỏ (dưới 10kg): phụ phí 200k/đêm, có rọ mõm + tiêm phòng' },
      description: 'Thú cưng nhỏ < 10kg: OK với phụ phí 200k/đêm', priority: 10,
    },
    {
      type: 'pet', name: 'large_pet_case_by_case',
      conditions: { pet_type: 'large' },
      effect: { allowed: false, condition_text: 'Thú cưng lớn hoặc đặc biệt: liên hệ staff để xét duyệt' },
      description: 'Thú cưng > 10kg: không auto-approve, phải check với staff', priority: 5,
    },

    // Smoking
    {
      type: 'smoking', name: 'no_smoking',
      conditions: {},
      effect: { allowed: false, penalty_vnd: 2_000_000, condition_text: 'Cấm hút thuốc trong phòng. Vi phạm: phạt 2 triệu + deep cleaning fee' },
      description: 'Không hút thuốc trong phòng. Phạt 2 triệu nếu vi phạm', priority: 10,
    },

    // Children
    {
      type: 'child', name: 'free_under_6',
      conditions: { age_max: 6 },
      effect: { allowed: true, surcharge_vnd: 0 },
      description: 'Trẻ em dưới 6 tuổi: miễn phí, ngủ chung giường bố mẹ', priority: 10,
    },
    {
      type: 'child', name: 'extra_bed_6_12',
      conditions: { age_min: 6, age_max: 12 },
      effect: { allowed: true, surcharge_vnd: 250_000 },
      description: 'Trẻ 6-12 tuổi: phụ phí 250k/đêm cho giường phụ', priority: 5,
    },
    {
      type: 'child', name: 'adult_rate_12plus',
      conditions: { age_min: 12 },
      effect: { allowed: true, charge_as_adult: true },
      description: 'Trên 12 tuổi: tính như người lớn', priority: 1,
    },

    // Payment
    {
      type: 'payment', name: 'accepted_methods',
      conditions: {},
      effect: { methods: ['bank_transfer', 'momo', 'vnpay', 'cash', 'credit_card'], deposit_percent: 30 },
      description: 'Phương thức thanh toán: Chuyển khoản, MoMo, VNPay, Credit Card, Tiền mặt. Cọc trước 30% khi book.', priority: 10,
    },
  ];

  const policyStmt = db.prepare(
    `INSERT OR IGNORE INTO hotel_policy_rules
     (hotel_id, policy_type, rule_name, conditions_json, effect_json, description, priority, active, created_at, updated_at)
     VALUES (0, ?, ?, ?, ?, ?, ?, 1, ?, ?)`
  );
  for (const p of policyRules) {
    // Check duplicate by (hotel_id=0, policy_type, rule_name)
    const exists = db.prepare(
      `SELECT id FROM hotel_policy_rules WHERE hotel_id = 0 AND policy_type = ? AND rule_name = ?`
    ).get(p.type, p.name);
    if (exists) continue;
    policyStmt.run(p.type, p.name, JSON.stringify(p.conditions), JSON.stringify(p.effect), p.description, p.priority, now, now);
    policies++;
  }

  /* ═══════════════════════════════════════════
     2. PRICING RULES
     ═══════════════════════════════════════════ */

  const pricingRulesList = [
    // Weekend markup (Fri/Sat)
    {
      rule_type: 'weekend_markup', rule_name: 'fri_sat_20percent',
      conditions: { days_of_week: [5, 6] },
      modifier_type: 'percent_add', modifier_value: 20,
      priority: 30, stackable: 1,
      description: 'Cuối tuần (T6, T7): +20% giá weekday',
    },

    // Long-stay discount
    {
      rule_type: 'long_stay', rule_name: 'stay_3to6',
      conditions: { nights_min: 3, nights_max: 6 },
      modifier_type: 'percent_discount', modifier_value: 5,
      priority: 20, stackable: 1,
      description: 'Ở 3-6 đêm: giảm 5%',
    },
    {
      rule_type: 'long_stay', rule_name: 'stay_7to13',
      conditions: { nights_min: 7, nights_max: 13 },
      modifier_type: 'percent_discount', modifier_value: 10,
      priority: 21, stackable: 1,
      description: 'Ở 7-13 đêm: giảm 10%',
    },
    {
      rule_type: 'long_stay', rule_name: 'stay_14plus',
      conditions: { nights_min: 14 },
      modifier_type: 'percent_discount', modifier_value: 15,
      priority: 22, stackable: 1,
      description: 'Ở từ 14 đêm: giảm 15%',
    },

    // Early bird
    {
      rule_type: 'early_bird', rule_name: 'book_30days_ahead',
      conditions: { days_ahead_min: 30 },
      modifier_type: 'percent_discount', modifier_value: 10,
      priority: 15, stackable: 1,
      description: 'Đặt trước 30+ ngày: giảm 10%',
    },

    // Last minute (fill empty rooms)
    {
      rule_type: 'last_minute', rule_name: 'book_48h_ahead',
      conditions: { days_ahead_min: 1, days_ahead_max: 2 },
      modifier_type: 'percent_discount', modifier_value: 15,
      priority: 14, stackable: 1,
      description: 'Đặt gấp < 48h: giảm 15% (tùy phòng trống)',
    },

    // Seasonal — peak dates
    {
      rule_type: 'seasonal', rule_name: 'peak_30_4_1_5',
      conditions: { date_from: '2026-04-28', date_to: '2026-05-03' },
      modifier_type: 'percent_add', modifier_value: 30,
      priority: 50, stackable: 0,   // Non-stackable: override các rule khác
      description: 'Lễ 30/4-1/5: +30%',
    },
    {
      rule_type: 'seasonal', rule_name: 'peak_2_9',
      conditions: { date_from: '2026-08-31', date_to: '2026-09-04' },
      modifier_type: 'percent_add', modifier_value: 25,
      priority: 50, stackable: 0,
      description: 'Lễ 2/9: +25%',
    },
    {
      rule_type: 'seasonal', rule_name: 'peak_christmas_newyear',
      conditions: { date_from: '2026-12-23', date_to: '2027-01-02' },
      modifier_type: 'percent_add', modifier_value: 40,
      priority: 50, stackable: 0,
      description: 'Giáng Sinh + Tết Tây: +40%',
    },
    {
      rule_type: 'seasonal', rule_name: 'peak_tet_am_2027',
      conditions: { date_from: '2027-02-15', date_to: '2027-02-21' },
      modifier_type: 'percent_add', modifier_value: 50,
      priority: 50, stackable: 0,
      description: 'Tết Âm 2027: +50%',
    },

    // Group booking
    {
      rule_type: 'group', rule_name: 'group_6plus_guests',
      conditions: { min_guests: 6 },
      modifier_type: 'percent_discount', modifier_value: 7,
      priority: 10, stackable: 1,
      description: 'Đoàn 6+ khách: giảm 7%',
    },
  ];

  const pricingStmt = db.prepare(
    `INSERT INTO pricing_rules
     (hotel_id, room_type_code, rule_type, rule_name, conditions_json, modifier_type, modifier_value, priority, stackable, description, active, created_at, updated_at)
     VALUES (0, NULL, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`
  );
  for (const p of pricingRulesList) {
    const exists = db.prepare(
      `SELECT id FROM pricing_rules WHERE hotel_id = 0 AND rule_type = ? AND rule_name = ?`
    ).get(p.rule_type, p.rule_name);
    if (exists) continue;
    pricingStmt.run(p.rule_type, p.rule_name, JSON.stringify(p.conditions), p.modifier_type, p.modifier_value, p.priority, p.stackable, p.description, now, now);
    pricing++;
  }

  /* ═══════════════════════════════════════════
     3. PROMOTIONS
     ═══════════════════════════════════════════ */

  const promoList = [
    {
      code: 'SONDER2026',
      name: 'Khách mới — giảm 15%',
      discount_type: 'percent', discount_value: 15, max_discount_vnd: 500_000,
      min_order_vnd: 500_000,
      eligibility: { first_time_only: true, customer_tier: ['new'] },
      usage_limit: 1000,
      usage_per_customer: 1,
      valid_from: now,
      valid_to: now + 365 * 24 * 3600_000,
      description: 'Khách đặt phòng lần đầu tại Sonder: giảm 15% (tối đa 500k). Dùng mã SONDER2026',
    },
    {
      code: 'BIRTHDAY',
      name: 'Sinh nhật giảm 20%',
      discount_type: 'percent', discount_value: 20, max_discount_vnd: 700_000,
      min_order_vnd: 500_000,
      eligibility: { requires_dob_match: true },
      usage_per_customer: 1,
      valid_from: now,
      valid_to: now + 365 * 24 * 3600_000,
      description: 'Giảm 20% (tối đa 700k) trong tháng sinh nhật. Mã BIRTHDAY',
    },
    {
      code: 'REFER5',
      name: 'Giới thiệu bạn — giảm 10%',
      discount_type: 'percent', discount_value: 10, max_discount_vnd: 300_000,
      eligibility: { requires_referral: true },
      valid_from: now,
      valid_to: now + 180 * 24 * 3600_000,
      description: 'Giới thiệu bạn bè đặt phòng: giảm 10% cho lần đặt tiếp theo',
    },
    {
      code: 'FLASH100K',
      name: 'Flash sale — giảm 100k',
      discount_type: 'fixed_vnd', discount_value: 100_000,
      min_order_vnd: 800_000,
      usage_limit: 200,
      valid_from: now,
      valid_to: now + 30 * 24 * 3600_000,
      description: 'Flash sale tháng này: giảm 100k đơn từ 800k',
    },
  ];

  const promoStmt = db.prepare(
    `INSERT OR IGNORE INTO promotions
     (hotel_id, code, name, discount_type, discount_value, max_discount_vnd, min_order_vnd,
      eligibility_json, usage_limit, usage_per_customer, used_count,
      valid_from, valid_to, active, description, created_at, updated_at)
     VALUES (0, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, 1, ?, ?, ?)`
  );
  for (const p of promoList) {
    promoStmt.run(
      p.code, p.name, p.discount_type, p.discount_value,
      p.max_discount_vnd || null, p.min_order_vnd || null,
      JSON.stringify(p.eligibility || {}),
      p.usage_limit || null, p.usage_per_customer || 1,
      p.valid_from, p.valid_to,
      p.description, now, now,
    );
    promos++;
  }

  console.log(`[domain-seed] policies=${policies} pricing=${pricing} promos=${promos}`);
  return { policies, pricing, promos };
}

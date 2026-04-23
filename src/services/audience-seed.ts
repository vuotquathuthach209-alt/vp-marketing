/**
 * Seed 8 realistic audiences cho Sonder.
 */

import { db } from '../db';
import { BUILTIN_AUDIENCES } from './marketing-audience-engine';

interface AudienceSeed {
  audience_name: string;
  display_name: string;
  description: string;
  filter_criteria: any;
  refresh_interval_min: number;
}

const SEED_AUDIENCES: AudienceSeed[] = [
  {
    audience_name: 'new_leads_no_booking',
    display_name: 'Khách mới chưa đặt phòng',
    description: 'Khách đã inbox 2-30 ngày qua nhưng chưa confirm booking → cần follow up',
    filter_criteria: { inbox_window_days: [2, 30], no_booking: true, min_messages: 2 },
    refresh_interval_min: 720,   // 12h
  },
  {
    audience_name: 'abandoned_cart_2h',
    display_name: 'Giỏ hàng bị bỏ',
    description: 'Khách đã tạo booking hold nhưng expire (không cọc) trong 1-24h qua',
    filter_criteria: { hold_expired_window_hours: [1, 24] },
    refresh_interval_min: 60,    // hourly (realtime)
  },
  {
    audience_name: 'vip_inactive_30d',
    display_name: 'Khách VIP ngủ đông',
    description: 'Khách VIP/BLACK_VIP không đặt 30+ ngày — send winback promo',
    filter_criteria: { tier: ['vip', 'black_vip'], last_booking_days_gte: 30 },
    refresh_interval_min: 1440,  // daily
  },
  {
    audience_name: 'regular_returners',
    display_name: 'Khách quen sắp cần đặt',
    description: 'Khách regular, last booking 15-60 ngày → upsell dịp sắp tới',
    filter_criteria: { tier: 'regular', last_booking_days_between: [15, 60] },
    refresh_interval_min: 1440,
  },
  {
    audience_name: 'churned_customers',
    display_name: 'Khách đã rời xa',
    description: 'Khách từng VIP/regular nhưng im 90+ ngày — winback aggressive',
    filter_criteria: { tier: ['regular', 'vip', 'black_vip'], last_booking_days_gte: 90 },
    refresh_interval_min: 10080,  // weekly
  },
  {
    audience_name: 'high_intent_no_book',
    display_name: 'Lead chất lượng — đã để SĐT',
    description: 'Khách đã để SĐT nhưng chưa book (contact captured 14 ngày)',
    filter_criteria: { has_phone: true, no_booking: true, captured_days_window: 14 },
    refresh_interval_min: 360,   // 6h
  },
  {
    audience_name: 'peak_date_leads',
    display_name: 'Lead peak date hụt phòng',
    description: 'Khách đã hỏi 30/4, 2/9, lễ Tết nhưng đã hết phòng → gợi ý option khác',
    filter_criteria: { peak_keywords: true, window_days: 30 },
    refresh_interval_min: 720,
  },
  {
    audience_name: 'birthday_this_month',
    display_name: 'Sinh nhật tháng này',
    description: 'Khách có DOB trong tháng hiện tại → send mã BIRTHDAY',
    filter_criteria: { dob_month_current: true },
    refresh_interval_min: 1440,
  },
];

export function seedAudiences(): { created: number; skipped: number } {
  const now = Date.now();
  let created = 0, skipped = 0;

  const stmt = db.prepare(
    `INSERT OR IGNORE INTO marketing_audiences
     (hotel_id, audience_name, display_name, description, filter_type, filter_criteria,
      refresh_interval_min, active, created_by, created_at, updated_at)
     VALUES (0, ?, ?, ?, 'sql_rule', ?, ?, 1, 'seed', ?, ?)`
  );

  for (const a of SEED_AUDIENCES) {
    // Skip nếu audience_name đã tồn tại (global)
    const exists = db.prepare(
      `SELECT id FROM marketing_audiences WHERE hotel_id = 0 AND audience_name = ?`
    ).get(a.audience_name);
    if (exists) { skipped++; continue; }

    // Verify built-in SQL exists
    if (!BUILTIN_AUDIENCES[a.audience_name]) {
      console.warn(`[audience-seed] no built-in SQL for ${a.audience_name}, skipping`);
      skipped++;
      continue;
    }

    stmt.run(
      a.audience_name, a.display_name, a.description,
      JSON.stringify(a.filter_criteria),
      a.refresh_interval_min,
      now, now,
    );
    created++;
  }

  console.log(`[audience-seed] created=${created} skipped=${skipped}`);
  return { created, skipped };
}

/**
 * Curated keyword seed cho Sondervn (OTA marketplace bán phòng cho khách sạn đối tác).
 *
 * Strategy:
 *   - 🟢 BRANDED (8): mục tiêu top 3 trong 4-6 tuần. Phải có để dominate khi user search "sondervn"
 *   - 🟢 LONG-TAIL CỤ THỂ (16): mục tiêu top 10 trong 2-5 tháng. Đây là chiến trường thực dụng
 *   - 🟡 MEDIUM-TAIL (12): mục tiêu top 30 trong 6-12 tháng + 5-15 backlinks
 *   - 🔴 HEAD TERMS (6): chỉ TRACK (track to measure, not expected to rank fast).
 *     Booking/Agoda/Traveloka chiếm — cần 18-24 tháng + 50+ backlinks
 *
 * Tier dùng `category` field để filter trong dashboard.
 */

export interface SeedKeyword {
  keyword: string;
  target_url: string;
  category: 'branded' | 'long_tail' | 'medium_tail' | 'head_term';
  priority: 'high' | 'medium' | 'low';
  notes?: string;
}

export const SONDERVN_SEED_KEYWORDS: SeedKeyword[] = [
  // ───────── BRANDED (8) — phải dominate trong 1 tháng ─────────
  { keyword: 'sondervn', target_url: 'https://sondervn.com', category: 'branded', priority: 'high',
    notes: 'Pure brand search — phải #1' },
  { keyword: 'sonder vn', target_url: 'https://sondervn.com', category: 'branded', priority: 'high' },
  { keyword: 'sondervn.com', target_url: 'https://sondervn.com', category: 'branded', priority: 'high' },
  { keyword: 'sonder việt nam', target_url: 'https://sondervn.com', category: 'branded', priority: 'high' },
  { keyword: 'sonder apartment hotel', target_url: 'https://sondervn.com', category: 'branded', priority: 'high' },
  { keyword: 'sonder apartment sài gòn', target_url: 'https://sondervn.com', category: 'branded', priority: 'high' },
  { keyword: 'đặt phòng sondervn', target_url: 'https://sondervn.com', category: 'branded', priority: 'medium' },
  { keyword: 'review sondervn', target_url: 'https://sondervn.com', category: 'branded', priority: 'medium' },

  // ───────── LONG-TAIL CỤ THỂ (16) — chiến trường chính ─────────
  // TP HCM (5 hotels có)
  { keyword: 'khách sạn quận 1 sài gòn giá dưới 500k', target_url: 'https://sondervn.com/khu-vuc/quan-1-sai-gon', category: 'long_tail', priority: 'high',
    notes: 'Bài #1 đã sinh — sẵn sàng publish' },
  { keyword: 'khách sạn bùi viện giá rẻ có máy lạnh', target_url: 'https://sondervn.com/khu-vuc/bui-vien', category: 'long_tail', priority: 'high' },
  { keyword: 'homestay cô giang quận 1 gia đình', target_url: 'https://sondervn.com/khu-vuc/co-giang', category: 'long_tail', priority: 'high' },
  { keyword: 'khách sạn phạm ngũ lão sài gòn dưới 400k', target_url: 'https://sondervn.com/khu-vuc/pham-ngu-lao', category: 'long_tail', priority: 'high' },
  { keyword: 'khách sạn gần chợ bến thành giá rẻ', target_url: 'https://sondervn.com/khu-vuc/ben-thanh', category: 'long_tail', priority: 'high' },
  { keyword: 'khách sạn quận 3 sài gòn gần trung tâm', target_url: 'https://sondervn.com/khu-vuc/quan-3', category: 'long_tail', priority: 'high' },
  { keyword: 'khách sạn tân bình gần sân bay tân sơn nhất', target_url: 'https://sondervn.com/khu-vuc/tan-binh', category: 'long_tail', priority: 'medium' },

  // Đà Lạt (2 hotels có)
  { keyword: 'homestay đà lạt view đồi giá rẻ', target_url: 'https://sondervn.com/khu-vuc/da-lat', category: 'long_tail', priority: 'high' },
  { keyword: 'khách sạn đà lạt trung tâm gần chợ đêm', target_url: 'https://sondervn.com/khu-vuc/da-lat-trung-tam', category: 'long_tail', priority: 'high' },
  { keyword: 'homestay đà lạt dành cho cặp đôi', target_url: 'https://sondervn.com/khu-vuc/da-lat', category: 'long_tail', priority: 'medium' },

  // Đà Nẵng (1 hotel có)
  { keyword: 'khách sạn đà nẵng gần biển mỹ khê', target_url: 'https://sondervn.com/khu-vuc/da-nang', category: 'long_tail', priority: 'high' },
  { keyword: 'homestay đà nẵng giá rẻ gần cầu rồng', target_url: 'https://sondervn.com/khu-vuc/da-nang', category: 'long_tail', priority: 'medium' },

  // Booking journey
  { keyword: 'cách đặt phòng khách sạn không cần thẻ tín dụng', target_url: 'https://sondervn.com/huong-dan-dat-phong', category: 'long_tail', priority: 'medium' },
  { keyword: 'app đặt phòng khách sạn việt nam của người việt', target_url: 'https://sondervn.com', category: 'long_tail', priority: 'high',
    notes: 'Positioning Sondervn là OTA Việt Nam, không phải Agoda quốc tế' },
  { keyword: 'đặt phòng khách sạn không phụ phí thẻ', target_url: 'https://sondervn.com', category: 'long_tail', priority: 'medium' },
  { keyword: 'đặt phòng theo giờ sài gòn ban ngày', target_url: 'https://sondervn.com', category: 'long_tail', priority: 'medium' },

  // ───────── MEDIUM-TAIL (12) — 6-12 tháng + backlinks ─────────
  { keyword: 'khách sạn quận 1 giá rẻ', target_url: 'https://sondervn.com/khu-vuc/quan-1-sai-gon', category: 'medium_tail', priority: 'high' },
  { keyword: 'khách sạn bùi viện', target_url: 'https://sondervn.com/khu-vuc/bui-vien', category: 'medium_tail', priority: 'high' },
  { keyword: 'homestay đà lạt giá rẻ', target_url: 'https://sondervn.com/khu-vuc/da-lat', category: 'medium_tail', priority: 'high' },
  { keyword: 'khách sạn đà nẵng giá rẻ', target_url: 'https://sondervn.com/khu-vuc/da-nang', category: 'medium_tail', priority: 'high' },
  { keyword: 'khách sạn trung tâm sài gòn', target_url: 'https://sondervn.com/khu-vuc/sai-gon', category: 'medium_tail', priority: 'medium' },
  { keyword: 'khách sạn quận 3 giá rẻ', target_url: 'https://sondervn.com/khu-vuc/quan-3', category: 'medium_tail', priority: 'medium' },
  { keyword: 'homestay quận 1', target_url: 'https://sondervn.com/khu-vuc/quan-1-sai-gon', category: 'medium_tail', priority: 'medium' },
  { keyword: 'khách sạn gần chợ bến thành', target_url: 'https://sondervn.com/khu-vuc/ben-thanh', category: 'medium_tail', priority: 'medium' },
  { keyword: 'khách sạn đà lạt trung tâm', target_url: 'https://sondervn.com/khu-vuc/da-lat-trung-tam', category: 'medium_tail', priority: 'medium' },
  { keyword: 'hostel sài gòn', target_url: 'https://sondervn.com/khu-vuc/sai-gon', category: 'medium_tail', priority: 'low' },
  { keyword: 'phòng khách sạn theo giờ', target_url: 'https://sondervn.com', category: 'medium_tail', priority: 'low' },
  { keyword: 'app đặt khách sạn việt nam', target_url: 'https://sondervn.com', category: 'medium_tail', priority: 'medium' },

  // ───────── HEAD TERMS (6) — track only, expect 18-24 tháng ─────────
  { keyword: 'khách sạn sài gòn', target_url: 'https://sondervn.com/khu-vuc/sai-gon', category: 'head_term', priority: 'low',
    notes: 'Agoda/Booking dominate — track to measure progress' },
  { keyword: 'khách sạn đà lạt', target_url: 'https://sondervn.com/khu-vuc/da-lat', category: 'head_term', priority: 'low' },
  { keyword: 'khách sạn đà nẵng', target_url: 'https://sondervn.com/khu-vuc/da-nang', category: 'head_term', priority: 'low' },
  { keyword: 'đặt phòng khách sạn', target_url: 'https://sondervn.com', category: 'head_term', priority: 'low' },
  { keyword: 'app đặt phòng', target_url: 'https://sondervn.com', category: 'head_term', priority: 'low' },
  { keyword: 'homestay việt nam', target_url: 'https://sondervn.com', category: 'head_term', priority: 'low' },
];

/**
 * Bulk insert seed keywords. Idempotent (INSERT OR IGNORE on keyword).
 *
 * @returns { inserted, skipped, total } stats
 */
export function seedSondervnKeywords(): { inserted: number; skipped: number; total: number } {
  const { db } = require('../../db');
  const now = Date.now();

  const stmt = db.prepare(
    `INSERT OR IGNORE INTO seo_keywords
       (keyword, target_url, category, search_volume, current_rank, prev_rank, last_checked_at, created_at)
     VALUES (?, ?, ?, ?, NULL, NULL, NULL, ?)`,
  );

  let inserted = 0, skipped = 0;
  const tx = db.transaction((items: SeedKeyword[]) => {
    for (const k of items) {
      const r = stmt.run(
        k.keyword.toLowerCase().trim(),
        k.target_url,
        k.category,
        0,         // search_volume — admin có thể update sau
        now,
      );
      if (r.changes > 0) inserted++; else skipped++;
    }
  });
  tx(SONDERVN_SEED_KEYWORDS);

  return { inserted, skipped, total: SONDERVN_SEED_KEYWORDS.length };
}

/** Bulk insert custom list (e.g. admin pastes CSV). */
export function bulkInsertKeywords(items: Array<{ keyword: string; target_url?: string; category?: string }>): { inserted: number; skipped: number } {
  const { db } = require('../../db');
  const now = Date.now();
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO seo_keywords
       (keyword, target_url, category, search_volume, current_rank, prev_rank, last_checked_at, created_at)
     VALUES (?, ?, ?, 0, NULL, NULL, NULL, ?)`,
  );
  let inserted = 0, skipped = 0;
  const tx = db.transaction((rows: any[]) => {
    for (const r of rows) {
      if (!r.keyword || !String(r.keyword).trim()) { skipped++; continue; }
      const out = stmt.run(
        String(r.keyword).toLowerCase().trim(),
        r.target_url || null,
        r.category || null,
        now,
      );
      if (out.changes > 0) inserted++; else skipped++;
    }
  });
  tx(items);
  return { inserted, skipped };
}

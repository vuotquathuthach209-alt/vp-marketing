/**
 * Monthly Learning — chạy mùng 1 hàng tháng
 *
 * Mục tiêu: tổng hợp bot_feedback (staff đã chấm) + câu Q-A có rating cao
 * thành "patterns" lưu vào monthly_learnings → sau này có thể apply
 * cross-hotel (anonymized) cho các KS mới.
 *
 * Phase 1 (Week 3): chỉ aggregate nội bộ per-hotel.
 * Phase 2 (sau): cross-hotel apply.
 */

import { db } from './../db';

export function aggregateMonthlyLearnings(): {
  month: string;
  good_qa: number;
  corrections: number;
  hotels: number;
} {
  const now = new Date();
  // Tổng hợp tháng trước (mùng 1 chạy → tổng tháng trước)
  const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const month = `${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, '0')}`;
  const startMs = prev.getTime();
  const endMs = new Date(prev.getFullYear(), prev.getMonth() + 1, 1).getTime();

  // 1. Top câu hỏi có rating = 1 (bot trả đúng) — pattern tốt
  const goodQa = db.prepare(`
    SELECT hotel_id, user_question, bot_answer, COUNT(*) as hits
    FROM bot_feedback
    WHERE rating = 1 AND created_at >= ? AND created_at < ?
    GROUP BY hotel_id, user_question
    HAVING hits >= 1
    ORDER BY hits DESC
    LIMIT 100
  `).all(startMs, endMs) as any[];

  // 2. Các correction (rating -1 + corrected_answer) — knowledge gaps
  const corrections = db.prepare(`
    SELECT hotel_id, user_question, corrected_answer, COUNT(*) as hits
    FROM bot_feedback
    WHERE rating = -1 AND corrected_answer IS NOT NULL AND corrected_answer != ''
      AND created_at >= ? AND created_at < ?
    GROUP BY hotel_id, user_question
    ORDER BY hits DESC
    LIMIT 100
  `).all(startMs, endMs) as any[];

  const hotels = new Set<number>();
  const createdAt = Date.now();

  const insert = db.prepare(
    `INSERT INTO monthly_learnings (month, pattern_type, pattern, accuracy, hotels_learned_from, applied_to_hotels, created_at)
     VALUES (?, ?, ?, ?, ?, 0, ?)`
  );

  for (const r of goodQa) {
    hotels.add(r.hotel_id);
    insert.run(
      month, 'good_qa',
      JSON.stringify({ q: r.user_question, a: r.bot_answer, hotel_id: r.hotel_id, hits: r.hits }),
      1.0, 1, createdAt
    );
  }
  for (const r of corrections) {
    hotels.add(r.hotel_id);
    insert.run(
      month, 'correction',
      JSON.stringify({ q: r.user_question, corrected: r.corrected_answer, hotel_id: r.hotel_id, hits: r.hits }),
      0.5, 1, createdAt
    );
  }

  return { month, good_qa: goodQa.length, corrections: corrections.length, hotels: hotels.size };
}

export function getRecentLearnings(limit = 50) {
  return db.prepare(
    `SELECT * FROM monthly_learnings ORDER BY id DESC LIMIT ?`
  ).all(limit);
}

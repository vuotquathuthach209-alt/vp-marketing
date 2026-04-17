/**
 * Bot Feedback API — staff khách sạn chấm điểm câu trả lời của bot
 * để feed vào monthly_learnings (cross-hotel pattern) sau này.
 */
import { Router } from 'express';
import { db } from '../db';
import { authMiddleware, AuthRequest, getHotelId } from '../middleware/auth';

const router = Router();
router.use(authMiddleware);

// GET /api/feedback/recent-replies — 50 câu trả lời gần nhất của bot để staff chấm
router.get('/recent-replies', (req: AuthRequest, res) => {
  const hotelId = getHotelId(req);
  // Lấy từ auto_reply_log (ghi mỗi lần bot trả)
  const rows = db.prepare(`
    SELECT l.id, l.page_id, l.kind, l.fb_id, l.original_text AS user_message, l.reply_text AS bot_reply,
           l.status, l.created_at,
           (SELECT rating FROM bot_feedback WHERE message_id = CAST(l.id AS TEXT) AND hotel_id = ? LIMIT 1) AS existing_rating
    FROM auto_reply_log l
    WHERE l.hotel_id = ? AND l.reply_text IS NOT NULL AND l.reply_text != ''
    ORDER BY l.id DESC LIMIT 50
  `).all(hotelId, hotelId);
  res.json(rows);
});

// POST /api/feedback/rate — chấm điểm 1 câu trả lời
router.post('/rate', (req: AuthRequest, res) => {
  const hotelId = getHotelId(req);
  const { message_id, user_question, bot_answer, rating, corrected_answer } = req.body;
  if (!user_question || !bot_answer || rating === undefined) {
    return res.status(400).json({ error: 'Thiếu user_question, bot_answer hoặc rating' });
  }
  const r = parseInt(rating, 10);
  if (r < -1 || r > 1) return res.status(400).json({ error: 'rating phải -1 / 0 / 1' });

  // Upsert (1 rating / message_id / hotel)
  if (message_id) {
    const existing = db.prepare(
      `SELECT id FROM bot_feedback WHERE hotel_id = ? AND message_id = ?`
    ).get(hotelId, String(message_id)) as { id: number } | undefined;
    if (existing) {
      db.prepare(
        `UPDATE bot_feedback SET rating = ?, corrected_answer = ?, reviewed_by = ?, created_at = ? WHERE id = ?`
      ).run(r, corrected_answer || null, (req as any).user?.id || null, Date.now(), existing.id);
      return res.json({ ok: true, updated: true });
    }
  }

  db.prepare(
    `INSERT INTO bot_feedback (hotel_id, message_id, user_question, bot_answer, rating, corrected_answer, reviewed_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    hotelId, message_id ? String(message_id) : null,
    user_question, bot_answer, r, corrected_answer || null,
    (req as any).user?.id || null, Date.now()
  );

  // Nếu negative rating + corrected_answer → auto-tạo wiki entry để bot học ngay
  if (r < 0 && corrected_answer && corrected_answer.trim()) {
    try {
      const title = user_question.slice(0, 80);
      const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) + '-' + Date.now();
      db.prepare(
        `INSERT INTO knowledge_wiki (namespace, slug, title, content, tags, always_inject, active, hotel_id, created_at, updated_at)
         VALUES ('faq', ?, ?, ?, '["feedback-learned"]', 0, 1, ?, ?, ?)`
      ).run(slug, title, `Q: ${user_question}\nA: ${corrected_answer}`, hotelId, Date.now(), Date.now());
    } catch (e: any) {
      console.warn('[feedback] auto-wiki fail:', e?.message);
    }
  }

  res.json({ ok: true });
});

// GET /api/feedback/stats — staff xem tổng quan feedback của mình
router.get('/stats', (req: AuthRequest, res) => {
  const hotelId = getHotelId(req);
  const agg = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN rating = 1 THEN 1 ELSE 0 END) as good,
      SUM(CASE WHEN rating = -1 THEN 1 ELSE 0 END) as bad,
      SUM(CASE WHEN corrected_answer IS NOT NULL AND corrected_answer != '' THEN 1 ELSE 0 END) as corrected
    FROM bot_feedback WHERE hotel_id = ?
  `).get(hotelId) as any;
  res.json(agg);
});

// GET /api/feedback/guests — danh sách guest profiles (staff xem lịch sử khách)
router.get('/guests', (req: AuthRequest, res) => {
  const hotelId = getHotelId(req);
  const rows = db.prepare(`
    SELECT id, fb_user_id, name, phone, language, first_seen, last_seen,
           total_conversations, booked_count, preferences
    FROM guest_profiles
    WHERE hotel_id = ?
    ORDER BY last_seen DESC LIMIT 100
  `).all(hotelId);
  res.json(rows);
});

export default router;

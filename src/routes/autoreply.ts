import { Router } from 'express';
import { db } from '../db';
import { authMiddleware, AuthRequest, getHotelId } from '../middleware/auth';
import { isBotPaused, pauseBot, resumeBot } from '../services/bot-control';

const router = Router();
router.use(authMiddleware);

// ── Kill switch ─────────────────────────────────────────────────────────
router.get('/pause-status', (req: AuthRequest, res) => {
  res.json(isBotPaused(getHotelId(req)));
});

router.post('/pause', (req: AuthRequest, res) => {
  const { minutes, reason } = req.body || {};
  const m = typeof minutes === 'number' ? minutes : parseInt(minutes, 10);
  if (isNaN(m)) return res.status(400).json({ error: 'minutes required (number; -1 = vô hạn)' });
  const until = pauseBot(getHotelId(req), m, reason);
  res.json({ ok: true, paused_until: until });
});

router.post('/resume', (req: AuthRequest, res) => {
  resumeBot(getHotelId(req));
  res.json({ ok: true });
});

router.get('/config', (req: AuthRequest, res) => {
  const hotelId = getHotelId(req);
  const rows = db
    .prepare(
      `SELECT p.id as page_id, p.name,
              COALESCE(c.reply_comments, 0) as reply_comments,
              COALESCE(c.reply_messages, 0) as reply_messages,
              COALESCE(c.system_prompt, '') as system_prompt
       FROM pages p LEFT JOIN auto_reply_config c ON c.page_id = p.id
       WHERE p.hotel_id = ?
       ORDER BY p.id ASC`
    )
    .all(hotelId);
  res.json(rows);
});

router.post('/config', (req: AuthRequest, res) => {
  const { page_id, reply_comments, reply_messages, system_prompt } = req.body;
  if (!page_id) return res.status(400).json({ error: 'Thieu page_id' });
  db.prepare(
    `INSERT INTO auto_reply_config (page_id, reply_comments, reply_messages, system_prompt, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(page_id) DO UPDATE SET
       reply_comments=excluded.reply_comments,
       reply_messages=excluded.reply_messages,
       system_prompt=excluded.system_prompt,
       updated_at=excluded.updated_at`
  ).run(page_id, reply_comments ? 1 : 0, reply_messages ? 1 : 0, system_prompt || '', Date.now());
  res.json({ ok: true });
});

router.get('/log', (req: AuthRequest, res) => {
  const hotelId = getHotelId(req);
  const items = db
    .prepare(
      `SELECT l.*, p.name as page_name
       FROM auto_reply_log l LEFT JOIN pages p ON p.id = l.page_id
       WHERE l.hotel_id = ?
       ORDER BY l.id DESC LIMIT 100`
    )
    .all(hotelId);
  res.json(items);
});

export default router;

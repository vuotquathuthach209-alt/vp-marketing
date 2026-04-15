import { Router } from 'express';
import { db } from '../db';
import { authMiddleware } from '../middleware/auth';

const router = Router();
router.use(authMiddleware);

router.get('/', (req, res) => {
  const items = db
    .prepare(
      `SELECT c.*, p.name as page_name
       FROM campaigns c LEFT JOIN pages p ON p.id = c.page_id
       ORDER BY c.id DESC`
    )
    .all() as any[];
  res.json(
    items.map((c) => ({
      ...c,
      topics: JSON.parse(c.topics),
      times: JSON.parse(c.times),
    }))
  );
});

router.post('/', (req, res) => {
  const { name, page_id, topics, times, with_image, active } = req.body;
  if (!name || !page_id) return res.status(400).json({ error: 'Thiếu tên hoặc page' });
  if (!Array.isArray(topics) || topics.length === 0) return res.status(400).json({ error: 'Thiếu chủ đề' });
  if (!Array.isArray(times) || times.length === 0) return res.status(400).json({ error: 'Thiếu giờ đăng' });

  // Validate giờ HH:MM
  const reg = /^([01]\d|2[0-3]):[0-5]\d$/;
  for (const t of times) if (!reg.test(t)) return res.status(400).json({ error: `Giờ không hợp lệ: ${t}` });

  const result = db
    .prepare(
      `INSERT INTO campaigns (name, page_id, topics, times, with_image, active, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      name,
      page_id,
      JSON.stringify(topics.filter((t: string) => t.trim())),
      JSON.stringify(times),
      with_image ? 1 : 0,
      active !== false ? 1 : 0,
      Date.now()
    );
  res.json({ id: result.lastInsertRowid });
});

router.patch('/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { active } = req.body;
  if (typeof active === 'boolean') {
    db.prepare(`UPDATE campaigns SET active = ? WHERE id = ?`).run(active ? 1 : 0, id);
  }
  res.json({ ok: true });
});

router.delete('/:id', (req, res) => {
  db.prepare(`DELETE FROM campaigns WHERE id = ?`).run(parseInt(req.params.id, 10));
  res.json({ ok: true });
});

export default router;

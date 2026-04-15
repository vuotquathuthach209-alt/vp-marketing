import { Router } from 'express';
import { db } from '../db';
import { authMiddleware } from '../middleware/auth';
import { publishText, publishImage, publishVideo, mediaFullPath } from '../services/facebook';

const router = Router();
router.use(authMiddleware);

// Danh sách bài đăng
router.get('/', (req, res) => {
  const items = db
    .prepare(
      `SELECT p.*, pg.name as page_name, m.filename as media_filename, m.mime_type as media_mime
       FROM posts p
       LEFT JOIN pages pg ON pg.id = p.page_id
       LEFT JOIN media m ON m.id = p.media_id
       ORDER BY p.id DESC LIMIT 200`
    )
    .all();
  res.json(items);
});

// Tạo bài đăng (draft / scheduled)
router.post('/', (req, res) => {
  const { page_id, caption, media_id, scheduled_at, publish_now } = req.body;
  if (!page_id || !caption) return res.status(400).json({ error: 'Thiếu page hoặc caption' });

  // Xác định media_type
  let media_type: string | null = 'none';
  if (media_id) {
    const media = db.prepare(`SELECT mime_type FROM media WHERE id = ?`).get(media_id) as
      | { mime_type: string }
      | undefined;
    if (!media) return res.status(400).json({ error: 'Media không tồn tại' });
    media_type = media.mime_type.startsWith('video/') ? 'video' : 'image';
  }

  const status = publish_now ? 'scheduled' : (scheduled_at ? 'scheduled' : 'draft');
  const sched = publish_now ? Date.now() : scheduled_at || null;

  const result = db
    .prepare(
      `INSERT INTO posts (page_id, caption, media_id, media_type, status, scheduled_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(page_id, caption, media_id || null, media_type, status, sched, Date.now());

  res.json({ id: result.lastInsertRowid });
});

// Đăng ngay lập tức (không chờ scheduler)
router.post('/:id/publish-now', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const post = db.prepare(`SELECT * FROM posts WHERE id = ?`).get(id) as any;
  if (!post) return res.status(404).json({ error: 'Không tìm thấy bài' });

  const page = db.prepare(`SELECT * FROM pages WHERE id = ?`).get(post.page_id) as any;
  if (!page) return res.status(400).json({ error: 'Không tìm thấy Fanpage' });

  db.prepare(`UPDATE posts SET status = 'publishing' WHERE id = ?`).run(id);
  try {
    let result;
    if (post.media_type === 'image' && post.media_id) {
      const media = db.prepare(`SELECT filename FROM media WHERE id = ?`).get(post.media_id) as any;
      result = await publishImage(page.fb_page_id, page.access_token, post.caption, mediaFullPath(media.filename));
    } else if (post.media_type === 'video' && post.media_id) {
      const media = db.prepare(`SELECT filename FROM media WHERE id = ?`).get(post.media_id) as any;
      result = await publishVideo(page.fb_page_id, page.access_token, post.caption, mediaFullPath(media.filename));
    } else {
      result = await publishText(page.fb_page_id, page.access_token, post.caption);
    }
    db.prepare(
      `UPDATE posts SET status = 'published', published_at = ?, fb_post_id = ?, error_message = NULL WHERE id = ?`
    ).run(Date.now(), result.fbPostId, id);
    res.json({ ok: true, fb_post_id: result.fbPostId });
  } catch (e: any) {
    const msg = e?.response?.data?.error?.message || e?.message;
    db.prepare(`UPDATE posts SET status = 'failed', error_message = ? WHERE id = ?`).run(msg, id);
    res.status(500).json({ error: msg });
  }
});

// Xóa bài
router.delete('/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  db.prepare(`DELETE FROM posts WHERE id = ?`).run(id);
  res.json({ ok: true });
});

export default router;

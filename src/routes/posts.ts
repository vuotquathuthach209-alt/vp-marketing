import { Router } from 'express';
import { db } from '../db';
import { authMiddleware, AuthRequest, getHotelId } from '../middleware/auth';
import { publishText, publishImage, publishVideo, mediaFullPath } from '../services/facebook';

const router = Router();
router.use(authMiddleware);

// Danh sách bài đăng — filtered by hotel_id
router.get('/', (req: AuthRequest, res) => {
  const hotelId = getHotelId(req);
  const items = db
    .prepare(
      `SELECT p.*, pg.name as page_name, m.filename as media_filename, m.mime_type as media_mime
       FROM posts p
       LEFT JOIN pages pg ON pg.id = p.page_id
       LEFT JOIN media m ON m.id = p.media_id
       WHERE p.hotel_id = ?
       ORDER BY p.id DESC LIMIT 200`
    )
    .all(hotelId);
  res.json(items);
});

// Tạo bài đăng — inject hotel_id
router.post('/', (req: AuthRequest, res) => {
  const hotelId = getHotelId(req);
  const { page_id, caption, media_id, scheduled_at, publish_now } = req.body;
  if (!page_id || !caption) return res.status(400).json({ error: 'Thiếu page hoặc caption' });

  let media_type: string | null = 'none';
  if (media_id) {
    const media = db.prepare(`SELECT mime_type FROM media WHERE id = ? AND hotel_id = ?`).get(media_id, hotelId) as
      | { mime_type: string }
      | undefined;
    if (!media) return res.status(400).json({ error: 'Media không tồn tại' });
    media_type = media.mime_type.startsWith('video/') ? 'video' : 'image';
  }

  const status = publish_now ? 'scheduled' : (scheduled_at ? 'scheduled' : 'draft');
  const sched = publish_now ? Date.now() : scheduled_at || null;

  const result = db
    .prepare(
      `INSERT INTO posts (page_id, caption, media_id, media_type, status, scheduled_at, hotel_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(page_id, caption, media_id || null, media_type, status, sched, hotelId, Date.now());

  res.json({ id: result.lastInsertRowid });
});

// Đăng ngay — check hotel_id
router.post('/:id/publish-now', async (req: AuthRequest, res) => {
  const hotelId = getHotelId(req);
  const id = parseInt(req.params.id as string, 10);
  const post = db.prepare(`SELECT * FROM posts WHERE id = ? AND hotel_id = ?`).get(id, hotelId) as any;
  if (!post) return res.status(404).json({ error: 'Không tìm thấy bài' });

  const page = db.prepare(`SELECT * FROM pages WHERE id = ? AND hotel_id = ?`).get(post.page_id, hotelId) as any;
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

    // v24: Cross-post FB → IG + Zalo OA (non-blocking)
    try {
      const { crossPostFromPostId } = require('../services/cross-post-sync');
      crossPostFromPostId(id, 'manual').catch((e: any) =>
        console.warn('[publish-now] cross-post fail:', e?.message)
      );
    } catch {}

    res.json({ ok: true, fb_post_id: result.fbPostId });
  } catch (e: any) {
    const fbErr = e?.response?.data?.error;
    const status = e?.response?.status;
    const msg = fbErr
      ? `[FB ${status || '?'}] ${fbErr.message}${fbErr.error_subcode ? ` (subcode ${fbErr.error_subcode})` : ''}${fbErr.code ? ` (code ${fbErr.code})` : ''}`
      : (e?.message || 'Lỗi không xác định');
    console.error('[publish-now] FAIL', {
      postId: id, status, fbErr, message: e?.message,
    });
    db.prepare(`UPDATE posts SET status = 'failed', error_message = ? WHERE id = ?`).run(msg, id);
    res.status(500).json({ error: msg });
  }
});

// Xóa bài — check hotel_id
router.delete('/:id', (req: AuthRequest, res) => {
  const hotelId = getHotelId(req);
  const id = parseInt(req.params.id as string, 10);
  db.prepare(`DELETE FROM posts WHERE id = ? AND hotel_id = ?`).run(id, hotelId);
  res.json({ ok: true });
});

// v24: Cross-post existing FB post → IG + Zalo (manual trigger cho bài đã publish)
router.post('/:id/cross-post', async (req: AuthRequest, res) => {
  try {
    const hotelId = getHotelId(req);
    const id = parseInt(req.params.id as string, 10);
    if (isNaN(id) || id <= 0) return res.status(400).json({ error: 'invalid id' });

    const post = db.prepare(
      `SELECT id, hotel_id, fb_post_id, status FROM posts WHERE id = ? AND hotel_id = ?`
    ).get(id, hotelId) as any;
    if (!post) return res.status(404).json({ error: 'not found' });
    if (post.status !== 'published' || !post.fb_post_id) {
      return res.status(400).json({ error: 'post chưa publish lên FB — không thể cross-post' });
    }

    const { crossPostFromPostId } = require('../services/cross-post-sync');
    const result = await crossPostFromPostId(id, 'manual');
    res.json(result || { error: 'cross-post failed' });
  } catch (e: any) {
    console.error('[cross-post route] fail:', e);
    res.status(500).json({ error: 'cross-post error' });
  }
});

// v24: List cross-post log cho 1 post
router.get('/:id/cross-post-log', (req: AuthRequest, res) => {
  try {
    const hotelId = getHotelId(req);
    const id = parseInt(req.params.id as string, 10);
    const post = db.prepare(
      `SELECT fb_post_id FROM posts WHERE id = ? AND hotel_id = ?`
    ).get(id, hotelId) as any;
    if (!post?.fb_post_id) return res.json({ items: [] });

    const items = db.prepare(
      `SELECT platform, target_id, result, external_id, error, created_at
       FROM cross_post_log WHERE fb_post_id = ? ORDER BY created_at DESC`
    ).all(post.fb_post_id);
    res.json({ items });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// v24: Cross-post stats dashboard
router.get('/cross-post/stats', (req: AuthRequest, res) => {
  try {
    const hotelId = getHotelId(req);
    const days = Math.min(30, Math.max(1, parseInt(String(req.query.days || '7'), 10)));
    const { getCrossPostStats, getZaloQuotaStatus } = require('../services/cross-post-sync');
    const stats = getCrossPostStats(hotelId, days * 24 * 3600_000);
    const zaloQuota = getZaloQuotaStatus(hotelId);
    res.json({ days, stats, zalo_quota: zaloQuota });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

export default router;

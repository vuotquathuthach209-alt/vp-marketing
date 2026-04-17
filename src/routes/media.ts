import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { config } from '../config';
import { db } from '../db';
import { authMiddleware, AuthRequest, getHotelId } from '../middleware/auth';

const router = Router();
router.use(authMiddleware);

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, config.mediaDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '';
    const name = `upload-${Date.now()}-${crypto.randomBytes(4).toString('hex')}${ext}`;
    cb(null, name);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 200 * 1024 * 1024 }, // 200MB
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/') || file.mimetype.startsWith('video/')) {
      cb(null, true);
    } else {
      cb(new Error('Chỉ cho phép file ảnh hoặc video'));
    }
  },
});

// Upload file thủ công
router.post('/upload', upload.single('file'), (req: AuthRequest, res) => {
  if (!req.file) return res.status(400).json({ error: 'Khong co file' });
  const hotelId = getHotelId(req);
  const result = db
    .prepare(
      `INSERT INTO media (filename, mime_type, size, source, hotel_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(req.file.filename, req.file.mimetype, req.file.size, 'upload', hotelId, Date.now());
  res.json({ id: result.lastInsertRowid, filename: req.file.filename });
});

// Danh sach media — per hotel
router.get('/', (req: AuthRequest, res) => {
  const hotelId = getHotelId(req);
  const items = db
    .prepare(`SELECT id, filename, mime_type, size, source, prompt, created_at FROM media WHERE hotel_id = ? ORDER BY id DESC LIMIT 200`)
    .all(hotelId);
  res.json(items);
});

// Xem file media
router.get('/file/:filename', (req, res) => {
  const filename = path.basename(req.params.filename); // chống path traversal
  const filepath = path.join(config.mediaDir, filename);
  if (!fs.existsSync(filepath)) return res.status(404).json({ error: 'Không tìm thấy' });
  res.sendFile(filepath);
});

// Xóa media
router.delete('/:id', (req: AuthRequest, res) => {
  const hotelId = getHotelId(req);
  const id = parseInt(req.params.id as string, 10);
  const row = db.prepare(`SELECT filename FROM media WHERE id = ? AND hotel_id = ?`).get(id, hotelId) as { filename: string } | undefined;
  if (row) {
    const filepath = path.join(config.mediaDir, row.filename);
    if (fs.existsSync(filepath)) fs.unlinkSync(filepath);
  }
  db.prepare(`DELETE FROM media WHERE id = ? AND hotel_id = ?`).run(id, hotelId);
  res.json({ ok: true });
});

// ══════ Room Images Management ══════

// GET /api/media/room-images — list room images for current hotel
router.get('/room-images', (req: any, res) => {
  const hotelId = req.hotelId || 1;
  const images = db.prepare(
    `SELECT * FROM room_images WHERE hotel_id = ? ORDER BY room_type_name, display_order`
  ).all(hotelId);
  res.json(images);
});

// POST /api/media/room-images — add a room image (URL-based)
router.post('/room-images', (req: any, res) => {
  const hotelId = req.hotelId || 1;
  const { room_type_name, image_url, caption, display_order } = req.body;
  if (!room_type_name || !image_url) {
    return res.status(400).json({ error: 'room_type_name và image_url là bắt buộc' });
  }
  const result = db.prepare(
    `INSERT INTO room_images (hotel_id, room_type_name, image_url, caption, display_order, active, created_at)
     VALUES (?, ?, ?, ?, ?, 1, ?)`
  ).run(hotelId, room_type_name, image_url, caption || '', display_order || 0, Date.now());
  res.json({ id: result.lastInsertRowid, ok: true });
});

// DELETE /api/media/room-images/:id — delete a room image
router.delete('/room-images/:id', (req: any, res) => {
  const hotelId = req.hotelId || 1;
  db.prepare(`DELETE FROM room_images WHERE id = ? AND hotel_id = ?`).run(req.params.id, hotelId);
  res.json({ ok: true });
});

// POST /api/media/room-images/upload — bulk multipart upload
// Form fields: room_type_name (required), caption (optional), files[] (up to 10 images)
router.post('/room-images/upload', upload.array('files', 10), (req: any, res) => {
  const hotelId = req.hotelId || 1;
  const { room_type_name, caption } = req.body;
  if (!room_type_name) return res.status(400).json({ error: 'room_type_name bắt buộc' });
  const files = (req.files || []) as Express.Multer.File[];
  if (files.length === 0) return res.status(400).json({ error: 'Chưa chọn file nào' });

  // Determine base URL for served images (absolute so FB can fetch)
  const base = (req.protocol + '://' + req.get('host')).replace(/\/+$/, '');
  const now = Date.now();
  const ins = db.prepare(
    `INSERT INTO room_images (hotel_id, room_type_name, image_url, caption, display_order, active, created_at)
     VALUES (?, ?, ?, ?, ?, 1, ?)`
  );
  const created: number[] = [];
  const tx = db.transaction(() => {
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      // Use public /media/ route (no auth) so Facebook/clients can fetch
      const url = `${base}/media/${encodeURIComponent(f.filename)}`;
      const r = ins.run(hotelId, room_type_name, url, caption || '', i, now + i);
      created.push(Number(r.lastInsertRowid));
    }
  });
  tx();
  res.json({ ok: true, count: created.length, ids: created });
});

export default router;

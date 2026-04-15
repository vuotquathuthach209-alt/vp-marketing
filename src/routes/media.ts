import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { config } from '../config';
import { db } from '../db';
import { authMiddleware } from '../middleware/auth';

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
router.post('/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Không có file' });
  const result = db
    .prepare(
      `INSERT INTO media (filename, mime_type, size, source, created_at)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(req.file.filename, req.file.mimetype, req.file.size, 'upload', Date.now());
  res.json({ id: result.lastInsertRowid, filename: req.file.filename });
});

// Danh sách media
router.get('/', (req, res) => {
  const items = db
    .prepare(`SELECT id, filename, mime_type, size, source, prompt, created_at FROM media ORDER BY id DESC LIMIT 200`)
    .all();
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
router.delete('/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const row = db.prepare(`SELECT filename FROM media WHERE id = ?`).get(id) as { filename: string } | undefined;
  if (row) {
    const filepath = path.join(config.mediaDir, row.filename);
    if (fs.existsSync(filepath)) fs.unlinkSync(filepath);
  }
  db.prepare(`DELETE FROM media WHERE id = ?`).run(id);
  res.json({ ok: true });
});

export default router;

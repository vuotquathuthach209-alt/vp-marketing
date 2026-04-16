import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { db } from '../db';
import { authMiddleware, AuthRequest, getHotelId } from '../middleware/auth';
import { config } from '../config';
import {
  getBookingConfig,
  saveBookingConfig,
  getPendingBookings,
  confirmBooking,
  rejectBooking,
  getBookingById,
} from '../services/bookingflow';
import { sendFBMessageToSender } from '../services/autoreply';

const router = Router();
router.use(authMiddleware);

// Multer for bank QR image upload
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, config.uploadsDir),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname) || '.png';
    cb(null, `bank-qr-${Date.now()}${ext}`);
  },
});
const upload = multer({ storage, limits: { fileSize: 5 * 1024 * 1024 } });

// GET /api/booking/config
router.get('/config', (_req, res) => {
  res.json(getBookingConfig());
});

// POST /api/booking/config
router.post('/config', (req, res) => {
  const cfg = saveBookingConfig(req.body);
  res.json(cfg);
});

// POST /api/booking/bank-image — upload bank QR
router.post('/bank-image', upload.single('file'), (req, res) => {
  const file = req.file;
  if (!file) return res.status(400).json({ error: 'Thiếu file' });

  const now = Date.now();
  const r = db.prepare(
    `INSERT INTO media (filename, mime_type, size, source, created_at) VALUES (?, ?, ?, 'upload', ?)`
  ).run(file.filename, file.mimetype, file.size, now);

  // Move to media dir
  const dest = path.join(config.mediaDir, file.filename);
  fs.renameSync(file.path, dest);

  const mediaId = Number(r.lastInsertRowid);
  const cfg = saveBookingConfig({ bank_qr_image_id: mediaId });
  res.json({ ok: true, mediaId, config: cfg });
});

// GET /api/booking/pending — per hotel
router.get('/pending', (req: AuthRequest, res) => {
  const hotelId = getHotelId(req);
  res.json(getPendingBookings(hotelId));
});

// POST /api/booking/:id/confirm
router.post('/:id/confirm', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { room } = req.body;
    const result = confirmBooking(id, room || 'N/A');
    // Send to customer
    try {
      await sendFBMessageToSender(result.senderId, result.reply);
    } catch (e: any) {
      console.warn('[booking] FB send fail:', e.message);
    }
    res.json({ ok: true, reply: result.reply });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

// POST /api/booking/:id/reject
router.post('/:id/reject', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { reason } = req.body;
    const result = rejectBooking(id, reason);
    try {
      await sendFBMessageToSender(result.senderId, result.reply);
    } catch (e: any) {
      console.warn('[booking] FB send fail:', e.message);
    }
    res.json({ ok: true, reply: result.reply });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

export default router;

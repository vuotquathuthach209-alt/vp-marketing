import { Router } from 'express';
import { db, getSetting, setSetting } from '../db';
import { authMiddleware, AuthRequest, getHotelId } from '../middleware/auth';
import { verifyPageToken } from '../services/facebook';
import { verifyHotelBot, saveHotelTelegramConfig, setHotelBotUsername } from '../services/hotel-telegram';
import { autoGenWikiFromOta } from '../services/ota-sync';
import { getOtaRoomImages } from '../services/ota-db';
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { config } from '../config';

const router = Router();
router.use(authMiddleware);

/**
 * Phase 3 — Hotel Onboarding Wizard
 *
 * Steps:
 * 1. Hotel info confirm (auto-filled from OTA)
 * 2. Connect FB Page (page_id + access_token)
 * 3. Setup Telegram bot (token + group_id)
 * 4. Configure chatbot (enable auto-reply)
 * 5. Configure autopilot (enable, post times)
 * 6. Review & activate
 */

// GET /api/onboarding/status — current onboarding progress
router.get('/status', (req: AuthRequest, res) => {
  const hotelId = getHotelId(req);

  const hotel = db.prepare(`SELECT * FROM mkt_hotels WHERE id = ?`).get(hotelId) as any;
  if (!hotel) return res.status(404).json({ error: 'Hotel not found' });

  const pages = db.prepare(`SELECT id, name, fb_page_id FROM pages WHERE hotel_id = ?`).all(hotelId) as any[];
  const tgConfig = db.prepare(`SELECT * FROM hotel_telegram_config WHERE page_id IN (SELECT id FROM pages WHERE hotel_id = ?)`).all(hotelId) as any[];
  const autoReply = db.prepare(`SELECT * FROM auto_reply_config WHERE page_id IN (SELECT id FROM pages WHERE hotel_id = ?)`).all(hotelId) as any[];
  const autopilotOn = getSetting('autopilot_enabled', hotelId) === '1';
  const wikiCount = db.prepare(`SELECT COUNT(*) as n FROM knowledge_wiki WHERE hotel_id = ? AND active = 1`).get(hotelId) as any;

  const roomImagesCount = db.prepare(
    `SELECT COUNT(*) as n FROM media WHERE hotel_id = ? AND source = 'ota-room'`
  ).get(hotelId) as any;

  const steps = {
    hotel_info: !!hotel.ota_hotel_id || hotel.status === 'active',
    fb_page: pages.length > 0,
    room_images: (roomImagesCount?.n || 0) > 0,
    telegram: tgConfig.some((t: any) => t.enabled),
    chatbot: autoReply.some((a: any) => a.reply_messages),
    autopilot: autopilotOn,
    wiki: (wikiCount?.n || 0) > 0,
  };

  const completedSteps = Object.values(steps).filter(Boolean).length;
  const totalSteps = Object.keys(steps).length;

  res.json({
    hotel_id: hotelId,
    hotel_name: hotel.name,
    plan: hotel.plan,
    status: hotel.status,
    ota_linked: !!hotel.ota_hotel_id,
    steps,
    progress: Math.round((completedSteps / totalSteps) * 100),
    completed: completedSteps,
    total: totalSteps,
    pages,
    telegram: tgConfig,
  });
});

// POST /api/onboarding/step/fb-page — connect Facebook Page
router.post('/step/fb-page', async (req: AuthRequest, res) => {
  const hotelId = getHotelId(req);
  const { fb_page_id, access_token, name } = req.body;

  if (!fb_page_id || !access_token) {
    return res.status(400).json({ error: 'Can Page ID va Access Token' });
  }

  try {
    const verified = await verifyPageToken(fb_page_id, access_token);
    const result = db.prepare(
      `INSERT INTO pages (name, fb_page_id, access_token, hotel_id, created_at) VALUES (?, ?, ?, ?, ?)`
    ).run(name || verified.name, verified.id, access_token, hotelId, Date.now());

    // Auto-enable auto-reply for messages
    db.prepare(
      `INSERT OR REPLACE INTO auto_reply_config (page_id, reply_comments, reply_messages, system_prompt, updated_at)
       VALUES (?, 0, 1, '', ?)`
    ).run(Number(result.lastInsertRowid), Date.now());

    res.json({ ok: true, pageId: Number(result.lastInsertRowid), pageName: verified.name });
  } catch (e: any) {
    res.status(400).json({ error: e?.response?.data?.error?.message || e?.message });
  }
});

// POST /api/onboarding/step/telegram — setup hotel Telegram bot
router.post('/step/telegram', async (req: AuthRequest, res) => {
  const hotelId = getHotelId(req);
  const { telegram_bot_token, telegram_group_id } = req.body;

  if (!telegram_bot_token) {
    return res.status(400).json({ error: 'Can Telegram bot token' });
  }

  try {
    // Find first page of this hotel
    const page = db.prepare(`SELECT id FROM pages WHERE hotel_id = ? LIMIT 1`).get(hotelId) as any;
    if (!page) return res.status(400).json({ error: 'Ket noi FB Page truoc' });

    const username = await verifyHotelBot(telegram_bot_token);
    saveHotelTelegramConfig(page.id, telegram_bot_token, telegram_group_id || null);
    setHotelBotUsername(page.id, username);

    res.json({ ok: true, bot_username: username });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

// POST /api/onboarding/step/chatbot — enable/disable chatbot
router.post('/step/chatbot', (req: AuthRequest, res) => {
  const hotelId = getHotelId(req);
  const { enabled } = req.body;

  const pages = db.prepare(`SELECT id FROM pages WHERE hotel_id = ?`).all(hotelId) as any[];
  for (const p of pages) {
    db.prepare(
      `INSERT OR REPLACE INTO auto_reply_config (page_id, reply_comments, reply_messages, system_prompt, updated_at)
       VALUES (?, 0, ?, '', ?)`
    ).run(p.id, enabled ? 1 : 0, Date.now());
  }

  res.json({ ok: true, enabled });
});

// POST /api/onboarding/step/autopilot — enable + set times
router.post('/step/autopilot', (req: AuthRequest, res) => {
  const hotelId = getHotelId(req);
  const { enabled, post_times } = req.body;

  setSetting('autopilot_enabled', enabled ? '1' : '0', hotelId);
  if (post_times && Array.isArray(post_times)) {
    setSetting('autopilot_post_times', JSON.stringify(post_times), hotelId);
  }

  res.json({ ok: true });
});

// POST /api/onboarding/step/wiki-init — auto-generate wiki from OTA data
router.post('/step/wiki-init', async (req: AuthRequest, res) => {
  const hotelId = getHotelId(req);
  const hotel = db.prepare(`SELECT ota_hotel_id FROM mkt_hotels WHERE id = ?`).get(hotelId) as any;

  if (!hotel?.ota_hotel_id) {
    return res.status(400).json({ error: 'Hotel chua lien ket OTA' });
  }

  try {
    const count = await autoGenWikiFromOta(hotelId, hotel.ota_hotel_id);
    res.json({ ok: true, wiki_entries: count });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/onboarding/step/import-room-images — tải ảnh phòng từ OTA DB về local media
router.post('/step/import-room-images', async (req: AuthRequest, res) => {
  const hotelId = getHotelId(req);
  const hotel = db.prepare(`SELECT ota_hotel_id FROM mkt_hotels WHERE id = ?`).get(hotelId) as any;
  if (!hotel?.ota_hotel_id) return res.status(400).json({ error: 'Hotel chưa liên kết OTA' });

  try {
    const imgs = await getOtaRoomImages(hotel.ota_hotel_id);
    if (!imgs.length) return res.json({ ok: true, imported: 0, message: 'Không có ảnh trong OTA DB' });

    const insertStmt = db.prepare(
      `INSERT INTO media (filename, mime_type, size, source, prompt, hotel_id, created_at)
       VALUES (?, ?, ?, 'ota-room', ?, ?, ?)`
    );
    const existsStmt = db.prepare(
      `SELECT id FROM media WHERE hotel_id = ? AND prompt = ? AND source = 'ota-room' LIMIT 1`
    );

    let imported = 0, skipped = 0, failed = 0;
    for (const img of imgs) {
      const tag = `[${img.room_type_name}] ${img.caption || ''} ${img.image_url}`.slice(0, 400);
      if (existsStmt.get(hotelId, tag)) { skipped++; continue; }
      try {
        const resp = await axios.get(img.image_url, { responseType: 'arraybuffer', timeout: 30000 });
        const ct = (resp.headers['content-type'] as string) || 'image/jpeg';
        const ext = ct.includes('png') ? 'png' : ct.includes('webp') ? 'webp' : 'jpg';
        const filename = `ota-${hotelId}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}.${ext}`;
        const fp = path.join(config.mediaDir, filename);
        fs.writeFileSync(fp, Buffer.from(resp.data));
        insertStmt.run(filename, ct, fs.statSync(fp).size, tag, hotelId, Date.now());
        imported++;
      } catch (e: any) {
        console.warn('[import-room-images] fail:', img.image_url, e?.message);
        failed++;
      }
    }
    res.json({ ok: true, imported, skipped, failed, total: imgs.length });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/onboarding/complete — mark onboarding done
router.post('/complete', (req: AuthRequest, res) => {
  const hotelId = getHotelId(req);
  db.prepare(`UPDATE mkt_hotels SET status = 'active', activated_at = ?, updated_at = ? WHERE id = ?`)
    .run(Date.now(), Date.now(), hotelId);
  res.json({ ok: true });
});

export default router;

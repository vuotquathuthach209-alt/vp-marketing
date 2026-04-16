import { Router } from 'express';
import { authMiddleware } from '../middleware/auth';
import {
  getHotelTelegramConfig,
  saveHotelTelegramConfig,
  toggleHotelTelegram,
  deleteHotelTelegramConfig,
  verifyHotelBot,
  setHotelBotUsername,
  getAllHotelTelegramConfigs,
  notifyHotel,
} from '../services/hotel-telegram';

const router = Router();
router.use(authMiddleware);

// GET /api/hotel-telegram — list all hotel telegram configs
router.get('/', (_req, res) => {
  res.json(getAllHotelTelegramConfigs());
});

// GET /api/hotel-telegram/:pageId
router.get('/:pageId', (req, res) => {
  const pageId = parseInt(req.params.pageId, 10);
  const cfg = getHotelTelegramConfig(pageId);
  res.json(cfg || { page_id: pageId, telegram_bot_token: null, telegram_group_id: null, enabled: 0 });
});

// POST /api/hotel-telegram/:pageId — save token + group
router.post('/:pageId', async (req, res) => {
  try {
    const pageId = parseInt(req.params.pageId, 10);
    const { telegram_bot_token, telegram_group_id, unlock_code } = req.body;

    if (!telegram_bot_token) {
      return res.status(400).json({ error: 'Thiếu telegram_bot_token' });
    }

    // Verify bot token
    const username = await verifyHotelBot(telegram_bot_token);
    saveHotelTelegramConfig(pageId, telegram_bot_token, telegram_group_id || null, unlock_code);
    setHotelBotUsername(pageId, username);

    // Test send to group if provided
    if (telegram_group_id) {
      const sent = await notifyHotel(pageId, `✅ Bot @${username} đã kết nối thành công với khách sạn này!`);
      if (!sent) {
        return res.json({
          ok: true,
          bot_username: username,
          warning: 'Token hợp lệ nhưng không gửi được tin vào group. Kiểm tra lại group_id hoặc thêm bot vào group.',
        });
      }
    }

    res.json({ ok: true, bot_username: username });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

// POST /api/hotel-telegram/:pageId/toggle
router.post('/:pageId/toggle', (req, res) => {
  const pageId = parseInt(req.params.pageId, 10);
  const { enabled } = req.body;
  toggleHotelTelegram(pageId, !!enabled);
  res.json({ ok: true });
});

// DELETE /api/hotel-telegram/:pageId
router.delete('/:pageId', (req, res) => {
  const pageId = parseInt(req.params.pageId, 10);
  deleteHotelTelegramConfig(pageId);
  res.json({ ok: true });
});

// POST /api/hotel-telegram/:pageId/test — send test message
router.post('/:pageId/test', async (req, res) => {
  try {
    const pageId = parseInt(req.params.pageId, 10);
    const sent = await notifyHotel(pageId, '🔔 Test notification từ vp-marketing!');
    res.json({ ok: sent, message: sent ? 'Đã gửi!' : 'Không gửi được — kiểm tra config' });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

export default router;

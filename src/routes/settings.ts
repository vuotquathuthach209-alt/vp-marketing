import { Router } from 'express';
import { db, getSetting, setSetting } from '../db';
import { verifyPageToken } from '../services/facebook';
import { authMiddleware } from '../middleware/auth';
import { countKeys, getAllKeys } from '../services/keyrotator';
import { getRouterStatus } from '../services/router';
import { config } from '../config';
import { setBotToken, getBotStatus, startBot, stopBot, notifyAll } from '../services/telegram';

const router = Router();
router.use(authMiddleware);

// Lấy settings hiện tại (che API key, chỉ hiện số lượng + 4 ký tự cuối của từng key)
router.get('/', (req, res) => {
  const summarize = (name: string, fallback?: string) => {
    const all = getAllKeys(name, fallback);
    return {
      count: all.length,
      masked: all.map((k) => `***${k.slice(-4)}`).join('\n'),
    };
  };
  res.json({
    anthropic: summarize('anthropic_api_key', config.anthropicApiKey),
    fal: summarize('fal_api_key', config.falApiKey),
    google: summarize('google_api_key'),
    groq: summarize('groq_api_key'),
  });
});

// Trạng thái router: task nào đang dùng model nào
router.get('/router', (req, res) => {
  res.json(getRouterStatus());
});

// Thêm API keys mới (APPEND mode — không xoá key cũ, tự dedupe)
// Chấp nhận nhiều key trong 1 lần, cách nhau bằng xuống dòng hoặc dấu phẩy
router.post('/keys', (req, res) => {
  const { anthropic_api_key, fal_api_key, google_api_key, groq_api_key } = req.body;
  const isMaskedLine = (v: string) => /^\*\*\*/.test(v.trim());

  // Parse input thành list key, bỏ qua các dòng masked (***xxxx)
  const parseInput = (val: any): string[] => {
    if (typeof val !== 'string') return [];
    return val
      .split(/[\n,]+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0 && !isMaskedLine(s));
  };

  // Merge key mới với key cũ, dedupe, lưu lại
  const appendKeys = (name: string, val: any, fallback?: string) => {
    const newKeys = parseInput(val);
    if (newKeys.length === 0) return;
    const existing = getAllKeys(name, fallback);
    const merged = Array.from(new Set([...existing, ...newKeys]));
    setSetting(name, merged.join('\n'));
  };

  appendKeys('anthropic_api_key', anthropic_api_key, config.anthropicApiKey);
  appendKeys('fal_api_key', fal_api_key, config.falApiKey);
  appendKeys('google_api_key', google_api_key);
  appendKeys('groq_api_key', groq_api_key);

  res.json({
    ok: true,
    anthropic_count: countKeys('anthropic_api_key', config.anthropicApiKey),
    fal_count: countKeys('fal_api_key', config.falApiKey),
    google_count: countKeys('google_api_key'),
    groq_count: countKeys('groq_api_key'),
  });
});

// Cấu hình provider gen ảnh (google | pollinations | fal | auto)
router.get('/image-provider', (req, res) => {
  res.json({ provider: getSetting('image_provider') || 'auto' });
});

router.post('/image-provider', (req, res) => {
  const { provider } = req.body;
  if (!['google', 'pollinations', 'fal', 'auto'].includes(provider)) {
    return res.status(400).json({ error: 'Provider không hợp lệ' });
  }
  setSetting('image_provider', provider);
  res.json({ ok: true, provider });
});

// Xoá toàn bộ key của 1 provider
router.delete('/keys/:provider', (req, res) => {
  const map: Record<string, string> = {
    anthropic: 'anthropic_api_key',
    fal: 'fal_api_key',
    google: 'google_api_key',
    groq: 'groq_api_key',
  };
  const name = map[req.params.provider];
  if (!name) return res.status(400).json({ error: 'Provider không hợp lệ' });
  setSetting(name, '');
  res.json({ ok: true });
});

// Lấy danh sách Fanpage
router.get('/pages', (req, res) => {
  const pages = db
    .prepare(`SELECT id, name, fb_page_id, created_at FROM pages ORDER BY id ASC`)
    .all();
  res.json(pages);
});

// Thêm Fanpage (kèm verify token)
router.post('/pages', async (req, res) => {
  const { fb_page_id, access_token, name } = req.body;
  if (!fb_page_id || !access_token) {
    return res.status(400).json({ error: 'Thiếu Page ID hoặc Access Token' });
  }

  try {
    const verified = await verifyPageToken(fb_page_id, access_token);
    const result = db
      .prepare(
        `INSERT INTO pages (name, fb_page_id, access_token, created_at) VALUES (?, ?, ?, ?)`
      )
      .run(name || verified.name, verified.id, access_token, Date.now());
    res.json({ ok: true, id: result.lastInsertRowid, name: verified.name });
  } catch (e: any) {
    const msg = e?.response?.data?.error?.message || e?.message;
    res.status(400).json({ error: `Không verify được token: ${msg}` });
  }
});

// Xóa Fanpage
router.delete('/pages/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  db.prepare(`DELETE FROM pages WHERE id = ?`).run(id);
  res.json({ ok: true });
});

// ===== Sprint 6: Telegram =====
router.get('/telegram', (req, res) => {
  const status = getBotStatus();
  const chats = db.prepare(
    `SELECT chat_id, username, first_name, authorized, notify, created_at, last_seen
     FROM telegram_chats ORDER BY last_seen DESC LIMIT 50`
  ).all();
  const token = getSetting('telegram_bot_token');
  const code = getSetting('telegram_unlock_code');
  res.json({
    ...status,
    token_masked: token ? `${token.slice(0, 8)}...${token.slice(-4)}` : null,
    unlock_code: code || null,
    chats,
  });
});

router.post('/telegram', (req, res) => {
  const { bot_token, unlock_code } = req.body;
  if (bot_token && typeof bot_token === 'string' && !bot_token.startsWith('***')) {
    setBotToken(bot_token.trim());
    stopBot();
    setTimeout(startBot, 500);
  }
  if (unlock_code !== undefined) {
    setSetting('telegram_unlock_code', String(unlock_code).trim());
  }
  res.json({ ok: true, ...getBotStatus() });
});

router.post('/telegram/test', async (req, res) => {
  try {
    await notifyAll('🧪 Test từ vp-marketing — nếu bạn đọc được tin này nghĩa là Telegram bot OK!');
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/telegram/authorize/:chat_id', (req, res) => {
  db.prepare(`UPDATE telegram_chats SET authorized = 1 WHERE chat_id = ?`).run(req.params.chat_id);
  res.json({ ok: true });
});

router.post('/telegram/revoke/:chat_id', (req, res) => {
  db.prepare(`UPDATE telegram_chats SET authorized = 0 WHERE chat_id = ?`).run(req.params.chat_id);
  res.json({ ok: true });
});

export default router;

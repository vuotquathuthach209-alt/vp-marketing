import { Router } from 'express';
import axios from 'axios';
import { db, getSetting, setSetting } from '../db';
import { verifyPageToken, debugToken, exchangeLongLivedToken, autoRefreshPageTokens } from '../services/facebook';
import { authMiddleware, AuthRequest, getHotelId } from '../middleware/auth';
import { countKeys, getAllKeys } from '../services/keyrotator';
import { getRouterStatus } from '../services/router';
import { config } from '../config';
import { setBotToken, getBotStatus, startBot, stopBot, notifyAll } from '../services/telegram';

const router = Router();
router.use(authMiddleware);

// Lấy settings hiện tại
router.get('/', (req: AuthRequest, res) => {
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
    deepseek: summarize('deepseek_api_key'),
    openai: summarize('openai_api_key'),
    mistral: summarize('mistral_api_key'),
  });
});

// Generic get setting (for API keys loading)
const ALLOWED_KEYS = ['anthropic_api_key', 'deepseek_api_key', 'openai_api_key', 'google_api_key', 'groq_api_key', 'mistral_api_key', 'fal_api_key', 'unsplash_access_key'];
router.get('/get', (req: AuthRequest, res) => {
  const key = req.query.key as string;
  if (!key || !ALLOWED_KEYS.includes(key)) return res.json({ value: '' });
  const val = getSetting(key) || '';
  // Mask keys for security — show only last 6 chars per line
  const masked = val.split('\n').map(k => k.length > 6 ? '***' + k.slice(-6) : k).join('\n');
  res.json({ value: masked });
});

// Generic set setting (for API keys saving)
router.post('/set', (req: AuthRequest, res) => {
  const { key, value } = req.body;
  if (!key || !ALLOWED_KEYS.includes(key)) return res.status(400).json({ error: 'Key khong hop le' });
  // Filter out masked values, keep only real keys
  const cleaned = (value || '').split(/[\n,]+/).map((s: string) => s.trim()).filter((s: string) => s.length > 0 && !s.startsWith('***')).join('\n');
  if (cleaned) setSetting(key, cleaned);
  res.json({ ok: true });
});

router.get('/router', (req, res) => {
  res.json(getRouterStatus());
});

// ═══ AI Tier (free / balanced / premium) — cascade strategy ═══
const VALID_TIERS = ['free', 'balanced', 'premium'];
router.get('/ai-tier', (_req, res) => {
  res.json({ tier: getSetting('ai_tier') || 'balanced' });
});
router.post('/ai-tier', (req, res) => {
  const { tier } = req.body;
  if (!VALID_TIERS.includes(tier)) return res.status(400).json({ error: 'Tier không hợp lệ' });
  setSetting('ai_tier', tier);
  res.json({ ok: true, tier });
});

// ═══ Test key — verify a provider key is live ═══
router.post('/test-key', async (req, res) => {
  const { provider, key } = req.body as { provider: string; key?: string };
  // Use provided key if given, else fall back to first stored key
  const testKey = (typeof key === 'string' && key && !key.startsWith('***'))
    ? key.split('\n')[0].trim()
    : (getAllKeys(`${provider}_api_key`)[0] || '');

  if (provider === 'ollama') {
    try {
      const host = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';
      const r = await axios.get(`${host}/api/tags`, { timeout: 3000 });
      const models = (r.data?.models || []).map((m: any) => m.name);
      return res.json({ ok: true, models });
    } catch (e: any) {
      return res.status(400).json({ ok: false, error: 'Ollama offline: ' + e.message });
    }
  }

  if (!testKey) return res.status(400).json({ ok: false, error: 'Chưa có key để test' });

  try {
    if (provider === 'google') {
      // List models is cheapest auth check
      const r = await axios.get(`https://generativelanguage.googleapis.com/v1beta/models?key=${testKey}&pageSize=1`, { timeout: 10000 });
      return res.json({ ok: true, info: `${(r.data?.models || []).length > 0 ? 'Key OK' : 'Key OK (no models)'}` });
    }
    if (provider === 'anthropic') {
      const r = await axios.post('https://api.anthropic.com/v1/messages', {
        model: 'claude-haiku-4-5-20251001', max_tokens: 5, messages: [{ role: 'user', content: 'hi' }],
      }, { timeout: 15000, headers: { 'x-api-key': testKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' } });
      return res.json({ ok: true, info: `Model ${r.data?.model || 'ok'}` });
    }
    if (provider === 'openai') {
      const r = await axios.get('https://api.openai.com/v1/models', {
        timeout: 10000, headers: { Authorization: `Bearer ${testKey}` },
      });
      return res.json({ ok: true, info: `${(r.data?.data || []).length} models` });
    }
    if (provider === 'deepseek') {
      const r = await axios.get('https://api.deepseek.com/models', {
        timeout: 10000, headers: { Authorization: `Bearer ${testKey}` },
      });
      return res.json({ ok: true, info: `${(r.data?.data || []).length} models` });
    }
    if (provider === 'groq') {
      const r = await axios.get('https://api.groq.com/openai/v1/models', {
        timeout: 10000, headers: { Authorization: `Bearer ${testKey}` },
      });
      return res.json({ ok: true, info: `${(r.data?.data || []).length} models` });
    }
    return res.status(400).json({ ok: false, error: 'Provider chưa hỗ trợ test' });
  } catch (e: any) {
    const status = e?.response?.status;
    const msg = e?.response?.data?.error?.message || e?.response?.data?.error || e.message;
    return res.status(400).json({ ok: false, error: `HTTP ${status || '?'}: ${msg}` });
  }
});

// Thêm API keys mới (APPEND)
router.post('/keys', (req, res) => {
  const { anthropic_api_key, fal_api_key, google_api_key, groq_api_key, deepseek_api_key, openai_api_key, mistral_api_key } = req.body;
  const isMaskedLine = (v: string) => /^\*\*\*/.test(v.trim());

  const parseInput = (val: any): string[] => {
    if (typeof val !== 'string') return [];
    return val.split(/[\n,]+/).map((s) => s.trim()).filter((s) => s.length > 0 && !isMaskedLine(s));
  };

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
  appendKeys('deepseek_api_key', deepseek_api_key);
  appendKeys('openai_api_key', openai_api_key);
  appendKeys('mistral_api_key', mistral_api_key);

  res.json({
    ok: true,
    anthropic_count: countKeys('anthropic_api_key', config.anthropicApiKey),
    fal_count: countKeys('fal_api_key', config.falApiKey),
    google_count: countKeys('google_api_key'),
    groq_count: countKeys('groq_api_key'),
  });
});

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

router.delete('/keys/:provider', (req, res) => {
  const map: Record<string, string> = {
    anthropic: 'anthropic_api_key', fal: 'fal_api_key', google: 'google_api_key',
    groq: 'groq_api_key', deepseek: 'deepseek_api_key', openai: 'openai_api_key',
    mistral: 'mistral_api_key', unsplash: 'unsplash_access_key',
  };
  const name = map[req.params.provider];
  if (!name) return res.status(400).json({ error: 'Provider không hợp lệ' });
  setSetting(name, '');
  res.json({ ok: true });
});

// ═══ FB App ID (public — để frontend load FB SDK) ═══
router.get('/fb-app-id', (req, res) => {
  res.json({ app_id: config.fbAppId || '' });
});

// ═══ Connect Facebook — nhận User Token, trả về danh sách Pages + Page Tokens ═══
router.post('/fb-connect', async (req: AuthRequest, res) => {
  const { user_access_token } = req.body;
  if (!user_access_token) return res.status(400).json({ error: 'Thiếu user_access_token' });

  try {
    // Đổi sang long-lived user token trước
    let longToken = user_access_token;
    if (config.fbAppId && config.fbAppSecret) {
      try {
        const ll = await exchangeLongLivedToken(user_access_token);
        longToken = ll.access_token;
      } catch { /* keep short-lived if exchange fails */ }
    }

    // Gọi /me/accounts để lấy danh sách Pages + Page Access Tokens
    const axios = require('axios');
    const resp = await axios.get('https://graph.facebook.com/v21.0/me/accounts', {
      params: {
        access_token: longToken,
        fields: 'id,name,access_token,category,fan_count,picture{url}',
        limit: 50,
      },
      timeout: 15000,
    });

    const pages = (resp.data?.data || []).map((p: any) => ({
      fb_page_id: p.id,
      name: p.name,
      access_token: p.access_token,
      category: p.category,
      fan_count: p.fan_count || 0,
      picture: p.picture?.data?.url || '',
    }));

    res.json({ pages });
  } catch (e: any) {
    const msg = e?.response?.data?.error?.message || e?.message;
    res.status(400).json({ error: `Lỗi kết nối Facebook: ${msg}` });
  }
});

// ═══ Add multiple pages at once (from fb-connect) ═══
router.post('/pages/bulk-add', async (req: AuthRequest, res) => {
  const hotelId = getHotelId(req);
  const { pages } = req.body; // Array of { fb_page_id, access_token, name }
  if (!Array.isArray(pages) || pages.length === 0) {
    return res.status(400).json({ error: 'Danh sách pages trống' });
  }

  const results: any[] = [];
  for (const p of pages) {
    try {
      // Check if page already exists
      const existing = db.prepare(`SELECT id FROM pages WHERE fb_page_id = ? AND hotel_id = ?`).get(p.fb_page_id, hotelId);
      if (existing) {
        // Update token
        db.prepare(`UPDATE pages SET access_token = ?, name = ? WHERE fb_page_id = ? AND hotel_id = ?`)
          .run(p.access_token, p.name, p.fb_page_id, hotelId);
        results.push({ fb_page_id: p.fb_page_id, name: p.name, status: 'updated' });
      } else {
        // Verify & add
        const verified = await verifyPageToken(p.fb_page_id, p.access_token);
        db.prepare(`INSERT INTO pages (name, fb_page_id, access_token, hotel_id, created_at) VALUES (?, ?, ?, ?, ?)`)
          .run(p.name || verified.name, verified.id, p.access_token, hotelId, Date.now());
        results.push({ fb_page_id: p.fb_page_id, name: verified.name, status: 'added' });
      }
    } catch (e: any) {
      results.push({ fb_page_id: p.fb_page_id, name: p.name, status: 'error', error: e.message });
    }
  }

  res.json({ ok: true, results });
});

// ═══ Fanpage — hotel_id isolated ═══

router.get('/pages', (req: AuthRequest, res) => {
  const hotelId = getHotelId(req);
  const pages = db
    .prepare(`SELECT id, name, fb_page_id, created_at FROM pages WHERE hotel_id = ? ORDER BY id ASC`)
    .all(hotelId);
  res.json(pages);
});

router.post('/pages', async (req: AuthRequest, res) => {
  const hotelId = getHotelId(req);
  const { fb_page_id, access_token, name } = req.body;
  if (!fb_page_id || !access_token) {
    return res.status(400).json({ error: 'Thiếu Page ID hoặc Access Token' });
  }

  try {
    const verified = await verifyPageToken(fb_page_id, access_token);
    const result = db
      .prepare(
        `INSERT INTO pages (name, fb_page_id, access_token, hotel_id, created_at) VALUES (?, ?, ?, ?, ?)`
      )
      .run(name || verified.name, verified.id, access_token, hotelId, Date.now());
    res.json({ ok: true, id: result.lastInsertRowid, name: verified.name });
  } catch (e: any) {
    const msg = e?.response?.data?.error?.message || e?.message;
    res.status(400).json({ error: `Không verify được token: ${msg}` });
  }
});

router.delete('/pages/:id', (req: AuthRequest, res) => {
  const hotelId = getHotelId(req);
  const id = parseInt(req.params.id as string, 10);
  db.prepare(`DELETE FROM pages WHERE id = ? AND hotel_id = ?`).run(id, hotelId);
  res.json({ ok: true });
});

// ═══ Telegram (global admin) ═══

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

// Kiểm tra token status tất cả pages
router.get('/pages/token-status', async (req: AuthRequest, res) => {
  const hotelId = getHotelId(req);
  const pages = db.prepare(`SELECT id, name, fb_page_id, access_token FROM pages WHERE hotel_id = ?`).all(hotelId) as any[];

  const results = [];
  for (const page of pages) {
    const info = await debugToken(page.access_token);
    const now = Math.floor(Date.now() / 1000);
    const daysLeft = info.expires_at > 0 ? Math.round((info.expires_at - now) / 86400) : -1;
    results.push({
      page_id: page.id,
      name: page.name,
      fb_page_id: page.fb_page_id,
      is_valid: info.is_valid,
      expires_at: info.expires_at > 0 ? new Date(info.expires_at * 1000).toISOString() : null,
      days_left: daysLeft,
      status: !info.is_valid ? '❌ Het han' : daysLeft < 7 ? '⚠️ Sap het' : '✅ OK',
      scopes: info.scopes,
    });
  }
  res.json(results);
});

// Refresh token thủ công cho 1 page
router.post('/pages/:id/refresh-token', async (req: AuthRequest, res) => {
  const hotelId = getHotelId(req);
  const pageId = parseInt(req.params.id as string, 10);
  const page = db.prepare(`SELECT * FROM pages WHERE id = ? AND hotel_id = ?`).get(pageId, hotelId) as any;
  if (!page) return res.status(404).json({ error: 'Page not found' });

  try {
    const result = await exchangeLongLivedToken(page.access_token);
    db.prepare(`UPDATE pages SET access_token = ? WHERE id = ?`).run(result.access_token, pageId);
    res.json({
      ok: true,
      expires_in_days: Math.round(result.expires_in / 86400),
      message: `Token da duoc gia han ${Math.round(result.expires_in / 86400)} ngay`,
    });
  } catch (e: any) {
    res.status(400).json({ error: e?.response?.data?.error?.message || e.message });
  }
});

// Refresh tất cả tokens (admin)
router.post('/pages/refresh-all', async (req: AuthRequest, res) => {
  const result = await autoRefreshPageTokens();
  res.json(result);
});

export default router;

import { Router } from 'express';
import { db, getSetting, setSetting } from '../db';
import { verifyPageToken } from '../services/facebook';
import { authMiddleware } from '../middleware/auth';
import { countKeys, getAllKeys } from '../services/keyrotator';
import { getRouterStatus } from '../services/router';
import { config } from '../config';

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

// Cập nhật API keys (hỗ trợ nhiều key, cách nhau bằng xuống dòng hoặc dấu phẩy)
router.post('/keys', (req, res) => {
  const { anthropic_api_key, fal_api_key, google_api_key, groq_api_key } = req.body;
  // Chỉ ghi đè nếu giá trị mới KHÔNG phải dạng masked (***xxxx)
  const isMasked = (v: string) => /^\*\*\*/.test(v.trim());
  const maybeSave = (name: string, val: any) => {
    if (typeof val === 'string' && !isMasked(val)) setSetting(name, val.trim());
  };
  maybeSave('anthropic_api_key', anthropic_api_key);
  maybeSave('fal_api_key', fal_api_key);
  maybeSave('google_api_key', google_api_key);
  maybeSave('groq_api_key', groq_api_key);

  res.json({
    ok: true,
    anthropic_count: countKeys('anthropic_api_key', config.anthropicApiKey),
    fal_count: countKeys('fal_api_key', config.falApiKey),
    google_count: countKeys('google_api_key'),
    groq_count: countKeys('groq_api_key'),
  });
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

export default router;

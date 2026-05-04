/**
 * YouTube OAuth admin routes — Connect / Callback / Status / Test.
 *
 * Endpoints:
 *   POST /admin/youtube/oauth/credentials   — save client_id + client_secret
 *   GET  /admin/youtube/oauth/start         — return auth URL for browser redirect
 *   GET  /admin/youtube/oauth/callback      — Google callback, exchange code for tokens
 *   GET  /admin/youtube/oauth/status        — connection status + channel info
 *   POST /admin/youtube/oauth/test          — smoke-test refresh + channel call
 *   POST /admin/youtube/oauth/disconnect    — remove tokens
 *   POST /admin/youtube/enable              — set enable_publish_youtube flag
 */

import { Router, Request, Response, NextFunction } from 'express';
import { db, getSetting, setSetting } from '../db';
import {
  buildYoutubeAuthUrl, exchangeYoutubeCode, isYoutubeConnected,
  testYoutubeConnection,
} from '../services/youtube-publisher';
import { authMiddleware } from '../middleware/auth';
import { config } from '../config';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';

const router = Router();

/** HTML-aware auth check — nếu không có cookie/token hợp lệ thì TRẢ VỀ HTML
 *  "Cần đăng nhập" thay vì JSON 401. Dùng cho /setup HTML page. */
function htmlAuthRequired(req: Request, res: Response, next: NextFunction) {
  const token = (req as any).cookies?.auth || req.headers.authorization?.replace('Bearer ', '');
  const loginPage = (msg: string) => `<!DOCTYPE html><html lang="vi"><head><meta charset="utf-8">
<title>Cần đăng nhập</title><style>body{font-family:-apple-system,sans-serif;background:#f3f4f6;
padding:80px 20px;text-align:center;color:#1f2937}h1{font-size:32px;margin-bottom:12px}
p{color:#6b7280;margin-bottom:32px}a{display:inline-block;padding:14px 28px;background:#2563eb;
color:#fff;border-radius:8px;text-decoration:none;font-weight:600}a:hover{background:#1d4ed8}</style>
</head><body><h1>🔒 ${msg}</h1><p>Trang YouTube Auto-Publish chỉ dành cho admin đã đăng nhập</p>
<a href="/">→ Đăng nhập admin</a></body></html>`;
  if (!token) return res.set('Content-Type', 'text/html').status(401).send(loginPage('Cần đăng nhập admin'));
  try {
    jwt.verify(token, config.jwtSecret);
    next();
  } catch {
    return res.set('Content-Type', 'text/html').status(401).send(loginPage('Token hết hạn'));
  }
}

// In-memory CSRF nonces (~5 min TTL). For single-tenant single-user this is fine.
const oauthNonces = new Map<string, number>();
const NONCE_TTL = 5 * 60_000;
function makeNonce(): string {
  const n = crypto.randomBytes(16).toString('hex');
  oauthNonces.set(n, Date.now());
  // Cleanup expired
  for (const [k, v] of oauthNonces.entries()) if (Date.now() - v > NONCE_TTL) oauthNonces.delete(k);
  return n;
}
function consumeNonce(n: string): boolean {
  const t = oauthNonces.get(n);
  if (!t) return false;
  oauthNonces.delete(n);
  return Date.now() - t < NONCE_TTL;
}

function getRedirectUri(req: any): string {
  // Public base có thể được override qua setting `public_base_url` (vd: https://app.sondervn.com).
  // Fallback dùng host của request.
  const base = getSetting('public_base_url') || `${req.protocol}://${req.get('host')}`;
  return `${base}/api/admin/youtube/oauth/callback`;
}

/* ═══════════════════════════════════════════════════════════════════
   PUBLIC ENDPOINT — Google OAuth callback (Google gọi không có cookie)
   Bảo vệ bằng `state` nonce CSRF (5 phút TTL).
   ═══════════════════════════════════════════════════════════════════ */
router.get('/oauth/callback', async (req, res) => {
  const { code, state, error } = req.query as Record<string, string>;
  if (error) return res.status(400).send(`<h1>OAuth lỗi</h1><p>${error}</p>`);
  if (!code || !state) return res.status(400).send('<h1>Missing code/state</h1>');
  if (!consumeNonce(state)) return res.status(400).send('<h1>Invalid/expired state — bấm Connect lại</h1>');
  const redirectUri = getRedirectUri(req);
  const r = await exchangeYoutubeCode(code, redirectUri);
  if (!r.ok) return res.status(500).send(`<h1>Exchange thất bại</h1><p>${r.error}</p>`);
  res.send(`
    <html><head><meta charset="utf-8"><title>YouTube đã kết nối</title></head>
    <body style="font-family:sans-serif;padding:40px;text-align:center;background:#f0f9ff">
      <h1 style="color:#059669">✓ YouTube đã kết nối thành công</h1>
      <p>refresh_token đã lưu. Đóng tab này và quay lại admin.</p>
      <p style="color:#6b7280;font-size:14px">expires_in: ${r.expires_in}s</p>
      <button onclick="window.close()" style="padding:12px 24px;background:#059669;color:white;border:none;border-radius:6px;cursor:pointer">Đóng</button>
    </body></html>
  `);
});

/* ═══════════════════════════════════════════════════════════════════
   AUTH-PROTECTED ENDPOINTS — admin login required (JSON 401 nếu không có)
   Apply authMiddleware per-route để /setup có thể dùng htmlAuthRequired riêng.
   ═══════════════════════════════════════════════════════════════════ */

/* ═══════════════ 1. Save credentials (client_id + secret) ═══════════════ */
router.post('/oauth/credentials', authMiddleware, (req, res) => {
  const { client_id, client_secret } = req.body || {};
  if (!client_id || !client_secret) return res.status(400).json({ error: 'client_id + client_secret required' });
  setSetting('youtube_client_id', String(client_id).trim());
  setSetting('youtube_client_secret', String(client_secret).trim());
  res.json({ ok: true, message: 'credentials saved. Now click "Connect" to grant access.' });
});

/* ═══════════════ 2. Start OAuth (returns auth URL) ═══════════════ */
router.get('/oauth/start', authMiddleware, (req, res) => {
  try {
    const nonce = makeNonce();
    const redirectUri = getRedirectUri(req);
    const authUrl = buildYoutubeAuthUrl(redirectUri, nonce);
    res.json({ ok: true, auth_url: authUrl, redirect_uri: redirectUri });
  } catch (e: any) {
    res.status(400).json({ error: e?.message });
  }
});

/* ═══════════════ 4. Status ═══════════════ */
router.get('/oauth/status', authMiddleware, async (_req, res) => {
  const connected = isYoutubeConnected();
  if (!connected) return res.json({ connected: false, message: 'chưa kết nối' });
  const grantedAt = getSetting('youtube_token_granted_at');
  res.json({
    connected: true,
    granted_at: grantedAt ? Number(grantedAt) : null,
    granted_at_human: grantedAt ? new Date(Number(grantedAt)).toISOString() : null,
    has_client_id: !!getSetting('youtube_client_id'),
    has_client_secret: !!getSetting('youtube_client_secret'),
    has_refresh_token: !!getSetting('youtube_refresh_token'),
    enabled: getSetting('enable_publish_youtube') === '1',
  });
});

/* ═══════════════ 5. Test connection ═══════════════ */
router.post('/oauth/test', authMiddleware, async (_req, res) => {
  const r = await testYoutubeConnection();
  res.json(r);
});

/* ═══════════════ 6. Disconnect ═══════════════ */
router.post('/oauth/disconnect', authMiddleware, (_req, res) => {
  setSetting('youtube_refresh_token', '');
  setSetting('youtube_token_granted_at', '');
  setSetting('enable_publish_youtube', '0');
  res.json({ ok: true, message: 'disconnected' });
});

/* ═══════════════ 7. Toggle enable flag ═══════════════ */
router.post('/enable', authMiddleware, (req, res) => {
  const { enabled } = req.body || {};
  setSetting('enable_publish_youtube', enabled ? '1' : '0');
  res.json({ ok: true, enabled: !!enabled });
});

/* ═══════════════ 8. Setup admin mini-page (HTML, vanilla JS) ═══════════════ */
// htmlAuthRequired returns nice HTML if not logged in (vs JSON 401)
router.get('/setup', htmlAuthRequired, (_req, res) => {
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>YouTube Auto-Publish Setup</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f3f4f6;padding:40px 20px;color:#1f2937;line-height:1.6}
    .container{max-width:780px;margin:0 auto;background:#fff;border-radius:12px;box-shadow:0 4px 20px rgba(0,0,0,0.08);padding:36px}
    h1{font-size:28px;margin-bottom:8px;color:#1f2937}
    .sub{color:#6b7280;margin-bottom:32px}
    .card{border:1px solid #e5e7eb;border-radius:8px;padding:20px;margin-bottom:20px;background:#fafafa}
    .card.connected{background:#ecfdf5;border-color:#10b981}
    .card.error{background:#fef2f2;border-color:#ef4444}
    label{display:block;font-weight:600;margin-bottom:6px;font-size:14px;color:#374151}
    input[type=text],input[type=password],textarea{width:100%;padding:10px 12px;border:1px solid #d1d5db;border-radius:6px;font-size:14px;font-family:inherit}
    button{padding:10px 20px;background:#dc2626;color:#fff;border:none;border-radius:6px;font-size:14px;font-weight:600;cursor:pointer;margin-right:8px;margin-top:8px}
    button:hover{background:#b91c1c}
    button.secondary{background:#6b7280}
    button.success{background:#059669}
    button.success:hover{background:#047857}
    button:disabled{opacity:0.5;cursor:not-allowed}
    .badge{display:inline-block;padding:4px 10px;border-radius:12px;font-size:12px;font-weight:600;margin-left:8px}
    .badge.ok{background:#d1fae5;color:#065f46}
    .badge.bad{background:#fee2e2;color:#991b1b}
    .step{font-size:14px;color:#4b5563;margin:8px 0}
    pre{background:#1f2937;color:#f9fafb;padding:12px;border-radius:6px;font-size:12px;overflow-x:auto;margin-top:8px}
    .muted{color:#6b7280;font-size:13px}
    a{color:#dc2626;text-decoration:underline}
  </style>
</head>
<body>
<div class="container">
  <h1>📺 YouTube Shorts Auto-Publish</h1>
  <p class="sub">Setup OAuth để cron 3-day tự đăng video lên YouTube channel</p>

  <div id="status-card" class="card">
    <h3 id="status-title">Đang kiểm tra trạng thái...</h3>
    <div id="status-detail" class="muted"></div>
  </div>

  <div class="card">
    <h3>🔧 Bước 1: Nhập Google OAuth credentials</h3>
    <p class="step">Lấy từ Google Cloud Console → APIs & Services → Credentials → OAuth 2.0 Client ID</p>
    <div style="margin-top:12px">
      <label>Client ID</label>
      <input type="text" id="client_id" placeholder="123-abc.apps.googleusercontent.com">
    </div>
    <div style="margin-top:12px">
      <label>Client Secret</label>
      <input type="password" id="client_secret" placeholder="GOCSPX-...">
    </div>
    <button onclick="saveCredentials()">💾 Lưu credentials</button>
  </div>

  <div class="card">
    <h3>🔗 Bước 2: Connect YouTube channel</h3>
    <p class="step">Click button → mở tab mới → grant access cho Sonder Bot → quay lại đây</p>
    <button class="success" onclick="connectYoutube()">🚀 Connect YouTube</button>
    <button class="secondary" onclick="testConnection()">🧪 Test kết nối</button>
    <div id="test-result" style="margin-top:12px"></div>
  </div>

  <div class="card">
    <h3>⚙️ Bước 3: Bật auto-publish</h3>
    <p class="step">Toggle để cron tự đăng YouTube khi có video mới</p>
    <button id="enable-btn" onclick="toggleEnable()">⏳ Loading...</button>
    <button class="secondary" onclick="disconnect()">🔌 Disconnect</button>
  </div>

  <div class="card">
    <h3>📖 Hướng dẫn lấy credentials Google Cloud</h3>
    <ol style="padding-left:20px;font-size:14px;line-height:1.8">
      <li>Vào <a href="https://console.cloud.google.com" target="_blank">console.cloud.google.com</a> → tạo project mới: <b>"Sonder Bot Marketing"</b></li>
      <li>APIs & Services → Library → Tìm <b>"YouTube Data API v3"</b> → Enable</li>
      <li>APIs & Services → OAuth consent screen:
        <ul style="margin-top:4px;padding-left:20px">
          <li>User Type: <b>External</b> → Create</li>
          <li>App name: Sonder Bot Marketing</li>
          <li>User support email: email của anh</li>
          <li>Developer contact: email của anh</li>
          <li>Save → Add scopes → tìm <code>youtube.upload</code> → Save</li>
          <li>Test users → Add: email Google đang sở hữu YT channel (anh dùng để login)</li>
        </ul>
      </li>
      <li>APIs & Services → Credentials → Create Credentials → OAuth 2.0 Client ID:
        <ul style="margin-top:4px;padding-left:20px">
          <li>Type: <b>Web application</b></li>
          <li>Name: Sonder Bot YT</li>
          <li>Authorized redirect URIs → Add: <code id="redirect-uri">https://app.sondervn.com/api/admin/youtube/oauth/callback</code></li>
          <li>Create → copy <b>Client ID</b> + <b>Client Secret</b> → paste vào Bước 1 trên</li>
        </ul>
      </li>
    </ol>
  </div>
</div>

<script>
async function fetchStatus() {
  try {
    const r = await fetch('/api/admin/youtube/oauth/status');
    return await r.json();
  } catch(e) { return { error: e.message }; }
}

async function refreshUI() {
  const s = await fetchStatus();
  const card = document.getElementById('status-card');
  const title = document.getElementById('status-title');
  const detail = document.getElementById('status-detail');
  const enableBtn = document.getElementById('enable-btn');

  if (s.connected) {
    card.className = 'card connected';
    title.innerHTML = '✓ YouTube đã kết nối <span class="badge ok">CONNECTED</span>';
    const grantedAt = s.granted_at_human ? new Date(s.granted_at_human).toLocaleString('vi-VN') : 'unknown';
    detail.innerHTML = 'Granted: ' + grantedAt + ' &nbsp;·&nbsp; refresh_token: <span class="badge ok">SAVED</span>';
    if (s.enabled) {
      enableBtn.textContent = '🟢 Đang BẬT — click để TẮT';
      enableBtn.className = 'secondary';
    } else {
      enableBtn.textContent = '🔴 Đang TẮT — click để BẬT';
      enableBtn.className = 'success';
    }
    enableBtn.disabled = false;
  } else {
    card.className = 'card';
    title.innerHTML = '⚠ Chưa kết nối <span class="badge bad">DISCONNECTED</span>';
    detail.innerHTML = 'Cần làm Bước 1 + 2 bên dưới';
    enableBtn.textContent = '⛔ Cần connect trước';
    enableBtn.disabled = true;
  }
}

async function saveCredentials() {
  const client_id = document.getElementById('client_id').value.trim();
  const client_secret = document.getElementById('client_secret').value.trim();
  if (!client_id || !client_secret) { alert('Cần điền cả Client ID + Secret'); return; }
  const r = await fetch('/api/admin/youtube/oauth/credentials', {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ client_id, client_secret })
  });
  const j = await r.json();
  alert(j.message || j.error || 'Done');
  document.getElementById('client_secret').value = ''; // clear sensitive
}

async function connectYoutube() {
  const r = await fetch('/api/admin/youtube/oauth/start');
  const j = await r.json();
  if (j.error) { alert('Lỗi: ' + j.error); return; }
  window.open(j.auth_url, '_blank', 'width=600,height=700');
  // Poll status every 3s for 60s
  let n = 0;
  const t = setInterval(async () => {
    n++;
    await refreshUI();
    const s = await fetchStatus();
    if (s.connected || n >= 20) {
      clearInterval(t);
      if (s.connected) alert('✓ Đã kết nối! Bấm "Test" để verify channel.');
    }
  }, 3000);
}

async function testConnection() {
  const div = document.getElementById('test-result');
  div.innerHTML = '⏳ Testing...';
  const r = await fetch('/api/admin/youtube/oauth/test', { method: 'POST' });
  const j = await r.json();
  if (j.ok) {
    div.innerHTML = '<div style="background:#d1fae5;padding:12px;border-radius:6px"><b>✓ Channel: ' + (j.channel?.title || 'N/A') + '</b><br>Subscribers: ' + (j.channel?.subscribers || '?') + ' · Videos: ' + (j.channel?.videos || '?') + '<br>Channel ID: <code>' + j.channel?.id + '</code></div>';
  } else {
    div.innerHTML = '<div style="background:#fee2e2;padding:12px;border-radius:6px;color:#991b1b">✗ Error: ' + j.error + '</div>';
  }
}

async function toggleEnable() {
  const s = await fetchStatus();
  const r = await fetch('/api/admin/youtube/enable', {
    method: 'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ enabled: !s.enabled })
  });
  await refreshUI();
}

async function disconnect() {
  if (!confirm('Disconnect YouTube? refresh_token sẽ xóa.')) return;
  await fetch('/api/admin/youtube/oauth/disconnect', { method: 'POST' });
  await refreshUI();
}

refreshUI();
</script>
</body>
</html>`);
});

export default router;

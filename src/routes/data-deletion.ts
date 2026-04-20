/**
 * Facebook Data Deletion Callback
 *
 * Spec: https://developers.facebook.com/docs/development/create-an-app/app-dashboard/data-deletion-callback
 *
 * FB gửi POST với body form-urlencoded: signed_request=<base64url.base64url>
 * - Phần 1: HMAC-SHA256 của phần 2 với FB_APP_SECRET
 * - Phần 2: JSON { algorithm, issued_at, user_id, ... }
 *
 * Trả về JSON: { url, confirmation_code }
 *   url = trang status để user theo dõi
 *   confirmation_code = mã tra cứu
 */
import { Router } from 'express';
import crypto from 'crypto';
import { db } from '../db';
import { config } from '../config';

const router = Router();

// ── Init audit table ────────────────────────────────────────────────
db.exec(`
CREATE TABLE IF NOT EXISTS data_deletion_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  confirmation_code TEXT UNIQUE NOT NULL,
  fb_user_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',  -- pending | completed | failed
  source TEXT NOT NULL DEFAULT 'fb_callback', -- fb_callback | manual_form | api
  deleted_counts TEXT,                      -- JSON summary of rows deleted
  requested_at INTEGER NOT NULL,
  completed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_ddr_code ON data_deletion_requests(confirmation_code);
CREATE INDEX IF NOT EXISTS idx_ddr_fb ON data_deletion_requests(fb_user_id);
`);

// ── Helpers ─────────────────────────────────────────────────────────
function b64urlDecode(s: string): Buffer {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Buffer.from(s, 'base64');
}

function parseSignedRequest(signed: string, secret: string): { user_id?: string } | null {
  try {
    const [sigB64, payloadB64] = signed.split('.');
    if (!sigB64 || !payloadB64) return null;
    const expected = crypto.createHmac('sha256', secret).update(payloadB64).digest();
    const provided = b64urlDecode(sigB64);
    if (expected.length !== provided.length || !crypto.timingSafeEqual(expected, provided)) return null;
    const payload = JSON.parse(b64urlDecode(payloadB64).toString('utf8'));
    return payload;
  } catch {
    return null;
  }
}

function genCode(): string {
  return crypto.randomBytes(12).toString('hex');
}

// ── Core deletion logic ─────────────────────────────────────────────
function deleteAllDataForFbUser(fbUserId: string): Record<string, number> {
  const counts: Record<string, number> = {};
  const del = (sql: string, ...params: any[]) => {
    try {
      const r = db.prepare(sql).run(...params);
      return r.changes || 0;
    } catch {
      return 0;
    }
  };
  // FB user_id is used as sender_id (Messenger PSID) across these tables
  counts.customer_contacts     = del(`DELETE FROM customer_contacts WHERE sender_id = ?`, fbUserId);
  counts.conversation_memory   = del(`DELETE FROM conversation_memory WHERE sender_id = ?`, fbUserId);
  counts.guest_profiles        = del(`DELETE FROM guest_profiles WHERE fb_user_id = ?`, fbUserId);
  counts.pending_bookings      = del(`DELETE FROM pending_bookings WHERE fb_sender_id = ?`, fbUserId);
  counts.appointments          = del(`DELETE FROM appointments WHERE sender_id = ?`, fbUserId);
  counts.agent_tool_calls      = del(`DELETE FROM agent_tool_calls WHERE sender_id = ?`, fbUserId);
  counts.bot_feedback          = del(`DELETE FROM bot_feedback WHERE sender_id = ?`, fbUserId);
  counts.auto_replies          = del(`DELETE FROM auto_replies WHERE sender_id = ?`, fbUserId);
  return counts;
}

// ── FB callback endpoint ────────────────────────────────────────────
router.post('/callback', (req, res) => {
  const signed = String((req.body && req.body.signed_request) || '');
  const secret = config.fbAppSecret || process.env.FB_APP_SECRET || '';
  if (!signed || !secret) {
    return res.status(400).json({ error: 'missing signed_request or FB_APP_SECRET' });
  }
  const payload = parseSignedRequest(signed, secret);
  if (!payload || !payload.user_id) {
    return res.status(400).json({ error: 'invalid signed_request' });
  }

  const code = genCode();
  const now = Date.now();
  db.prepare(
    `INSERT INTO data_deletion_requests (confirmation_code, fb_user_id, status, source, requested_at)
     VALUES (?, ?, 'pending', 'fb_callback', ?)`
  ).run(code, payload.user_id, now);

  // Delete async (but run sync since SQLite is fast locally)
  try {
    const counts = deleteAllDataForFbUser(payload.user_id);
    db.prepare(
      `UPDATE data_deletion_requests
       SET status = 'completed', deleted_counts = ?, completed_at = ?
       WHERE confirmation_code = ?`
    ).run(JSON.stringify(counts), Date.now(), code);
  } catch (e: any) {
    db.prepare(
      `UPDATE data_deletion_requests SET status = 'failed', deleted_counts = ? WHERE confirmation_code = ?`
    ).run(JSON.stringify({ error: e?.message }), code);
  }

  const base = config.publicUrl || 'https://mkt.sondervn.com';
  res.json({
    url: `${base}/data-deletion/status?code=${code}`,
    confirmation_code: code,
  });
});

// ── Status endpoint ─────────────────────────────────────────────────
// /api/data-deletion/status → JSON (for programmatic/FB)
// /data-deletion/status     → HTML (human-friendly, URL returned to FB)
router.get('/status', (req, res) => {
  const code = String(req.query.code || '');
  const wantsHtml = !req.baseUrl.startsWith('/api');
  const row = code ? db.prepare(
    `SELECT confirmation_code, status, source, deleted_counts, requested_at, completed_at
     FROM data_deletion_requests WHERE confirmation_code = ?`
  ).get(code) as any : null;

  if (!wantsHtml) {
    if (!code) return res.status(400).json({ error: 'missing code' });
    if (!row) return res.status(404).json({ error: 'not found' });
    return res.json({
      confirmation_code: row.confirmation_code,
      status: row.status,
      source: row.source,
      requested_at: row.requested_at,
      completed_at: row.completed_at,
      deleted: row.deleted_counts ? JSON.parse(row.deleted_counts) : null,
    });
  }

  const esc = (s: any) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' } as any)[c]);
  const fmt = (ms?: number) => ms ? new Date(ms).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' }) : '—';
  const deleted = row?.deleted_counts ? JSON.parse(row.deleted_counts) : null;
  const statusPill = row ? ({
    completed: '<span style="background:#dcfce7;color:#166534;padding:4px 12px;border-radius:999px;font-weight:600">✅ Đã xóa</span>',
    pending:   '<span style="background:#fef3c7;color:#92400e;padding:4px 12px;border-radius:999px;font-weight:600">⏳ Đang xử lý</span>',
    failed:    '<span style="background:#fee2e2;color:#991b1b;padding:4px 12px;border-radius:999px;font-weight:600">❌ Lỗi</span>',
  } as any)[row.status] || row.status : '';

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html>
<html lang="vi"><head><meta charset="UTF-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Trạng thái xóa dữ liệu — VP Marketing</title>
<script src="https://cdn.tailwindcss.com"></script>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;800&display=swap" rel="stylesheet">
<style>body{font-family:'Inter',sans-serif;background:linear-gradient(180deg,#eef2ff,#f6f7fb);min-height:100vh}</style>
</head><body class="text-slate-800">
<div class="max-w-2xl mx-auto px-5 py-12">
  <a href="/data-deletion.html" class="text-sm text-indigo-600 hover:underline">← Hướng dẫn xóa dữ liệu</a>
  <h1 class="text-3xl font-extrabold mt-3 mb-6">Trạng thái yêu cầu xóa</h1>
  ${!code ? `
    <div class="bg-white rounded-2xl shadow-lg p-8 text-center">
      <p class="text-slate-500">Thiếu mã xác nhận. Nhập mã bên dưới để tra cứu:</p>
      <form method="GET" class="mt-4 flex gap-2">
        <input name="code" class="flex-1 border rounded-lg px-3 py-2 text-sm" placeholder="Mã xác nhận" required />
        <button class="bg-indigo-600 text-white px-4 py-2 rounded-lg text-sm font-semibold">Tra cứu</button>
      </form>
    </div>` : !row ? `
    <div class="bg-white rounded-2xl shadow-lg p-8 text-center">
      <p class="text-2xl">❓</p>
      <h2 class="text-xl font-bold mt-2">Không tìm thấy mã</h2>
      <p class="text-slate-500 mt-2">Mã <code class="bg-slate-100 px-2 py-0.5 rounded">${esc(code)}</code> không có trong hệ thống.</p>
    </div>` : `
    <div class="bg-white rounded-2xl shadow-lg p-8">
      <div class="flex items-center justify-between mb-4">
        <div><div class="text-xs text-slate-500 mb-1">Mã xác nhận</div><code class="bg-slate-100 px-3 py-1 rounded font-mono">${esc(row.confirmation_code)}</code></div>
        ${statusPill}
      </div>
      <table class="w-full text-sm">
        <tr><td class="py-2 text-slate-500">Thời gian yêu cầu</td><td class="py-2 font-medium text-right">${fmt(row.requested_at)}</td></tr>
        <tr class="border-t"><td class="py-2 text-slate-500">Thời gian hoàn tất</td><td class="py-2 font-medium text-right">${fmt(row.completed_at)}</td></tr>
        <tr class="border-t"><td class="py-2 text-slate-500">Nguồn yêu cầu</td><td class="py-2 font-medium text-right">${row.source === 'fb_callback' ? 'Facebook' : row.source === 'manual_form' ? 'Biểu mẫu thủ công' : esc(row.source)}</td></tr>
      </table>
      ${deleted ? `
      <div class="mt-6 pt-5 border-t">
        <h3 class="font-semibold mb-3">Chi tiết dữ liệu đã xóa</h3>
        <ul class="text-sm space-y-1">
          ${Object.entries(deleted).map(([k, v]) => `<li class="flex justify-between"><span class="text-slate-500">${esc(k)}</span><span class="font-mono font-semibold">${esc(v)} bản ghi</span></li>`).join('')}
        </ul>
      </div>` : ''}
      <p class="text-xs text-slate-400 mt-6 text-center">Yêu cầu xóa vĩnh viễn theo Nghị định 13/2023/NĐ-CP và chính sách Meta.</p>
    </div>`}
  <div class="text-center mt-6 text-xs text-slate-400">
    <a href="/privacy.html" class="hover:underline">Bảo mật</a> • <a href="/terms.html" class="hover:underline">Điều khoản</a> • <a href="/" class="hover:underline">Trang chủ</a>
  </div>
</div></body></html>`);
});

// ── Manual deletion request (form from /data-deletion.html) ─────────
router.post('/manual', (req, res) => {
  const fbUserId = String(req.body?.fb_user_id || '').trim();
  const email = String(req.body?.email || '').trim();
  if (!fbUserId && !email) {
    return res.status(400).json({ error: 'fb_user_id hoặc email là bắt buộc' });
  }
  const code = genCode();
  const now = Date.now();
  const counts = fbUserId ? deleteAllDataForFbUser(fbUserId) : {};
  db.prepare(
    `INSERT INTO data_deletion_requests (confirmation_code, fb_user_id, status, source, deleted_counts, requested_at, completed_at)
     VALUES (?, ?, 'completed', 'manual_form', ?, ?, ?)`
  ).run(code, fbUserId || `email:${email}`, JSON.stringify(counts), now, now);
  res.json({
    ok: true,
    confirmation_code: code,
    status_url: `/data-deletion/status?code=${code}`,
    deleted: counts,
  });
});

export default router;

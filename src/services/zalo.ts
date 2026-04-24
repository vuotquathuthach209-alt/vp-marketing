/**
 * Zalo Official Account integration
 *
 * Docs: https://developers.zalo.me/docs/api/official-account-api
 *
 * Flow:
 *  - KS đăng ký Zalo OA → lấy access_token (từ Zalo dev console, refresh mỗi 25h)
 *  - Webhook nhận message → smartReply → gửi reply qua Zalo API
 *
 * Settings keys (per-hotel via getSetting(..., hotelId)):
 *  - zalo_oa_id
 *  - zalo_access_token
 *  - zalo_refresh_token
 *  - zalo_app_secret (for webhook signature verify)
 */

import axios from 'axios';
import crypto from 'crypto';
import { db, getSetting, setSetting } from '../db';
import { encrypt, decrypt } from './crypto';

// One-time schema
db.exec(`
CREATE TABLE IF NOT EXISTS zalo_oa (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hotel_id INTEGER NOT NULL,
  oa_id TEXT NOT NULL,
  oa_name TEXT,
  access_token TEXT NOT NULL,
  refresh_token TEXT,
  token_expires_at INTEGER,
  app_secret TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  UNIQUE(hotel_id, oa_id)
);
CREATE INDEX IF NOT EXISTS idx_zalo_oa_hotel ON zalo_oa(hotel_id);

-- ZNS templates (Zalo Notification Service) — admin manage per hotel
CREATE TABLE IF NOT EXISTS zalo_zns_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hotel_id INTEGER NOT NULL,
  template_id TEXT NOT NULL,          -- ID từ Zalo Business Console
  template_name TEXT NOT NULL,        -- 'booking_confirm', 'checkin_reminder', ...
  template_type TEXT NOT NULL,        -- booking_confirm | checkin_reminder | review_request | promo | custom
  variables TEXT,                     -- JSON array of variable names bot phải điền
  description TEXT,
  status TEXT DEFAULT 'active',       -- active | disabled
  created_at INTEGER NOT NULL,
  UNIQUE(hotel_id, template_id)
);
CREATE INDEX IF NOT EXISTS idx_zns_tpl_hotel ON zalo_zns_templates(hotel_id, template_type);

-- ZNS send log (audit + rate limit)
CREATE TABLE IF NOT EXISTS zalo_zns_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hotel_id INTEGER NOT NULL,
  template_id TEXT NOT NULL,
  phone TEXT NOT NULL,
  tracking_id TEXT,
  data_json TEXT,
  status TEXT NOT NULL,               -- sent | failed | delivered | read
  error TEXT,
  zalo_msg_id TEXT,
  sent_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_zns_log_hotel ON zalo_zns_log(hotel_id, sent_at DESC);

-- Zalo OA Articles — bài đăng lên feed OA Sonder (giống FB post)
CREATE TABLE IF NOT EXISTS zalo_articles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hotel_id INTEGER NOT NULL,
  oa_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  cover_url TEXT,                     -- URL ảnh cover (HTTPS public)
  body_html TEXT NOT NULL,            -- Rich text content (HTML hoặc markdown chuyển HTML)
  status TEXT DEFAULT 'draft',        -- draft | scheduled | publishing | published | failed
  zalo_article_id TEXT,               -- ID từ Zalo sau khi publish OK
  zalo_article_url TEXT,              -- public URL của bài trên Zalo
  scheduled_at INTEGER,               -- null nếu publish ngay
  published_at INTEGER,
  error TEXT,                         -- message khi fail
  post_id INTEGER,                    -- FK tới posts.id nếu cross-post từ FB
  created_by INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_zalo_articles_hotel ON zalo_articles(hotel_id, status, scheduled_at);
CREATE INDEX IF NOT EXISTS idx_zalo_articles_scheduled ON zalo_articles(status, scheduled_at) WHERE status IN ('scheduled','publishing');
`);

export interface ZaloOA {
  id: number;
  hotel_id: number;
  oa_id: string;
  oa_name: string | null;
  access_token: string;
  refresh_token: string | null;
  token_expires_at: number | null;
  app_secret: string | null;
  enabled: number;
}

function decryptRow(r: ZaloOA | undefined | null): ZaloOA | null {
  if (!r) return null;
  return {
    ...r,
    access_token: decrypt(r.access_token) || '',
    refresh_token: decrypt(r.refresh_token),
    app_secret: decrypt(r.app_secret),
  };
}

export function getZaloByOaId(oaId: string): ZaloOA | null {
  const r = db.prepare(`SELECT * FROM zalo_oa WHERE oa_id = ? AND enabled = 1`).get(oaId) as ZaloOA | undefined;
  return decryptRow(r);
}

export function listZaloForHotel(hotelId: number): ZaloOA[] {
  const rows = db.prepare(`SELECT * FROM zalo_oa WHERE hotel_id = ? ORDER BY id DESC`).all(hotelId) as ZaloOA[];
  return rows.map(r => decryptRow(r)!).filter(Boolean);
}

export function saveZaloOA(input: {
  hotel_id: number;
  oa_id: string;
  oa_name?: string;
  access_token: string;
  refresh_token?: string;
  app_secret?: string;
}): number {
  const existing = db.prepare(`SELECT id FROM zalo_oa WHERE hotel_id = ? AND oa_id = ?`)
    .get(input.hotel_id, input.oa_id) as { id: number } | undefined;
  if (existing) {
    db.prepare(
      `UPDATE zalo_oa SET oa_name = ?, access_token = ?, refresh_token = COALESCE(?, refresh_token),
       app_secret = COALESCE(?, app_secret), enabled = 1 WHERE id = ?`
    ).run(input.oa_name || null, encrypt(input.access_token), encrypt(input.refresh_token || null), encrypt(input.app_secret || null), existing.id);
    return existing.id;
  }
  const r = db.prepare(
    `INSERT INTO zalo_oa (hotel_id, oa_id, oa_name, access_token, refresh_token, app_secret, enabled, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?)`
  ).run(input.hotel_id, input.oa_id, input.oa_name || null,
        encrypt(input.access_token), encrypt(input.refresh_token || null), encrypt(input.app_secret || null), Date.now());
  return Number(r.lastInsertRowid);
}

/** Gửi text message qua Zalo OA. recipient.user_id là Zalo user ID. */
export async function zaloSendText(oa: ZaloOA, userId: string, text: string): Promise<any> {
  try {
    // v24: Zalo KHÔNG render markdown → strip **bold**, *italic*, ... trước khi gửi.
    //       Nếu để nguyên, khách thấy "**550k/đêm**" literal → lộ rõ là bot.
    const { sanitizeForZalo } = require('./message-sanitizer');
    const cleanText = sanitizeForZalo(text);

    const r = await axios.post(
      'https://openapi.zalo.me/v3.0/oa/message/cs',
      {
        recipient: { user_id: userId },
        message: { text: cleanText },
      },
      {
        headers: {
          'access_token': oa.access_token,
          'Content-Type': 'application/json',
        },
        timeout: 15000,
      }
    );
    if (r.data?.error && r.data.error !== 0) {
      throw new Error(`Zalo ${r.data.error}: ${r.data.message}`);
    }
    return r.data;
  } catch (e: any) {
    console.error('[zalo] send fail:', e?.response?.data || e?.message);
    throw e;
  }
}

/** Gửi ảnh qua Zalo OA. image_url phải là HTTPS public URL. */
export async function zaloSendImage(oa: ZaloOA, userId: string, imageUrl: string, caption?: string): Promise<any> {
  try {
    const r = await axios.post(
      'https://openapi.zalo.me/v3.0/oa/message/cs',
      {
        recipient: { user_id: userId },
        message: {
          text: caption?.slice(0, 400),
          attachment: {
            type: 'template',
            payload: {
              template_type: 'media',
              elements: [{ media_type: 'image', url: imageUrl }],
            },
          },
        },
      },
      {
        headers: { 'access_token': oa.access_token, 'Content-Type': 'application/json' },
        timeout: 15000,
      }
    );
    if (r.data?.error && r.data.error !== 0) {
      throw new Error(`Zalo ${r.data.error}: ${r.data.message}`);
    }
    return r.data;
  } catch (e: any) {
    console.error('[zalo] sendImage fail:', e?.response?.data || e?.message);
    throw e;
  }
}

/** Gửi message với quick reply buttons — khách click nhanh không cần gõ.
 *  buttons: mảng {title: string, payload?: string} (payload = text bot sẽ nhận khi click)
 *  Zalo hỗ trợ tối đa 10 buttons per message. */
export async function zaloSendQuickReply(
  oa: ZaloOA,
  userId: string,
  text: string,
  buttons: Array<{ title: string; payload?: string }>,
): Promise<any> {
  try {
    const maxButtons = buttons.slice(0, 10);
    const r = await axios.post(
      'https://openapi.zalo.me/v3.0/oa/message/cs',
      {
        recipient: { user_id: userId },
        message: {
          text: text.slice(0, 1000),
          attachment: {
            type: 'template',
            payload: {
              template_type: 'list',
              elements: maxButtons.map((b, i) => ({
                title: b.title.slice(0, 100),
                subtitle: '',
                default_action: {
                  type: 'oa.query.show',
                  payload: b.payload || b.title,
                },
              })),
            },
          },
        },
      },
      {
        headers: { 'access_token': oa.access_token, 'Content-Type': 'application/json' },
        timeout: 15000,
      }
    );
    if (r.data?.error && r.data.error !== 0) {
      throw new Error(`Zalo ${r.data.error}: ${r.data.message}`);
    }
    return r.data;
  } catch (e: any) {
    console.error('[zalo] quickReply fail:', e?.response?.data || e?.message);
    throw e;
  }
}

/** Lookup Zalo user profile (name, avatar) để personalize reply.
 *  Yêu cầu khách đã message OA ít nhất 1 lần. */
export async function zaloGetUserProfile(oa: ZaloOA, userId: string): Promise<{
  user_id: string;
  display_name?: string;
  user_gender?: number;    // 1=male, 0=female
  avatar?: string;
  is_sensitive?: boolean;
} | null> {
  try {
    const r = await axios.get(
      `https://openapi.zalo.me/v3.0/oa/user/detail`,
      {
        params: { data: JSON.stringify({ user_id: userId }) },
        headers: { 'access_token': oa.access_token },
        timeout: 10000,
      }
    );
    if (r.data?.error && r.data.error !== 0) {
      console.warn('[zalo] getUserProfile:', r.data.message);
      return null;
    }
    return r.data?.data || null;
  } catch (e: any) {
    console.warn('[zalo] getUserProfile fail:', e?.response?.data || e?.message);
    return null;
  }
}

/**
 * ZNS — Zalo Notification Service.
 * Gửi template notification (booking confirm, check-in reminder, review request...).
 * KHÁC với message cs: ZNS có thể gửi KỂ CẢ khi 48h window đã hết,
 * nhưng template phải pre-approved bởi Zalo.
 *
 * @param templateId - ID template đã approve trên Zalo Business Console
 * @param phone - SĐT khách (bắt buộc) — Zalo lookup user qua phone
 * @param templateData - Key-value replace placeholders trong template
 */
export async function zaloSendZNS(
  oa: ZaloOA,
  phone: string,
  templateId: string,
  templateData: Record<string, string>,
  options?: { trackingId?: string },
): Promise<any> {
  try {
    // Normalize phone to E.164 (Vietnam: 84xxx)
    let normalizedPhone = phone.replace(/\D/g, '');
    if (normalizedPhone.startsWith('0')) normalizedPhone = '84' + normalizedPhone.slice(1);
    if (!normalizedPhone.startsWith('84')) normalizedPhone = '84' + normalizedPhone;

    const r = await axios.post(
      'https://business.openapi.zalo.me/message/template',
      {
        phone: normalizedPhone,
        template_id: templateId,
        template_data: templateData,
        tracking_id: options?.trackingId || `zns_${Date.now()}`,
      },
      {
        headers: { 'access_token': oa.access_token, 'Content-Type': 'application/json' },
        timeout: 15000,
      }
    );
    if (r.data?.error && r.data.error !== 0) {
      throw new Error(`ZNS ${r.data.error}: ${r.data.message}`);
    }
    return r.data;
  } catch (e: any) {
    console.error('[zalo] ZNS fail:', e?.response?.data || e?.message);
    throw e;
  }
}

/** Verify webhook signature (Zalo mac header). */
export function verifyZaloSignature(appSecret: string, timestamp: string, body: string, mac: string): boolean {
  if (!appSecret || !mac) return false;
  const expected = crypto.createHmac('sha256', appSecret)
    .update(appSecret + body + timestamp)
    .digest('hex');
  return expected === mac;
}

// ═══════════════════════════════════════════════════════════
// OA Broadcast (gửi rich message ảnh+text tới users)
// Zalo Article API (/article/create) đã deprecate cho tier tiêu chuẩn,
// thay bằng rich message broadcast qua /oa/message/cs.
// ═══════════════════════════════════════════════════════════

import FormData from 'form-data';

/** Upload ảnh lên Zalo, trả về attachment_id.
 *  Zalo chỉ accept ảnh đã upload (không accept URL external trong message).
 */
export async function zaloUploadImage(oa: ZaloOA, imageBuffer: Buffer, filename = 'image.jpg', contentType = 'image/jpeg'): Promise<string | null> {
  try {
    const form = new FormData();
    form.append('file', imageBuffer, { filename, contentType });
    const r = await axios.post(
      'https://openapi.zalo.me/v2.0/oa/upload/image',
      form,
      {
        headers: { ...form.getHeaders(), access_token: oa.access_token },
        timeout: 30000,
        maxContentLength: 20 * 1024 * 1024,
        maxBodyLength: 20 * 1024 * 1024,
      },
    );
    if (r.data?.error !== 0) {
      throw new Error(`Zalo upload ${r.data.error}: ${r.data.message}`);
    }
    return r.data?.data?.attachment_id || null;
  } catch (e: any) {
    console.error('[zalo] upload fail:', e?.response?.data || e?.message);
    throw e;
  }
}

/** Upload ảnh từ URL (bot download rồi upload lại cho Zalo) */
export async function zaloUploadImageFromUrl(oa: ZaloOA, imageUrl: string): Promise<string | null> {
  const resp = await axios.get(imageUrl, { responseType: 'arraybuffer', timeout: 20000, maxContentLength: 20 * 1024 * 1024 });
  const buf = Buffer.from(resp.data);
  const ct = resp.headers['content-type'] || 'image/jpeg';
  const ext = ct.includes('png') ? 'png' : ct.includes('webp') ? 'webp' : 'jpg';
  return zaloUploadImage(oa, buf, `cover.${ext}`, ct);
}

/** Gửi 1 rich message (ảnh + caption) tới 1 user. */
export async function zaloSendRichMessage(
  oa: ZaloOA,
  userId: string,
  opts: { caption: string; attachmentId?: string; imageUrl?: string },
): Promise<{ ok: boolean; message_id?: string; error?: string }> {
  try {
    let attId = opts.attachmentId;
    if (!attId && opts.imageUrl) {
      attId = (await zaloUploadImageFromUrl(oa, opts.imageUrl)) || undefined;
    }
    const message: any = { text: opts.caption.slice(0, 2000) };
    if (attId) {
      message.attachment = {
        type: 'template',
        payload: { template_type: 'media', elements: [{ media_type: 'image', attachment_id: attId }] },
      };
    }
    const r = await axios.post(
      'https://openapi.zalo.me/v3.0/oa/message/cs',
      { recipient: { user_id: userId }, message },
      { headers: { access_token: oa.access_token, 'Content-Type': 'application/json' }, timeout: 15000 },
    );
    if (r.data?.error !== 0) {
      return { ok: false, error: `Zalo ${r.data.error}: ${r.data.message}` };
    }
    return { ok: true, message_id: r.data?.data?.message_id };
  } catch (e: any) {
    return { ok: false, error: e?.response?.data?.message || e?.message };
  }
}

/** Lấy danh sách user recent (đã chat OA trong 48h CS window).
 *  Source hỗn hợp:
 *  1. Zalo API listrecentchat (nhanh, đúng CS window)
 *  2. Fallback: DB conversation_memory (users đã từng chat bot)
 *  Dedup bằng Map. */
export async function zaloGetRecentChatUsers(oa: ZaloOA, limit = 500): Promise<Array<{ user_id: string; display_name?: string }>> {
  const users = new Map<string, string>();

  // Source 1: Zalo API
  let offset = 0;
  const pageSize = 50;
  while (offset < 200) {
    try {
      const r = await axios.get(
        `https://openapi.zalo.me/v2.0/oa/listrecentchat?data=${encodeURIComponent(JSON.stringify({ offset, count: pageSize }))}`,
        { headers: { access_token: oa.access_token }, timeout: 15000 },
      );
      const items = r.data?.data || [];
      if (!items.length) break;
      for (const msg of items) {
        const uid = msg.src === 1 ? msg.from_id : msg.to_id;
        const name = msg.src === 1 ? msg.from_display_name : msg.to_display_name;
        if (uid && uid !== oa.oa_id && !users.has(uid)) users.set(uid, name || '');
      }
      offset += pageSize;
      if (items.length < pageSize) break;
    } catch { break; }
  }

  // Source 2: DB (users đã nhắn bot trong 48h)
  const cutoff = Date.now() - 48 * 60 * 60 * 1000;
  try {
    const rows = db.prepare(
      `SELECT DISTINCT SUBSTR(sender_id, 6) AS user_id, MAX(created_at) AS last_ts
       FROM conversation_memory
       WHERE sender_id LIKE 'zalo:%'
         AND sender_id NOT LIKE 'zalo:zalo_sim_%'
         AND created_at >= ?
       GROUP BY sender_id
       ORDER BY last_ts DESC`,
    ).all(cutoff) as any[];
    for (const r of rows) {
      if (r.user_id && !users.has(r.user_id)) users.set(r.user_id, '');
    }
  } catch {}

  return Array.from(users, ([user_id, display_name]) => ({ user_id, display_name })).slice(0, limit);
}

/** Gửi broadcast: upload ảnh 1 lần + gửi rich message tới danh sách user.
 *  Rate limit: Zalo khoảng 30 msg/second, tôi throttle 100ms giữa các request.
 *  Returns { sent, failed, errors } per user. */
export async function zaloBroadcastRichMessage(
  oa: ZaloOA,
  opts: {
    caption: string;
    imageUrl?: string;
    attachmentId?: string;
    userIds?: string[];         // nếu không truyền, dùng recent chat users
    onProgress?: (done: number, total: number) => void;
  },
): Promise<{ sent: number; failed: number; errors: Array<{ user_id: string; error: string }>; attachment_id?: string; recipient_count: number }> {
  // 1. Upload cover nếu cần
  let attId = opts.attachmentId;
  if (!attId && opts.imageUrl) {
    attId = (await zaloUploadImageFromUrl(oa, opts.imageUrl)) || undefined;
  }

  // 2. Lấy danh sách users
  let targets = opts.userIds;
  if (!targets || targets.length === 0) {
    const recent = await zaloGetRecentChatUsers(oa, 500);
    targets = recent.map(u => u.user_id);
  }

  const errors: Array<{ user_id: string; error: string }> = [];
  let sent = 0, failed = 0;
  for (let i = 0; i < targets.length; i++) {
    const uid = targets[i];
    const r = await zaloSendRichMessage(oa, uid, { caption: opts.caption, attachmentId: attId });
    if (r.ok) sent++;
    else { failed++; errors.push({ user_id: uid, error: r.error || 'unknown' }); }
    opts.onProgress?.(i + 1, targets.length);
    // Throttle 100ms để tránh rate limit
    if (i < targets.length - 1) await new Promise(r => setTimeout(r, 100));
  }
  return { sent, failed, errors, attachment_id: attId, recipient_count: targets.length };
}

/** v24: Tạo Article trên TIMELINE OA (không gửi tin nhắn tới follower).
 *
 *  Differences:
 *    - zaloBroadcastRichMessage   → push inbox tới từng follower (gửi tin nhắn)
 *    - zaloCreateTimelineArticle  → đăng lên feed của OA (followers thấy khi vào OA page, KHÔNG push)
 *
 *  Endpoint: POST https://openapi.zalo.me/v2.0/article/create
 *  Cần scope: oa.article.create (OA verified business có sẵn)
 *
 *  Response: {data: {id: "<article_id>", url: "..."}, error: 0}
 */
export async function zaloCreateTimelineArticle(
  oa: ZaloOA,
  opts: {
    title: string;
    description?: string;
    cover: string;                                          // URL or attachment_id
    bodyBlocks: Array<{ type: 'text' | 'image'; content: string; desc?: string }>;
    author?: string;
    status?: 'show' | 'hide';
    comment?: 'enable' | 'disable';
  },
): Promise<{ article_id?: string; url?: string; raw: any }> {
  try {
    // Step 1: Ensure cover is an upload attachment (Zalo needs attachment_id, not URL)
    let coverAttId = opts.cover;
    if (/^https?:\/\//.test(opts.cover)) {
      const id = await zaloUploadImageFromUrl(oa, opts.cover);
      if (!id) throw new Error('Cannot upload cover image');
      coverAttId = id;
    }

    // Step 2: Upload inline images in body (nếu có)
    const processedBody: any[] = [];
    for (const block of opts.bodyBlocks) {
      if (block.type === 'image' && /^https?:\/\//.test(block.content)) {
        const id = await zaloUploadImageFromUrl(oa, block.content);
        if (id) processedBody.push({ type: 'image', content: id, desc: block.desc || '' });
      } else if (block.type === 'text') {
        processedBody.push({ type: 'text', content: block.content });
      }
    }

    // Step 3: POST article — type 'normal' = bài viết thường (khác 'video')
    const payload = {
      type: 'normal',
      title: opts.title.slice(0, 100),
      description: (opts.description || '').slice(0, 200),
      cover: coverAttId,
      body: processedBody,
      author: opts.author || 'Sonder',
      status: opts.status || 'show',
      comment: opts.comment || 'enable',
    };

    const r = await axios.post(
      'https://openapi.zalo.me/v2.0/article/create',
      payload,
      {
        headers: { access_token: oa.access_token, 'Content-Type': 'application/json' },
        timeout: 30000,
      }
    );

    if (r.data?.error !== 0) {
      throw new Error(`Zalo article ${r.data.error}: ${r.data.message}`);
    }

    return {
      article_id: r.data?.data?.id,
      url: r.data?.data?.url,
      raw: r.data,
    };
  } catch (e: any) {
    const msg = e?.response?.data || e?.message;
    console.error('[zalo] create article fail:', msg);
    throw e;
  }
}

/** Legacy name — HIỆN TẠI GỌI TIMELINE ARTICLE (không broadcast).
 *  Dùng cho cross-post tự động để KHÔNG spam inbox follower.
 *  Nếu muốn broadcast cũ → dùng zaloBroadcastRichMessage trực tiếp.
 */
export async function zaloCreateArticle(
  oa: ZaloOA,
  opts: {
    title: string;
    description?: string;
    cover: string;
    bodyBlocks: Array<{ type: 'text' | 'image'; content: string; desc?: string }>;
    author?: string;
    status?: 'show' | 'hide';
    comment?: 'enable' | 'disable';
  },
): Promise<{ article_id?: string; url?: string; raw: any }> {
  // v24: Default to timeline article (không gửi tin nhắn tới follower)
  return zaloCreateTimelineArticle(oa, opts);
}

/** Convert plain text → body blocks (giữ để compat với legacy code) */
export function textToZaloBodyBlocks(text: string, imageUrls?: string[]): Array<{ type: 'text' | 'image'; content: string; desc?: string }> {
  const blocks: Array<{ type: 'text' | 'image'; content: string; desc?: string }> = [];
  const paragraphs = text.split(/\n{2,}/).filter(p => p.trim());
  for (const p of paragraphs) {
    blocks.push({ type: 'text', content: p });
  }
  if (imageUrls) for (const url of imageUrls) blocks.push({ type: 'image', content: url });
  return blocks;
}

/**
 * Refresh access_token. Zalo tokens live ~25h.
 * Docs: POST https://oauth.zaloapp.com/v4/oa/access_token
 */
export async function refreshZaloToken(oa: ZaloOA): Promise<boolean> {
  if (!oa.refresh_token) return false;
  const appId = getSetting('zalo_app_id');
  const appSecret = oa.app_secret || getSetting('zalo_app_secret');
  if (!appId || !appSecret) return false;

  try {
    const r = await axios.post(
      'https://oauth.zaloapp.com/v4/oa/access_token',
      new URLSearchParams({
        refresh_token: oa.refresh_token,
        app_id: appId,
        grant_type: 'refresh_token',
      }).toString(),
      {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'secret_key': appSecret },
        timeout: 15000,
      }
    );
    const newToken = r.data?.access_token;
    const newRefresh = r.data?.refresh_token;
    const expiresIn = parseInt(r.data?.expires_in || '0', 10);
    if (!newToken) return false;
    db.prepare(
      `UPDATE zalo_oa SET access_token = ?, refresh_token = COALESCE(?, refresh_token),
       token_expires_at = ? WHERE id = ?`
    ).run(encrypt(newToken), newRefresh ? encrypt(newRefresh) : null, expiresIn ? Date.now() + expiresIn * 1000 : null, oa.id);
    return true;
  } catch (e: any) {
    console.error('[zalo] refresh fail:', e?.response?.data || e?.message);
    return false;
  }
}

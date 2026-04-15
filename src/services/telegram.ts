import axios from 'axios';
import { db, getSetting, setSetting } from '../db';
import { generateCaption } from './claude';
import { getOverview, getBestPostingTime } from './analytics';
import { buildContext, getWikiStats } from './wiki';
import { syncBooking } from './booking';
import { publishText, publishImage, mediaFullPath } from './facebook';

/**
 * Sprint 6 — Telegram Bot (long-polling, no webhook).
 *
 * Commands:
 *   /start                     — welcome + capability list
 *   /help                      — danh sách lệnh
 *   /unlock <code>             — unlock chat (code lấy từ settings 'telegram_unlock_code')
 *   /pages                     — list FB pages đang quản lý
 *   /caption <topic>           — AI generate caption (Wiki RAG)
 *   /post <page_id>|<topic>    — generate + schedule smart slot
 *   /publish <page_id>|<text>  — đăng ngay text-only
 *   /stats                     — overview 30 ngày
 *   /besttime                  — khung giờ vàng
 *   /wiki <topic>              — preview Wiki context
 *   /booking <content>         — sync booking data
 *   /notify on|off             — bật/tắt notification
 *   /whoami                    — xem chat_id + trạng thái
 *
 * Notifications outbound:
 *   - Post publish success/fail
 *   - A/B winner decided
 *   - Auto-reply error rate spike
 */

const API = (token: string) => `https://api.telegram.org/bot${token}`;

interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    from?: { id: number; username?: string; first_name?: string };
    chat: { id: number; type: string };
    text?: string;
  };
}

interface ChatRow {
  chat_id: string;
  authorized: number;
  notify: number;
}

let botToken: string | null = null;
let offset = 0;
let running = false;
let pollTimer: NodeJS.Timeout | null = null;

function getToken(): string | null {
  if (botToken) return botToken;
  botToken = getSetting('telegram_bot_token');
  return botToken;
}

export function setBotToken(token: string) {
  botToken = token;
  setSetting('telegram_bot_token', token);
}

export function getBotStatus() {
  return {
    configured: !!getToken(),
    running,
    chats: db.prepare(`SELECT COUNT(*) as n FROM telegram_chats WHERE authorized = 1`).get(),
    unlock_code_set: !!getSetting('telegram_unlock_code'),
  };
}

// ---------- HTTP helpers ----------
async function tg(method: string, params: any = {}) {
  const token = getToken();
  if (!token) throw new Error('Telegram token chưa cấu hình');
  try {
    const r = await axios.post(`${API(token)}/${method}`, params, { timeout: 35000 });
    return r.data;
  } catch (e: any) {
    const msg = e?.response?.data?.description || e?.message;
    throw new Error(`Telegram ${method}: ${msg}`);
  }
}

async function sendMessage(chatId: string | number, text: string, extra: any = {}) {
  // Telegram giới hạn 4096 chars/msg
  const body = text.length > 4000 ? text.slice(0, 3990) + '\n...(cắt)' : text;
  return tg('sendMessage', {
    chat_id: chatId,
    text: body,
    parse_mode: 'Markdown',
    disable_web_page_preview: true,
    ...extra,
  });
}

// ---------- Auth ----------
function upsertChat(chatId: string, username?: string, firstName?: string) {
  const now = Date.now();
  db.prepare(
    `INSERT INTO telegram_chats (chat_id, username, first_name, authorized, notify, created_at, last_seen)
     VALUES (?, ?, ?, 0, 1, ?, ?)
     ON CONFLICT(chat_id) DO UPDATE SET
       username = COALESCE(excluded.username, username),
       first_name = COALESCE(excluded.first_name, first_name),
       last_seen = excluded.last_seen`
  ).run(chatId, username || null, firstName || null, now, now);
}

function getChat(chatId: string): ChatRow | undefined {
  return db.prepare(`SELECT chat_id, authorized, notify FROM telegram_chats WHERE chat_id = ?`)
    .get(chatId) as ChatRow | undefined;
}

function isAuthorized(chatId: string): boolean {
  const row = getChat(chatId);
  return !!row && row.authorized === 1;
}

function authorize(chatId: string) {
  db.prepare(`UPDATE telegram_chats SET authorized = 1 WHERE chat_id = ?`).run(chatId);
}

// ---------- Command handlers ----------
const HELP = `*📱 vp-marketing Bot*

_Trước khi dùng:_ \`/unlock <code>\`

*Lệnh có sẵn:*
• \`/pages\` — danh sách fanpage
• \`/caption <chủ đề>\` — AI viết caption (dùng Wiki)
• \`/post <page_id>|<chủ đề>\` — gen + đăng vào giờ vàng
• \`/publish <page_id>|<text>\` — đăng text NGAY
• \`/stats\` — báo cáo 30 ngày
• \`/besttime\` — khung giờ vàng
• \`/wiki <chủ đề>\` — preview Wiki context
• \`/booking <nội dung>\` — cập nhật phòng trống
• \`/notify on|off\` — bật/tắt thông báo
• \`/whoami\` — xem chat ID
• \`/help\` — menu này`;

async function handleCommand(chatId: string, text: string, from: any) {
  const [cmdRaw, ...rest] = text.trim().split(/\s+/);
  const cmd = cmdRaw.toLowerCase().replace(/@\w+$/, ''); // strip /cmd@botname
  const arg = rest.join(' ');

  // Lệnh không cần auth
  if (cmd === '/start') {
    return sendMessage(
      chatId,
      `Xin chào ${from?.first_name || ''}! 👋\n\nĐây là bot điều khiển *vp-marketing*.\n\nĐể dùng, bạn cần unlock:\n\`/unlock <mã>\`\n\nMã unlock do admin thiết lập trong tab Cấu hình → Telegram.`
    );
  }

  if (cmd === '/whoami') {
    const row = getChat(chatId);
    return sendMessage(
      chatId,
      `*Chat ID:* \`${chatId}\`\n*Authorized:* ${row?.authorized ? '✅' : '❌'}\n*Notify:* ${row?.notify ? 'ON' : 'OFF'}`
    );
  }

  if (cmd === '/unlock') {
    const code = getSetting('telegram_unlock_code');
    if (!code) return sendMessage(chatId, '❌ Admin chưa đặt mã unlock. Vào vp-marketing → Cấu hình → Telegram để set.');
    if (arg.trim() === code) {
      authorize(chatId);
      return sendMessage(chatId, `✅ Đã unlock! Gõ /help để xem danh sách lệnh.`);
    }
    return sendMessage(chatId, '❌ Mã sai.');
  }

  // Các lệnh còn lại cần auth
  if (!isAuthorized(chatId)) {
    return sendMessage(chatId, '🔒 Chưa unlock. Dùng `/unlock <mã>` trước.');
  }

  try {
    switch (cmd) {
      case '/help':
        return sendMessage(chatId, HELP);

      case '/pages': {
        const pages = db.prepare(`SELECT id, name, fb_page_id FROM pages ORDER BY id`).all() as any[];
        if (!pages.length) return sendMessage(chatId, '📭 Chưa có fanpage nào. Thêm trong tab Cấu hình.');
        const lines = pages.map((p) => `• *${p.id}* — ${p.name} \`(${p.fb_page_id})\``);
        return sendMessage(chatId, `*Fanpages:*\n${lines.join('\n')}`);
      }

      case '/caption': {
        if (!arg) return sendMessage(chatId, 'Cú pháp: `/caption <chủ đề>`');
        await sendMessage(chatId, '✍️ Đang viết caption...');
        const caption = await generateCaption(arg);
        return sendMessage(chatId, `📝 *Caption cho "${arg}":*\n\n${caption}`);
      }

      case '/post': {
        // /post <page_id>|<topic>
        const parts = arg.split('|').map((s) => s.trim());
        if (parts.length < 2) return sendMessage(chatId, 'Cú pháp: `/post <page_id>|<chủ đề>`\nVD: `/post 1|Combo Đà Lạt cuối tuần`');
        const pageId = parseInt(parts[0], 10);
        const topic = parts.slice(1).join('|');
        const page = db.prepare(`SELECT id, name FROM pages WHERE id = ?`).get(pageId) as any;
        if (!page) return sendMessage(chatId, `❌ Không tìm thấy page id=${pageId}. Dùng /pages xem list.`);

        await sendMessage(chatId, `✍️ Đang viết caption cho "${topic}"...`);
        const caption = await generateCaption(topic);

        // Smart slot
        const bt = getBestPostingTime(60);
        const now = new Date();
        const slot = new Date(now);
        slot.setMinutes(0, 0, 0);
        slot.setHours(bt.best_hour?.hour ?? 9);
        if (slot.getTime() <= now.getTime() + 5 * 60_000) slot.setDate(slot.getDate() + 1);

        const r = db.prepare(
          `INSERT INTO posts (page_id, caption, media_type, status, scheduled_at, created_at)
           VALUES (?, ?, 'none', 'scheduled', ?, ?)`
        ).run(pageId, caption, slot.getTime(), Date.now());

        return sendMessage(
          chatId,
          `✅ Đã lên lịch post #${r.lastInsertRowid}\n*Trang:* ${page.name}\n*Thời gian:* ${slot.toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })}\n\n${caption}`
        );
      }

      case '/publish': {
        const parts = arg.split('|').map((s) => s.trim());
        if (parts.length < 2) return sendMessage(chatId, 'Cú pháp: `/publish <page_id>|<text>`');
        const pageId = parseInt(parts[0], 10);
        const content = parts.slice(1).join('|');
        const page = db.prepare(`SELECT id, name, fb_page_id, access_token FROM pages WHERE id = ?`).get(pageId) as any;
        if (!page) return sendMessage(chatId, `❌ Không tìm thấy page id=${pageId}`);

        await sendMessage(chatId, `🚀 Đang đăng lên ${page.name}...`);
        try {
          const result = await publishText(page.fb_page_id, page.access_token, content);
          const r = db.prepare(
            `INSERT INTO posts (page_id, caption, media_type, status, scheduled_at, published_at, fb_post_id, created_at)
             VALUES (?, ?, 'none', 'published', ?, ?, ?, ?)`
          ).run(pageId, content, Date.now(), Date.now(), result.fbPostId, Date.now());
          return sendMessage(chatId, `✅ Đã đăng! Post #${r.lastInsertRowid} → \`${result.fbPostId}\``);
        } catch (e: any) {
          return sendMessage(chatId, `❌ Lỗi đăng: ${e?.message || e}`);
        }
      }

      case '/stats': {
        const ov = getOverview(30) as any;
        const rate = ((ov.avg_engagement_rate || 0) * 100).toFixed(2);
        return sendMessage(
          chatId,
          `*📊 30 ngày gần nhất*\n\n• Tổng bài: *${ov.total_posts || 0}*\n• Reach: *${(ov.total_reach || 0).toLocaleString()}*\n• Tương tác: *${(ov.total_engagement || 0).toLocaleString()}*\n• Avg engagement: *${rate}%*`
        );
      }

      case '/besttime': {
        const bt = getBestPostingTime(60);
        if (!bt.total_samples) return sendMessage(chatId, 'Chưa đủ dữ liệu (cần 5-10 post có metric).');
        const dow = ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'];
        return sendMessage(
          chatId,
          `*⏰ Giờ vàng* (60 ngày, ${bt.total_samples} bài)\n\n• Giờ: *${String(bt.best_hour!.hour).padStart(2, '0')}:00* — ${(bt.best_hour!.avg_score * 100).toFixed(2)}%\n• Thứ: *${dow[bt.best_dow!.dow]}* — ${(bt.best_dow!.avg_score * 100).toFixed(2)}%`
        );
      }

      case '/wiki': {
        if (!arg) {
          const stats = getWikiStats();
          return sendMessage(chatId, `*Wiki stats:* ${stats.total} entries, ${stats.embedded} có embedding`);
        }
        const ctx = await buildContext(arg, 3500);
        return sendMessage(chatId, ctx ? `*Wiki cho "${arg}":*\n\n${ctx}` : '(Không có match nào)');
      }

      case '/booking': {
        if (!arg) return sendMessage(chatId, 'Cú pháp: `/booking <nội dung>`');
        const r = await syncBooking({ content: arg, source: 'telegram' });
        return sendMessage(chatId, `✅ Đã cập nhật booking (entry #${r.id}, ${r.content_length} ký tự).`);
      }

      case '/notify': {
        const v = arg.trim().toLowerCase();
        if (v !== 'on' && v !== 'off') return sendMessage(chatId, 'Cú pháp: `/notify on` hoặc `/notify off`');
        db.prepare(`UPDATE telegram_chats SET notify = ? WHERE chat_id = ?`).run(v === 'on' ? 1 : 0, chatId);
        return sendMessage(chatId, `🔔 Notify ${v.toUpperCase()}`);
      }

      default:
        return sendMessage(chatId, `Lệnh không rõ: \`${cmd}\`\nGõ /help`);
    }
  } catch (e: any) {
    console.error('[telegram] handler error:', e);
    return sendMessage(chatId, `❌ Lỗi: ${e?.message || e}`);
  }
}

async function handleUpdate(u: TelegramUpdate) {
  const msg = u.message;
  if (!msg || !msg.text) return;
  const chatId = String(msg.chat.id);
  upsertChat(chatId, msg.from?.username, msg.from?.first_name);
  if (msg.text.startsWith('/')) {
    await handleCommand(chatId, msg.text, msg.from);
  }
}

// ---------- Long polling loop ----------
async function pollLoop() {
  if (!running) return;
  const token = getToken();
  if (!token) {
    pollTimer = setTimeout(pollLoop, 10000);
    return;
  }
  try {
    const r = await axios.get(`${API(token)}/getUpdates`, {
      params: { offset, timeout: 25 },
      timeout: 35000,
    });
    const updates: TelegramUpdate[] = r.data?.result || [];
    for (const u of updates) {
      offset = u.update_id + 1;
      handleUpdate(u).catch((e) => console.error('[telegram] update err:', e));
    }
    pollTimer = setTimeout(pollLoop, 100);
  } catch (e: any) {
    const status = e?.response?.status;
    if (status === 401 || status === 404) {
      console.error('[telegram] token invalid — stopping bot');
      running = false;
      return;
    }
    console.warn('[telegram] poll error:', e?.message);
    pollTimer = setTimeout(pollLoop, 5000);
  }
}

export function startBot() {
  if (running) return;
  const token = getToken();
  if (!token) {
    console.log('[telegram] chưa có token, skip');
    return;
  }
  running = true;
  console.log('[telegram] bot starting (long-poll)');
  // Verify token
  tg('getMe')
    .then((r) => {
      console.log(`[telegram] bot live: @${r?.result?.username}`);
      pollLoop();
    })
    .catch((e) => {
      console.error('[telegram] getMe fail:', e.message);
      running = false;
    });
}

export function stopBot() {
  running = false;
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = null;
}

/**
 * Notification cho các chat đã authorized + bật notify.
 */
export async function notifyAll(text: string) {
  if (!getToken()) return;
  const chats = db.prepare(
    `SELECT chat_id FROM telegram_chats WHERE authorized = 1 AND notify = 1`
  ).all() as { chat_id: string }[];
  for (const c of chats) {
    try {
      await sendMessage(c.chat_id, text);
    } catch (e: any) {
      console.warn(`[telegram] notify ${c.chat_id} fail:`, e?.message);
    }
  }
}

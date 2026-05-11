/**
 * Telegram bot — minimal version for admin alerts only.
 *
 * After pivot (2026-05-11): FB chat auto-reply was removed. Telegram bot now only
 * handles system notifications (post published, errors, V5T pipeline events).
 *
 * Removed: /caption, /post, /publish, /stats, /besttime, /wiki, /booking, /bookings,
 *          /confirm, /reject, /rooms, /seo (will add when SEO module ready).
 * Kept:    /start, /help, /unlock, /whoami, /pause, /resume + notifyAll() + notifyAdmin()
 */

import axios from 'axios';
import { db, getSetting } from '../db';

const API = 'https://api.telegram.org';

function getToken(): string | null {
  return getSetting('telegram_bot_token') || process.env.TELEGRAM_BOT_TOKEN || null;
}

function getUnlockCode(): string {
  return getSetting('telegram_unlock_code') || 'sonder2024';
}

async function sendMessage(chatId: string | number, text: string, parseMode: 'Markdown' | 'HTML' | undefined = 'Markdown'): Promise<void> {
  const token = getToken();
  if (!token) return;
  try {
    await axios.post(`${API}/bot${token}/sendMessage`, {
      chat_id: chatId,
      text: text.slice(0, 4000),
      parse_mode: parseMode,
      disable_web_page_preview: true,
    }, { timeout: 10_000 });
  } catch (e: any) {
    console.warn(`[telegram] sendMessage ${chatId} fail:`, e?.response?.data?.description || e?.message);
  }
}

function isAuthorized(chatId: number): boolean {
  const row = db.prepare(
    `SELECT authorized FROM telegram_chats WHERE chat_id = ?`
  ).get(String(chatId)) as { authorized: number } | undefined;
  return !!row?.authorized;
}

function authorizeChat(chatId: number, username: string, firstName: string): void {
  db.prepare(
    `INSERT OR REPLACE INTO telegram_chats (chat_id, username, first_name, authorized, notify, created_at, last_seen_at)
     VALUES (?, ?, ?, 1, 1, COALESCE((SELECT created_at FROM telegram_chats WHERE chat_id = ?), ?), ?)`
  ).run(String(chatId), username || '', firstName || '', String(chatId), Date.now(), Date.now());
}

function updateLastSeen(chatId: number): void {
  db.prepare(`UPDATE telegram_chats SET last_seen_at = ? WHERE chat_id = ?`).run(Date.now(), String(chatId));
}

/* ───────── Long-poll bot loop ───────── */

let lastUpdateId = 0;
let polling = false;

async function pollUpdates(): Promise<void> {
  if (polling) return;
  const token = getToken();
  if (!token) return;
  polling = true;
  try {
    const r = await axios.get(`${API}/bot${token}/getUpdates`, {
      params: { offset: lastUpdateId + 1, timeout: 25, limit: 50 },
      timeout: 30_000,
    });
    const updates: any[] = r.data?.result || [];
    for (const u of updates) {
      lastUpdateId = u.update_id;
      try {
        await handleMessage(u.message || u.edited_message || {});
      } catch (e: any) {
        console.warn('[telegram] handle msg fail:', e?.message);
      }
    }
  } catch (e: any) {
    if (!String(e?.message || '').includes('timeout')) {
      console.warn('[telegram] poll fail:', e?.response?.data?.description || e?.message);
    }
  } finally {
    polling = false;
  }
}

async function handleMessage(msg: any): Promise<void> {
  if (!msg?.chat?.id || !msg?.text) return;
  const chatId = msg.chat.id;
  const text = String(msg.text).trim();
  const username = msg.from?.username || '';
  const firstName = msg.from?.first_name || '';

  updateLastSeen(chatId);

  // /start — public welcome
  if (text === '/start' || text === '/help') {
    const authd = isAuthorized(chatId);
    const lines = [
      '🤖 *VP Marketing — Admin Bot*',
      '',
      authd ? '✅ Đã unlock.' : '🔒 Chưa unlock. Gõ: `/unlock <code>`',
      '',
      '*Lệnh:*',
      '/start, /help — show this',
      '/whoami — chat ID + username',
      '/unlock <code> — unlock admin features',
      authd ? '/pause — pause all notifications' : '',
      authd ? '/resume — resume notifications' : '',
      '',
      '_Sau khi unlock, bot sẽ tự push:_',
      '• Post publish thành công/fail',
      '• V5T pipeline events (gen/render/publish)',
      '• System errors',
    ].filter(Boolean).join('\n');
    await sendMessage(chatId, lines);
    return;
  }

  // /whoami
  if (text === '/whoami') {
    await sendMessage(chatId, `*Chat ID:* \`${chatId}\`\n*Username:* @${username || 'n/a'}\n*Auth:* ${isAuthorized(chatId) ? '✅' : '🔒'}`);
    return;
  }

  // /unlock <code>
  if (text.startsWith('/unlock')) {
    const code = text.slice(7).trim();
    if (code === getUnlockCode()) {
      authorizeChat(chatId, username, firstName);
      await sendMessage(chatId, `✅ Unlocked. Bot sẽ push alerts tới chat này.`);
    } else {
      await sendMessage(chatId, `❌ Sai code.`);
    }
    return;
  }

  // Authorization gate for anything below
  if (!isAuthorized(chatId)) {
    await sendMessage(chatId, `🔒 Cần unlock trước. /unlock <code>`);
    return;
  }

  // /pause + /resume
  if (text === '/pause') {
    db.prepare(`UPDATE telegram_chats SET notify = 0 WHERE chat_id = ?`).run(String(chatId));
    await sendMessage(chatId, `🔕 Đã tắt notifications.`);
    return;
  }
  if (text === '/resume') {
    db.prepare(`UPDATE telegram_chats SET notify = 1 WHERE chat_id = ?`).run(String(chatId));
    await sendMessage(chatId, `🔔 Đã bật notifications.`);
    return;
  }

  // Unknown command
  await sendMessage(chatId, `❓ Lệnh không hiểu. Gõ /help để xem danh sách.`);
}

/* ───────── Public API ───────── */

export function startBot(): void {
  const token = getToken();
  if (!token) {
    console.log('[telegram] no token configured, bot disabled');
    return;
  }
  console.log('[telegram] bot starting (long-poll)');
  setInterval(() => { pollUpdates().catch(() => {}); }, 1_000);
  console.log('[telegram] bot live');
}

/** Push to ONE authorized admin chat (by setting 'admin_telegram_chat_id'), else broadcast. */
export async function notifyAdmin(text: string): Promise<void> {
  if (!getToken()) return;
  const row = db.prepare(`SELECT value FROM settings WHERE key = 'admin_telegram_chat_id'`).get() as
    | { value: string } | undefined;
  const chatId = row?.value?.trim();
  if (chatId) {
    try {
      await sendMessage(chatId, text);
      return;
    } catch (e: any) {
      console.warn('[telegram] notifyAdmin fail:', e?.message);
    }
  }
  return notifyAll(text);
}

/** Broadcast to all authorized chats that have notify=1. */
export async function notifyAll(text: string): Promise<void> {
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

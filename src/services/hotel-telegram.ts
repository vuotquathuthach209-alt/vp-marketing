import axios from 'axios';
import { db } from '../db';

/**
 * Sprint 9 — Per-hotel Telegram Bot
 *
 * Each hotel (page) has its own Telegram bot token + group ID.
 * Notifications go to hotel's own group, not the global admin bot.
 * Global bot remains for system admin commands.
 */

const API = (token: string) => `https://api.telegram.org/bot${token}`;

export interface HotelTelegramConfig {
  page_id: number;
  telegram_bot_token: string | null;
  telegram_group_id: string | null;
  bot_username: string | null;
  enabled: number;
  unlock_code: string | null;
}

// ---------- CRUD ----------

export function getHotelTelegramConfig(pageId: number): HotelTelegramConfig | null {
  return db.prepare(
    `SELECT page_id, telegram_bot_token, telegram_group_id, bot_username, enabled, unlock_code
     FROM hotel_telegram_config WHERE page_id = ?`
  ).get(pageId) as HotelTelegramConfig | null;
}

export function saveHotelTelegramConfig(
  pageId: number,
  token: string | null,
  groupId: string | null,
  unlockCode?: string
) {
  const now = Date.now();
  db.prepare(
    `INSERT INTO hotel_telegram_config (page_id, telegram_bot_token, telegram_group_id, enabled, unlock_code, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(page_id) DO UPDATE SET
       telegram_bot_token = excluded.telegram_bot_token,
       telegram_group_id = excluded.telegram_group_id,
       unlock_code = COALESCE(excluded.unlock_code, unlock_code),
       updated_at = excluded.updated_at`
  ).run(pageId, token, groupId, token ? 1 : 0, unlockCode || null, now, now);
}

export function setHotelBotUsername(pageId: number, username: string) {
  db.prepare(`UPDATE hotel_telegram_config SET bot_username = ?, updated_at = ? WHERE page_id = ?`)
    .run(username, Date.now(), pageId);
}

export function toggleHotelTelegram(pageId: number, enabled: boolean) {
  db.prepare(`UPDATE hotel_telegram_config SET enabled = ?, updated_at = ? WHERE page_id = ?`)
    .run(enabled ? 1 : 0, Date.now(), pageId);
}

export function deleteHotelTelegramConfig(pageId: number) {
  db.prepare(`DELETE FROM hotel_telegram_config WHERE page_id = ?`).run(pageId);
}

// ---------- Send messages via hotel's own bot ----------

async function hotelTg(token: string, method: string, params: any = {}) {
  try {
    const r = await axios.post(`${API(token)}/${method}`, params, { timeout: 15000 });
    return r.data;
  } catch (e: any) {
    const msg = e?.response?.data?.description || e?.message;
    throw new Error(`Hotel Telegram ${method}: ${msg}`);
  }
}

/** Send message via hotel's own bot to hotel's group */
export async function notifyHotel(pageId: number, text: string) {
  const cfg = getHotelTelegramConfig(pageId);
  if (!cfg || !cfg.enabled || !cfg.telegram_bot_token || !cfg.telegram_group_id) {
    console.log(`[hotel-tg] page ${pageId}: no telegram config, skip notify`);
    return false;
  }
  try {
    const body = text.length > 4000 ? text.slice(0, 3990) + '\n...(cắt)' : text;
    await hotelTg(cfg.telegram_bot_token, 'sendMessage', {
      chat_id: cfg.telegram_group_id,
      text: body,
      parse_mode: 'Markdown',
      disable_web_page_preview: true,
    });
    return true;
  } catch (e: any) {
    console.error(`[hotel-tg] notify page ${pageId} failed:`, e.message);
    return false;
  }
}

/** Send photo via hotel's own bot */
export async function notifyHotelPhoto(pageId: number, photoUrl: string, caption?: string) {
  const cfg = getHotelTelegramConfig(pageId);
  if (!cfg || !cfg.enabled || !cfg.telegram_bot_token || !cfg.telegram_group_id) return false;
  try {
    await hotelTg(cfg.telegram_bot_token, 'sendPhoto', {
      chat_id: cfg.telegram_group_id,
      photo: photoUrl,
      caption: caption ? (caption.length > 1000 ? caption.slice(0, 990) + '...' : caption) : undefined,
      parse_mode: 'Markdown',
    });
    return true;
  } catch (e: any) {
    console.error(`[hotel-tg] photo page ${pageId} failed:`, e.message);
    return false;
  }
}

/** Verify a hotel's telegram bot token — returns bot username or throws */
export async function verifyHotelBot(token: string): Promise<string> {
  const r = await hotelTg(token, 'getMe');
  return r?.result?.username || 'unknown';
}

/** Get all hotel telegram configs */
export function getAllHotelTelegramConfigs(): (HotelTelegramConfig & { page_name: string })[] {
  return db.prepare(
    `SELECT h.*, p.name as page_name
     FROM hotel_telegram_config h
     JOIN pages p ON p.id = h.page_id
     ORDER BY h.page_id`
  ).all() as any[];
}

/**
 * Smart notify — tries hotel-specific bot first, falls back to global bot.
 * Used by booking flow, auto-reply etc.
 */
export async function notifyHotelOrGlobal(pageId: number, text: string) {
  const sent = await notifyHotel(pageId, text);
  if (!sent) {
    // Fallback to global bot
    const { notifyAll } = await import('./telegram');
    await notifyAll(text);
  }
}

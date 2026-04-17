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
    const r = await axios.post(
      'https://openapi.zalo.me/v3.0/oa/message/cs',
      {
        recipient: { user_id: userId },
        message: { text: text.slice(0, 2000) },
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

/** Verify webhook signature (Zalo mac header). */
export function verifyZaloSignature(appSecret: string, timestamp: string, body: string, mac: string): boolean {
  if (!appSecret || !mac) return false;
  const expected = crypto.createHmac('sha256', appSecret)
    .update(appSecret + body + timestamp)
    .digest('hex');
  return expected === mac;
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

/**
 * Guest Memory Service — lưu trí nhớ khách qua các phiên chat
 *
 * Mục tiêu: khách quay lại lần 2, 3… bot nhớ tên / số / sở thích → trải nghiệm
 * "người thật" thay vì "bot". Lưu ít, inject ngắn gọn vào prompt.
 */

import { db } from '../db';

export interface GuestProfile {
  id: number;
  hotel_id: number;
  fb_user_id: string | null;
  phone: string | null;
  name: string | null;
  language: string;
  first_seen: number;
  last_seen: number;
  total_conversations: number;
  booked_count: number;
  preferences: string; // JSON
}

/** Upsert theo (hotel_id, fb_user_id). Tự tăng total_conversations nếu last_seen > 6h. */
export function upsertGuest(
  hotelId: number,
  fbUserId: string,
  patch: { name?: string; phone?: string; language?: string; prefs?: Record<string, any> } = {}
): GuestProfile | null {
  if (!fbUserId) return null;
  const now = Date.now();
  const existing = db.prepare(
    `SELECT * FROM guest_profiles WHERE hotel_id = ? AND fb_user_id = ?`
  ).get(hotelId, fbUserId) as GuestProfile | undefined;

  if (!existing) {
    const prefs = JSON.stringify(patch.prefs || {});
    db.prepare(
      `INSERT INTO guest_profiles
       (hotel_id, fb_user_id, name, phone, language, first_seen, last_seen, total_conversations, booked_count, preferences)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, 0, ?)`
    ).run(hotelId, fbUserId, patch.name || null, patch.phone || null, patch.language || 'vi', now, now, prefs);
    return getGuest(hotelId, fbUserId);
  }

  // Update: only fill non-null fields, merge prefs, bump conversation count if idle > 6h
  const idle6h = now - existing.last_seen > 6 * 60 * 60 * 1000;
  let mergedPrefs = existing.preferences;
  if (patch.prefs && Object.keys(patch.prefs).length) {
    try {
      const old = JSON.parse(existing.preferences || '{}');
      mergedPrefs = JSON.stringify({ ...old, ...patch.prefs });
    } catch { mergedPrefs = JSON.stringify(patch.prefs); }
  }

  db.prepare(
    `UPDATE guest_profiles SET
       name = COALESCE(?, name),
       phone = COALESCE(?, phone),
       language = COALESCE(?, language),
       last_seen = ?,
       total_conversations = total_conversations + ?,
       preferences = ?
     WHERE id = ?`
  ).run(
    patch.name || null,
    patch.phone || null,
    patch.language || null,
    now,
    idle6h ? 1 : 0,
    mergedPrefs,
    existing.id
  );

  return getGuest(hotelId, fbUserId);
}

export function getGuest(hotelId: number, fbUserId: string): GuestProfile | null {
  return (db.prepare(
    `SELECT * FROM guest_profiles WHERE hotel_id = ? AND fb_user_id = ?`
  ).get(hotelId, fbUserId) as GuestProfile) || null;
}

/**
 * Sinh snippet ngắn để inject vào system prompt. Ví dụ:
 *   "Khách quen: Anh Tuấn (SĐT: 0909xxx), đã liên hệ 3 lần, thích phòng view biển."
 * Empty string nếu không có dữ liệu đáng kể.
 */
export function getGuestMemorySnippet(hotelId: number, fbUserId: string): string {
  const g = getGuest(hotelId, fbUserId);
  if (!g) return '';
  const parts: string[] = [];
  if (g.total_conversations >= 2) parts.push(`khách quen (liên hệ lần ${g.total_conversations + 1})`);
  if (g.name) parts.push(`tên: ${g.name}`);
  if (g.phone) parts.push(`SĐT: ${g.phone}`);
  if (g.booked_count > 0) parts.push(`đã đặt ${g.booked_count} lần`);
  try {
    const prefs = JSON.parse(g.preferences || '{}');
    const keys = Object.keys(prefs);
    if (keys.length) {
      const summary = keys.slice(0, 3).map(k => `${k}: ${prefs[k]}`).join(', ');
      parts.push(`sở thích: ${summary}`);
    }
  } catch {}
  if (parts.length === 0) return '';
  return `[THÔNG TIN KHÁCH]: ${parts.join('; ')}. Dùng tên khách khi chào, tránh hỏi lại info đã có.`;
}

/** Đánh dấu khách đã book thành công (gọi khi booking flow complete). */
export function markGuestBooked(hotelId: number, fbUserId: string) {
  db.prepare(
    `UPDATE guest_profiles SET booked_count = booked_count + 1, last_seen = ? WHERE hotel_id = ? AND fb_user_id = ?`
  ).run(Date.now(), hotelId, fbUserId);
}

/**
 * Kill-switch cho bot per-hotel.
 *  - `bot_paused_until` trong mkt_hotels (epoch ms). Nếu > now → bot im lặng.
 *  - KS bấm Pause 1h / đến sáng mai / vô hạn.
 */
import { db } from '../db';

export function isBotPaused(hotelId: number): { paused: boolean; until?: number; reason?: string } {
  const row = db.prepare(
    `SELECT bot_paused_until AS until_ts, bot_pause_reason AS reason FROM mkt_hotels WHERE id = ?`
  ).get(hotelId) as { until_ts: number | null; reason: string | null } | undefined;
  if (!row || !row.until_ts) return { paused: false };
  if (row.until_ts > Date.now()) return { paused: true, until: row.until_ts, reason: row.reason || undefined };
  return { paused: false };
}

export function pauseBot(hotelId: number, minutes: number, reason?: string): number {
  const until = minutes >= 0 ? Date.now() + minutes * 60_000 : Date.now() + 365 * 24 * 3600_000; // -1 = vô hạn
  db.prepare(`UPDATE mkt_hotels SET bot_paused_until = ?, bot_pause_reason = ? WHERE id = ?`)
    .run(until, reason || null, hotelId);
  return until;
}

export function resumeBot(hotelId: number): void {
  db.prepare(`UPDATE mkt_hotels SET bot_paused_until = NULL, bot_pause_reason = NULL WHERE id = ?`).run(hotelId);
}

import { db } from '../db';
import { embed, encodeEmbedding, EMBED_MODEL } from './embedder';

/**
 * Booking data sync — dữ liệu phòng trống / occupancy / khuyến mãi real-time.
 * Được push vào bằng POST /api/analytics/booking/sync (từ Google Sheet webhook,
 * Zapier, Make, hoặc cron tự viết). Nội dung sẽ ghi đè vào
 * knowledge_wiki namespace='business' slug='availability', always_inject=1
 * để AI dùng trong mọi caption.
 */

export interface BookingSnapshot {
  // Free-form nội dung — user có thể push bất cứ markdown nào
  content?: string;
  // Hoặc structured: hệ thống sẽ tự format
  available_rooms?: Record<string, number>; // { "Deluxe": 3, "Suite": 1 }
  occupancy_rate?: number; // 0-1
  check_in_range?: string; // "15-17/04"
  promo_note?: string;
  source?: string;
}

function formatSnapshot(s: BookingSnapshot): string {
  if (s.content && s.content.trim()) return s.content.trim();

  const lines: string[] = [];
  lines.push(`Cập nhật lúc: ${new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })}`);
  if (s.occupancy_rate !== undefined) {
    lines.push(`- Tỷ lệ lấp đầy hiện tại: ${Math.round(s.occupancy_rate * 100)}%`);
  }
  if (s.available_rooms) {
    const parts = Object.entries(s.available_rooms).map(([k, v]) => `${k}: còn ${v} phòng`);
    if (parts.length) lines.push(`- Phòng còn trống: ${parts.join(', ')}`);
  }
  if (s.check_in_range) lines.push(`- Khoảng check-in: ${s.check_in_range}`);
  if (s.promo_note) lines.push(`- Ghi chú khuyến mãi: ${s.promo_note}`);
  if (s.source) lines.push(`\n(Nguồn: ${s.source})`);
  return lines.join('\n');
}

export async function syncBooking(snapshot: BookingSnapshot) {
  const content = formatSnapshot(snapshot);
  const title = 'Tình trạng phòng & khuyến mãi (real-time)';
  const slug = 'availability';
  const namespace = 'business';
  const now = Date.now();

  const existing = db
    .prepare(`SELECT id FROM knowledge_wiki WHERE namespace = ? AND slug = ?`)
    .get(namespace, slug) as { id: number } | undefined;

  let id: number;
  if (existing) {
    db.prepare(
      `UPDATE knowledge_wiki SET title = ?, content = ?, always_inject = 1, active = 1, updated_at = ?
       WHERE id = ?`
    ).run(title, content, now, existing.id);
    id = existing.id;
  } else {
    const r = db
      .prepare(
        `INSERT INTO knowledge_wiki
         (namespace, slug, title, content, tags, always_inject, active, updated_at, created_at)
         VALUES (?, ?, ?, ?, '["booking","availability","promo"]', 1, 1, ?, ?)`
      )
      .run(namespace, slug, title, content, now, now);
    id = Number(r.lastInsertRowid);
  }

  // Re-embed
  try {
    const vec = await embed(`${title}\n${content}`);
    if (vec) {
      db.prepare(`UPDATE knowledge_wiki SET embedding = ?, embedding_model = ? WHERE id = ?`).run(
        encodeEmbedding(vec),
        EMBED_MODEL,
        id
      );
    }
  } catch (e: any) {
    console.warn('[booking] embed fail:', e?.message);
  }

  return { id, content_length: content.length };
}

export function getLatestBooking() {
  return db
    .prepare(
      `SELECT id, title, content, updated_at FROM knowledge_wiki
       WHERE namespace = 'business' AND slug = 'availability'`
    )
    .get();
}

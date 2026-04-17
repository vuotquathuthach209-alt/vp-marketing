/**
 * Billing Renewal Reminder — check hàng ngày, nhắc khi plan sắp hết hạn.
 *
 * Chiến lược: gửi notify admin cho các KS sắp hết hạn ở các mốc D-7, D-3, D-1, D-0.
 * Mỗi mốc chỉ gửi 1 lần (dedupe qua bảng billing_reminder_log).
 */

import { db } from '../db';
import { notifyAdmin } from './telegram';

// Ensure log table (one-time migration)
db.exec(`
CREATE TABLE IF NOT EXISTS billing_reminder_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hotel_id INTEGER NOT NULL,
  milestone TEXT NOT NULL,   -- 'D-7' | 'D-3' | 'D-1' | 'D-0' | 'expired'
  sent_at INTEGER NOT NULL,
  UNIQUE(hotel_id, milestone)
);
`);

const MILESTONES = [
  { key: 'D-7', days: 7 },
  { key: 'D-3', days: 3 },
  { key: 'D-1', days: 1 },
  { key: 'D-0', days: 0 },
] as const;

export async function runBillingReminders(): Promise<{ sent: number; expired_newly: number }> {
  const now = Date.now();
  const DAY = 24 * 60 * 60 * 1000;

  const hotels = db.prepare(
    `SELECT id, name, plan, plan_expires_at FROM mkt_hotels
     WHERE plan_expires_at IS NOT NULL AND plan != 'free' AND status = 'active'`
  ).all() as { id: number; name: string; plan: string; plan_expires_at: number }[];

  let sent = 0;
  let expiredNewly = 0;

  const logStmt = db.prepare(
    `INSERT OR IGNORE INTO billing_reminder_log (hotel_id, milestone, sent_at) VALUES (?, ?, ?)`
  );
  const loggedStmt = db.prepare(
    `SELECT 1 FROM billing_reminder_log WHERE hotel_id = ? AND milestone = ?`
  );

  for (const h of hotels) {
    const daysLeft = Math.ceil((h.plan_expires_at - now) / DAY);

    // Sắp hết hạn — các mốc nhắc
    for (const m of MILESTONES) {
      if (daysLeft === m.days && !loggedStmt.get(h.id, m.key)) {
        try {
          await notifyAdmin(
            `🔔 *Nhắc gia hạn* — ${m.key}\n` +
            `Hotel #${h.id} (${h.name})\n` +
            `Gói: *${h.plan}* còn ${daysLeft} ngày\n` +
            `Hết hạn: ${new Date(h.plan_expires_at).toLocaleDateString('vi-VN')}`
          );
          logStmt.run(h.id, m.key, now);
          sent++;
        } catch (e: any) {
          console.warn(`[billing] notify fail hotel #${h.id}:`, e?.message);
        }
      }
    }

    // Đã hết hạn → downgrade về free, notify 1 lần
    if (daysLeft < 0 && !loggedStmt.get(h.id, 'expired')) {
      try {
        db.prepare(
          `UPDATE mkt_hotels SET plan = 'free', status = 'expired', updated_at = ? WHERE id = ?`
        ).run(now, h.id);
        await notifyAdmin(
          `⛔ *Gói đã hết hạn* — Hotel #${h.id} (${h.name})\n` +
          `Đã tự động hạ xuống Free. Liên hệ KS để gia hạn.`
        );
        logStmt.run(h.id, 'expired', now);
        expiredNewly++;
      } catch (e: any) {
        console.warn(`[billing] expire fail hotel #${h.id}:`, e?.message);
      }
    }
  }

  return { sent, expired_newly: expiredNewly };
}

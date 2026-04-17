/**
 * Lightweight event tracking — funnel + growth analytics.
 * Thay vì GA/Mixpanel, tự lưu sqlite cho đơn giản + privacy.
 *
 * Ví dụ events:
 *   pricing_view, plan_selected, proof_submitted, plan_approved,
 *   onboarding_step_done, bot_reply_sent, bot_rated_good/bad, churned
 */
import { db } from '../db';

db.exec(`
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hotel_id INTEGER,
  user_id INTEGER,
  event_name TEXT NOT NULL,
  meta TEXT,            -- JSON
  ip TEXT,
  ua TEXT,
  ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_name_ts ON events(event_name, ts);
CREATE INDEX IF NOT EXISTS idx_events_hotel_ts ON events(hotel_id, ts);
`);

export function trackEvent(opts: {
  event: string;
  hotelId?: number | null;
  userId?: number | null;
  meta?: any;
  ip?: string;
  ua?: string;
}): void {
  try {
    db.prepare(
      `INSERT INTO events (hotel_id, user_id, event_name, meta, ip, ua, ts) VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      opts.hotelId ?? null,
      opts.userId ?? null,
      opts.event,
      opts.meta ? JSON.stringify(opts.meta).slice(0, 2000) : null,
      opts.ip || null,
      opts.ua ? opts.ua.slice(0, 200) : null,
      Date.now()
    );
  } catch (e: any) {
    console.error('[events] track fail:', e?.message);
  }
}

/** Funnel: đếm distinct hotel_id / session đạt mỗi step trong khoảng thời gian. */
export function funnel(steps: string[], sinceMs: number): Array<{ step: string; count: number; pct_of_first: number }> {
  const counts: number[] = steps.map(step => {
    const r = db.prepare(
      `SELECT COUNT(DISTINCT COALESCE(hotel_id, ip)) AS n
       FROM events WHERE event_name = ? AND ts >= ?`
    ).get(step, sinceMs) as { n: number };
    return r.n || 0;
  });
  const first = counts[0] || 1;
  return steps.map((step, i) => ({
    step,
    count: counts[i],
    pct_of_first: Math.round((counts[i] / first) * 1000) / 10,
  }));
}

export function topEvents(sinceMs: number, limit = 20): Array<{ event: string; count: number }> {
  return db.prepare(
    `SELECT event_name AS event, COUNT(*) AS count
     FROM events WHERE ts >= ? GROUP BY event_name ORDER BY count DESC LIMIT ?`
  ).all(sinceMs, limit) as any;
}

/**
 * Auto-Handoff Safety Net
 *
 * Khi bot không resolve sau N turn (low confidence / frustrated liên tục),
 * tự động kích hoạt handoff để không mất khách.
 *
 * Rules trigger:
 *   A. 2 lượt liên tiếp bot có intent='unclear' hoặc confidence<0.5
 *   B. 2 lượt user thể hiện frustrated/angry
 *   C. 4+ turn user không vào được booking và không có câu hỏi rõ ràng
 *
 * Output: { trigger: bool, reason: string }
 * Dispatcher sẽ gọi handleHandoff() khi trigger=true.
 *
 * Cooldown: đã handoff 1 lần thì không trigger lại trong 30 phút cùng sender.
 */
import { db } from '../db';
import { Emotion, Intent, RouterOutput } from './intent-router';

const HANDOFF_COOLDOWN_MS = 30 * 60 * 1000;

// Init tracker table (per-sender rolling counters)
db.exec(`
CREATE TABLE IF NOT EXISTS handoff_tracker (
  sender_id TEXT NOT NULL,
  page_id INTEGER NOT NULL DEFAULT 0,
  low_conf_streak INTEGER NOT NULL DEFAULT 0,
  frustrated_streak INTEGER NOT NULL DEFAULT 0,
  total_turns INTEGER NOT NULL DEFAULT 0,
  last_handoff_at INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (sender_id, page_id)
);
`);

interface TrackerRow {
  low_conf_streak: number;
  frustrated_streak: number;
  total_turns: number;
  last_handoff_at: number | null;
}

function getTracker(senderId: string, pageId: number): TrackerRow {
  const row = db.prepare(
    `SELECT low_conf_streak, frustrated_streak, total_turns, last_handoff_at
     FROM handoff_tracker WHERE sender_id = ? AND page_id = ?`
  ).get(senderId, pageId) as TrackerRow | undefined;
  return row || { low_conf_streak: 0, frustrated_streak: 0, total_turns: 0, last_handoff_at: null };
}

function upsertTracker(senderId: string, pageId: number, updates: Partial<TrackerRow>): void {
  const current = getTracker(senderId, pageId);
  const merged = { ...current, ...updates };
  db.prepare(
    `INSERT INTO handoff_tracker (sender_id, page_id, low_conf_streak, frustrated_streak, total_turns, last_handoff_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(sender_id, page_id) DO UPDATE SET
       low_conf_streak = excluded.low_conf_streak,
       frustrated_streak = excluded.frustrated_streak,
       total_turns = excluded.total_turns,
       last_handoff_at = excluded.last_handoff_at,
       updated_at = excluded.updated_at`
  ).run(senderId, pageId, merged.low_conf_streak, merged.frustrated_streak, merged.total_turns, merged.last_handoff_at, Date.now());
}

export interface HandoffDecision {
  trigger: boolean;
  reason?: string;
}

/**
 * Gọi mỗi lượt — update counters + check trigger.
 * Trả về trigger=true khi cần handoff.
 */
export function updateAndCheck(opts: {
  senderId: string;
  pageId: number;
  ro: RouterOutput;
  bookingCreated?: boolean;
}): HandoffDecision {
  const { senderId, pageId, ro, bookingCreated } = opts;
  const t = getTracker(senderId, pageId);

  // Cooldown: đã handoff gần đây → không trigger nữa
  if (t.last_handoff_at && Date.now() - t.last_handoff_at < HANDOFF_COOLDOWN_MS) {
    upsertTracker(senderId, pageId, { total_turns: t.total_turns + 1 });
    return { trigger: false };
  }

  const isLowConf = ro.intent === 'unclear' || ro.confidence < 0.5;
  const isFrustrated: boolean = ro.emotion === 'frustrated' || ro.emotion === 'angry';

  const next: Partial<TrackerRow> = {
    total_turns: t.total_turns + 1,
    low_conf_streak: isLowConf ? t.low_conf_streak + 1 : 0,
    frustrated_streak: isFrustrated ? t.frustrated_streak + 1 : 0,
  };

  // Rule A: 2 lượt liên tiếp unclear / low conf
  if ((next.low_conf_streak || 0) >= 2) {
    upsertTracker(senderId, pageId, { ...next, last_handoff_at: Date.now() });
    return { trigger: true, reason: 'low_conf_streak_2' };
  }
  // Rule B: 2 lượt frustrated/angry
  if ((next.frustrated_streak || 0) >= 2) {
    upsertTracker(senderId, pageId, { ...next, last_handoff_at: Date.now() });
    return { trigger: true, reason: 'frustrated_streak_2' };
  }
  // Rule C: 5+ turn tổng mà không có booking + không có câu hỏi rõ ràng
  if ((next.total_turns || 0) >= 5 && !bookingCreated && ro.intent === 'unclear') {
    upsertTracker(senderId, pageId, { ...next, last_handoff_at: Date.now() });
    return { trigger: true, reason: 'stalled_conversation' };
  }

  upsertTracker(senderId, pageId, next);
  return { trigger: false };
}

/** Reset counters khi user đạt mục tiêu (vào booking, phản hồi tích cực) */
export function resetTracker(senderId: string, pageId: number): void {
  upsertTracker(senderId, pageId, { low_conf_streak: 0, frustrated_streak: 0, total_turns: 0 });
}

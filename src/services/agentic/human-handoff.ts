/**
 * Human Handoff — v27 Agentic Bot
 *
 * Khi bot quyết định escalate sang nhân viên thật:
 *   1. Render handoff template (với hotline)
 *   2. Notify Telegram staff với context đầy đủ
 *   3. Mark bot_conversation_state.handed_off = 1 (pause bot)
 *   4. Log vào handoff_log table
 *
 * Triggers:
 *   - User explicitly asks: "gặp nhân viên", "cho em gặp staff"
 *   - Safety guard: confidence < 0.3 AND data not available
 *   - Stuck: same_stage_count >= 3
 *   - Turn >= 6 AND slot_completeness < 0.4
 */

import { db } from '../../db';

const HOTLINE = '0348 644 833';

// Auto-create handoff_log table nếu chưa có
db.exec(`
CREATE TABLE IF NOT EXISTS handoff_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sender_id TEXT NOT NULL,
  hotel_id INTEGER,
  trigger_reason TEXT NOT NULL,       -- 'user_request' | 'safety_low_conf' | 'stuck_turns' | 'slow_progress'
  confidence_score REAL,
  context_json TEXT,                  -- last 5 msg + slots snapshot
  handled_at INTEGER,                 -- khi nào staff take over
  handled_by TEXT,                    -- staff user_id
  status TEXT DEFAULT 'pending',      -- 'pending' | 'taken' | 'resolved' | 'timeout'
  telegram_msg_id TEXT,               -- Telegram message ID
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_handoff_status ON handoff_log(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_handoff_sender ON handoff_log(sender_id);
`);

export interface HandoffContext {
  sender_id: string;
  hotel_id?: number;
  customer_name?: string;
  customer_phone?: string;
  trigger_reason: 'user_request' | 'safety_low_conf' | 'stuck_turns' | 'slow_progress' | 'data_not_found';
  confidence_score?: number;
  last_message: string;
  slots?: any;
  history?: Array<{ role: string; message: string }>;
}

/**
 * Main handoff entry.
 */
export async function executeHandoff(ctx: HandoffContext): Promise<{
  ok: boolean;
  log_id: number;
  telegram_sent: boolean;
  bot_paused: boolean;
}> {
  const now = Date.now();

  // 1. Insert log
  const logResult = db.prepare(`
    INSERT INTO handoff_log
      (sender_id, hotel_id, trigger_reason, confidence_score, context_json, status, created_at)
    VALUES (?, ?, ?, ?, ?, 'pending', ?)
  `).run(
    ctx.sender_id,
    ctx.hotel_id || null,
    ctx.trigger_reason,
    ctx.confidence_score || null,
    JSON.stringify({
      last_message: ctx.last_message,
      slots: ctx.slots || {},
      history: (ctx.history || []).slice(-5),
      customer_name: ctx.customer_name,
      customer_phone: ctx.customer_phone,
    }),
    now,
  );
  const logId = Number(logResult.lastInsertRowid);

  // 2. Mark bot paused for this sender
  let botPaused = false;
  try {
    const { markHandedOff } = require('../conversation-fsm');
    markHandedOff(ctx.sender_id);
    botPaused = true;
  } catch (e: any) {
    console.warn('[handoff] mark bot paused fail:', e?.message);
  }

  // 3. Notify Telegram
  let tgSent = false;
  try {
    const channel = ctx.sender_id.startsWith('zalo:') ? '🔵 Zalo' : '📘 Facebook';
    const reasonMap: Record<string, string> = {
      user_request: '🙋 Khách chủ động yêu cầu',
      safety_low_conf: '⚠️ Bot không chắc chắn (safety)',
      stuck_turns: '🔁 Bot loop, không tiến triển',
      slow_progress: '⏳ Chậm tiến triển (turn 6+ chưa xong)',
      data_not_found: '❌ Data không có trong hệ thống',
    };

    const slotSummary = ctx.slots ? Object.entries(ctx.slots)
      .filter(([k, v]) => v != null && v !== '' && !['shown_property_ids'].includes(k))
      .map(([k, v]) => `${k}=${JSON.stringify(v).slice(0, 40)}`)
      .join('\n') : '(no slots)';

    const historyLog = (ctx.history || []).slice(-5).map(h =>
      `${h.role === 'user' ? '👤' : '🤖'} ${h.message.slice(0, 100)}`
    ).join('\n');

    const tgMsg =
      `🆘 *BOT HANDOFF — cần nhân viên hỗ trợ*\n\n` +
      `${channel} Sender: \`${ctx.sender_id}\`\n` +
      `${ctx.customer_name ? `Tên: ${ctx.customer_name}\n` : ''}` +
      `${ctx.customer_phone ? `SĐT: ${ctx.customer_phone}\n` : ''}` +
      `Lý do: ${reasonMap[ctx.trigger_reason] || ctx.trigger_reason}\n` +
      `${ctx.confidence_score !== undefined ? `Confidence: ${(ctx.confidence_score * 100).toFixed(0)}%\n` : ''}` +
      `\n*Câu hỏi gần nhất:*\n"${ctx.last_message.slice(0, 200)}"\n` +
      `\n*Slots đã có:*\n\`\`\`\n${slotSummary}\n\`\`\`\n` +
      `\n*5 turn gần nhất:*\n${historyLog || '(none)'}\n` +
      `\n⏱ Handoff ID: #${logId} — cần reply trong 5 phút.`;

    const { notifyAll } = require('../telegram');
    await notifyAll(tgMsg).catch((e: any) => console.warn('[handoff] tg notify fail:', e?.message));
    tgSent = true;
  } catch (e: any) {
    console.warn('[handoff] telegram fail:', e?.message);
  }

  console.log(`[handoff] executed log=${logId} sender=${ctx.sender_id} reason=${ctx.trigger_reason} tg=${tgSent} paused=${botPaused}`);
  return { ok: true, log_id: logId, telegram_sent: tgSent, bot_paused: botPaused };
}

/**
 * Admin: staff mark handoff as taken.
 */
export function markHandoffTaken(logId: number, staffId: string): boolean {
  try {
    const r = db.prepare(
      `UPDATE handoff_log SET status = 'taken', handled_at = ?, handled_by = ? WHERE id = ?`
    ).run(Date.now(), staffId, logId);
    return r.changes > 0;
  } catch { return false; }
}

/**
 * Admin: resume bot cho sender sau khi staff xử lý xong.
 */
export function resumeBotAfterHandoff(senderId: string, logId?: number): boolean {
  try {
    const { resumeBot } = require('../conversation-fsm');
    resumeBot(senderId);
    if (logId) {
      db.prepare(`UPDATE handoff_log SET status = 'resolved' WHERE id = ?`).run(logId);
    }
    console.log(`[handoff] bot resumed for ${senderId}`);
    return true;
  } catch (e: any) {
    console.warn('[handoff] resume fail:', e?.message);
    return false;
  }
}

/**
 * List pending handoffs (admin view).
 */
export function listPendingHandoffs(limit: number = 50): any[] {
  return db.prepare(
    `SELECT * FROM handoff_log WHERE status = 'pending' ORDER BY created_at DESC LIMIT ?`
  ).all(limit) as any[];
}

/**
 * Handoff stats (last 30 days).
 */
export function getHandoffStats(days: number = 30): any {
  const cutoff = Date.now() - days * 24 * 3600_000;
  const stats = db.prepare(`
    SELECT trigger_reason, status, COUNT(*) as n
    FROM handoff_log
    WHERE created_at > ?
    GROUP BY trigger_reason, status
  `).all(cutoff);
  const total = (db.prepare(`SELECT COUNT(*) as n FROM handoff_log WHERE created_at > ?`).get(cutoff) as any).n;
  return { total, days, breakdown: stats };
}

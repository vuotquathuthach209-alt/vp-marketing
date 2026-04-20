/**
 * Stalled Lead Re-engagement
 *
 * Cron chạy hàng giờ. Tìm khách "ngủ quên" giữa flow booking
 * (đã qualified nhưng chưa deposit), gửi 1 follow-up khuyến khích.
 *
 * Tuân thủ Facebook 24h window:
 *   - CHỈ gửi khi user message gần nhất < 24h
 *   - Mỗi sender chỉ nhận 1 stalled message per conversation (dedupe)
 *   - Log event 'stalled_reengage_sent' cho funnel
 *
 * Chiến lược:
 *   A. Stalled 2-6h sau qualified (chưa booking_created):
 *      → nhắc nhẹ "còn giữ chỗ giùm anh/chị không?"
 *   B. Stalled 6-12h sau booking_created (chưa deposit):
 *      → đề nghị hỗ trợ + tier-aware offer
 *   C. VIP/frequent → ưu đãi 5-10%
 *
 * Respect kill-switch: isBotPaused() → skip hotel này.
 */
import { db } from '../db';
import axios from 'axios';
import { trackEvent } from './events';

const GRAPH = 'https://graph.facebook.com/v19.0';

// Trạng thái booking cần re-engage
const STALLED_STATUSES = ['collecting', 'paused', 'quoting'] as const;

// Tránh gửi quá nhiều — cooldown 24h per sender
const REENGAGE_COOLDOWN_MS = 24 * 3600 * 1000;

// Chỉ gửi trong window 24h từ tin nhắn gần nhất của user
const FB_24H_WINDOW_MS = 24 * 3600 * 1000;

// Min stall time trước khi re-engage
const MIN_STALL_MS_QUOTING = 4 * 3600 * 1000;       // 4h sau quoting (chưa deposit)
const MIN_STALL_MS_COLLECTING = 2 * 3600 * 1000;    // 2h sau qualified (chưa booking_created)
const MAX_STALL_MS = 23 * 3600 * 1000;              // cận trên FB 24h

interface StalledCandidate {
  booking_id: number;
  sender_id: string;
  page_id: number;
  page_access_token: string;
  hotel_id: number;
  booking_status: string;
  nights: number;
  room_type: string | null;
  total_price: number;
  last_user_msg_at: number;
  stall_duration_ms: number;
}

function getCandidates(): StalledCandidate[] {
  const now = Date.now();

  // Lấy booking stalled + last user message từ conversation_memory
  const rows = db.prepare(`
    SELECT
      b.id AS booking_id,
      b.fb_sender_id AS sender_id,
      b.status AS booking_status,
      b.nights,
      b.room_type,
      b.total_price,
      b.updated_at AS booking_updated_at,
      (SELECT MAX(created_at) FROM conversation_memory
        WHERE sender_id = b.fb_sender_id AND role = 'user') AS last_user_msg_at,
      p.id AS page_id,
      p.access_token AS page_access_token,
      p.hotel_id
    FROM pending_bookings b
    LEFT JOIN pages p ON p.hotel_id = 1
    WHERE b.status IN ('collecting', 'paused', 'quoting')
      AND b.updated_at < ?
  `).all(now - MIN_STALL_MS_COLLECTING) as any[];

  const candidates: StalledCandidate[] = [];
  for (const r of rows) {
    if (!r.page_id || !r.page_access_token || !r.last_user_msg_at) continue;

    const stallMs = now - r.last_user_msg_at;
    const minStall = r.booking_status === 'quoting' ? MIN_STALL_MS_QUOTING : MIN_STALL_MS_COLLECTING;

    // Out of FB 24h window → skip
    if (stallMs > MAX_STALL_MS) continue;
    if (stallMs < minStall) continue;

    // Cooldown check
    const recent = db.prepare(
      `SELECT id FROM events WHERE event_name = 'stalled_reengage_sent'
       AND json_extract(meta, '$.sender_id') = ? AND ts > ?`
    ).get(r.sender_id, now - REENGAGE_COOLDOWN_MS);
    if (recent) continue;

    candidates.push({
      booking_id: r.booking_id,
      sender_id: r.sender_id,
      page_id: r.page_id,
      page_access_token: r.page_access_token,
      hotel_id: r.hotel_id || 1,
      booking_status: r.booking_status,
      nights: r.nights || 1,
      room_type: r.room_type,
      total_price: r.total_price || 0,
      last_user_msg_at: r.last_user_msg_at,
      stall_duration_ms: stallMs,
    });
  }

  return candidates;
}

function composeMessage(c: StalledCandidate): string {
  const hours = Math.round(c.stall_duration_ms / 3600000);
  let tier = 'new';
  try {
    const { classifyCustomer } = require('./customer-tier');
    const info = classifyCustomer({ senderId: c.sender_id, hotelId: c.hotel_id });
    if (info?.tier) tier = info.tier;
  } catch {}

  if (c.booking_status === 'quoting') {
    // Đã có báo giá, chờ deposit
    const discount = tier === 'vip' ? 10 : tier === 'frequent' ? 7 : 5;
    return `Chào anh/chị 😊 Em thấy mình đã có báo giá phòng ${c.room_type || ''} cách đây ${hours} giờ nhưng chưa chuyển khoản ạ.\n\n` +
      `Bên em vẫn đang giữ chỗ cho anh/chị. Nếu chốt trong hôm nay, em tặng giảm ${discount}% tổng đơn ạ 🎁\n\n` +
      `Anh/chị cần em hỗ trợ thêm gì không ạ?`;
  }
  // collecting / paused
  return `Chào anh/chị ạ 😊 Em còn giữ suất phòng cho mình đây. Anh/chị cần em tư vấn thêm thông tin gì để chốt đơn không ạ?\n\n` +
    `${tier === 'vip' || tier === 'frequent' ? '💎 Khách quen bên em chốt hôm nay sẽ được ưu đãi đặc biệt ạ.' : '✨ Em có thể hỗ trợ check phòng trống ngay nếu mình biết ngày ạ.'}`;
}

export interface ReengagementStats {
  found: number;
  sent: number;
  skipped_bot_paused: number;
  errors: number;
}

async function sendFBMessage(pageToken: string, senderId: string, text: string): Promise<boolean> {
  try {
    await axios.post(
      `${GRAPH}/me/messages`,
      {
        recipient: { id: senderId },
        message: { text },
        messaging_type: 'RESPONSE', // trong 24h window, RESPONSE là OK
      },
      { params: { access_token: pageToken }, timeout: 15000 },
    );
    return true;
  } catch (e: any) {
    console.warn('[stalled-lead] FB send fail:', e?.response?.data?.error?.message || e.message);
    return false;
  }
}

export async function runReengagement(): Promise<ReengagementStats> {
  const stats: ReengagementStats = { found: 0, sent: 0, skipped_bot_paused: 0, errors: 0 };
  const candidates = getCandidates();
  stats.found = candidates.length;

  for (const c of candidates) {
    // Kill-switch check
    try {
      const { isBotPaused } = require('./bot-control');
      const p = isBotPaused(c.hotel_id);
      if (p.paused) { stats.skipped_bot_paused++; continue; }
    } catch {}

    const msg = composeMessage(c);
    const ok = await sendFBMessage(c.page_access_token, c.sender_id, msg);

    if (ok) {
      stats.sent++;
      try {
        trackEvent({
          event: 'stalled_reengage_sent',
          hotelId: c.hotel_id,
          meta: {
            sender_id: c.sender_id,
            booking_id: c.booking_id,
            page_id: c.page_id,
            booking_status: c.booking_status,
            stall_hours: Math.round(c.stall_duration_ms / 3600000),
          },
        });
      } catch {}

      // Lưu vào conversation_memory để bot sau này biết đã nhắc
      try {
        db.prepare(
          `INSERT INTO conversation_memory (sender_id, page_id, role, message, intent, created_at)
           VALUES (?, ?, 'bot', ?, 'stalled_reengage', ?)`
        ).run(c.sender_id, c.page_id, msg, Date.now());
      } catch {}
    } else {
      stats.errors++;
    }
  }

  if (stats.found > 0) {
    console.log(`[stalled-lead] found=${stats.found} sent=${stats.sent} paused=${stats.skipped_bot_paused} err=${stats.errors}`);
  }
  return stats;
}

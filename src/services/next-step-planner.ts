/**
 * Next-Step Planner
 *
 * Sau khi bot trả lời, thêm 1 câu hỏi / CTA chủ động để dẫn dắt hội thoại.
 * Mục tiêu: tăng engagement, giảm số lần user phải chủ động hỏi tiếp.
 *
 * Nguyên tắc:
 *  - KHÔNG thêm nếu bot đã có câu hỏi rồi (tránh đặt 2 câu hỏi).
 *  - KHÔNG thêm nếu user đang frustrated/angry (để họ yên).
 *  - KHÔNG thêm khi intent=goodbye/complaint/handoff.
 *  - CHỈ thêm khi có "gap" thực sự — missing slot hoặc chưa xác nhận.
 *
 * Triển khai rule-based — nhanh, deterministic, không tốn LLM.
 */
import { RouterOutput, RouterSlots } from './intent-router';

const SKIP_INTENTS = new Set(['goodbye', 'complaint', 'handoff_request', 'booking_action', 'booking_info']);

function replyEndsWithQuestion(reply: string): boolean {
  const trimmed = reply.trim();
  if (trimmed.endsWith('?')) return true;
  if (/\b(ạ|nhé|không|nhỉ|chưa|hay)\s*[\?\!\.]?\s*$/i.test(trimmed)) return true;
  // VN subtle questions
  if (/\bcần (em|mình) (tư vấn|hỗ trợ|check|chốt)\b/i.test(trimmed)) return true;
  return false;
}

/** CTA cho từng intent, có rotation để không lặp */
const CTA_BY_INTENT: Record<string, string[]> = {
  location_q: [
    'Anh/chị định đi ngày nào em check phòng trống nhé ạ?',
    'Anh/chị có cần em tư vấn phòng phù hợp cho chuyến này không ạ?',
    'Nếu anh/chị chốt được ngày thì em gửi giá tốt nhất cho anh/chị luôn ạ 😊',
  ],
  amenity_q: [
    'Anh/chị định ở bao nhiêu đêm để em tư vấn phòng phù hợp ạ?',
    'Anh/chị cần phòng cho mấy khách ạ?',
  ],
  policy_q: [
    'Anh/chị còn câu hỏi nào về chính sách không ạ?',
    'Nếu anh/chị muốn đặt phòng, em có thể hỗ trợ ngay ạ 😊',
  ],
  price_q: [
    'Anh/chị định đi ngày nào ạ? Em check giá chính xác cho anh/chị.',
    'Anh/chị có ngân sách cụ thể không ạ, em tư vấn phòng phù hợp nhé.',
  ],
  small_talk: [], // không CTA cho small talk
};

export function appendNextStep(opts: {
  reply: string;
  ro: RouterOutput;
  bookingState?: string | null;
  historyTail: string[];
}): string {
  const { reply, ro, bookingState, historyTail } = opts;

  if (!reply || reply.length < 10) return reply;
  if (SKIP_INTENTS.has(ro.intent)) return reply;
  if (ro.emotion === 'angry' || ro.emotion === 'frustrated') return reply;

  // Đã có câu hỏi trong reply → không thêm
  if (replyEndsWithQuestion(reply)) return reply;

  // Nếu booking đang active với đủ info → không thêm
  if (bookingState === 'quoting' || bookingState === 'awaiting_transfer') return reply;

  // Nếu 2 lần gần nhất bot đã hỏi mà user không trả lời → không hỏi nữa
  const recentBotMsgs = historyTail.filter(h => h.startsWith('Bot:')).slice(-2);
  const twoQuestionsInRow = recentBotMsgs.length >= 2 && recentBotMsgs.every(m => m.includes('?'));
  if (twoQuestionsInRow) return reply;

  const ctas = CTA_BY_INTENT[ro.intent];
  if (!ctas || ctas.length === 0) return reply;

  const cta = ctas[Math.floor(Math.random() * ctas.length)];
  // Nếu reply đã kết thúc bằng dấu câu thì đi xuống dòng; nếu không thì thêm dấu chấm
  const sep = /[.!?😊🙏❤️🌸🎉]$/u.test(reply.trim()) ? '\n\n' : '.\n\n';
  return reply.trim() + sep + cta;
}

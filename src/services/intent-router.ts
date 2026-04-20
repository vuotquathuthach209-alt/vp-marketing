/**
 * Intent-First Orchestrator — Turn classifier
 *
 * MỖI lượt tin nhắn đi qua đây TRƯỚC khi chạm FSM/RAG.
 * Ra quyết định: cần gọi BookingFSM, hay Objection Handler, hay RAG, hay handoff?
 *
 * Output JSON strict → dispatcher dùng routing deterministic.
 *
 * Nguyên tắc:
 *  - Không state-hijack: dù user đang ở booking FSM, nếu intent mới ≠ booking
 *    và confidence cao, route sang handler tương ứng (FSM pause, không mất data).
 *  - Fallback rule-based nếu Gemini fail.
 *  - Latency target: ~60-80ms.
 */
import { generate } from './router';

export type Intent =
  | 'booking_action'     // đặt phòng: "đặt 20/4 deluxe", "ok", "đồng ý"
  | 'booking_info'       // cung cấp slot: "20/4 2 đêm 2 khách"
  | 'price_objection'    // than đắt / xin giảm: "mắc thế", "giảm 10%"
  | 'location_q'         // hỏi vị trí: "ở đâu", "xa sân bay ko"
  | 'amenity_q'          // hỏi tiện nghi: "có bếp ko", "wifi ok ko"
  | 'price_q'            // hỏi giá: "bao nhiêu tiền", "rẻ hơn ko"
  | 'policy_q'           // hỏi chính sách: "check-in mấy giờ", "hủy được ko"
  | 'small_talk'         // chào, cảm ơn, alo
  | 'complaint'          // khiếu nại: "tệ quá", "ko ok"
  | 'goodbye'            // tạm biệt
  | 'handoff_request'    // xin gặp nhân viên
  | 'unclear';           // không đủ tự tin

export type Emotion = 'neutral' | 'frustrated' | 'excited' | 'hesitant' | 'angry';

export interface RouterSlots {
  date?: string;          // "20/4" | "mai" | "cuối tuần"
  room_type?: string;     // "deluxe" | "standard" | "twin"
  nights?: number;
  guests?: number;
  phone?: string;
  price_limit?: number;   // "dưới 300k" → 300000
}

export interface RouterOutput {
  intent: Intent;
  confidence: number;     // 0..1
  slots: RouterSlots;
  emotion: Emotion;
  is_continuation: boolean; // tiếp nối booking flow trước?
  reasoning?: string;       // chỉ log, không dùng để route
  source: 'llm' | 'rule';   // thống kê
}

const INTENTS_DESC = `
- booking_action: xác nhận đặt phòng / đồng ý / "ok, đặt luôn"
- booking_info: đang cung cấp ngày/loại phòng/số đêm để đặt (không phải hỏi)
- price_objection: than đắt, xin giảm, so sánh với chỗ khác, "mắc thế", "sao đắt vậy"
- location_q: hỏi vị trí, địa chỉ, khoảng cách, bản đồ
- amenity_q: hỏi tiện nghi (wifi, bếp, máy lạnh, giặt là, ăn sáng, bể bơi)
- price_q: hỏi giá chung, "bao nhiêu", "giá", "có phòng rẻ hơn"
- policy_q: hỏi check-in/out, hủy phòng, cọc, pet, trẻ em, thanh toán
- small_talk: chào, cảm ơn, alo, emoji không rõ ý, "ngủ dậy chưa"
- complaint: phàn nàn, khiếu nại, không hài lòng
- goodbye: tạm biệt, chốt câu chuyện "thôi nhé", "hẹn sau"
- handoff_request: "cho gặp nhân viên", "nói chuyện với người thật"
- unclear: câu quá mơ hồ, không đủ tự tin phân loại
`;

const EMOTIONS_DESC = `neutral | frustrated (khó chịu, ngập ngừng) | excited (hứng thú, nhiệt tình) | hesitant (do dự, phân vân) | angry (giận)`;

function buildPrompt(message: string, historyTail: string[], bookingState?: string | null): { system: string; user: string } {
  const system = `Bạn là classifier nhanh cho chatbot khách sạn Việt Nam. Trả về JSON đúng schema, KHÔNG văn bản thừa.

INTENTS:
${INTENTS_DESC}

EMOTIONS: ${EMOTIONS_DESC}

SLOTS (chỉ điền nếu có trong message):
- date: "20/4" | "mai" | "cuối tuần" | "tối nay"
- room_type: standard | deluxe | twin | double | family | suite
- nights: số nguyên (đêm)
- guests: số nguyên (khách)
- phone: 10-11 chữ số VN
- price_limit: số VND max khách muốn (VD "dưới 300k" → 300000)

SCHEMA (strict):
{"intent":"<enum>","confidence":<0..1>,"slots":{...},"emotion":"<enum>","is_continuation":<bool>,"reasoning":"<1 câu>"}

NGUYÊN TẮC:
- confidence cao (>0.8) chỉ khi rất rõ ràng. Mơ hồ → 0.3-0.5 + intent=unclear.
- is_continuation=true nếu user đang trả lời tiếp câu hỏi của bot về booking.
- "Mắc thế" = price_objection, KHÔNG phải booking_info.
- "Có phòng dưới 300k ko" = price_q (có price_limit=300000), KHÔNG phải booking_action.
- "Alo", "Ngủ dậy chưa" = small_talk.
- Tin nhắn chứa ngày (20/4) + loại phòng = booking_info với confidence>0.85.`;

  const historyStr = historyTail.length > 0
    ? `Lịch sử (mới nhất dưới):\n${historyTail.map((h, i) => `${i + 1}. ${h}`).join('\n')}\n\n`
    : '';
  const stateStr = bookingState ? `Trạng thái booking hiện tại: ${bookingState}\n\n` : '';
  const user = `${historyStr}${stateStr}Tin nhắn khách:\n"${message}"\n\nJSON:`;
  return { system, user };
}

/**
 * Rule-based fallback — match nhanh cho trường hợp đơn giản.
 * Dùng khi Gemini lỗi hoặc để double-check.
 */
function ruleBasedClassify(message: string): RouterOutput {
  const m = message.toLowerCase().trim();
  const slots: RouterSlots = {};

  // Extract slots đơn giản
  const dateMatch = m.match(/(\d{1,2})\s*[\/\-]\s*(\d{1,2})/);
  if (dateMatch) slots.date = `${dateMatch[1]}/${dateMatch[2]}`;
  const nightsMatch = m.match(/(\d+)\s*(?:đêm|ngay|ngày|night)/i);
  if (nightsMatch) slots.nights = parseInt(nightsMatch[1], 10);
  const guestsMatch = m.match(/(\d+)\s*(?:khách|người|guest|ng\b)/i);
  if (guestsMatch) slots.guests = parseInt(guestsMatch[1], 10);
  const phoneMatch = m.match(/\b(0\d{9,10})\b/);
  if (phoneMatch) slots.phone = phoneMatch[1];
  const priceMatch = m.match(/(?:dưới|<|below|max)\s*(\d+)\s*(k|nghìn|ngan|triệu|tr|m)/i);
  if (priceMatch) {
    const num = parseInt(priceMatch[1], 10);
    const unit = priceMatch[2].toLowerCase();
    slots.price_limit = ['k', 'nghìn', 'ngan'].includes(unit) ? num * 1000 : num * 1000000;
  }
  const roomMatch = m.match(/\b(standard|deluxe|twin|double|family|suite|std)\b/i);
  if (roomMatch) slots.room_type = roomMatch[1].toLowerCase() === 'std' ? 'standard' : roomMatch[1].toLowerCase();

  // Rule hierarchy
  let intent: Intent = 'unclear';
  let confidence = 0.5;

  if (m.length <= 2 || /^(alo|a lô|hi|hello|hey|u|uh|ờ|ừ)$/i.test(m)) {
    intent = 'small_talk';
    confidence = 0.9;
  } else if (/\b(bye|tạm biệt|hẹn gặp|ok nhé thôi)\b/i.test(m)) {
    intent = 'goodbye';
    confidence = 0.85;
  } else if (/\b(gặp nhân viên|người thật|cho gặp (chị|anh|người)|nói chuyện với)\b/i.test(m)) {
    intent = 'handoff_request';
    confidence = 0.9;
  } else if (/\b(mắc|đắt|sao đắt|giá cao|đắt quá|mắc thế|bớt|giảm giá|discount|rẻ hơn)\b/i.test(m)) {
    intent = 'price_objection';
    confidence = 0.85;
  } else if (/\b(tệ|kém|dở|thất vọng|lừa đảo|khiếu nại|không ok)\b/i.test(m)) {
    intent = 'complaint';
    confidence = 0.8;
  } else if (slots.price_limit || /\b(bao nhiêu|giá|price|rẻ nhất)\b/i.test(m)) {
    intent = 'price_q';
    confidence = 0.8;
  } else if (/\b(ở đâu|địa chỉ|đường|map|bản đồ|xa (sân bay|trung tâm)|gần (sân bay|biển|trung tâm))\b/i.test(m)) {
    intent = 'location_q';
    confidence = 0.85;
  } else if (/\b(check.?in|check.?out|cọc|hủy phòng|hoàn tiền|thanh toán|pet|trẻ em|chính sách)\b/i.test(m)) {
    intent = 'policy_q';
    confidence = 0.8;
  } else if (/\b(wifi|máy lạnh|điều hòa|bếp|giặt|bể bơi|ăn sáng|đồ ăn|tiện nghi|có (gì|chỗ))\b/i.test(m)) {
    intent = 'amenity_q';
    confidence = 0.75;
  } else if (/\b(ok|đặt|đồng ý|xác nhận|book|chuyển|yes|có)\b/i.test(m) && m.length <= 20) {
    intent = 'booking_action';
    confidence = 0.75;
  } else if (slots.date || slots.room_type || slots.nights) {
    intent = 'booking_info';
    confidence = 0.7;
  } else if (m.endsWith('?')) {
    intent = 'unclear';
    confidence = 0.4;
  }

  return {
    intent,
    confidence,
    slots,
    emotion: /(mắc|tệ|dở|thất vọng|kém)/i.test(m) ? 'frustrated' : 'neutral',
    is_continuation: false,
    reasoning: 'rule-based',
    source: 'rule',
  };
}

export async function classifyTurn(ctx: {
  message: string;
  historyTail?: string[];
  bookingState?: string | null;
  industry?: string;
}): Promise<RouterOutput> {
  const { message, historyTail = [], bookingState } = ctx;

  // Shortcut: very short messages → rule-based only
  if (message.trim().length <= 3) return ruleBasedClassify(message);

  // Try LLM
  try {
    const { system, user } = buildPrompt(message, historyTail, bookingState || undefined);
    const raw = await generate({ task: 'intent_gateway', system, user });
    const cleaned = raw.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    // Find first { and last }
    const s = cleaned.indexOf('{');
    const e = cleaned.lastIndexOf('}');
    if (s < 0 || e < s) throw new Error('no JSON in LLM output');
    const parsed = JSON.parse(cleaned.slice(s, e + 1)) as Partial<RouterOutput>;

    // Validate + defaults
    const intent = (parsed.intent || 'unclear') as Intent;
    const confidence = Math.max(0, Math.min(1, Number(parsed.confidence) || 0.5));
    const emotion = (parsed.emotion || 'neutral') as Emotion;
    return {
      intent,
      confidence,
      slots: (parsed.slots || {}) as RouterSlots,
      emotion,
      is_continuation: !!parsed.is_continuation,
      reasoning: parsed.reasoning || '',
      source: 'llm',
    };
  } catch (e: any) {
    // Fallback rule-based
    const fallback = ruleBasedClassify(message);
    fallback.reasoning = `llm_failed: ${String(e?.message || e).slice(0, 80)}`;
    return fallback;
  }
}

/**
 * Decide handler từ router output.
 * Deterministic — no LLM here.
 */
export type HandlerType =
  | 'booking_fsm'
  | 'objection_handler'
  | 'fast_reply'
  | 'rag_pipeline'
  | 'handoff';

export function decideHandler(ro: RouterOutput, hasActiveBookingCtx: boolean): HandlerType {
  // Handoff khi user xin hoặc complaint nặng
  if (ro.intent === 'handoff_request') return 'handoff';
  if (ro.intent === 'complaint' && ro.emotion === 'angry') return 'handoff';

  // Low confidence → handoff (tạm thời; sau này có thể dùng RAG cautious)
  if (ro.confidence < 0.4) return 'rag_pipeline'; // thử RAG, an toàn hơn handoff sớm

  // Booking flow — CHỈ khi intent rõ là booking, không phải sticky state
  if (ro.intent === 'booking_action') return 'booking_fsm';
  if (ro.intent === 'booking_info' && ro.confidence >= 0.65) return 'booking_fsm';
  if (hasActiveBookingCtx && ro.is_continuation && ro.confidence >= 0.6) return 'booking_fsm';

  // Price objection — chuyên biệt
  if (ro.intent === 'price_objection') return 'objection_handler';

  // Small talk / goodbye — fast template
  if (ro.intent === 'small_talk' || ro.intent === 'goodbye') return 'fast_reply';

  // Còn lại: RAG
  return 'rag_pipeline';
}

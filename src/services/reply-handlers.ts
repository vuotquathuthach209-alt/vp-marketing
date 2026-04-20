/**
 * Reply handlers — các chiến lược trả lời chuyên biệt theo intent.
 *
 * Được gọi từ smartreply.ts dựa vào output của intent-router.decideHandler().
 * Mỗi handler tự do dùng LLM hay template; mục tiêu: đa dạng + nhất quán.
 */
import { RouterOutput, RouterSlots } from './intent-router';
import { generate } from './router';
import { notifyAdmin } from './telegram';
import { db } from '../db';

// ──────────────────────────────────────────────────────────────
// A. Fast Reply — greeting / goodbye / small_talk
//    Không gọi LLM (tiết kiệm latency + cost), lấy template có sẵn.
// ──────────────────────────────────────────────────────────────

const GREETING_REPLIES = [
  'Dạ em chào anh/chị ạ 😊 Anh/chị cần em tư vấn gì ạ?',
  'Chào anh/chị! Em có thể giúp gì cho anh/chị hôm nay ạ?',
  'Dạ em đây ạ 😊 Anh/chị cần tìm phòng ngày nào vậy ạ?',
  'Em chào anh/chị ạ 🙌 Anh/chị cần thông tin gì em hỗ trợ nhé!',
];

const GOODBYE_REPLIES = [
  'Dạ cảm ơn anh/chị ạ! Có gì anh/chị nhắn em bất cứ lúc nào nhé ❤️',
  'Cảm ơn anh/chị! Chúc anh/chị một ngày tốt lành ạ 🌸',
  'Dạ em cảm ơn nhiều ạ! Rất mong sớm được đón anh/chị ạ 🙏',
];

const SMALL_TALK_REPLIES: Record<string, string[]> = {
  alo: [
    'Dạ em đây ạ 😊 Anh/chị cần em hỗ trợ gì ạ?',
    'Dạ em nghe ạ! Có gì em giúp được không ạ?',
  ],
  how_are_you: [
    'Dạ em vẫn ổn, cảm ơn anh/chị ạ 😊 Anh/chị cần tư vấn phòng khách sạn không ạ?',
    'Dạ em khỏe ạ 🌸 Anh/chị có kế hoạch đi chơi cuối tuần chưa ạ?',
  ],
  thanks: [
    'Dạ không có gì ạ, anh/chị cần gì thêm cứ nhắn em nhé! 🤗',
    'Dạ cảm ơn anh/chị đã quan tâm ạ ❤️',
  ],
  default: [
    'Dạ em đây ạ 😊 Anh/chị cần tư vấn gì thêm không ạ?',
    'Dạ, anh/chị có cần em hỗ trợ tìm phòng không ạ?',
  ],
};

function pickRandom<T>(arr: T[]): T { return arr[Math.floor(Math.random() * arr.length)]; }

export function fastReply(ro: RouterOutput, message: string): string {
  const m = message.toLowerCase().trim();
  if (ro.intent === 'goodbye') return pickRandom(GOODBYE_REPLIES);

  if (/\b(cảm ơn|c[aả]m ơn|thanks?|thank you|tks)\b/i.test(m)) {
    return pickRandom(SMALL_TALK_REPLIES.thanks);
  }
  if (/\b(ngủ dậy|sáng nay|khỏe|how.*are.*you|có khỏe)\b/i.test(m)) {
    return pickRandom(SMALL_TALK_REPLIES.how_are_you);
  }
  if (/^(alo|a lô|hello)/i.test(m)) {
    return pickRandom(SMALL_TALK_REPLIES.alo);
  }
  // Default greeting / tiny message
  if (m.length <= 10) return pickRandom(GREETING_REPLIES);
  return pickRandom(SMALL_TALK_REPLIES.default);
}

// ──────────────────────────────────────────────────────────────
// B. Objection Handler — chuyên xử lý "mắc thế", "giảm giá"
//    Chiến lược 4 bước: Empathy → Anchor → Alternative → Soft-close.
// ──────────────────────────────────────────────────────────────

interface ObjectionCtx {
  ro: RouterOutput;
  message: string;
  hotelId: number;
  history: string[];
  /** Rẻ nhất trong room_types (nếu biết) */
  cheapest?: { name: string; price: number };
}

export async function handleObjection(ctx: ObjectionCtx): Promise<string> {
  const { ro, message, cheapest } = ctx;
  const priceLimit = ro.slots.price_limit;

  // Build prompt cho LLM — để câu trả lời tự nhiên + đa dạng
  const strategyHint = [
    '1. Empathy: thừa nhận cảm xúc ("em hiểu ạ", "em cảm ơn chị đã thẳng thắn").',
    '2. Anchor giá trị: nhắc 1-2 điểm mạnh (vị trí, tiện nghi, dịch vụ).',
    cheapest
      ? `3. Đề xuất phòng rẻ nhất: ${cheapest.name} ${cheapest.price.toLocaleString('vi-VN')}đ.`
      : '3. Gợi ý linh hoạt: đi giữa tuần rẻ hơn, hoặc giảm 1 đêm.',
    priceLimit
      ? `4. Nếu ngân sách của khách là ${priceLimit.toLocaleString('vi-VN')}đ, nói thẳng có / không có option trong tầm giá đó.`
      : '4. Soft-close: hỏi ngân sách cụ thể để tư vấn chính xác.',
  ].join('\n');

  const system = `Bạn là trợ lý khách sạn Việt Nam, đang xử lý phản đối giá của khách.
Phong cách: thân thiện, đồng cảm, chuyên nghiệp. KHÔNG bắt ép, KHÔNG sale cứng.
Độ dài: 2-3 câu, ≤60 từ. KHÔNG dùng bullet hay markdown. KHÔNG lặp lại template "Mình cần thêm thông tin".

Chiến lược bắt buộc áp dụng theo thứ tự:
${strategyHint}`;

  const user = `Khách nhắn: "${message}"

${ctx.history.length > 0 ? `Ngữ cảnh gần đây:\n${ctx.history.slice(-3).join('\n')}\n\n` : ''}Viết 1 câu trả lời theo chiến lược trên.`;

  try {
    const reply = await generate({ task: 'reply_qwen', system, user });
    return reply.trim().slice(0, 400);
  } catch {
    // Fallback template
    if (cheapest) {
      return `Dạ em hiểu ạ 😊 Phòng ${cheapest.name} bên em hiện có giá ${cheapest.price.toLocaleString('vi-VN')}đ — đã gồm đầy đủ tiện nghi. Anh/chị muốn xem không ạ?`;
    }
    return 'Dạ em hiểu ạ. Anh/chị cho em biết ngân sách mong muốn để em tư vấn phòng phù hợp nhất nhé ạ 😊';
  }
}

// ──────────────────────────────────────────────────────────────
// C. Handoff — khi complaint angry hoặc user xin gặp người
// ──────────────────────────────────────────────────────────────

export async function handleHandoff(ctx: {
  hotelId: number;
  senderId?: string;
  senderName?: string;
  message: string;
  history: string[];
}): Promise<string> {
  // Gửi Telegram alert (qua notifyAdmin — tự route theo hotel settings)
  try {
    const summary = [
      `🚨 Cần hỗ trợ người thật (hotel #${ctx.hotelId})`,
      `Khách: ${ctx.senderName || ctx.senderId || 'ẩn danh'}`,
      `Tin nhắn: "${ctx.message}"`,
      ctx.history.length > 0 ? `Ngữ cảnh:\n${ctx.history.slice(-3).join('\n')}` : '',
    ].filter(Boolean).join('\n');
    await notifyAdmin(summary);
  } catch { /* non-fatal */ }

  return 'Dạ em đã ghi nhận và thông báo cho anh/chị quản lý. Quản lý sẽ phản hồi anh/chị trong ít phút ạ 🙏';
}

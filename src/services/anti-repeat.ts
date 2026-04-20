/**
 * Anti-Repetition Filter
 *
 * Mục tiêu: bot không lặp lại câu trả lời giống hệt (hoặc gần giống)
 * với 3 câu trước cho cùng sender — tránh cảm giác "máy móc".
 *
 * Kỹ thuật: embedding cosine similarity.
 *  - MiniLM ONNX local (đã có), ~20ms/embed.
 *  - Threshold 0.85 — trên đó coi là "trùng".
 *  - Khi trùng: gọi LLM rephrase; nếu vẫn trùng sau 2 lần → fallback template.
 *
 * Không áp dụng cho:
 *  - Booking FSM (template cố ý có cấu trúc, không phải hội thoại tự nhiên).
 *  - Trả lời rỗng.
 *  - Tin nhắn < 15 ký tự (ít có nghĩa để so sánh).
 */
import { db } from '../db';
import { embed, cosine } from './embedder';
import { generate } from './router';

const SIMILARITY_THRESHOLD = 0.85;
const MAX_REPHRASE_ATTEMPTS = 2;
const HISTORY_LOOKBACK = 3;
const STALE_MINUTES = 30; // chỉ xét bot replies trong 30 phút gần nhất

// Intent skip list — những intent có template cấu trúc, không cần chống lặp
const SKIP_INTENTS = new Set<string>([
  'booking', 'booking_info', 'booking_action', 'transfer',
  'handoff', 'bot_paused',
]);

function getRecentBotReplies(senderId: string, pageId: number, limit: number): string[] {
  const cutoff = Date.now() - STALE_MINUTES * 60 * 1000;
  const rows = db.prepare(
    `SELECT message FROM conversation_memory
     WHERE sender_id = ? AND page_id = ? AND role = 'bot' AND created_at >= ?
     ORDER BY id DESC LIMIT ?`
  ).all(senderId, pageId, cutoff, limit) as any[];
  return rows.map(r => r.message).filter(Boolean);
}

/**
 * Kiểm tra + rephrase nếu cần. Trả về reply cuối cùng (đã đa dạng hóa).
 */
export async function ensureDiverse(opts: {
  reply: string;
  senderId?: string;
  pageId: number;
  intent?: string;
  userMessage: string;
}): Promise<{ reply: string; wasRephrased: boolean; similarity?: number }> {
  const { reply, senderId, pageId, intent, userMessage } = opts;

  if (!reply || reply.length < 15) return { reply, wasRephrased: false };
  if (!senderId) return { reply, wasRephrased: false };
  if (intent && SKIP_INTENTS.has(intent)) return { reply, wasRephrased: false };

  const recent = getRecentBotReplies(senderId, pageId, HISTORY_LOOKBACK);
  if (recent.length === 0) return { reply, wasRephrased: false };

  // Embed candidate + recent
  const candidateEmb = await embed(reply);
  if (!candidateEmb) return { reply, wasRephrased: false }; // embedder unavailable → bỏ qua

  let highestSim = 0;
  for (const past of recent) {
    const pastEmb = await embed(past);
    if (!pastEmb) continue;
    const sim = cosine(candidateEmb, pastEmb);
    if (sim > highestSim) highestSim = sim;
  }

  if (highestSim <= SIMILARITY_THRESHOLD) {
    return { reply, wasRephrased: false, similarity: highestSim };
  }

  // Lặp → rephrase
  let current = reply;
  let lastSim = highestSim;
  for (let attempt = 0; attempt < MAX_REPHRASE_ATTEMPTS; attempt++) {
    try {
      const rephrased = await rephraseReply(current, userMessage, recent);
      const rEmb = await embed(rephrased);
      if (!rEmb) break;
      let newHighest = 0;
      for (const past of recent) {
        const pastEmb = await embed(past);
        if (!pastEmb) continue;
        const sim = cosine(rEmb, pastEmb);
        if (sim > newHighest) newHighest = sim;
      }
      if (newHighest <= SIMILARITY_THRESHOLD) {
        return { reply: rephrased, wasRephrased: true, similarity: newHighest };
      }
      current = rephrased;
      lastSim = newHighest;
    } catch (e) {
      break;
    }
  }

  // Vẫn trùng → thêm variation nhẹ (prepend/append) để không y hệt
  const variations = [
    'Dạ ',
    'Dạ vâng, ',
    'Em xin phép bổ sung: ',
    'Như em đã chia sẻ, ',
  ];
  const prefix = variations[Math.floor(Math.random() * variations.length)];
  return {
    reply: current.startsWith('Dạ') ? current : prefix + current,
    wasRephrased: true,
    similarity: lastSim,
  };
}

async function rephraseReply(original: string, userMessage: string, recentReplies: string[]): Promise<string> {
  const system = `Bạn là trợ lý viết lại câu trả lời chatbot khách sạn.
Nhiệm vụ: viết lại câu dưới bằng cách DIỄN ĐẠT KHÁC (dùng từ đồng nghĩa, cấu trúc câu khác, thứ tự ý đảo)
nhưng GIỮ NGUYÊN THÔNG TIN và tông thân thiện.

Quan trọng:
- KHÔNG thêm thông tin mới.
- KHÔNG bỏ thông tin quan trọng (giá, địa chỉ, số phòng).
- Độ dài tương đương.
- Tự nhiên như người Việt nói.
- CHỈ trả ra câu mới, KHÔNG giải thích.`;

  const recentStr = recentReplies.length > 0
    ? `Các câu BOT đã gửi gần đây (tránh giống):\n${recentReplies.map((r, i) => `${i + 1}. ${r.slice(0, 120)}`).join('\n')}\n\n`
    : '';

  const user = `Khách hỏi: "${userMessage}"

${recentStr}Câu gốc cần viết lại:
"${original}"

Câu mới (chỉ câu, không giải thích):`;

  // Dùng reply_qwen để rẻ; nếu Qwen offline sẽ tự fallback sang Gemini.
  const out = await generate({ task: 'reply_qwen', system, user });
  return out.trim().replace(/^["']|["']$/g, '').slice(0, 500);
}

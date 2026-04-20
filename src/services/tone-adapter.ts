/**
 * Tone Adapter
 *
 * Dịch emotion từ intent-router + tín hiệu lịch sử → directive phong cách
 * bơm vào system prompt của LLM generation.
 *
 * Inspired by ChatGPT constitution / Claude tone-shifting:
 *   - Gương cảm xúc (empathy mirror) khi khách giận/frustrated.
 *   - Giữ năng lượng tích cực khi khách hứng thú.
 *   - Giảm áp lực, mở câu hỏi khi khách do dự.
 */
import { Emotion } from './intent-router';

export interface ToneDirective {
  label: string;      // 'empathetic' | 'cheerful' | 'gentle' | 'neutral' | 'apologetic'
  directive: string;  // chỉ dẫn ghép vào system prompt
  reply_style: string; // ngắn gọn cho log
  suggested_emojis?: string[];
}

export function toneFor(emotion: Emotion, opts?: { hasComplaintHistory?: boolean; repeatedQuestion?: boolean }): ToneDirective {
  if (emotion === 'angry' || opts?.hasComplaintHistory) {
    return {
      label: 'apologetic',
      directive: `Tông giọng: XIN LỖI CHÂN THÀNH trước, không biện minh, không giải thích dài.
Câu đầu tiên PHẢI thừa nhận cảm xúc khách ("Dạ em rất xin lỗi ạ" / "Em thành thật xin lỗi anh/chị").
KHÔNG dùng emoji vui. Có thể dùng 🙏 duy nhất.
Độ dài: 2-3 câu, gọn. Kết thúc bằng đề xuất giải pháp cụ thể hoặc xin phép kết nối quản lý.`,
      reply_style: 'apologetic_short',
      suggested_emojis: ['🙏'],
    };
  }
  if (emotion === 'frustrated') {
    return {
      label: 'empathetic',
      directive: `Tông giọng: ĐỒNG CẢM trước, nhún nhường.
Câu đầu thừa nhận khó chịu của khách ("Em hiểu ạ" / "Em biết ạ").
Tránh từ ngữ bán hàng cứng. Chậm rãi, không hối thúc.
Emoji: tối đa 1 emoji nhẹ (😊 được, 🙏 được). Tuyệt đối KHÔNG 🎉 ❤️ 🔥.`,
      reply_style: 'empathetic',
      suggested_emojis: ['😊', '🙏'],
    };
  }
  if (emotion === 'excited') {
    return {
      label: 'cheerful',
      directive: `Tông giọng: NHIỆT TÌNH, hứng thú cùng khách.
Dùng emoji tích cực vừa phải (1-2): 😊 🌸 ❤️ 🎉.
Có thể gợi ý thêm dịch vụ / upsell nhẹ nhàng khi phù hợp.`,
      reply_style: 'cheerful',
      suggested_emojis: ['😊', '🌸', '❤️'],
    };
  }
  if (emotion === 'hesitant') {
    return {
      label: 'gentle',
      directive: `Tông giọng: NHẸ NHÀNG, không ép buộc.
Cho khách không gian suy nghĩ. Mở câu hỏi nhẹ ở cuối ("Anh/chị cân nhắc nhé" / "Có gì em hỗ trợ thêm").
Tránh tạo cảm giác sale-pressure. Emoji nhẹ (😊) tối đa 1.`,
      reply_style: 'gentle',
      suggested_emojis: ['😊'],
    };
  }
  return {
    label: 'neutral',
    directive: `Tông giọng: thân thiện, chuyên nghiệp. 1 emoji 😊 tối đa.`,
    reply_style: 'neutral',
    suggested_emojis: ['😊'],
  };
}

/**
 * Dò phàn nàn tích lũy trong history — nếu có ≥ 2 turn user
 * thể hiện không hài lòng thì tăng cấp độ tone.
 */
export function hasComplaintHistory(historyTail: string[]): boolean {
  const COMPLAINT_MARKERS = /(tệ|kém|chán|thất vọng|lừa|bực|dở|không ok|ko ok|khó chịu|sai|bẩn|hỏng)/i;
  let count = 0;
  for (const line of historyTail) {
    if (line.startsWith('Khách:') && COMPLAINT_MARKERS.test(line)) count++;
  }
  return count >= 2;
}

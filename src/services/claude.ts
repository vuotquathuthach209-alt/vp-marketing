import { buildContext } from './wiki';
import { generate } from './router';

/**
 * Module này giờ là facade mỏng, chỉ định nghĩa task-specific logic
 * (system prompt, RAG injection) — việc gọi model thực tế do router
 * xử lý, tự chọn Anthropic / Gemini / Groq tùy cấu hình.
 */

const CAPTION_SYSTEM = `Bạn là chuyên gia content marketing ngành lưu trú & du lịch tại Việt Nam.
Viết caption Facebook tiếng Việt hấp dẫn, tự nhiên, có emoji phù hợp.

NGUYÊN TẮC:
- Mở đầu bằng câu hook gây chú ý (câu hỏi, con số, hoặc cảm xúc)
- Mô tả trải nghiệm cụ thể, không chung chung
- Call-to-action rõ ràng (inbox, comment, đặt phòng...)
- Kết thúc với 5-8 hashtag liên quan (du lịch, địa điểm, loại hình)
- Độ dài 80-180 từ
- Giọng văn ấm áp, mời gọi, không hời hợt
- KHÔNG dùng từ sáo rỗng như "tuyệt vời", "tuyệt đỉnh", "không thể bỏ qua"
- KHÔNG markdown, chỉ text thuần + emoji`;

const IMAGE_PROMPT_SYSTEM = `Bạn chuyển caption tiếng Việt thành prompt tiếng Anh để gen ảnh AI.
Prompt phải: mô tả scene cụ thể, ánh sáng, góc máy, phong cách (cinematic, photorealistic),
phù hợp với ngành du lịch/khách sạn. Không dùng chữ, không có text trong ảnh. Tối đa 60 từ.
Chỉ trả về prompt, không giải thích.`;

export async function generateCaption(topic: string, extraContext?: string): Promise<string> {
  // Tự động inject Wiki context (RAG): doanh nghiệp, brand voice, campaign, product, faq
  const wikiCtx = buildContext(topic);
  const ctxBlock = wikiCtx
    ? `\n\n--- KIẾN THỨC DOANH NGHIỆP (dùng chính xác số liệu, tên, tone bên dưới) ---\n${wikiCtx}\n--- HẾT KIẾN THỨC ---\n`
    : '';
  const userPrompt = `Chủ đề: ${topic}${ctxBlock}${extraContext ? `\n\nThông tin thêm: ${extraContext}` : ''}\n\nHãy viết caption Facebook cho chủ đề trên. Nếu có kiến thức doanh nghiệp bên trên, hãy dựa vào đó (giá, tên phòng, chương trình khuyến mãi) — KHÔNG bịa số liệu.`;

  return generate({
    task: 'caption',
    system: CAPTION_SYSTEM,
    user: userPrompt,
  });
}

export async function generateImagePrompt(caption: string): Promise<string> {
  return generate({
    task: 'image_prompt',
    system: IMAGE_PROMPT_SYSTEM,
    user: `Caption:\n${caption}\n\nViết image prompt:`,
  });
}

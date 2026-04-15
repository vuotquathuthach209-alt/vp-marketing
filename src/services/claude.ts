import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config';
import { pickKey, getAllKeys } from './keyrotator';
import { buildContext } from './wiki';

/**
 * Gọi Claude với cơ chế failover: nếu key hiện tại lỗi (rate limit, quota...)
 * thì thử key tiếp theo. Trả về text hoặc throw nếu tất cả key đều fail.
 */
async function callWithFailover<T>(fn: (client: Anthropic) => Promise<T>): Promise<T> {
  const keys = getAllKeys('anthropic_api_key', config.anthropicApiKey);
  if (keys.length === 0) throw new Error('Chưa cấu hình Anthropic API Key. Vào Cấu hình để nhập.');

  // Bắt đầu từ key round-robin, rồi fallback sang các key còn lại nếu lỗi
  const startIdx = keys.indexOf(pickKey('anthropic_api_key', config.anthropicApiKey));
  let lastErr: any;
  for (let i = 0; i < keys.length; i++) {
    const key = keys[(startIdx + i) % keys.length];
    try {
      return await fn(new Anthropic({ apiKey: key }));
    } catch (e: any) {
      lastErr = e;
      const status = e?.status || e?.response?.status;
      // Chỉ failover khi lỗi quota/rate-limit/auth; lỗi khác (400) thì throw luôn
      if (![401, 403, 429, 529].includes(status)) throw e;
      console.warn(`[claude] Key ${key.slice(-6)} lỗi ${status}, thử key kế tiếp...`);
    }
  }
  throw lastErr;
}

const SYSTEM_PROMPT = `Bạn là chuyên gia content marketing ngành lưu trú & du lịch tại Việt Nam.
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

export async function generateCaption(topic: string, extraContext?: string): Promise<string> {
  // Tự động inject Wiki context (RAG): doanh nghiệp, brand voice, campaign, product, faq
  const wikiCtx = buildContext(topic);
  const ctxBlock = wikiCtx
    ? `\n\n--- KIẾN THỨC DOANH NGHIỆP (dùng chính xác số liệu, tên, tone bên dưới) ---\n${wikiCtx}\n--- HẾT KIẾN THỨC ---\n`
    : '';
  const userPrompt = `Chủ đề: ${topic}${ctxBlock}${extraContext ? `\n\nThông tin thêm: ${extraContext}` : ''}\n\nHãy viết caption Facebook cho chủ đề trên. Nếu có kiến thức doanh nghiệp bên trên, hãy dựa vào đó (giá, tên phòng, chương trình khuyến mãi) — KHÔNG bịa số liệu.`;

  const msg = await callWithFailover((client) =>
    client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userPrompt }],
    })
  );

  const textBlock = msg.content.find((b) => b.type === 'text');
  if (!textBlock || textBlock.type !== 'text') throw new Error('Không nhận được caption từ Claude');
  return textBlock.text.trim();
}

export async function generateImagePrompt(caption: string): Promise<string> {
  const msg = await callWithFailover((client) =>
    client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 400,
      system: `Bạn chuyển caption tiếng Việt thành prompt tiếng Anh để gen ảnh AI.
Prompt phải: mô tả scene cụ thể, ánh sáng, góc máy, phong cách (cinematic, photorealistic),
phù hợp với ngành du lịch/khách sạn. Không dùng chữ, không có text trong ảnh. Tối đa 60 từ.
Chỉ trả về prompt, không giải thích.`,
      messages: [{ role: 'user', content: `Caption:\n${caption}\n\nViết image prompt:` }],
    })
  );
  const textBlock = msg.content.find((b) => b.type === 'text');
  if (!textBlock || textBlock.type !== 'text') throw new Error('Không nhận được prompt từ Claude');
  return textBlock.text.trim();
}

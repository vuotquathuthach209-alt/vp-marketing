/**
 * Multimodal Analyzer — Gemini Flash 2.5 vision + audio.
 *
 * Nhiệm vụ: biến attachment (ảnh/audio) thành TEXT CÓ NGỮ CẢNH + INTENT HINT
 * để dispatcher v6 xử lý bằng pipeline text hiện có.
 *
 * Kịch bản khách sạn:
 *  - Ảnh phòng từ OTA → "còn phòng này không?"
 *  - CCCD / Passport → eKYC check-in
 *  - Bill chuyển khoản → deposit proof (đã có flow transfer)
 *  - Screenshot bản đồ → "làm sao đến đây?"
 *  - Ảnh sự cố (bẩn, hỏng) → complaint + evidence
 *  - Voice message → transcribe → text
 *
 * Cost: Gemini Flash ~$0.075/1M input tok. 1 ảnh ~258 tok.
 *       1 audio 30s ~750 tok. Cực rẻ.
 */
import axios from 'axios';
import { pickKey } from './keyrotator';

const GEMINI_MODEL = 'gemini-2.5-flash';

export type AttachmentType = 'image' | 'audio' | 'video';

export type DetectedKind =
  | 'room_photo'       // ảnh phòng/khách sạn (có thể từ OTA)
  | 'id_document'      // CCCD/Passport
  | 'payment_proof'    // bill chuyển khoản
  | 'map_screenshot'   // ảnh bản đồ/chỉ đường
  | 'complaint_photo'  // bằng chứng sự cố
  | 'food_photo'       // ảnh đồ ăn (nhà hàng / ăn sáng)
  | 'person_photo'     // ảnh chân dung (selfie)
  | 'voice_question'   // tin nhắn voice
  | 'other';

export interface MultimodalResult {
  kind: DetectedKind;
  description: string;     // mô tả ngắn gọn nội dung
  extracted_text: string;  // OCR (nếu có text trong ảnh) hoặc transcript
  intent_hint: string;     // gợi ý cho intent router (VD: "khách hỏi phòng", "complaint")
  confidence: number;
  synthesized_message: string; // text giả lập để feed vào dispatcher text pipeline
}

interface AttachmentInput {
  mimeType: string;        // e.g. 'image/jpeg', 'audio/mp4'
  data: Buffer;            // raw bytes
}

function buildPrompt(type: AttachmentType): string {
  return `Bạn là trợ lý phân tích tin nhắn khách hàng khách sạn. Khách vừa gửi 1 ${type === 'image' ? 'hình ảnh' : type === 'audio' ? 'tin nhắn thoại' : 'video'}.

Phân tích và trả về JSON ĐÚNG schema:
{
  "kind": "room_photo | id_document | payment_proof | map_screenshot | complaint_photo | food_photo | person_photo | voice_question | other",
  "description": "<mô tả ngắn gọn nội dung 1-2 câu>",
  "extracted_text": "<text có trong ảnh nếu có, hoặc transcript audio; nếu không có thì ''>",
  "intent_hint": "<1 câu hướng dẫn cho bot: khách muốn gì?>",
  "confidence": <0.0-1.0>,
  "synthesized_message": "<câu giả lập khách viết ra text, sẽ feed cho bot chính>"
}

HƯỚNG DẪN synthesized_message:
- Đây là phần QUAN TRỌNG NHẤT. Bot text sẽ xử lý câu này.
- Viết như khách đang nhắn: "Còn phòng kiểu này không ạ?" / "Đây là CCCD của em, check-in giúp em nhé"
- Nếu là bill chuyển khoản: "(đã gửi bill chuyển khoản)"
- Nếu là map: "Làm sao đến chỗ này?"
- Nếu voice, lấy transcript làm synthesized_message
- Ngắn gọn, tự nhiên tiếng Việt (hoặc ngôn ngữ của transcript nếu voice)

CHỈ trả JSON, không giải thích.`;
}

async function callGeminiMultimodal(
  prompt: string,
  input: AttachmentInput,
  maxTokens = 600,
): Promise<string> {
  const key = pickKey('google_api_key', process.env.GOOGLE_API_KEY);
  if (!key) throw new Error('GOOGLE_API_KEY not configured');

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${key}`;
  const base64 = input.data.toString('base64');

  const resp = await axios.post(
    url,
    {
      contents: [{
        role: 'user',
        parts: [
          { inline_data: { mime_type: input.mimeType, data: base64 } },
          { text: prompt },
        ],
      }],
      generationConfig: {
        maxOutputTokens: maxTokens,
        temperature: 0.3,
        responseMimeType: 'application/json', // force JSON output
      },
    },
    { timeout: 30000, headers: { 'Content-Type': 'application/json' } },
  );
  const text = resp.data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Gemini multimodal: no text');
  return String(text).trim();
}

export async function analyzeAttachment(opts: {
  type: AttachmentType;
  mimeType: string;
  data: Buffer;
}): Promise<MultimodalResult> {
  const { type, mimeType, data } = opts;

  try {
    const raw = await callGeminiMultimodal(buildPrompt(type), { mimeType, data });
    const cleaned = raw.replace(/```json/gi, '').replace(/```/g, '').trim();
    const s = cleaned.indexOf('{');
    const e = cleaned.lastIndexOf('}');
    if (s < 0 || e < s) {
      console.warn('[multimodal] raw output (no JSON):', raw.slice(0, 300));
      throw new Error('no JSON');
    }
    const parsed = JSON.parse(cleaned.slice(s, e + 1)) as Partial<MultimodalResult>;
    return {
      kind: (parsed.kind || 'other') as DetectedKind,
      description: parsed.description || '',
      extracted_text: parsed.extracted_text || '',
      intent_hint: parsed.intent_hint || '',
      confidence: Math.max(0, Math.min(1, Number(parsed.confidence) || 0.5)),
      synthesized_message: parsed.synthesized_message || '(khách gửi ' + type + ')',
    };
  } catch (e: any) {
    console.warn('[multimodal] analyze fail:', e?.message);
    return {
      kind: 'other',
      description: '',
      extracted_text: '',
      intent_hint: '',
      confidence: 0.3,
      synthesized_message: type === 'audio' ? '(tin nhắn voice không đọc được)' : '(khách gửi ảnh)',
    };
  }
}

/**
 * Sentiment analyzer via Gemini Flash.
 *
 * Returns: positive | neutral | negative | unknown
 *        + score (-1 to 1)
 *        + reason (1 sentence why)
 *        + is_question (boolean for comments)
 *        + is_urgent (negative review with strong signal)
 *
 * Cost: ~$0.0001 per call (Gemini Flash, ~50 input + 50 output tokens).
 * For 100 comments/day: ~$0.01/day, $0.30/month. Negligible.
 */

import axios from 'axios';
import { getSetting } from '../../db';
import type { Sentiment } from './types';

const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent';

const PROMPT_TEMPLATE = (text: string, context: 'review' | 'comment') => `Phân loại sentiment đoạn ${context === 'review' ? 'đánh giá khách sạn' : 'comment trên Facebook/Instagram'} sau từ KHÁCH HÀNG.

Trả về CHỈ JSON, không markdown, không text khác:
{
  "sentiment": "positive" | "neutral" | "negative",
  "score": <số -1.0 đến 1.0, -1 = rất tiêu cực, 1 = rất tích cực>,
  "reason": "<1 câu tiếng Việt giải thích vì sao>",
  "is_question": <true nếu là câu hỏi, false nếu không>,
  "is_urgent": <true nếu CỰC negative + có yếu tố KHẨN CẤP (đe doạ kiện, fraud, bị thương, an toàn) — RẤT HIẾM, mặc định false>,
  "language": "vi" | "en" | "other"
}

ĐÁNH GIÁ NGHIÊM TÚC. Một số ví dụ:
- "Khách sạn này rất tốt, nhân viên thân thiện" → positive (score: 0.8)
- "Bình thường, không có gì đặc biệt" → neutral (score: 0)
- "Phòng bẩn, mùi hôi, không bao giờ quay lại!" → negative (score: -0.9)
- "Cho hỏi giá phòng đôi cuối tuần?" → neutral, is_question: true
- "Tôi sẽ kiện ra toà vì khách sạn lấy tiền cọc bất hợp pháp!" → negative, is_urgent: true
- "Xinh quá!" / "Đẹp!" / "Tuyệt vời" (chỉ vài chữ) → positive (score: 0.6)

ĐOẠN VĂN:
"""${text.slice(0, 1000)}"""`;

export interface SentimentResult {
  sentiment: Sentiment;
  score: number;
  reason: string;
  is_question: boolean;
  is_urgent: boolean;
  language: string | null;
}

export async function classifySentiment(text: string, context: 'review' | 'comment' = 'review'): Promise<SentimentResult | null> {
  const apiKey = getSetting('google_api_key') || process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    console.warn('[care-sentiment] google_api_key not configured');
    return null;
  }
  if (!text || text.trim().length === 0) {
    return { sentiment: 'unknown', score: 0, reason: 'empty text', is_question: false, is_urgent: false, language: null };
  }

  try {
    const r = await axios.post(
      `${GEMINI_URL}?key=${apiKey}`,
      {
        contents: [{ parts: [{ text: PROMPT_TEMPLATE(text, context) }] }],
        generationConfig: {
          temperature: 0.1,
          maxOutputTokens: 300,
          responseMimeType: 'application/json',
        },
      },
      { timeout: 20_000 },
    );
    const raw = r.data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!raw) return null;
    const parsed = JSON.parse(raw);

    // Validate + normalize
    const sentiment: Sentiment = ['positive', 'neutral', 'negative'].includes(parsed.sentiment)
      ? parsed.sentiment : 'unknown';
    const score = Math.max(-1, Math.min(1, parseFloat(parsed.score) || 0));
    return {
      sentiment,
      score,
      reason: String(parsed.reason || '').slice(0, 200),
      is_question: !!parsed.is_question,
      is_urgent: !!parsed.is_urgent,
      language: parsed.language || null,
    };
  } catch (e: any) {
    console.warn('[care-sentiment] fail:', e?.response?.data?.error?.message || e?.message);
    return null;
  }
}

/** Batch classify with throttle. Returns map of input index → result. */
export async function classifyBatch(items: Array<{ text: string; context?: 'review' | 'comment' }>): Promise<SentimentResult[]> {
  const results: SentimentResult[] = [];
  for (const item of items) {
    const r = await classifySentiment(item.text, item.context || 'review');
    results.push(r || { sentiment: 'unknown', score: 0, reason: 'classify failed', is_question: false, is_urgent: false, language: null });
    await new Promise((r) => setTimeout(r, 150));   // throttle
  }
  return results;
}

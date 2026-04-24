/**
 * Script Writer — LLM generate structured video script.
 *
 * Input: topic + target_duration
 * Output: { hook, scenes: [...], cta } với timestamp + visual_prompt cho từng scene
 *
 * Dùng smartCascade (Gemini 2.5 Flash → Pro → GPT → Qwen) — infrastructure share OK.
 */

import { getVSSetting } from './feature-flag';

// Style guide injected vào MỌI visual prompt để đảm bảo consistency
export const DEFAULT_VISUAL_STYLE_GUIDE = [
  'cinematic travel photography',
  'warm golden hour lighting',
  'shallow depth of field',
  'vibrant but natural colors',
  'Southeast Asian / Vietnamese aesthetic',
  'consistent warm color grading',
].join(', ');

export interface ScriptScene {
  index: number;
  kind: 'hook' | 'main' | 'cta';
  text: string;                       // Voiceover text (tiếng Việt)
  duration_sec: number;               // Target duration cho scene này
  visual_prompt: string;              // English prompt cho video gen / stock search
  stock_keywords: string[];           // Keywords ngắn cho stock search
  b_roll_notes?: string;              // Optional: gợi ý b-roll
}

export interface ScriptOutput {
  title: string;
  hook_question: string;
  total_duration_sec: number;
  scenes: ScriptScene[];
  cta_text: string;
  caption_social: string;             // Caption cho FB/IG/Zalo
  hashtags: string[];
  provider: string;
  tokens_used?: { input: number; output: number };
}

export interface ScriptOptions {
  topic: string;
  target_duration_sec?: number;       // Default 90
  style?: 'informative' | 'energetic' | 'warm' | 'professional';
  audience?: string;                  // "du khách trẻ", "gia đình", ...
  language?: 'vi' | 'en';
  brand_name?: string;
  custom_style_guide?: string;
}

const SYSTEM_PROMPT = `Bạn là content creator video travel tips chuyên nghiệp. Viết kịch bản video ngắn (60-180 giây) cho social media (Reels/Shorts), tiếng Việt.

CẤU TRÚC CỐ ĐỊNH:
1. HOOK (5 giây): câu mở đầu gây tò mò, 1 câu hỏi hoặc fact bất ngờ
2. MAIN (70% thời lượng): 6-12 scenes, mỗi scene 5-10 giây, nội dung giá trị cao
3. CTA (10-15 giây): kêu gọi hành động + gợi ý đặt phòng Sonder (nếu phù hợp)

QUY TẮC NGHIÊM NGẶT:
1. Giọng "mình" hoặc "bạn" (thân thiện với người xem)
2. Mỗi scene text phải đủ ngắn để đọc trong duration_sec × 2.5 words/sec (VN tốc độ)
3. KHÔNG bịa số liệu (giá, thống kê cụ thể) — dùng "từ X", "khoảng", "thường"
4. visual_prompt viết TIẾNG ANH — description cảnh quay cho stock search HOẶC AI video
5. stock_keywords: 2-4 từ khoá ngắn (EN) cho Pexels/Pixabay search
6. Scene đầu = hook, scene cuối = cta, ở giữa là main
7. Mỗi scene phải có chủ đề khác nhau (tránh lặp cảnh)

OUTPUT JSON STRICT:
{
  "title": "...",
  "hook_question": "Bạn biết...",
  "total_duration_sec": 90,
  "scenes": [
    {
      "index": 0,
      "kind": "hook",
      "text": "Bạn biết không, ...",
      "duration_sec": 5,
      "visual_prompt": "bustling Vietnamese street food market at dawn, atmospheric smoke rising from food carts, cinematic shallow depth of field",
      "stock_keywords": ["vietnamese street food", "morning market"],
      "b_roll_notes": "wide shot"
    },
    ...
  ],
  "cta_text": "Đặt phòng Sonder gần đây để trải nghiệm trọn vẹn...",
  "caption_social": "Caption ngắn 2-3 dòng cho FB/IG/Zalo, có emoji phù hợp",
  "hashtags": ["#dulich", "#saigon", ...]
}`;

function buildUserPrompt(opts: ScriptOptions): string {
  const duration = opts.target_duration_sec || 90;
  const style = opts.style || 'warm';
  const audience = opts.audience || 'du khách trẻ 20-35 tuổi';
  const brandName = opts.brand_name || 'Sonder';
  const styleGuide = opts.custom_style_guide || DEFAULT_VISUAL_STYLE_GUIDE;

  const numScenes = duration <= 60 ? '6-8' : duration <= 120 ? '8-12' : '10-15';

  return `Topic: "${opts.topic}"
Target duration: ${duration} giây
Style: ${style}
Audience: ${audience}
Brand: ${brandName}
Visual style guide (prepend vào mọi visual_prompt): ${styleGuide}

Số scenes gợi ý: ${numScenes}

Viết kịch bản đầy đủ. Output JSON.`;
}

/**
 * Main entry — generate script.
 * Return null nếu LLM fail (caller có thể retry hoặc fallback manual).
 */
export async function generateScript(opts: ScriptOptions): Promise<ScriptOutput | null> {
  try {
    // smartCascade là infrastructure share được (không phải chatbot/agentic logic)
    const { smartCascade } = require('../smart-cascade');
    const result = await smartCascade({
      system: SYSTEM_PROMPT,
      user: buildUserPrompt(opts),
      json: true,
      temperature: 0.7,
      maxTokens: 3000,
      startFrom: 'gemini_flash',
    });

    if (!result?.text) return null;

    let parsed: any;
    try { parsed = JSON.parse(result.text); }
    catch {
      const m = result.text.match(/\{[\s\S]*\}/);
      if (!m) return null;
      try { parsed = JSON.parse(m[0]); } catch { return null; }
    }

    // Validate + sanitize
    if (!parsed.scenes || !Array.isArray(parsed.scenes) || parsed.scenes.length < 3) return null;

    // Auto-inject style guide into visual_prompts if missing
    const styleGuide = opts.custom_style_guide || DEFAULT_VISUAL_STYLE_GUIDE;
    const scenes: ScriptScene[] = parsed.scenes.map((s: any, i: number) => ({
      index: s.index ?? i,
      kind: (['hook', 'main', 'cta'].includes(s.kind) ? s.kind : (i === 0 ? 'hook' : i === parsed.scenes.length - 1 ? 'cta' : 'main')),
      text: String(s.text || '').substring(0, 500),
      duration_sec: Math.max(3, Math.min(20, Number(s.duration_sec) || 8)),
      visual_prompt: String(s.visual_prompt || '').includes(styleGuide.split(',')[0])
        ? s.visual_prompt
        : `${s.visual_prompt}, ${styleGuide}`,
      stock_keywords: Array.isArray(s.stock_keywords)
        ? s.stock_keywords.slice(0, 5).map((k: any) => String(k).substring(0, 50))
        : [],
      b_roll_notes: s.b_roll_notes ? String(s.b_roll_notes).substring(0, 200) : undefined,
    }));

    // Check total duration roughly matches target
    const totalFromScenes = scenes.reduce((sum, s) => sum + s.duration_sec, 0);
    const target = opts.target_duration_sec || 90;
    if (Math.abs(totalFromScenes - target) > 30) {
      console.warn(`[vs-script] duration mismatch: scenes sum ${totalFromScenes}s vs target ${target}s — proportionally scaling`);
      const scale = target / totalFromScenes;
      for (const s of scenes) s.duration_sec = Math.round(s.duration_sec * scale * 10) / 10;
    }

    return {
      title: String(parsed.title || opts.topic).substring(0, 200),
      hook_question: String(parsed.hook_question || '').substring(0, 300),
      total_duration_sec: scenes.reduce((sum, s) => sum + s.duration_sec, 0),
      scenes,
      cta_text: String(parsed.cta_text || '').substring(0, 400),
      caption_social: String(parsed.caption_social || '').substring(0, 1000),
      hashtags: Array.isArray(parsed.hashtags)
        ? parsed.hashtags.slice(0, 15).map((h: any) => String(h).replace(/^#*/, '#'))
        : [],
      provider: result.provider || 'gemini_flash',
      tokens_used: result.tokens_in && result.tokens_out
        ? { input: result.tokens_in, output: result.tokens_out }
        : undefined,
    };
  } catch (e: any) {
    console.warn('[vs-script] generate err:', e?.message);
    return null;
  }
}

/**
 * Estimate TTS cost cho script (chars count).
 */
export function estimateTTSCost(script: ScriptOutput): { chars: number; elevenlabs_cents: number } {
  const fullText = [
    script.hook_question,
    ...script.scenes.map(s => s.text),
    script.cta_text,
  ].join(' ');

  const chars = fullText.length;
  // ElevenLabs Starter plan: ~$0.30/1000 chars
  const cents = Math.ceil((chars / 1000) * 30);
  return { chars, elevenlabs_cents: cents };
}

/**
 * Tips Script Writer — Claude generate 5 tips + A/B hook variants.
 *
 * Format video 75s:
 *   - Hook 5s (1 trong 5 viral patterns)
 *   - 5 tips × 12s = 60s
 *   - CTA 10s
 *
 * Output: TipsScript với 2 hook variants (A/B test sau 48h pick winner).
 */

import axios from 'axios';
import { getSetting } from '../../db';
import type { TipsCategory, HookPattern, TipScene, TipsScript } from './tips-engine';

const HOOK_PATTERN_TEMPLATES: Record<HookPattern, string> = {
  number:
    'Pattern "number": "{N} sai lầm/cách/lý do/dấu hiệu..." — số (3/5/7) + curiosity gap. ' +
    'Ví dụ: "5 sai lầm 99% du khách Việt mắc khi đặt phòng homestay"',

  authority:
    'Pattern "authority": "Sau {N} chuyến đi/năm/tháng, mình học được..." — số chuyến + insight. ' +
    'Ví dụ: "Sau 50 chuyến đi nội địa, mình thấy đa số mọi người làm sai 1 thứ"',

  question:
    'Pattern "question": "Bạn có biết...?" — câu hỏi đánh thẳng curiosity. ' +
    'Ví dụ: "Bạn có biết Sài Gòn có 1 khu giá phòng rẻ HƠN homestay tỉnh không?"',

  time:
    'Pattern "time": "{thời điểm cụ thể}, {hành động/quyết định}..." — kịch tính. ' +
    'Ví dụ: "11 giờ đêm, mình check-in homestay quận Tân Bình và NHẬN RA 1 điều..."',

  contradiction:
    'Pattern "contradiction": "Đừng/Không nên... TRỪ KHI..." — contrarian hook. ' +
    'Ví dụ: "Đừng đặt phòng ở Q1 trừ khi bạn biết 3 điều này"',
};

const SCRIPT_SYSTEM = `Bạn là biên kịch video Reels/Shorts viral cho Sonder. Mục tiêu: 75 giây value-driven content cho audience VN 22-40 tuổi.

CẤU TRÚC BẮT BUỘC:
1. HOOK 5s — 1 câu, 8-15 từ. Stop the scroll.
2. 5 TIPS × 12s mỗi tip:
   - title: 4-7 từ (cho overlay text big bold)
   - text: voiceover 1 câu, 12-20 từ (đọc 8-12s)
   - visual_query: 3-5 ENG keywords cho Pexels
3. CTA 10s — câu hỏi engagement HOẶC value action ("save bài này")

QUY TẮC NỘI DUNG:
- Tiếng Việt ĐỜI THƯỜNG, "mình"/"bạn" thân thiện.
- TRÁNH: "trải nghiệm khó quên", "đỉnh cao", "không thể bỏ qua", "khám phá", "tinh hoa".
- Tip phải CONCRETE, có thể làm theo (số liệu / địa điểm cụ thể / thời gian cụ thể).
- KHÔNG sến, KHÔNG meme.
- Mỗi tip text bắt đầu bằng VERB action (Đặt, Chọn, Tránh, Check, Săn, Hỏi, Mang, Đợi, Đi, Book).

QUY TẮC HOOK (V2.1 — A/B test):
- Generate 2 hook variants (A và B) — MỘT pattern khác hoàn toàn về tone.
- A = pattern được chỉ định.
- B = pattern khác (random từ 4 patterns còn lại).
- Cả 2 đều phải đạt: stop scroll, 8-15 từ, không bla bla.

CTA gợi ý:
- "Save bài này lại để khi cần đặt phòng nhé"
- "Bạn còn tip nào khác? Comment cho mình"
- "Tag bạn nào sắp đi du lịch để biết tip này"

OUTPUT JSON STRICT (không markdown fence, không text ngoài JSON):
{
  "hook_text": "<hook A — pattern được assign>",
  "hook_variants": {
    "A": "<hook A>",
    "B": "<hook B — pattern khác>"
  },
  "tips": [
    {
      "number": 1,
      "title": "...",        // 4-7 từ cho overlay
      "text": "...",          // voiceover 12-20 từ
      "visual_query": "..."   // 3-5 ENG keywords
    },
    ...5 tips
  ],
  "cta_text": "...",
  "caption_text": "...",      // FB/IG caption 80-200 chars
  "hashtags": ["#dulich", ...]   // 3-5 hashtags
}`;

function buildScriptUserPrompt(opts: {
  topic: string;
  category: TipsCategory;
  hook_pattern: HookPattern;
  description?: string;
  audience?: string;
}): string {
  const monthVN = new Date().getMonth() + 1;

  return `# Topic
${opts.topic}

# Category
${opts.category}

${opts.description ? `# Mô tả gốc\n${opts.description}\n` : ''}

# Audience
${opts.audience || 'du khách trẻ 22-35 tuổi'}

# Hook pattern bắt buộc cho variant A
${HOOK_PATTERN_TEMPLATES[opts.hook_pattern]}

# Variant B
Generate hook B với 1 pattern KHÁC hoàn toàn (không phải ${opts.hook_pattern}). Random pick từ 4 patterns còn lại để tăng variety A/B test.

# Bối cảnh hiện tại
Tháng ${monthVN} năm ${new Date().getFullYear()}. ${getMonthContext(monthVN)}.

Viết script video 75s với 5 tips concrete. KHÔNG generic.

Output JSON only.`;
}

function getMonthContext(month: number): string {
  const ctx: Record<number, string> = {
    1: 'Tháng 1 — đầu năm, sau Tết Tây, chuẩn bị Tết Âm',
    2: 'Tháng 2 — Tết Âm Lịch, Valentine',
    3: 'Tháng 3 — sau Tết, đi du lịch tháng thấp điểm',
    4: 'Tháng 4 — Lễ Giỗ Tổ Hùng Vương, mùa xuân',
    5: 'Tháng 5 — Lễ 30/4-1/5, hè đầu',
    6: 'Tháng 6 — nghỉ hè bắt đầu, mưa đầu mùa',
    7: 'Tháng 7 — hè cao điểm, mưa nhiều',
    8: 'Tháng 8 — hè, lễ Vu Lan',
    9: 'Tháng 9 — đầu năm học, du lịch ít người',
    10: 'Tháng 10 — đẹp nhất mùa thu, ít mưa',
    11: 'Tháng 11 — chuẩn bị Giáng Sinh, lễ 20/11',
    12: 'Tháng 12 — Giáng Sinh, Tết Tây, cuối năm',
  };
  return ctx[month] || '';
}

// ═══════════════════════════════════════════════════════════
// Direct Claude call
// ═══════════════════════════════════════════════════════════

async function callClaude(system: string, user: string, maxTokens = 3000): Promise<string> {
  const apiKey = getSetting('anthropic_api_key');
  if (!apiKey) throw new Error('anthropic_api_key not set');

  const r = await axios.post(
    'https://api.anthropic.com/v1/messages',
    {
      model: 'claude-sonnet-4-6',
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: user }],
    },
    {
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      timeout: 180_000,
    }
  );
  return ((r.data?.content || []).map((b: any) => b?.text || '').join('') || '').trim();
}

// ═══════════════════════════════════════════════════════════
// Main entry — generate full TipsScript
// ═══════════════════════════════════════════════════════════

export async function generateTipsScript(opts: {
  topic: string;
  category: TipsCategory;
  hook_pattern: HookPattern;
  description?: string;
  audience?: string;
}): Promise<TipsScript> {
  const raw = await callClaude(SCRIPT_SYSTEM, buildScriptUserPrompt(opts), 3500);

  let parsed: any;
  try { parsed = JSON.parse(raw); }
  catch {
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) throw new Error(`Cannot parse JSON: ${raw.slice(0, 300)}`);
    parsed = JSON.parse(m[0]);
  }

  // Validate structure
  if (!parsed.tips || !Array.isArray(parsed.tips) || parsed.tips.length < 4) {
    throw new Error(`Invalid script: tips array length=${parsed.tips?.length}`);
  }

  const tips: TipScene[] = parsed.tips.slice(0, 5).map((t: any, i: number) => ({
    number: t.number || (i + 1),
    title: String(t.title || '').substring(0, 80).trim(),
    text: String(t.text || '').substring(0, 400).trim(),
    visual_query: String(t.visual_query || '').substring(0, 100).trim(),
  }));

  if (tips.length !== 5) {
    // Pad to 5 if Claude gave 4
    while (tips.length < 5) {
      tips.push({
        number: tips.length + 1,
        title: 'Thêm tip',
        text: 'Tip bổ sung — please re-generate',
        visual_query: 'travel vietnam',
      });
    }
  }

  const hookA = String(parsed.hook_text || parsed.hook_variants?.A || '').substring(0, 200).trim();
  const hookB = String(parsed.hook_variants?.B || '').substring(0, 200).trim();

  if (!hookA) throw new Error('Missing hook_text');

  // Estimate total duration: hook 5s + 5 tips × 12s + CTA 10s = 75s
  const totalDuration = 5 + tips.length * 12 + 10;

  return {
    category: opts.category,
    topic: opts.topic,
    hook_pattern: opts.hook_pattern,
    hook_text: hookA,
    hook_variants: {
      A: hookA,
      B: hookB || hookA,  // Fallback if B missing
    },
    tips,
    cta_text: String(parsed.cta_text || 'Save bài này lại nếu hữu ích nhé!').substring(0, 300),
    caption_text: String(parsed.caption_text || `${opts.topic} — Sonder VN`).substring(0, 500),
    hashtags: Array.isArray(parsed.hashtags)
      ? parsed.hashtags.slice(0, 8).map((h: any) => String(h).replace(/^#*/, '#'))
      : ['#dulich', '#travel', '#sonder'],
    total_duration_sec: totalDuration,
  };
}

/**
 * Weekend Script Writer — Claude generate per-theme structured scripts.
 *
 * 4 distinct prompt templates cho 4 themes:
 *   1. day_in_area     — timeline morning→night, 8 scenes
 *   2. inside_sonder   — feature showcase, 8 scenes
 *   3. guest_story     — narrative arc, 9 scenes
 *   4. why_sonder      — value pitch, 8 scenes
 *
 * Output: WeekendScript với scenes array (text + visual + mood).
 */

import axios from 'axios';
import { getSetting } from '../../db';
import {
  WeekendScript,
  WeekendScene,
  WeekendThemeType,
  THEME_METADATA,
} from './weekend-engine';

async function callClaude(system: string, user: string, maxTokens = 4000): Promise<string> {
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
// Common output format
// ═══════════════════════════════════════════════════════════

const COMMON_RULES = `QUY TẮC CHUNG:
- Tiếng Việt đời thường, "mình"/"bạn" thân thiện. POV ngôi 1.
- TRÁNH: "trải nghiệm khó quên", "không thể bỏ qua", "đỉnh cao", "khám phá", "tinh hoa".
- Mỗi scene text: 1 câu voiceover, 12-25 từ (đọc 8-12s).
- visual_prompt: ENGLISH cinematic image prompt (nhắc Vietnamese / Saigon setting nếu phù hợp).
- visual_query: 3-5 ENGLISH keywords cho Pexels stock fallback.
- mood: calm | warm | uplifting | cinematic | intimate
- camera: wide | medium | close-up | aerial | pov
- prefer_visual: 'ai' (controlled scenes) | 'stock' (motion B-roll)

OUTPUT JSON STRICT (không markdown fence, không text ngoài JSON):
{
  "topic": "...",
  "hook_text": "...",          // dòng đầu hook 8-15 từ
  "cta_text": "...",           // 1 câu kết
  "caption_text": "...",       // FB/IG caption 100-200 chars
  "hashtags": ["#dulich", "#sonder", ...],
  "thumbnail_prompt": "...",   // ENGLISH prompt cho custom thumbnail
  "scenes": [
    {
      "scene_idx": 0,
      "beat": "hook",
      "text": "...",
      "duration_sec": 8,
      "visual_prompt": "...",
      "visual_query": "...",
      "mood": "warm",
      "camera": "wide",
      "prefer_visual": "ai",
      "overlay_text": ""        // optional
    },
    ...
  ]
}`;

// ═══════════════════════════════════════════════════════════
// Per-theme prompts
// ═══════════════════════════════════════════════════════════

const THEME_SYSTEM_PROMPTS: Record<WeekendThemeType, string> = {
  day_in_area: `Bạn là biên kịch video Reels về du lịch SG. Viết video "Một ngày ở [khu vực]" 100s, 8 scenes timeline morning → night.

CẤU TRÚC 8 SCENES timeline (overlay_text = giờ cụ thể):
1. [hook] 8s — Câu mở "Nếu bạn có 1 ngày ở [khu vực], đây là cách mình sẽ dùng" hoặc tương tự. overlay: "1 NGÀY"
2. [context] 12s — 07:00 sáng cafe/breakfast. overlay: "07:00"
3. [context] 12s — 09:30 hoạt động sáng (chợ, công viên, walking). overlay: "09:30"
4. [feature] 12s — 12:00 trưa ăn ngon đặc trưng khu. overlay: "12:00"
5. [feature] 12s — 15:00 chiều cafe cụ thể / điểm chơi. overlay: "15:00"
6. [detail] 12s — 18:00 hoàng hôn / view đặc trưng khu. overlay: "18:00"
7. [payoff] 12s — 20:00 ăn tối / nightlife. overlay: "20:00"
8. [cta] 10s — đề xuất ở Sonder gần đó. overlay không cần.

QUY TẮC:
- Khu vực CỤ THỂ (Q1/Tân Bình/Bình Thạnh/Phú Nhuận/Q3...).
- Tên quán/đường/landmark THỰC SỰ tồn tại — không bịa.
- Nếu không chắc, dùng cụm chung như "quán cafe trên đường Mạc Đĩnh Chi" không bịa tên.
- Visual: prefer_visual='stock' cho scenes 2-7 (motion), 'ai' cho hook + cta.

${COMMON_RULES}`,

  inside_sonder: `Bạn là biên kịch video Reels showcasing 1 feature đặc biệt phòng Sonder. 95s, 8 scenes feature deep-dive.

CẤU TRÚC 8 SCENES:
1. [hook] 8s — câu mở curiosity về feature. VD: "Bạn có biết 1 phòng có thể có view 360° không?"
2. [context] 12s — giới thiệu phòng Sonder + feature đặc trưng
3. [feature] 12s — close-up của feature số 1
4. [feature] 12s — trải nghiệm sử dụng feature
5. [detail] 12s — 1 chi tiết bên trong (vật dụng, finish)
6. [detail] 12s — moment khách thường love nhất
7. [payoff] 12s — feeling chung khi ở phòng
8. [cta] 10s — gợi ý đặt phòng + tên cụ thể

QUY TẮC:
- KHÔNG hard-sell. Showcase NHẸ, ý tự thành.
- Visual: prefer_visual='ai' cho 60% scenes (controlled showcase), 'stock' cho mood B-roll.
- AI image prompts cần specific: "Sonder boutique room with bathtub view, warm wooden interior, large window, evening light"

${COMMON_RULES}`,

  guest_story: `Bạn là biên kịch storytelling 1 vị khách specific từ 1 quốc gia đến Sonder. 110s, 9 scenes narrative arc.

CẤU TRÚC 9 SCENES (narrative arc):
1. [hook] 8s — câu mở personal stake. VD: "Anh Kim từ Seoul lần đầu đặt chân SG..."
2. [context] 12s — guest's lý do đến SG (business / vacation / move)
3. [context] 12s — pain point họ tìm cách giải quyết
4. [feature] 12s — moment họ thấy Sonder
5. [feature] 12s — first impression khi check-in
6. [detail] 12s — feature/khoảnh khắc họ love
7. [detail] 12s — interaction với staff / local
8. [payoff] 12s — họ rời đi với cảm nghĩ gì
9. [cta] 10s — they would return because... (soft CTA)

QUY TẮC:
- Tên Korean/Japanese/etc. THẬT SỰ phổ biến (Kim, Park, Tanaka, Smith, Lim...).
- KHÔNG bịa số liệu. Câu cảm xúc, không stats.
- Visual: 50/50 mix AI (character control) + Stock (Saigon city, transit, sights).

${COMMON_RULES}`,

  why_sonder: `Bạn là biên kịch video brand-pitch "Why Sonder không giống khách sạn thường". 100s, 8 scenes value pitch.

CẤU TRÚC 8 SCENES (value pitch arc):
1. [hook] 8s — câu mở pain. VD: "Bạn có chán việc ở khách sạn cảm giác như sleep box không?"
2. [context] 12s — nỗi đau common của khách sạn truyền thống
3. [feature] 12s — Sonder differentiator #1 (không phải hotel chain)
4. [feature] 12s — Sonder differentiator #2 (local Vietnamese aesthetic)
5. [feature] 12s — Sonder differentiator #3 (business travelers love)
6. [feature] 12s — Sonder differentiator #4 (cost-effective for stays >3 nights)
7. [payoff] 12s — feeling gì khi staying tại Sonder
8. [cta] 10s — soft invitation, not pushy.

QUY TẮC:
- KHÔNG khoe quá đà. Compare với HOTEL THƯỜNG, không name competitor cụ thể.
- Mỗi differentiator = 1 lý do CỤ THỂ, dùng được.
- Visual: 60% AI (controlled compose lifestyle), 40% stock comparison shots.

${COMMON_RULES}`,
};

// ═══════════════════════════════════════════════════════════
// Main entry — generate script per theme + subject
// ═══════════════════════════════════════════════════════════

export async function generateWeekendScript(opts: {
  theme: WeekendThemeType;
  subject: string;
  audience?: string;
}): Promise<WeekendScript> {
  const meta = THEME_METADATA[opts.theme];
  const system = THEME_SYSTEM_PROMPTS[opts.theme];

  const userPrompt = `# Theme
${meta.label}

# Subject cụ thể (BẮT BUỘC focus vào subject này)
${opts.subject}

# Audience
${opts.audience || 'du khách trẻ 22-40 tuổi, đang tìm chỗ ở khác biệt ở SG'}

# Description theme
${meta.description}

Viết script video ${meta.duration_target_sec}s với ${meta.scenes_target} scenes theo cấu trúc system prompt.

Output JSON only.`;

  const raw = await callClaude(system, userPrompt, 4000);

  let parsed: any;
  try { parsed = JSON.parse(raw); }
  catch {
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) throw new Error(`Cannot parse JSON: ${raw.slice(0, 300)}`);
    parsed = JSON.parse(m[0]);
  }

  // Validate
  if (!parsed.scenes || !Array.isArray(parsed.scenes) || parsed.scenes.length < 6) {
    throw new Error(`Invalid script: scenes count=${parsed.scenes?.length}`);
  }

  const validBeats = ['hook', 'context', 'feature', 'detail', 'payoff', 'cta'];
  const validMoods = ['calm', 'warm', 'uplifting', 'cinematic', 'intimate'];
  const validCameras = ['wide', 'medium', 'close-up', 'aerial', 'pov'];
  const validPrefers = ['ai', 'stock'];

  const scenes: WeekendScene[] = parsed.scenes.map((s: any, i: number) => ({
    scene_idx: s.scene_idx ?? i,
    beat: validBeats.includes(s.beat) ? s.beat : (i === 0 ? 'hook' : i === parsed.scenes.length - 1 ? 'cta' : 'feature'),
    text: String(s.text || '').substring(0, 500).trim(),
    duration_sec: Math.max(6, Math.min(20, Number(s.duration_sec) || 12)),
    visual_prompt: String(s.visual_prompt || '').substring(0, 800).trim(),
    visual_query: String(s.visual_query || '').substring(0, 100).trim(),
    mood: validMoods.includes(s.mood) ? s.mood : 'warm',
    camera: validCameras.includes(s.camera) ? s.camera : 'medium',
    prefer_visual: validPrefers.includes(s.prefer_visual) ? s.prefer_visual : 'stock',
    overlay_text: s.overlay_text ? String(s.overlay_text).substring(0, 50) : undefined,
  }));

  const totalDuration = scenes.reduce((sum, s) => sum + s.duration_sec, 0);

  return {
    theme_type: opts.theme,
    theme_subject: opts.subject,
    topic: String(parsed.topic || `${meta.label}: ${opts.subject}`).substring(0, 300),
    hook_text: String(parsed.hook_text || '').substring(0, 300),
    cta_text: String(parsed.cta_text || '').substring(0, 300),
    caption_text: String(parsed.caption_text || '').substring(0, 500),
    hashtags: Array.isArray(parsed.hashtags)
      ? parsed.hashtags.slice(0, 8).map((h: any) => String(h).replace(/^#*/, '#'))
      : ['#sonder', '#dulich', '#saigon'],
    thumbnail_prompt: String(parsed.thumbnail_prompt || `${opts.subject}, cinematic, Vietnamese setting, warm lighting`).substring(0, 500),
    scenes,
    total_duration_sec: totalDuration,
  };
}

/**
 * Tips Engine — Daily Travel Tips video pipeline (V2.1).
 *
 * RAIL B của 3-rail architecture:
 *   - T2 (Mon): booking_tips (đặt phòng, vé)
 *   - T4 (Wed): sonder_areas (Q1, Tân Bình, Bình Thạnh)
 *   - T6 (Fri): seasonal_trends (Tết, lễ, mùa)
 *
 * Format video (75s):
 *   - Hook 5s (1 trong 5 patterns viral)
 *   - 5 tips × 12s = 60s (number overlay + tip card + voiceover)
 *   - CTA 10s
 *
 * Voice: ElevenLabs energetic (vs Linh storytelling của Story Engine)
 * Visual: 100% Pexels stock + AI thumbnail
 * BGM: energetic mood (đang dùng uplifting fallback đến khi expand library)
 *
 * Cost: ~$0.40/video (mainly ElevenLabs ~1200 chars × $0.30/1k)
 */

import { db, getSetting } from '../../db';
import axios from 'axios';

// ═══════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════

export type TipsCategory = 'booking_tips' | 'sonder_areas' | 'seasonal_trends';

export type HookPattern = 'number' | 'authority' | 'question' | 'time' | 'contradiction';

export interface TipScene {
  number: number;                     // 1-5
  title: string;                      // Short title (8-15 chars) cho overlay
  text: string;                       // Voiceover text (40-80 chars VN)
  visual_query: string;               // Pexels search keywords (English)
  visual_url?: string;                // Filled after fetch
  voice_audio_path?: string;          // Filled after TTS
  duration_sec?: number;              // Filled after voice gen (actual)
}

export interface TipsScript {
  category: TipsCategory;
  topic: string;
  hook_pattern: HookPattern;
  hook_text: string;                  // Final hook (winner)
  hook_variants: { A: string; B: string };
  tips: TipScene[];                   // Always 5
  cta_text: string;
  caption_text: string;
  hashtags: string[];
  total_duration_sec: number;
}

export interface TipsIdea {
  id?: number;
  category: TipsCategory;
  topic: string;
  description?: string;
  hook_pattern?: HookPattern;
  target_audience?: string;
  relevance_score: number;
  trending_score: number;
  seasonal_tag?: string;
  used_video_id?: number;
  discovered_at: number;
  used_at?: number;
}

// ═══════════════════════════════════════════════════════════
// Category rotation — 1 category per day
// ═══════════════════════════════════════════════════════════

/** Map day-of-week (0=Sun, 1=Mon, ...) → category. T2/T4/T6 only. */
const DAY_TO_CATEGORY: Record<number, TipsCategory | null> = {
  0: null,                  // Sun → Weekend Special
  1: 'booking_tips',        // Mon
  2: null,                  // Tue → cross-post day
  3: 'sonder_areas',        // Wed
  4: null,                  // Thu → Story
  5: 'seasonal_trends',     // Fri
  6: null,                  // Sat → Story
};

export function getTodayCategory(): TipsCategory | null {
  const now = new Date();
  const vnDay = new Date(now.getTime() + 7 * 3600 * 1000).getUTCDay();
  return DAY_TO_CATEGORY[vnDay];
}

// ═══════════════════════════════════════════════════════════
// Direct Claude call (giống story-engine pattern)
// ═══════════════════════════════════════════════════════════

async function callClaude(system: string, user: string, maxTokens = 3000): Promise<string> {
  const apiKey = getSetting('anthropic_api_key');
  if (!apiKey) throw new Error('anthropic_api_key not in settings');

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
  const text = ((r.data?.content || []).map((b: any) => b?.text || '').join('') || '').trim();
  if (!text) throw new Error('Claude empty response');
  return text;
}

// ═══════════════════════════════════════════════════════════
// Idea generator — Claude propose 5-10 ideas per category per request
// ═══════════════════════════════════════════════════════════

const IDEAS_SYSTEM = `Bạn là content strategist video Reels/Shorts cho Sonder — nền tảng lưu trú TP.HCM. Đề xuất chủ đề video tips du lịch HOT cho audience Việt Nam 22-40 tuổi.

QUY TẮC:
1. Topic phải có giá trị THỰC DỤNG (mẹo dùng được, không bla bla).
2. Tránh chủ đề đã quá nhàm: "10 quán cafe đẹp", "5 điểm du lịch Đà Lạt".
3. Tìm góc lạ, contrarian, hoặc data-driven.
4. Mỗi topic dùng được cho video 75s (5 tips concrete bên trong).

CÁC PATTERN HOOK VIRAL (gợi ý 1 cho mỗi topic):
- "number": "5 sai lầm 99% du khách Việt..."
- "authority": "Sau 50 chuyến đi, mình học được..."
- "question": "Bạn có biết Sài Gòn có 1 khu..."
- "time": "11 giờ đêm khi mình check-in..."
- "contradiction": "Đừng đặt phòng Q1 trừ khi..."

OUTPUT JSON ARRAY (KHÔNG markdown fence, không giải thích):
[
  {
    "topic": "5 sai lầm khi đặt vé máy bay nội địa khiến bạn mất tiền",
    "description": "Mistake: đặt cuối tuần, ko chọn ngày tránh peak, ko compare site",
    "hook_pattern": "number",
    "target_audience": "du khách trẻ 22-30",
    "relevance_score": 0.9,
    "trending_score": 0.8,
    "seasonal_tag": "evergreen"
  },
  ...
]`;

export async function generateIdeas(category: TipsCategory, count: number = 8): Promise<TipsIdea[]> {
  const month = new Date().getMonth() + 1;
  const seasonHint = getSeasonHint(month);

  const userPrompt = `Tạo ${count} chủ đề video tips category "${category}".

${getCategoryGuide(category)}

Bối cảnh hiện tại: tháng ${month} (${seasonHint}).

Output ${count} JSON objects trong array.`;

  const raw = await callClaude(IDEAS_SYSTEM, userPrompt, 2500);
  const parsed = parseJsonArray(raw);

  return parsed
    .filter((p: any) => p && p.topic)
    .slice(0, count)
    .map((p: any) => ({
      category,
      topic: String(p.topic).substring(0, 200),
      description: p.description ? String(p.description).substring(0, 300) : undefined,
      hook_pattern: validHookPattern(p.hook_pattern),
      target_audience: p.target_audience ? String(p.target_audience).substring(0, 100) : undefined,
      relevance_score: clamp(Number(p.relevance_score) || 0.7, 0, 1),
      trending_score: clamp(Number(p.trending_score) || 0.5, 0, 1),
      seasonal_tag: String(p.seasonal_tag || 'evergreen'),
      discovered_at: Date.now(),
    }));
}

function getCategoryGuide(c: TipsCategory): string {
  const guides: Record<TipsCategory, string> = {
    booking_tips: `Category: tips đặt phòng/vé (booking, săn deal, tránh scam).
Examples GOOD: "5 cách săn vé máy bay rẻ ít ai biết", "7 dấu hiệu phòng giá rẻ là scam"
Examples BAD (avoid): "10 app đặt phòng tốt nhất" (quá generic)`,

    sonder_areas: `Category: khu vực Sonder TP.HCM (Q1, Tân Bình, Bình Thạnh, sân bay).
Examples GOOD: "Q1 vs Tân Bình — chọn đâu ngủ qua đêm chuyến bay sớm?", "5 quán ăn 24h gần Sonder Airport"
Lưu ý: KHÔNG hard-sell, focus VALUE thực sự cho audience.`,

    seasonal_trends: `Category: trends seasonal theo tháng (lễ Tết 30/4, mùa hè, Trung Thu, Giáng Sinh).
Tháng hiện tại: chú trọng dịp đặc biệt, sự kiện sắp tới.
Examples GOOD: "5 nơi check-in Trung Thu chỉ 30 phút từ Q1", "Lễ 30/4 ở SG: 7 chỗ KHÔNG đông"`,
  };
  return guides[c];
}

function getSeasonHint(month: number): string {
  if ([12, 1, 2].includes(month)) return 'mùa đông + Tết';
  if ([3, 4, 5].includes(month)) return 'mùa xuân + lễ 30/4-1/5';
  if ([6, 7, 8].includes(month)) return 'mùa hè + nghỉ hè';
  return 'mùa thu + Giáng Sinh + Tết Tây';
}

function validHookPattern(p: any): HookPattern | undefined {
  const valid: HookPattern[] = ['number', 'authority', 'question', 'time', 'contradiction'];
  return valid.includes(p) ? p : undefined;
}

function parseJsonArray(raw: string): any[] {
  // Try direct parse
  try {
    const p = JSON.parse(raw);
    return Array.isArray(p) ? p : [];
  } catch {}

  // Try extract array
  const m = raw.match(/\[[\s\S]*\]/);
  if (!m) return [];
  try {
    const p = JSON.parse(m[0]);
    return Array.isArray(p) ? p : [];
  } catch { return []; }
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

// ═══════════════════════════════════════════════════════════
// Save ideas to DB (dedup by topic case-insensitive)
// ═══════════════════════════════════════════════════════════

export function saveIdeas(ideas: TipsIdea[]): { saved: number; skipped: number } {
  let saved = 0, skipped = 0;
  for (const idea of ideas) {
    try {
      const existing = db.prepare(
        `SELECT id FROM tips_ideas WHERE lower(topic) = lower(?) AND category = ?`
      ).get(idea.topic, idea.category);
      if (existing) { skipped++; continue; }

      db.prepare(`
        INSERT INTO tips_ideas
          (category, topic, description, hook_pattern, target_audience,
           relevance_score, trending_score, seasonal_tag, discovered_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        idea.category,
        idea.topic,
        idea.description || null,
        idea.hook_pattern || null,
        idea.target_audience || null,
        idea.relevance_score,
        idea.trending_score,
        idea.seasonal_tag || null,
        idea.discovered_at,
      );
      saved++;
    } catch (e: any) {
      console.warn('[tips-engine] save idea err:', e?.message);
    }
  }
  return { saved, skipped };
}

// ═══════════════════════════════════════════════════════════
// Pick next idea for given category (best score, unused)
// ═══════════════════════════════════════════════════════════

export function pickNextIdea(category: TipsCategory): TipsIdea | null {
  const row = db.prepare(`
    SELECT * FROM tips_ideas
    WHERE category = ? AND used_video_id IS NULL
    ORDER BY (relevance_score * 0.6 + trending_score * 0.4) DESC, discovered_at DESC
    LIMIT 1
  `).get(category) as TipsIdea | undefined;
  return row || null;
}

export function markIdeaUsed(ideaId: number, videoId: number): void {
  try {
    db.prepare(`UPDATE tips_ideas SET used_video_id = ?, used_at = ? WHERE id = ?`)
      .run(videoId, Date.now(), ideaId);
  } catch {}
}

// ═══════════════════════════════════════════════════════════
// Auto-replenish ideas pool (cron weekly)
// ═══════════════════════════════════════════════════════════

const MIN_UNUSED_PER_CATEGORY = 5;

export async function replenishIdeasIfLow(): Promise<{ generated: number; categories: string[] }> {
  const categories: TipsCategory[] = ['booking_tips', 'sonder_areas', 'seasonal_trends'];
  let totalGenerated = 0;
  const replenished: string[] = [];

  for (const cat of categories) {
    const count = (db.prepare(
      `SELECT COUNT(*) as n FROM tips_ideas WHERE category = ? AND used_video_id IS NULL`
    ).get(cat) as any).n;

    if (count < MIN_UNUSED_PER_CATEGORY) {
      console.log(`[tips-engine] category ${cat}: only ${count} unused → generate 8 new`);
      try {
        const ideas = await generateIdeas(cat, 8);
        const r = saveIdeas(ideas);
        totalGenerated += r.saved;
        replenished.push(cat);
      } catch (e: any) {
        console.warn(`[tips-engine] replenish ${cat} fail:`, e?.message);
      }
    }
  }

  return { generated: totalGenerated, categories: replenished };
}

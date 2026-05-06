/**
 * V5 Script Writer — 3 hook variants per post.
 *
 * Reference: skill sonder-content-v5 (3 variants A/B/C, 2 themes, 7 hooks)
 *
 * Pipeline:
 *   1. Pick theme (60% saigon_insider, 40% sonder_bts)
 *   2. Get available real footage (60% pillar)
 *   3. Pick 3 different hook patterns from 7 options
 *   4. Generate script body via Claude/Qwen
 *   5. Generate 3 hook variants (same body, different first 3s)
 *   6. Plan visual shots (real footage primary, AI fill gaps)
 *   7. Save v5_scripts row
 */

import { db } from '../../db';
import { generate } from '../router';
import type { V5Script, V5Theme, HookPattern, V5VisualPlan, V5Shot } from './types';

const HOOK_PATTERNS: HookPattern[] = [
  'textural_asmr',
  'time_location',
  'observational',
  'expectation_reality',
  'numerical_serial',
  'object_character',
  'guest_pov',
];

/** Pick theme respecting 60/40 split + recent rotation */
function pickTheme(): V5Theme {
  const recent5 = db.prepare(
    `SELECT theme FROM v5_scripts ORDER BY id DESC LIMIT 5`,
  ).all() as Array<{ theme: V5Theme }>;

  const insiderCount = recent5.filter(r => r.theme === 'saigon_insider').length;
  const btsCount = recent5.filter(r => r.theme === 'sonder_bts').length;

  // Target: 60% saigon_insider, 40% sonder_bts
  if (recent5.length >= 5) {
    if (insiderCount < 3) return 'saigon_insider';
    if (btsCount < 2) return 'sonder_bts';
  }

  // Random respecting probabilistic split
  return Math.random() < 0.6 ? 'saigon_insider' : 'sonder_bts';
}

/** Pick 3 distinct hook patterns from 7 options */
function pick3HookPatterns(theme: V5Theme): [HookPattern, HookPattern, HookPattern] {
  // Theme-appropriate patterns
  const candidates = theme === 'saigon_insider'
    ? ['textural_asmr', 'time_location', 'observational', 'numerical_serial', 'object_character'] as HookPattern[]
    : ['textural_asmr', 'observational', 'expectation_reality', 'object_character', 'guest_pov'] as HookPattern[];

  // Shuffle + take 3
  const shuffled = [...candidates].sort(() => Math.random() - 0.5);
  return [shuffled[0], shuffled[1], shuffled[2]];
}

/** Get available real footage for theme */
function getAvailableFootage(theme: V5Theme, limit = 20): Array<any> {
  const moments = theme === 'saigon_insider'
    ? ['street', 'cafe_vy', 'pho_quan', 'market', 'rain', 'morning_ride']
    : ['pha_tra_gung', 'san_dem', 'hanh_lang', 'check_in', 'cay_nhan', 'view_phong'];

  return db.prepare(
    `SELECT * FROM v5_footage
     WHERE used_count < 5
     ORDER BY used_count ASC, RANDOM()
     LIMIT ?`,
  ).all(limit);
}

/** Generate script body via LLM */
async function generateScriptBody(theme: V5Theme): Promise<{
  title: string;
  context_vo: string;
  encounter_vo: string;
  reflection_vo: string;
  closing_vo: string;
  loop_reward_visual: string;
  bgm_mood: string;
}> {
  const themePrompt = theme === 'saigon_insider'
    ? `Theme: SÀI GÒN INSIDER GUIDE — 1 góc nhìn riêng về Sài Gòn (quán phở 6h sáng, cafe Vy đối diện Sonder Q1, hẻm Bình Thạnh, mưa chiều, etc). Giá trị thực cho khách. Position Sonder = local insider, không phải hotel chain.`
    : `Theme: SONDER BEHIND-THE-SCENE — 1 moment hành động cụ thể tại Sonder. Chú Tuấn pha trà gừng, sảnh đèn vàng đêm mưa, khách check-in muộn được đợi. Brand value qua hành động, KHÔNG tuyên bố.`;

  const systemPrompt = `Em là content strategist Sonder Vietnam. Viết script cho Reels 15-30s.

PHILOSOPHY (BẮT BUỘC):
- POV "mình" (intimate, không phải "các bạn")
- Ý tự thành: brand value qua HÀNH ĐỘNG, không qua TUYÊN BỐ
- KHÔNG mention "Sonder", "đặt phòng", "khách sạn" trong script
- KHÔNG hard-sell
- Thơ, cụ thể, sensory
- Tên VN thật (Linh, Tuấn, Vy, Khanh, Hà)

${themePrompt}

OUTPUT JSON:
{
  "title": "<4-7 từ, dùng cho admin tracking>",
  "context_vo": "<5-8s VO, ~15-20 từ, thiết lập where+when>",
  "encounter_vo": "<8-15s VO, ~25-35 từ, hành động cụ thể>",
  "reflection_vo": "<3-5s VO, ~8-12 từ, ý tự thành>",
  "closing_vo": "<2-3s VO, ~5-8 từ, poetic loop reward>",
  "loop_reward_visual": "<describe visual ECHO opening shot in English>",
  "bgm_mood": "warm" | "calm" | "cinematic" | "intimate" | "uplifting"
}

Total VO ~50-70 từ tiếng Việt. Cut every 2-3 giây.`;

  const userPrompt = `Generate 1 V5 Reels script. Theme đã chọn ở system prompt. Output JSON only, no markdown wrapper.`;

  try {
    const text = (await generate({
      task: 'caption',
      system: systemPrompt,
      user: userPrompt,
    })).trim();
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('no JSON in LLM output');
    const parsed = JSON.parse(jsonMatch[0]);

    return {
      title: parsed.title || 'Untitled',
      context_vo: parsed.context_vo || '',
      encounter_vo: parsed.encounter_vo || '',
      reflection_vo: parsed.reflection_vo || '',
      closing_vo: parsed.closing_vo || '',
      loop_reward_visual: parsed.loop_reward_visual || '',
      bgm_mood: parsed.bgm_mood || 'warm',
    };
  } catch (e: any) {
    console.warn('[v5-script-writer] body gen fail:', e.message);
    throw e;
  }
}

/** Generate 1 hook variant for given pattern */
async function generateHookVariant(
  theme: V5Theme,
  pattern: HookPattern,
  bodyContext: string,
): Promise<{ pattern: HookPattern; vo_text: string; visual_prompt: string }> {
  const patternGuide: Record<HookPattern, string> = {
    textural_asmr: 'Macro close-up texture, ZERO voiceover 0-3s. Hơi nóng, hạt mưa, tay viết. ASMR feel. KHÔNG VO.',
    time_location: 'Format "<giờ chính xác>. <địa điểm chính xác>." VD: "5h45 sáng. Hẻm Bình Thạnh."',
    observational: '1 chi tiết người khác bỏ qua. VD: "Chú Tuấn không hỏi mình từ đâu đến."',
    expectation_reality: '"<Expectation>. Nhưng <reality>." VD: "Tưởng đêm SG ồn. Hoá ra phòng này yên hơn nhà cũ."',
    numerical_serial: '"<Ngày/Tuần/Lần thứ N> tại <địa điểm>. <hành động>." VD: "Đêm thứ 3 tại Sài Gòn. Mình chưa gọi điện về nhà."',
    object_character: 'First 3s = close-up 1 vật → reveal owner muộn. VD: "Chìa khoá đồng. Tay Linh xoay nhẹ."',
    guest_pov: 'Real guest POV. VD: "Lần thứ 4 tôi quay lại. Vẫn chú Tuấn ấy."',
  };

  const systemPrompt = `Em là Sonder content strategist. Generate 1 hook (3 giây đầu) cho Reels.

HOOK PATTERN: ${pattern}
GUIDE: ${patternGuide[pattern]}

THEME: ${theme}
BODY CONTEXT: ${bodyContext}

Output JSON:
{
  "vo_text": "<VO 0-3s, max 10 từ. Có thể empty nếu textural_asmr>",
  "visual_prompt": "<English, describe macro close-up shot 0-3s, vertical 9:16>"
}

Hook MUST be silent visual + textural. KHÔNG explain, KHÔNG title card.`;

  try {
    const text = (await generate({
      task: 'caption',
      system: systemPrompt,
      user: 'Generate hook JSON only.',
    })).trim();
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('no JSON');
    const parsed = JSON.parse(jsonMatch[0]);

    return {
      pattern,
      vo_text: parsed.vo_text || '',
      visual_prompt: parsed.visual_prompt || '',
    };
  } catch (e: any) {
    console.warn(`[v5-script-writer] hook variant ${pattern} fail:`, e.message);
    return { pattern, vo_text: '', visual_prompt: '' };
  }
}

/** Plan visual shots — real footage primary, AI fill gaps */
function planVisualShots(
  theme: V5Theme,
  totalDurationSec: number,
  availableFootage: any[],
): V5VisualPlan {
  const shots: V5Shot[] = [];
  const cutInterval = 2.5; // seconds per shot
  const numShots = Math.ceil(totalDurationSec / cutInterval);
  let currentSec = 0;

  for (let i = 0; i < numShots; i++) {
    const startSec = currentSec;
    const endSec = Math.min(currentSec + cutInterval, totalDurationSec);

    // 60% real footage, 30% ai_image, 10% ai_video
    const r = Math.random();
    if (r < 0.6 && availableFootage.length > 0) {
      // Real footage — pick least-used clip
      const footage = availableFootage[i % availableFootage.length];
      shots.push({
        shot_no: i + 1,
        start_sec: startSec,
        end_sec: endSec,
        source: 'real_footage',
        footage_id: footage.id,
      });
    } else if (r < 0.9) {
      shots.push({
        shot_no: i + 1,
        start_sec: startSec,
        end_sec: endSec,
        source: 'ai_image',
        ai_provider: 'fal_flux',
        ai_prompt: `Sonder Vietnam ${theme}, vertical 9:16, cinematic warm light, shot ${i + 1}/${numShots}`,
      });
    } else {
      shots.push({
        shot_no: i + 1,
        start_sec: startSec,
        end_sec: endSec,
        source: 'ai_video',
        ai_provider: 'fal_wan',
        ai_prompt: `Sonder Vietnam ${theme}, motion shot, vertical 9:16`,
      });
    }

    currentSec = endSec;
  }

  return { shots };
}

/** Main entry — generate 1 complete V5 script with 3 hooks */
export async function generateV5Script(opts?: {
  theme?: V5Theme;
  generated_by?: string;
}): Promise<V5Script | null> {
  const theme = opts?.theme || pickTheme();
  console.log(`[v5-script-writer] generating script for theme=${theme}`);

  try {
    // 1. Generate script body
    const body = await generateScriptBody(theme);

    // 2. Pick 3 hook patterns
    const [pA, pB, pC] = pick3HookPatterns(theme);

    // 3. Generate 3 hook variants (parallel)
    const bodyContext = `${body.context_vo} ${body.encounter_vo}`.slice(0, 200);
    const [hookA, hookB, hookC] = await Promise.all([
      generateHookVariant(theme, pA, bodyContext),
      generateHookVariant(theme, pB, bodyContext),
      generateHookVariant(theme, pC, bodyContext),
    ]);

    // 4. Get available footage + plan shots
    const footage = getAvailableFootage(theme);
    const totalDuration = 25; // target 20-30s
    const visualPlan = planVisualShots(theme, totalDuration, footage);

    // 5. Persist to DB
    const now = Date.now();
    const r = db.prepare(
      `INSERT INTO v5_scripts
       (theme, title, body_json, hook_a_json, hook_b_json, hook_c_json,
        visual_plan_json, loop_reward_visual, bgm_mood, total_duration_target_sec,
        status, generated_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)`,
    ).run(
      theme, body.title,
      JSON.stringify({
        context_vo: body.context_vo,
        encounter_vo: body.encounter_vo,
        reflection_vo: body.reflection_vo,
        closing_vo: body.closing_vo,
      }),
      JSON.stringify(hookA),
      JSON.stringify(hookB),
      JSON.stringify(hookC),
      JSON.stringify(visualPlan),
      body.loop_reward_visual,
      body.bgm_mood,
      totalDuration,
      opts?.generated_by || 'manual',
      now,
    );

    const id = r.lastInsertRowid as number;
    console.log(`[v5-script-writer] ✅ generated script id=${id} theme=${theme} title="${body.title}"`);

    return {
      id,
      theme,
      title: body.title,
      arc_id: null,
      context_vo: body.context_vo,
      encounter_vo: body.encounter_vo,
      reflection_vo: body.reflection_vo,
      closing_vo: body.closing_vo,
      hook_a: hookA,
      hook_b: hookB,
      hook_c: hookC,
      visual_plan: visualPlan,
      loop_reward_visual: body.loop_reward_visual,
      bgm_mood: body.bgm_mood as any,
      total_duration_target_sec: totalDuration,
      status: 'draft',
      created_at: now,
      generated_by: opts?.generated_by || 'manual',
    };
  } catch (e: any) {
    console.error('[v5-script-writer] FATAL:', e.message);
    return null;
  }
}

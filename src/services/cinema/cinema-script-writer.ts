/**
 * Cinema Script Writer — Claude Sonnet 4.6 generate 5-7 phút long-form script.
 *
 * Output: 3-act structure với 18-23 shots.
 * Each shot có voiceover_text VN + visual_prompt ENG + shot_type (cho tool routing).
 *
 * Continuity: read-only từ story_continuity (Anthology facts).
 * KHÔNG ghi vào story_continuity (tách biệt 100%).
 *
 * Reference skill: sonder-cinema
 */

import axios from 'axios';
import { db, getSetting } from '../../db';

// (getSetting is now used inside generateCinemaScript to resolve cinema_target_duration_sec)

// ═══════════════════════════════════════════════════════════
// Types — locked by sonder-cinema skill
// ═══════════════════════════════════════════════════════════

export type Act = 'cold_open' | 'title' | 'act1' | 'act2' | 'act3' | 'outro';
export type ShotType = 'HERO_ESTABLISHING' | 'CHARACTER_SCENE' | 'ATMOSPHERIC_BROLL' | 'TALKING_HEAD';

export interface CinemaShot {
  shot_no: number;                      // 1..23
  act: Act;
  shot_type: ShotType;
  voiceover_text: string;               // VN, "" nếu không có VO (cold open)
  visual_prompt: string;                // ENG cho video gen
  duration_target_sec: number;
  director_note?: string;
  /** PLAN B HYBRID FLAGS — drive cost-optimized provider routing */
  has_character?: boolean;              // shot có nhân vật close-up?
  money_shot?: boolean;                 // shot critical face quality (Hailuo locked)?
  stock_query?: string;                 // ENG keywords cho Pexels search (if applicable)
}

export interface CinemaScript {
  // Identity
  title: string;                        // "Một Đêm Ở Sonder"
  primary_character: string;            // linh | tuan | vy | khanh | ha | tai
  secondary_characters?: string[];

  // 3-Act story
  premise: string;                      // 1-2 sentences concept
  cold_open_text?: string;              // optional VO line cho cold open
  title_card_text: string;              // "Sonder Cinema #N: Title"
  closing_line: string;                 // poetic last words

  // Shot list
  shots: CinemaShot[];                  // 18-23 shots

  // Brand metadata
  brand_values_used: string[];          // 1-2 value_keys
  bgm_mood: 'warm' | 'calm' | 'cinematic' | 'intimate' | 'uplifting';

  // Captions
  caption_yt: string;                   // YouTube long-form description
  caption_fb_teaser: string;            // FB Reels 60s teaser caption
  hashtags: string[];                   // 1-3 max

  // Continuity refs (read-only from Anthology)
  references_anthology_facts: string[]; // fact_keys referenced

  // Totals
  total_duration_target_sec: number;    // 300-420
  total_words_vn: number;
}

// ═══════════════════════════════════════════════════════════
// DURATION-AWARE SCALING — Pilot Mode (60s) | Mid (180s) | Full (360s)
// ═══════════════════════════════════════════════════════════

interface DurationProfile {
  total_sec: number;
  total_words: { min: number; max: number };
  shots: { min: number; max: number };
  shot_avg_sec: number;
  acts_breakdown: string;
  cold_open_sec: number;
  act_distribution: { act1: number; act2: number; act3: number; outro: number };
  is_pilot: boolean;
}

function getDurationProfile(targetSec: number): DurationProfile {
  if (targetSec <= 90) {
    // Pilot Mode: 60-90s — test quality before scaling up
    return {
      total_sec: targetSec,
      total_words: { min: 100, max: 180 },
      shots: { min: 5, max: 7 },
      shot_avg_sec: 10,
      acts_breakdown: 'cold open 6s + act1 18s + act2 24s + act3 12s',
      cold_open_sec: 6,
      act_distribution: { act1: 18, act2: 24, act3: 12, outro: 0 },
      is_pilot: true,
    };
  }
  if (targetSec <= 220) {
    // Mid: 3 minutes — proof of concept for longer
    return {
      total_sec: targetSec,
      total_words: { min: 300, max: 480 },
      shots: { min: 10, max: 14 },
      shot_avg_sec: 14,
      acts_breakdown: 'cold open 10s + title 5s + act1 50s + act2 75s + act3 35s + outro 10s',
      cold_open_sec: 10,
      act_distribution: { act1: 50, act2: 75, act3: 35, outro: 10 },
      is_pilot: false,
    };
  }
  // Full Cinema: 5-7 min (default)
  return {
    total_sec: targetSec,
    total_words: { min: 600, max: 900 },
    shots: { min: 18, max: 23 },
    shot_avg_sec: 16,
    acts_breakdown: 'cold open 15s + title 5s + act1 90s + act2 180s + act3 90s + outro 15s',
    cold_open_sec: 15,
    act_distribution: { act1: 90, act2: 180, act3: 90, outro: 15 },
    is_pilot: false,
  };
}

// ═══════════════════════════════════════════════════════════
// SYSTEM PROMPT — dynamically scaled by duration profile
// ═══════════════════════════════════════════════════════════

function buildSystemPrompt(profile: DurationProfile): string {
  const modeLabel = profile.is_pilot
    ? `PILOT MODE — ${profile.total_sec}s short cinema (test quality)`
    : profile.total_sec <= 220
      ? `MID MODE — ${profile.total_sec}s mid cinema`
      : `FULL MODE — ${profile.total_sec}s long-form cinema`;

  const structureSection = profile.is_pilot
    ? `═══════════════════════════════════════════════════════════════
STRUCTURE PILOT MODE (LOCKED — total ${profile.total_sec}s):
═══════════════════════════════════════════════════════════════

COLD OPEN (${profile.cold_open_sec}s, 1 shot):
  1 hero shot KHÔNG voiceover. Visual hook ngắn gọn.
  → Use HERO_ESTABLISHING

ACT I — SETUP (${profile.act_distribution.act1}s, 1-2 shots):
  Establish character + context NHANH. POV "mình".
  → Use CHARACTER_SCENE + 1 ATMOSPHERIC_BROLL

ACT II — ENCOUNTER (${profile.act_distribution.act2}s, 2-3 shots) ★★★ TRỌNG TÂM ★★★:
  1 moment chính. Brand value 1 thấm qua hành động.
  → Use CHARACTER_SCENE + ATMOSPHERIC_BROLL hoặc TALKING_HEAD

ACT III — REFLECTION (${profile.act_distribution.act3}s, 1-2 shots):
  Closing line poetic. Fade logo.
  → Use ATMOSPHERIC_BROLL hoặc HERO_ESTABLISHING

LƯU Ý PILOT MODE: KHÔNG có TITLE CARD, KHÔNG có OUTRO riêng.
Closing line đặt trong Act III. Logo fade trong shot cuối.`
    : `═══════════════════════════════════════════════════════════════
3-ACT STRUCTURE (LOCKED — total ${profile.total_sec}s):
${profile.acts_breakdown}
═══════════════════════════════════════════════════════════════

COLD OPEN (${profile.cold_open_sec}s, 1 shot):
  1 hero shot KHÔNG voiceover. Visual hook duy nhất.

TITLE CARD (5-10s, 1 shot):
  "Sonder Cinema #N: Title" + 1 VO line 8-12 từ.

ACT I — SETUP (${profile.act_distribution.act1}s, 3-5 shots):
  Establish character + context + stake.

ACT II — STORY/CONFLICT (${profile.act_distribution.act2}s, 5-8 shots) ★★★ TRỌNG TÂM ★★★:
  Friction → Encounter → Realization
  Brand values 1-2 thấm qua HÀNH ĐỘNG.

ACT III — REFLECTION (${profile.act_distribution.act3}s, 3-5 shots) ★ Ý TỰ THÀNH ★:
  Inner monologue, payoff. Poetic closing line.

OUTRO (${profile.act_distribution.outro}s, 1 shot):
  Atmospheric + Sonder logo fade in.`;

  return `Bạn là biên kịch trưởng "Sonder Cinema" — ${modeLabel}. Đây là LITERATURE/CINEMA premium chất lượng cao. Audience: 22-40 tuổi VN.

═══════════════════════════════════════════════════════════════
TRIẾT LÝ CINEMA (BẤT KHẢ XÂM PHẠM):
═══════════════════════════════════════════════════════════════

1. LONG-FORM ARC — 5-7 phút trọn vẹn 1 chương sâu của character
2. CINEMATIC PRODUCTION — premium tools (Veo/Hailuo/Hedra)
3. KHÔNG QUẢNG CÁO — tuyệt đối KHÔNG mention "Sonder", "khách sạn", "đặt phòng"
4. Ý TỰ THÀNH — brand values qua HÀNH ĐỘNG, không qua TUYÊN BỐ
5. POV "mình"/"tôi" — Tiếng Việt đời thường

${structureSection}

═══════════════════════════════════════════════════════════════
HYBRID COST OPTIMIZATION (BẮT BUỘC mỗi shot):
═══════════════════════════════════════════════════════════════

Mỗi shot PHẢI có 3 flags để route đến tool rẻ nhất phù hợp:

1. has_character (boolean):
   • true  = shot có nhân vật (Linh, Tuấn, Vy...) close-up hoặc medium shot
   • false = wide cảnh ngoại, atmospheric, b-roll macro, không có khuôn mặt cụ thể

2. money_shot (boolean):
   • true  = shot face critical (Hailuo Pro locked — best face consistency)
   • false = shot bình thường (có thể dùng Wan rẻ hơn)
   • LIMIT: max 1-2 money_shot/episode để tiết kiệm chi phí

3. stock_query (string, OPTIONAL):
   • Set khi has_character=false: ENG keywords để search Pexels free stock
   • Ví dụ: "saigon street rain night", "vietnamese tea cup macro", "hotel lobby warm light"
   • LEAVE EMPTY nếu shot phải AI gen (có character, action cụ thể)

ROUTING RESULT (auto-pick by storyboard):
  has_character=false + stock_query   → Pexels FREE → Luma free → Wan paid
  has_character=true + money_shot=true → Hailuo Pro $0.49 (locked, no fallback)
  has_character=true + money_shot=false → Wan cheap → Hailuo fallback
  TALKING_HEAD shots                   → Hedra (lip-sync required)
  ATMOSPHERIC_BROLL                    → Pexels FREE → Seedance fallback

GUIDELINE PILOT 60s (5-7 shots):
  - 2-3 shots NO character (cold open + 1-2 b-roll + outro) → set stock_query
  - 1 money_shot character close-up → has_character=true, money_shot=true
  - 1-2 character action wide → has_character=true, money_shot=false
  - 0-1 talking head dialogue → shot_type=TALKING_HEAD

═══════════════════════════════════════════════════════════════
SHOT TYPE ROUTING (BẮT BUỘC chọn 1 type/shot):
═══════════════════════════════════════════════════════════════

HERO_ESTABLISHING — wide cinematic, atmospheric (Veo 3.1)
  ✅ Wide drone Sài Gòn golden hour
  ✅ Cảnh đêm mưa Bến Thành nhìn từ taxi
  → 6-12s mỗi shot. Use cho cold open + outro + acts mở đầu.

CHARACTER_SCENE — close-up nhân vật action (Hailuo 2.3 Pro)
  ✅ Linh đi bộ vào sảnh khách sạn
  ✅ Tuấn pha trà tỉ mỉ
  → 6-10s. Best face/micro-expression consistency.

ATMOSPHERIC_BROLL — texture detail close-up (Seedance Fast — RẺ)
  ✅ Ly trà bốc khói macro
  ✅ Tay viết vào nhật ký, hạt mưa lăn trên cửa sổ
  → 4-8s. Use NHIỀU cho texture (rẻ).

TALKING_HEAD — character nói thẳng máy quay (Hedra Character-3)
  ✅ Tuấn POV "Tôi không hỏi gì. Tôi pha trà..."
  ✅ Linh viết nhật ký vừa nói thầm
  → 8-15s. Lip-sync. Use 2-3 shots/episode trong Act II.

═══════════════════════════════════════════════════════════════
4 BRAND VALUES (chọn 1-2 thấm qua):
═══════════════════════════════════════════════════════════════

• respect_individual — không hỏi "đi với ai", không phán xét, gọi tên
• warm_like_home — trà gừng pha sẵn, đèn vàng, gia vị Việt sẵn
• understand_local — gợi ý quán phở 6h sáng cụ thể, biết cafe yên cuối tuần
• always_someone_waits — 11h đêm vẫn lễ tân pha trà, không "self check-in"

═══════════════════════════════════════════════════════════════
ANTI-PATTERNS — TUYỆT ĐỐI KHÔNG VIẾT:
═══════════════════════════════════════════════════════════════

❌ "Sonder cam kết phục vụ 24/7"
❌ "Đặt phòng Sonder ngay" / "Inbox" / "Gọi ngay"
❌ "Trải nghiệm khó quên" / "Khám phá" / "Tinh hoa"
❌ Tên Western (Mary, John) — chỉ tên VN trong character pool
❌ Stock generic "luxury hotel"
❌ Hashtag spam #saigon #travel
❌ Emoji rườm rà (tối đa 1 nhẹ ở caption đầu)

═══════════════════════════════════════════════════════════════
CHARACTER POOL (6 chars):
═══════════════════════════════════════════════════════════════

• Linh (28, female, main_protagonist) — vừa từ ĐN về SG, viết nhật ký
• Tuấn (54, male, staff_anchor) — lễ tân Sonder Airport 8 năm, pha trà
• Vy (32, female, external_observer) — chủ cafe đối diện Sonder Q1, ly hôn 1 con
• Khanh (35, male, returning_guest) — Hàn Quốc, business trip lần 5
• Hà (62, female, family_visitor) — mẹ Linh ở Đà Nẵng
• Tài (24, male, long_term_resident) — sinh viên freelance, ở Sonder Phú Nhuận

═══════════════════════════════════════════════════════════════
LOCATIONS (4 properties Sonder):
═══════════════════════════════════════════════════════════════

• Sonder Airport (Tân Bình) — sảnh đèn vàng, trà gừng, Tuấn anchor
• Sonder Q1 — rooftop view Bitexco, cafe Vy đối diện
• Sonder Bình Thạnh — view sông SG + Landmark 81, hẻm yên
• Sonder Phú Nhuận — hẻm sâu, garden hoa muống, Tài's spot

═══════════════════════════════════════════════════════════════
CONTINUITY (BẮT BUỘC tôn trọng từ Anthology):
═══════════════════════════════════════════════════════════════

User sẽ inject Anthology facts đã established (story_continuity table).
→ KHÔNG được contradict. Linh đã ăn phở Bà Tám HVT (fact ep#13) → tập Cinema này phải biết Linh đã ăn rồi.
→ Có thể callback explicit ("Tuấn nhớ cô gái mai trước ăn phở rồi") hoặc tacit (Linh không cần được giới thiệu quán nữa).

═══════════════════════════════════════════════════════════════
JSON SAFETY RULES (BẮT BUỘC):
═══════════════════════════════════════════════════════════════

✅ Inside string values, dùng dấu nháy đơn ' hoặc em-dash — cho dialogue
   ✅ "voiceover_text": "Chú nói: 'Phở Ba Tám đường Hoàng Văn Thụ.'"
❌ KHÔNG dùng " bên trong string value
✅ KHÔNG smart quotes " " ' '
✅ KHÔNG trailing comma trước } hoặc ]
✅ Dùng \\n cho newline, không newline thật

═══════════════════════════════════════════════════════════════
OUTPUT FORMAT (JSON only, không markdown fence):
═══════════════════════════════════════════════════════════════

{
  "title": "<4-7 từ VN>",
  "primary_character": "<slug>",
  "secondary_characters": ["<slug>", ...],
  "premise": "<1-2 sentence concept>",
  "cold_open_text": "<optional VO 8-12 từ HOẶC empty string>",
  "title_card_text": "Sonder Cinema #N: <title>",
  "closing_line": "<poetic 1 sentence VN>",
  "shots": [
    {
      "shot_no": 1, "act": "cold_open", "shot_type": "HERO_ESTABLISHING",
      "voiceover_text": "",
      "visual_prompt": "<ENG detailed cinematic prompt>",
      "duration_target_sec": 12,
      "director_note": "no VO, ambient SG night sound",
      "has_character": false,
      "money_shot": false,
      "stock_query": "saigon hotel lobby night warm amber"
    },
    ... ${profile.shots.min}-${profile.shots.max} shots total ...
    { "shot_no": <last>, "act": "${profile.is_pilot ? 'act3' : 'outro'}", "shot_type": "ATMOSPHERIC_BROLL",
      "voiceover_text": "${profile.is_pilot ? '<closing line>' : ''}", "visual_prompt": "...",
      "duration_target_sec": ${profile.is_pilot ? 6 : 15},
      "director_note": "fade in Sonder logo bottom-right slowly" }
  ],
  "brand_values_used": ["${profile.is_pilot ? 'warm_like_home' : 'warm_like_home, understand_local'}"],
  "bgm_mood": "warm",
  "caption_yt": "<YT description ${profile.is_pilot ? '80-200' : '200-500'} chars, poetic, no CTA>",
  "caption_fb_teaser": "<FB caption ${profile.is_pilot ? 'KHÔNG CẦN — same as caption_yt' : 'cho 60s teaser cut, 80-200 chars'}>",
  "hashtags": ["#sondervn"],
  "references_anthology_facts": ["linh.first_pho_saigon", ...],
  "total_duration_target_sec": ${profile.total_sec},
  "total_words_vn": <number trong khoảng ${profile.total_words.min}-${profile.total_words.max}>
}

QUY TẮC FINAL:
- Total ${profile.shots.min}-${profile.shots.max} shots, ${profile.total_sec}s (±10%)
- Voiceover ALL shots: ${profile.total_words.min}-${profile.total_words.max} từ VN total
- Closing line PHẢI poetic, KHÔNG CTA, KHÔNG mention Sonder
- visual_prompt MAX ${profile.is_pilot ? '180' : '300'} chars/shot (concise English keywords + camera + lighting)
- director_note MAX ${profile.is_pilot ? '60' : '120'} chars/shot (single sentence)
- ${profile.is_pilot ? 'PILOT MODE: bỏ TITLE CARD và OUTRO riêng. Closing line nằm trong Act III shot cuối. Brand value chỉ 1 (không 2). Caption_yt 80-200 chars (KHÔNG cần caption_fb_teaser riêng — copy same).' : ''}
- Output JSON only. Không giải thích. KHÔNG markdown fence.`;
}

// ═══════════════════════════════════════════════════════════
// Build user prompt — inject character + location + Anthology continuity
// ═══════════════════════════════════════════════════════════

interface BuildPromptOpts {
  primary_character: string;
  secondary_characters?: string[];
  episode_idea: string;             // admin gợi ý
  episode_no: number;
  characterProfile: any;
  secondaryProfiles?: any[];
  recentAnthologyFacts: any[];
  recentAnthologyEpisodes: any[];
}

function buildUserPrompt(opts: BuildPromptOpts): string {
  const monthVN = new Date().getMonth() + 1;
  const yearVN = new Date().getFullYear();

  const charBlock = `
- slug: ${opts.characterProfile.slug}
- name: ${opts.characterProfile.name}
- age: ${opts.characterProfile.age}
- role: ${opts.characterProfile.role}
- backstory: ${opts.characterProfile.backstory}
- visual_prompt (cho image gen): ${opts.characterProfile.visual_prompt}
- signature_props: ${opts.characterProfile.signature_props}`;

  const secBlock = opts.secondaryProfiles && opts.secondaryProfiles.length
    ? opts.secondaryProfiles.map((c) => `\n- ${c.slug} (${c.name}, ${c.age}t, ${c.role}): ${c.backstory}`).join('\n')
    : '  (none — solo episode)';

  const factsBlock = opts.recentAnthologyFacts.length
    ? opts.recentAnthologyFacts.map((f: any) => `  - ${f.fact_key}: ${f.fact_value}`).join('\n')
    : '  (chưa có fact established về character này)';

  const recentBlock = opts.recentAnthologyEpisodes.length
    ? opts.recentAnthologyEpisodes.slice(0, 5).map((e: any, i: number) =>
        `  ${i + 1}. Ep#${e.episode_no} "${e.title || ''}" — ${(e.caption || '').slice(0, 120)}`
      ).join('\n')
    : '  (chưa có anthology episode)';

  return `# RUNTIME CONTEXT
Cinema Episode #${opts.episode_no} | Tháng ${monthVN}/${yearVN}

# PRIMARY CHARACTER (read from story_characters table)
${charBlock}

# SECONDARY CHARACTERS
${secBlock}

# ANTHOLOGY CONTINUITY (read-only — KHÔNG được contradict)

## Recent Anthology episodes featuring ${opts.characterProfile.name}:
${recentBlock}

## Established facts (story_continuity table):
${factsBlock}

# EPISODE IDEA (admin direction)
${opts.episode_idea}

# YOUR TASK

Viết 1 cinema episode 5-7 phút theo 3-act structure:
1. CONTINUITY first — đọc kỹ Anthology facts. KHÔNG contradict. Có thể callback.
2. 18-23 shots với shot_type chính xác (HERO/CHARACTER/BROLL/TALKING).
3. Cold open visual hook + outro silent fade logo.
4. Brand values 1-2 thấm qua hành động.
5. Closing line poetic.
6. references_anthology_facts list các facts đã callback.

Output JSON only.`;
}

// ═══════════════════════════════════════════════════════════
// Claude call
// ═══════════════════════════════════════════════════════════

async function callClaude(system: string, user: string, maxTokens = 8000): Promise<string> {
  const apiKey = getSetting('anthropic_api_key') || process.env.CLAUDE_API_KEY;
  if (!apiKey) throw new Error('anthropic_api_key not set');

  // Promise.race robust timeout — axios timeout + AbortController đều có thể fail
  // với long-running streaming responses từ Claude API. Promise.race guarantees
  // exactly one promise wins.
  const HARD_TIMEOUT_MS = 240_000;     // 4 min hard ceiling
  const controller = new AbortController();

  const apiCall: Promise<string> = (async () => {
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
        timeout: HARD_TIMEOUT_MS,
        signal: controller.signal,
      },
    );
    const text = ((r.data?.content || []).map((b: any) => b?.text || '').join('') || '').trim();
    if (!text) throw new Error('Claude returned empty response');
    return text;
  })();

  let timeoutId: NodeJS.Timeout | null = null;
  const timeoutPromise: Promise<never> = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      try { controller.abort(); } catch {}
      reject(new Error(`Claude API hard-timeout (${HARD_TIMEOUT_MS / 1000}s) — Promise.race fired`));
    }, HARD_TIMEOUT_MS);
  });

  try {
    const result = await Promise.race([apiCall, timeoutPromise]);
    return result;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

// ═══════════════════════════════════════════════════════════
// JSON repair (same robust 3-pass as anthology)
// ═══════════════════════════════════════════════════════════

function repairInnerQuotes(jsonText: string): string {
  return jsonText.replace(
    /("(?:[a-z_][a-z_0-9]*)"\s*:\s*")([\s\S]*?)("\s*(?=[,}\]\n]))/gi,
    (_match, prefix: string, content: string, suffix: string) => {
      const fixed = content.replace(/(?<!\\)"/g, '\\"');
      return prefix + fixed + suffix;
    },
  );
}

/**
 * Pass 4: insert missing commas between adjacent objects/strings in arrays.
 * Common Claude mistake — forgets comma between array elements.
 */
function repairMissingCommas(jsonText: string): string {
  return jsonText
    // }\n  { → },\n  {  (between objects in array)
    .replace(/\}(\s*\n\s*)\{/g, '},$1{')
    // ]\n  [ → ],\n  [  (between arrays)
    .replace(/\](\s*\n\s*)\[/g, '],$1[')
    // "..."\n  "..." → "...",\n  "..."  (between strings in array — careful, only inside arrays)
    .replace(/"(\s*\n\s*)"/g, '",$1"')
    // }  "key":  → },  "key":  (forgot comma between key:value pairs in object)
    .replace(/(\}|"|\d|true|false|null)(\s*\n\s*)"([a-z_][a-z_0-9]*)"\s*:/gi, '$1,$2"$3":');
}

function extractJSON(raw: string): any {
  let cleaned = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
  const m = cleaned.match(/\{[\s\S]*\}/);
  if (m) cleaned = m[0];

  try { return JSON.parse(cleaned); }
  catch {
    // Pass 1: smart quotes + trailing commas
    let fixed = cleaned
      .replace(/[‘’]/g, "'")
      .replace(/[“”]/g, '"')
      .replace(/,(\s*[}\]])/g, '$1');
    try { return JSON.parse(fixed); }
    catch {
      // Pass 2: missing commas between elements
      let withCommas = repairMissingCommas(fixed);
      try { return JSON.parse(withCommas); }
      catch {
        // Pass 3: inner unescaped quotes
        const repaired = repairInnerQuotes(withCommas);
        try { return JSON.parse(repaired); }
        catch (e: any) {
          // Save full raw to /tmp for debug
          try {
            const fs = require('fs');
            const dumpPath = `/tmp/cinema-script-fail-${Date.now()}.txt`;
            fs.writeFileSync(dumpPath, `=== ORIGINAL ===\n${raw}\n\n=== AFTER PASS 1+2+3 ===\n${repaired}`);
            console.error(`[cinema-script] full raw dumped to ${dumpPath}`);
          } catch {}
          console.error(`[cinema-script] JSON parse fail (4 passes): ${e.message}`);
          console.error(`[cinema-script] first 500: ${raw.slice(0, 500)}`);
          console.error(`[cinema-script] last 300: ${raw.slice(-300)}`);
          throw new Error(`Cannot parse JSON: ${e.message}`);
        }
      }
    }
  }
}

// ═══════════════════════════════════════════════════════════
// Validation
// ═══════════════════════════════════════════════════════════

const FORBIDDEN_NARRATION = [
  /sonder/i, /khách\s*sạn/i, /đặt\s*phòng/i, /inbox/i,
  /gọi\s*ngay/i, /\bcam\s*kết\b/i, /\btự\s*hào\b/i,
  /trải\s*nghiệm\s*khó\s*quên/i, /khám\s*phá/i,
  /tinh\s*hoa/i, /đỉnh\s*cao/i,
];

export interface ValidationResult { ok: boolean; warnings: string[]; errors: string[]; }

function validateScript(script: CinemaScript, profile: DurationProfile): ValidationResult {
  const warnings: string[] = [];
  const errors: string[] = [];

  // Shots count — duration-aware
  const minShots = Math.max(3, profile.shots.min - 2);
  const maxShots = profile.shots.max + 3;
  if (!Array.isArray(script.shots) || script.shots.length < minShots || script.shots.length > maxShots) {
    errors.push(`shots must be ${profile.shots.min}-${profile.shots.max} (got ${script.shots?.length})`);
  }

  // Total duration — ±20% tolerance
  const minDur = Math.round(profile.total_sec * 0.7);
  const maxDur = Math.round(profile.total_sec * 1.3);
  if (script.total_duration_target_sec < minDur || script.total_duration_target_sec > maxDur) {
    warnings.push(`total_duration ${script.total_duration_target_sec}s outside ${minDur}-${maxDur}s target`);
  }

  // Forbidden words in voiceover (combined all shots)
  const allVO = (script.shots || []).map((s) => s.voiceover_text).join(' \n ')
    + (script.cold_open_text || '') + ' ' + (script.closing_line || '');
  for (const re of FORBIDDEN_NARRATION) {
    if (re.test(allVO)) errors.push(`forbidden pattern in narration: ${re}`);
  }

  // Brand values 1-2
  if (!Array.isArray(script.brand_values_used) || script.brand_values_used.length === 0 || script.brand_values_used.length > 2) {
    warnings.push(`brand_values_used should be 1-2, got ${script.brand_values_used?.length}`);
  }

  // Hashtags ≤3
  if (Array.isArray(script.hashtags) && script.hashtags.length > 3) {
    warnings.push(`hashtags should be 1-3, got ${script.hashtags.length} (will trim)`);
  }

  // Acts coverage
  const acts = new Set((script.shots || []).map((s) => s.act));
  if (!acts.has('cold_open')) warnings.push('missing cold_open shot');
  if (!acts.has('act1')) errors.push('missing Act I shots');
  if (!acts.has('act2')) errors.push('missing Act II shots');
  if (!acts.has('act3')) errors.push('missing Act III shots');
  if (!acts.has('outro')) warnings.push('missing outro shot');

  return { ok: errors.length === 0, warnings, errors };
}

// ═══════════════════════════════════════════════════════════
// Normalize
// ═══════════════════════════════════════════════════════════

function normalizeScript(parsed: any, primaryChar: string): CinemaScript {
  const shots: CinemaShot[] = (parsed.shots || []).map((s: any, i: number) => ({
    shot_no: s.shot_no || i + 1,
    act: s.act || 'act2',
    shot_type: s.shot_type || 'CHARACTER_SCENE',
    voiceover_text: String(s.voiceover_text || '').trim(),
    visual_prompt: String(s.visual_prompt || '').trim(),
    duration_target_sec: Number(s.duration_target_sec) || 8,
    director_note: s.director_note ? String(s.director_note).slice(0, 300) : undefined,
    /** Plan B hybrid flags — default safe values if Claude omits */
    has_character: typeof s.has_character === 'boolean' ? s.has_character : (s.shot_type === 'CHARACTER_SCENE' || s.shot_type === 'TALKING_HEAD'),
    money_shot: typeof s.money_shot === 'boolean' ? s.money_shot : false,
    stock_query: s.stock_query ? String(s.stock_query).slice(0, 200) : undefined,
  }));

  const totalDur = Number(parsed.total_duration_target_sec) || shots.reduce((a, s) => a + s.duration_target_sec, 0);
  const totalWords = Number(parsed.total_words_vn) || shots.reduce((a, s) => a + (s.voiceover_text || '').split(/\s+/).filter(Boolean).length, 0);

  return {
    title: String(parsed.title || 'Cinema Episode').slice(0, 100).trim(),
    primary_character: parsed.primary_character || primaryChar,
    secondary_characters: Array.isArray(parsed.secondary_characters) ? parsed.secondary_characters.slice(0, 3) : [],
    premise: String(parsed.premise || '').slice(0, 500),
    cold_open_text: parsed.cold_open_text ? String(parsed.cold_open_text).slice(0, 200) : undefined,
    title_card_text: String(parsed.title_card_text || `Sonder Cinema: ${parsed.title || ''}`).slice(0, 100),
    closing_line: String(parsed.closing_line || '').slice(0, 200),
    shots,
    brand_values_used: Array.isArray(parsed.brand_values_used) ? parsed.brand_values_used.slice(0, 2) : [],
    bgm_mood: (['warm', 'calm', 'cinematic', 'intimate', 'uplifting'].includes(parsed.bgm_mood) ? parsed.bgm_mood : 'warm') as CinemaScript['bgm_mood'],
    caption_yt: String(parsed.caption_yt || '').slice(0, 1000),
    caption_fb_teaser: String(parsed.caption_fb_teaser || '').slice(0, 600),
    hashtags: Array.isArray(parsed.hashtags) ? parsed.hashtags.slice(0, 3).map((h: any) => String(h).replace(/^#*/, '#')) : ['#sondervn'],
    references_anthology_facts: Array.isArray(parsed.references_anthology_facts) ? parsed.references_anthology_facts.slice(0, 10) : [],
    total_duration_target_sec: Math.round(totalDur),
    total_words_vn: totalWords,
  };
}

// ═══════════════════════════════════════════════════════════
// MAIN ENTRY
// ═══════════════════════════════════════════════════════════

export interface GenerateScriptOpts {
  primary_character: string;
  secondary_characters?: string[];
  episode_idea: string;
  episode_no: number;
  /** Target duration. 60-90s = Pilot Mode | 180s = Mid | 360s = Full (default) */
  target_duration_sec?: number;
}

export interface GenerateScriptResult {
  script: CinemaScript;
  raw_response: string;
  validation: ValidationResult;
  retry_count: number;
}

export async function generateCinemaScript(opts: GenerateScriptOpts): Promise<GenerateScriptResult> {
  // Load primary character profile
  const characterProfile = db.prepare(`SELECT * FROM story_characters WHERE slug = ?`).get(opts.primary_character) as any;
  if (!characterProfile) throw new Error(`character not found: ${opts.primary_character}`);

  // Load secondary
  const secondaryProfiles = (opts.secondary_characters || [])
    .map((s) => db.prepare(`SELECT * FROM story_characters WHERE slug = ?`).get(s))
    .filter((c) => c) as any[];

  // Load Anthology continuity (READ-ONLY)
  const recentAnthologyEpisodes = db.prepare(`
    SELECT e.episode_no, e.title, e.caption, e.beat
    FROM story_episodes e
    WHERE e.character_ids LIKE ?
    ORDER BY e.id DESC LIMIT 8
  `).all(`%"${opts.primary_character}"%`) as any[];

  const recentAnthologyFacts = db.prepare(`
    SELECT fact_key, fact_value, established_at
    FROM story_continuity
    WHERE fact_key LIKE ? AND superseded_at IS NULL
    ORDER BY established_at DESC LIMIT 30
  `).all(`${opts.primary_character}.%`) as any[];

  // Resolve duration profile (60s = Pilot, 180s = Mid, 360s = Full)
  const targetDur = opts.target_duration_sec
    || parseInt(getSetting('cinema_target_duration_sec') || '60', 10)
    || 60;
  const profile = getDurationProfile(targetDur);
  const systemPrompt = buildSystemPrompt(profile);
  // Higher maxTokens to avoid JSON truncation. Claude verbose visual_prompts
  // can be 200-400 chars each; safety buffer needed.
  // PILOT 6 shots × ~1500 chars/shot = ~9000 chars + boilerplate = need ~5000 tokens
  const maxTokens = profile.is_pilot ? 5500 : profile.total_sec <= 220 ? 8000 : 12000;

  const userPrompt = buildUserPrompt({
    primary_character: opts.primary_character,
    secondary_characters: opts.secondary_characters,
    episode_idea: opts.episode_idea,
    episode_no: opts.episode_no,
    characterProfile,
    secondaryProfiles,
    recentAnthologyFacts,
    recentAnthologyEpisodes,
  });

  console.log(`[cinema-script] generating ep#${opts.episode_no} for ${opts.primary_character} | mode=${profile.is_pilot ? 'PILOT' : profile.total_sec <= 220 ? 'MID' : 'FULL'} target=${profile.total_sec}s shots=${profile.shots.min}-${profile.shots.max} | anthology_eps=${recentAnthologyEpisodes.length} facts=${recentAnthologyFacts.length}`);

  let raw = await callClaude(systemPrompt, userPrompt, maxTokens);
  let parsed = extractJSON(raw);
  let script = normalizeScript(parsed, opts.primary_character);
  let validation = validateScript(script, profile);
  let retryCount = 0;

  // Retry once on hard errors
  if (!validation.ok) {
    retryCount = 1;
    console.warn(`[cinema-script] validation fail (${validation.errors.length} errors), retry...`);
    const retryPrompt = `${userPrompt}\n\n# RETRY — ERRORS từ lần trước (FIX):\n${validation.errors.map((e) => `- ${e}`).join('\n')}`;
    raw = await callClaude(systemPrompt, retryPrompt, maxTokens);
    parsed = extractJSON(raw);
    script = normalizeScript(parsed, opts.primary_character);
    validation = validateScript(script, profile);
  }

  if (validation.warnings.length) {
    console.log(`[cinema-script] warnings: ${validation.warnings.join(' | ')}`);
  }
  if (!validation.ok) {
    console.warn(`[cinema-script] still failing: ${validation.errors.join(' | ')}`);
  }

  console.log(`[cinema-script] OK title="${script.title}" shots=${script.shots.length} dur=${script.total_duration_target_sec}s words=${script.total_words_vn}`);

  return { script, raw_response: raw, validation, retry_count: retryCount };
}

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
// SYSTEM PROMPT — LOCKED by sonder-cinema skill
// ═══════════════════════════════════════════════════════════

const SYSTEM_PROMPT = `Bạn là biên kịch trưởng "Sonder Cinema" — series long-form 5-7 phút PREMIUM về universe khách sạn boutique Sonder ở Sài Gòn. Đây là LITERATURE/CINEMA, KHÔNG phải Reels ngắn. Audience: 22-40 tuổi VN, intentional viewers (click YT để xem, không scroll).

═══════════════════════════════════════════════════════════════
TRIẾT LÝ CINEMA (BẤT KHẢ XÂM PHẠM):
═══════════════════════════════════════════════════════════════

1. LONG-FORM ARC — 5-7 phút trọn vẹn 1 chương sâu của character
2. CINEMATIC PRODUCTION — premium tools (Veo/Hailuo/Hedra)
3. KHÔNG QUẢNG CÁO — tuyệt đối KHÔNG mention "Sonder", "khách sạn", "đặt phòng"
4. Ý TỰ THÀNH — brand values qua HÀNH ĐỘNG, không qua TUYÊN BỐ
5. POV "mình"/"tôi" — Tiếng Việt đời thường

═══════════════════════════════════════════════════════════════
3-ACT STRUCTURE (LOCKED — total 5-7 phút = 300-420s):
═══════════════════════════════════════════════════════════════

COLD OPEN (15s, 1 shot):
  1 hero shot KHÔNG voiceover. Visual hook duy nhất.
  ✅ Linh ngồi cửa sổ máy bay, Sài Gòn ban đêm hiện ra
  ❌ Title card "Sonder presents..."

TITLE CARD (5-10s, 1 shot):
  "Sonder Cinema #N: Title"
  1 voiceover line giới thiệu nhẹ (8-12 từ) — optional

ACT I — SETUP (90s, 5-6 shots):
  Establish character + context + stake.
  Voiceover POV "mình" intimate.

ACT II — STORY/CONFLICT (180s, 8-10 shots) ★★★ TRỌNG TÂM ★★★:
  Friction → Encounter → Realization
  Brand values 1-2 thấm qua HÀNH ĐỘNG
  Có thể có dialogue close-up (TALKING_HEAD)
  Logo placements visual subtle (không verbal)

ACT III — REFLECTION (90s, 4-5 shots) ★ Ý TỰ THÀNH ★:
  Inner monologue, payoff arc
  POETIC closing line, fade to logo

OUTRO (15s, 1 shot):
  1 atmospheric shot + Sonder logo fade in
  Silent music outro

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
      "director_note": "no VO, ambient SG night sound"
    },
    { "shot_no": 2, "act": "title", "shot_type": "ATMOSPHERIC_BROLL", ... },
    ... 18-23 shots total ...
    { "shot_no": 22, "act": "outro", "shot_type": "HERO_ESTABLISHING",
      "voiceover_text": "", "visual_prompt": "...", "duration_target_sec": 15,
      "director_note": "fade in Sonder logo bottom-right slowly" }
  ],
  "brand_values_used": ["warm_like_home", "understand_local"],
  "bgm_mood": "warm",
  "caption_yt": "<YT description 200-500 chars, poetic, no CTA>",
  "caption_fb_teaser": "<FB caption cho 60s teaser cut, 80-200 chars>",
  "hashtags": ["#sondervn"],
  "references_anthology_facts": ["linh.first_pho_saigon", ...],
  "total_duration_target_sec": 360,
  "total_words_vn": 720
}

QUY TẮC FINAL:
- Total 18-23 shots, 5-7 phút (300-420s)
- Voiceover ALL shots: 600-900 từ VN total
- Closing line PHẢI poetic, KHÔNG CTA, KHÔNG mention Sonder
- Output JSON only. Không giải thích.`;

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
      timeout: 360_000,                 // 6 min — long script generation
    },
  );

  const text = ((r.data?.content || []).map((b: any) => b?.text || '').join('') || '').trim();
  if (!text) throw new Error('Claude returned empty response');
  return text;
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

function extractJSON(raw: string): any {
  let cleaned = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
  const m = cleaned.match(/\{[\s\S]*\}/);
  if (m) cleaned = m[0];

  try { return JSON.parse(cleaned); }
  catch {
    let fixed = cleaned
      .replace(/[‘’]/g, "'")
      .replace(/[“”]/g, '"')
      .replace(/,(\s*[}\]])/g, '$1');
    try { return JSON.parse(fixed); }
    catch {
      const repaired = repairInnerQuotes(fixed);
      try { return JSON.parse(repaired); }
      catch (e: any) {
        console.error(`[cinema-script] JSON parse fail (3 passes): ${e.message}`);
        console.error(`[cinema-script] first 500: ${raw.slice(0, 500)}`);
        throw new Error(`Cannot parse JSON: ${e.message}`);
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

function validateScript(script: CinemaScript): ValidationResult {
  const warnings: string[] = [];
  const errors: string[] = [];

  // Shots count 18-23
  if (!Array.isArray(script.shots) || script.shots.length < 15 || script.shots.length > 26) {
    errors.push(`shots must be 18-23, got ${script.shots?.length}`);
  }

  // Total duration 300-420
  if (script.total_duration_target_sec < 240 || script.total_duration_target_sec > 480) {
    warnings.push(`total_duration ${script.total_duration_target_sec}s outside 300-420 target`);
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

  console.log(`[cinema-script] generating ep#${opts.episode_no} for ${opts.primary_character} | anthology_eps=${recentAnthologyEpisodes.length} facts=${recentAnthologyFacts.length}`);

  let raw = await callClaude(SYSTEM_PROMPT, userPrompt, 8000);
  let parsed = extractJSON(raw);
  let script = normalizeScript(parsed, opts.primary_character);
  let validation = validateScript(script);
  let retryCount = 0;

  // Retry once on hard errors
  if (!validation.ok) {
    retryCount = 1;
    console.warn(`[cinema-script] validation fail (${validation.errors.length} errors), retry...`);
    const retryPrompt = `${userPrompt}\n\n# RETRY — ERRORS từ lần trước (FIX):\n${validation.errors.map((e) => `- ${e}`).join('\n')}`;
    raw = await callClaude(SYSTEM_PROMPT, retryPrompt, 8000);
    parsed = extractJSON(raw);
    script = normalizeScript(parsed, opts.primary_character);
    validation = validateScript(script);
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

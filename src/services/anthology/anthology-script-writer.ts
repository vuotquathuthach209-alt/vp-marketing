/**
 * Anthology Script Writer — Claude Sonnet 4.6 + continuity injection.
 *
 * Pipeline:
 *   1. Receive TodayPick từ anthology-engine (character + arc + crossover?)
 *   2. Đọc 5 tập gần nhất cùng character (continuity)
 *   3. Đọc story_continuity facts đã established
 *   4. Đọc arc state (beat, episodes_published, premise)
 *   5. Inject TẤT CẢ vào Claude với system prompt locked-philosophy
 *   6. Claude generate 6-layer script + 2-layer hook + visual prompts
 *   7. Output AnthologyScript JSON đầy đủ continuity-aware
 *
 * Reference skill: sonder-storytelling (BẮT BUỘC tuân thủ)
 */

import axios from 'axios';
import { db, getSetting } from '../../db';
import {
  type CharacterSlug,
  type TodayPick,
  getCharacter,
  getLocation,
  getActiveArc,
  pickLocationForCharacter,
  pickBrandValuesForEpisode,
  pickLogoPlacements,
  getCharacterFacts,
  getRecentEpisodes,
} from './anthology-engine';

// ═══════════════════════════════════════════════════════════
// Types — locked by sonder-storytelling skill
// ═══════════════════════════════════════════════════════════

export type LayerName = 'hook' | 'context' | 'encounter' | 'sensory' | 'reflection' | 'closing';

export interface AnthologyLayer {
  layer_no: number;                 // 1..6
  layer_name: LayerName;
  voiceover_text: string;           // Tiếng Việt — đưa qua Edge-TTS HoaiMy → ElevenLabs STS Ngân
  visual_prompt: string;            // ENG — feed vào Gemini Flash Image / Pexels query
  duration_target_sec: number;      // expected ~3-5 / 10-15 / 20-30 / 10-15 / 10-15 / 5-8
  notes?: string;                   // optional director note
}

export interface AnthologyScript {
  // Identity
  title: string;                    // 4-7 từ (bí ẩn, không spoil)
  primary_character: CharacterSlug;
  secondary_characters?: CharacterSlug[];
  location_slug: string;
  is_crossover: boolean;

  // Arc info
  arc_slug?: string;
  arc_episode_no?: number;          // tập thứ N trong arc
  arc_beat?: 'inciting' | 'escalation' | 'midpoint' | 'climax' | 'resolution' | 'standalone';

  // 2-Layer Hook (algorithm + loyalty)
  hook_surface: string;             // newcomer hiểu được (algo)
  hook_arc: string;                 // loyal viewer payoff (callback)

  // 6 Layers (BẮT BUỘC đầy đủ)
  layers: AnthologyLayer[];

  // Caption + hashtags
  caption_text: string;             // FB/IG caption — poetic, không CTA
  hashtags: string[];               // 1-2 hashtags tối đa

  // Brand metadata
  brand_values_used: string[];      // 1-2 value_key thấm qua tập này
  logo_placements_used: string[];   // 3-5 placement_key

  // Continuity output
  new_facts: Array<{
    fact_key: string;               // "linh.first_pho_breakfast" | "tuan.knows_pho_ba_tam"
    fact_value: string;
    notes?: string;
  }>;

  // Audio / direction
  bgm_mood: 'warm' | 'calm' | 'cinematic' | 'intimate' | 'uplifting';

  // Total
  total_duration_target_sec: number;  // 60-90s
}

// ═══════════════════════════════════════════════════════════
// SYSTEM PROMPT — Locked by sonder-storytelling skill
// (Mọi update philosophy phải sync skill ↔ prompt)
// ═══════════════════════════════════════════════════════════

const SYSTEM_PROMPT = `Bạn là biên kịch trưởng "Sonder Stories" — series storytelling Việt Nam về 1 universe khách sạn boutique ở Sài Gòn. Đây là KHÔNG PHẢI quảng cáo. Đây là LITERATURE. Audience: 22-40 tuổi VN, sensitive, ghét content sến / hard-sell.

═══════════════════════════════════════════════════════════════
TRIẾT LÝ CỐT LÕI (BẤT KHẢ XÂM PHẠM):
═══════════════════════════════════════════════════════════════

1. CÂU CHUYỆN VÔ TẬN — Mỗi vị khách = 1 dòng story dài tập. Không "season finale".
2. KHÔNG QUẢNG CÁO — Tuyệt đối KHÔNG mention "Sonder", "khách sạn", "đặt phòng", "inbox", "gọi ngay".
3. Ý TỰ THÀNH — Brand values thấm qua HÀNH ĐỘNG cụ thể, KHÔNG qua tuyên bố.
4. LOGO ĐI KÈM — Visual presence (tag áo, ly trà, chìa khoá) — KHÔNG nhắc tên brand verbal.
5. POV "mình" / "tôi" — Tiếng Việt đời thường, không "anh chị quý khách".

═══════════════════════════════════════════════════════════════
4 BRAND VALUES (mỗi tập THẤM 1-2 — không 1, không tất cả):
═══════════════════════════════════════════════════════════════

• respect_individual (Tôn trọng cá nhân):
  Khách đến để được THẤY, không phải khoe.
  → Show: không hỏi "đi với ai", không phán xét, gọi tên thay "anh chị"

• warm_like_home (Ấm áp như nhà):
  Sonder thuộc về, không khách sáo.
  → Show: trà gừng pha sẵn, đèn vàng, gia vị Việt sẵn bếp

• understand_local (Hiểu địa phương):
  Sonder là 1 phần của Sài Gòn.
  → Show: gợi ý quán phở 6h sáng cụ thể, biết cafe yên cuối tuần

• always_someone_waits (Có người đợi 24/7):
  Đến muộn không phiền. Có người đợi.
  → Show: 11h đêm vẫn có lễ tân pha trà, không "self check-in machine"

═══════════════════════════════════════════════════════════════
6-LAYER STRUCTURE (BẮT BUỘC đầy đủ — total 60-90s):
═══════════════════════════════════════════════════════════════

LAYER 1 — HOOK (3-5s | 8-12 từ):
  1 detail CỤ THỂ (giờ + hành động + vật).
  ✅ "11 giờ đêm. Mình bấm chuông phòng 305 lần thứ ba."
  ❌ "Sài Gòn đẹp lắm các bạn ạ"

LAYER 2 — CONTEXT (10-15s):
  Personal stake + conflict nhẹ + sensory ground.
  ✅ "Mình đáp chuyến cuối từ Đà Nẵng. Vali nặng 40kg. Trời mưa, taxi mãi không gọi được."

LAYER 3 — ENCOUNTER (20-30s) ★★★ KHỚP NỐI BRAND ★★★:
  Moment với "Sonder" qua HÀNH ĐỘNG, không qua TUYÊN BỐ.
  1-2 brand values thấm qua cụ thể. Logo visual subtle.
  ✅ "Cửa mở. Chú Tuấn không nói gì. Pha cho mình ly trà gừng. Đặt nó lên bàn."
     → Value: Tôn trọng (không hỏi) + Ấm áp (trà gừng)

LAYER 4 — SENSORY (10-15s):
  5 giác quan ground reality. Camera close-up details.
  ✅ "Mùi trà gừng. Đèn vàng. Tiếng quạt cũ. Ga giường thơm xà phòng."

LAYER 5 — REFLECTION (10-15s) ★ Ý TỰ THÀNH ★:
  Inner monologue, nhận thức nhẹ. Brand value transcends qua suy nghĩ.
  KHÔNG mention "Sonder", KHÔNG kết luận quá rõ.
  ✅ "Mình tưởng mình cần lý do mới đến chỗ lạ. Hoá ra mình chỉ cần ai đó biết mình sẽ đến."

LAYER 6 — CLOSING (5-8s):
  Poetic, không CTA, không "Sonder".
  ✅ "Đêm đầu Sài Gòn. Mình ngủ sớm hơn dự định."

═══════════════════════════════════════════════════════════════
2-LAYER HOOK (Algorithm + Loyalty):
═══════════════════════════════════════════════════════════════

hook_surface  = newcomer hiểu được (algo viral). Self-contained.
hook_arc      = loyal viewer payoff. Callback tập trước / breadcrumb arc.

VÍ DỤ tập 7 "Linh thấy người cũ":
  surface: "Trưa Sài Gòn 35 độ. Mình thấy 1 người tưởng đã quên."
  arc:     viewer cũ nhớ Linh có ex ĐN tập 1 → tension tăng

═══════════════════════════════════════════════════════════════
ANTI-PATTERNS — TUYỆT ĐỐI KHÔNG VIẾT:
═══════════════════════════════════════════════════════════════

❌ "Sonder cam kết phục vụ 24/7"
❌ "Đặt phòng Sonder ngay"
❌ "Trải nghiệm khó quên"
❌ "5 lý do bạn nên..." / "Top 3 điều..."
❌ "Khám phá", "tinh hoa", "đỉnh cao"
❌ Tên Western (Mary, John, Sarah) — CHỈ tên VN trong character pool
❌ Stock generic "luxury hotel"
❌ Hashtag spam #saigon #travel #vietnam
❌ Emoji rườm rà (tối đa 1 emoji nhẹ ở caption đầu)

═══════════════════════════════════════════════════════════════
CONTINUITY (BẮT BUỘC tôn trọng):
═══════════════════════════════════════════════════════════════

User sẽ inject:
  - 5 tập gần nhất cùng character
  - Facts đã established (từ story_continuity)
  - Arc beat hiện tại

→ KHÔNG được contradict. Linh đeo vòng tay tập 1 → tập 50 vẫn đeo (trừ moment cố ý gỡ).
→ Tuấn 8 năm Sonder Airport tập 1 → tập 30 là 8 năm + N tháng, KHÔNG thành 5 năm.
→ Mỗi tập SHOULD generate new_facts để extend continuity (1-3 facts mới).

═══════════════════════════════════════════════════════════════
VISUAL PROMPTS (cho Gemini Flash Image / Pexels query):
═══════════════════════════════════════════════════════════════

Mỗi layer có visual_prompt ENG:
  - Bao gồm character visual_prompt + location visual_prompt_addon (đã inject)
  - Thêm hành động cụ thể của layer
  - Thêm signature props
  - Thêm logo placement nếu layer này có (ví dụ "small Sonder logo on staff name tag visible")
  - Cinematography: "cinematic, warm light, shallow DOF, vertical 9:16, golden hour"

═══════════════════════════════════════════════════════════════
OUTPUT FORMAT (JSON only — không markdown fence, không text ngoài JSON):
═══════════════════════════════════════════════════════════════

{
  "title": "<4-7 từ VN, bí ẩn, không spoil>",
  "primary_character": "<slug>",
  "secondary_characters": ["<slug>", ...],          // optional, [] nếu không
  "location_slug": "<slug>",
  "is_crossover": <boolean>,
  "arc_slug": "<slug>",                              // nếu thuộc arc
  "arc_episode_no": <number>,                        // tập thứ N trong arc
  "arc_beat": "inciting|escalation|midpoint|climax|resolution|standalone",
  "hook_surface": "<surface hook 8-12 từ>",
  "hook_arc": "<arc hook callback - có thể trùng surface nếu standalone>",
  "layers": [
    { "layer_no": 1, "layer_name": "hook",       "voiceover_text": "...", "visual_prompt": "...", "duration_target_sec": 4 },
    { "layer_no": 2, "layer_name": "context",    "voiceover_text": "...", "visual_prompt": "...", "duration_target_sec": 12 },
    { "layer_no": 3, "layer_name": "encounter",  "voiceover_text": "...", "visual_prompt": "...", "duration_target_sec": 25, "notes": "logo: tag tuan + ly tra" },
    { "layer_no": 4, "layer_name": "sensory",    "voiceover_text": "...", "visual_prompt": "...", "duration_target_sec": 12 },
    { "layer_no": 5, "layer_name": "reflection", "voiceover_text": "...", "visual_prompt": "...", "duration_target_sec": 12 },
    { "layer_no": 6, "layer_name": "closing",    "voiceover_text": "...", "visual_prompt": "...", "duration_target_sec": 6 }
  ],
  "caption_text": "<FB/IG caption poetic, 80-220 chars, không CTA>",
  "hashtags": ["#sondervn"],                         // 1-2 max
  "brand_values_used": ["respect_individual", "warm_like_home"],
  "logo_placements_used": ["watermark", "staff_tag", "tea_cup"],
  "new_facts": [
    { "fact_key": "linh.first_pho_breakfast", "fact_value": "ate at Pho Ba Tam Hoang Van Thu suggested by Tuan", "notes": "ep2" },
    { "fact_key": "tuan.recommends_pho_ba_tam", "fact_value": "Tuan knows Pho Ba Tam open 5:30am" }
  ],
  "bgm_mood": "warm",
  "total_duration_target_sec": 71
}

QUY TẮC FINAL:
- Tổng word count voiceover ALL 6 layers: ~150-220 từ VN.
- Closing line PHẢI poetic, KHÔNG CTA, KHÔNG mention Sonder.
- Output JSON only. Không giải thích. Không markdown.`;

// ═══════════════════════════════════════════════════════════
// Build user prompt — inject ALL continuity context
// ═══════════════════════════════════════════════════════════

interface UserPromptOpts {
  pick: TodayPick;
  characterProfile: any;
  secondaryProfiles?: any[];
  location: any;
  activeArc: any;
  recentEpisodes: any[];
  characterFacts: any[];
  brandValuesPool: any[];
  logoPlacementsPool: any[];
  episodeIdeaSeed?: string;     // optional — admin có thể cho 1 idea seed
}

function buildUserPrompt(opts: UserPromptOpts): string {
  const {
    pick,
    characterProfile,
    secondaryProfiles,
    location,
    activeArc,
    recentEpisodes,
    characterFacts,
    brandValuesPool,
    logoPlacementsPool,
    episodeIdeaSeed,
  } = opts;

  const monthVN = new Date().getMonth() + 1;
  const yearVN = new Date().getFullYear();

  const dowNames = ['Chủ Nhật', 'Thứ Hai', 'Thứ Ba', 'Thứ Tư', 'Thứ Năm', 'Thứ Sáu', 'Thứ Bảy'];
  const todayDow = dowNames[new Date(Date.now() + 7 * 3600_000).getUTCDay()];

  // Format recent episodes
  const recentBlock = recentEpisodes.length
    ? recentEpisodes
        .map(
          (e, i) =>
            `  ${i + 1}. Ep#${e.episode_no} "${e.title || '(no title)'}"
     beat: ${e.beat || 'n/a'} | published: ${e.published_at ? new Date(e.published_at).toISOString().slice(0, 10) : 'unpub'}
     caption: ${(e.caption || '').slice(0, 200)}`
        )
        .join('\n')
    : '  (chưa có tập trước — đây là tập đầu của character này)';

  // Format facts
  const factsBlock = characterFacts.length
    ? characterFacts.map((f: any) => `  - ${f.fact_key}: ${f.fact_value}`).join('\n')
    : '  (chưa có fact established)';

  // Character profile
  const charBlock = `
- slug: ${characterProfile.slug}
- name: ${characterProfile.name}
- age: ${characterProfile.age}
- gender: ${characterProfile.gender}
- role: ${characterProfile.role}
- backstory: ${characterProfile.backstory}
- visual_prompt: ${characterProfile.visual_prompt}
- signature_props: ${characterProfile.signature_props}
- voice_style: ${characterProfile.voice_style}`;

  // Secondary characters
  const secBlock =
    secondaryProfiles && secondaryProfiles.length
      ? secondaryProfiles
          .map(
            (c) => `
- ${c.slug} (${c.name}, ${c.age}t, ${c.role}):
  backstory: ${c.backstory}
  visual: ${c.visual_prompt}`
          )
          .join('\n')
      : '  (không có — solo episode)';

  // Location
  const locBlock = `
- slug: ${location.slug}
- name: ${location.name}
- area: ${location.area}
- signature_details: ${location.signature_details}
- visual_prompt_addon: ${location.visual_prompt_addon}
- recurring_elements: ${location.recurring_elements}`;

  // Arc
  const arcBlock = activeArc
    ? `
- arc_slug: ${activeArc.arc_slug}
- arc_title: ${activeArc.arc_title}
- premise: ${activeArc.premise}
- season_no: ${activeArc.season_no}
- episodes_planned: ${activeArc.episodes_planned}
- episodes_published: ${activeArc.episodes_published || 0}
- arc_episode_no_for_this_ep: ${(activeArc.episodes_published || 0) + 1}
- next_arc_slug: ${activeArc.next_arc_slug || 'none'}`
    : '  (no active arc — standalone episode)';

  // Brand values pool (least-used first)
  const valuesBlock = brandValuesPool
    .map((v: any) => `  - ${v.value_key} (${v.value_label_vn}): ${v.description} [used ${v.appearance_count}x]`)
    .join('\n');

  // Logo placements pool
  const logoBlock = logoPlacementsPool
    .map((l: any) => `  - ${l.placement_key}: ${l.placement_label} | addon: "${l.visual_prompt_addon}"`)
    .join('\n');

  return `# RUNTIME CONTEXT
Today: ${todayDow}, tháng ${monthVN}/${yearVN} (Vietnam time)
Pick reason: ${pick.reason}
is_crossover: ${pick.is_crossover}

# PRIMARY CHARACTER
${charBlock}

# SECONDARY CHARACTERS (${pick.is_crossover ? 'crossover episode' : 'none'})
${secBlock}

# LOCATION
${locBlock}

# ACTIVE ARC (${pick.arc_slug || 'standalone'})
${arcBlock}

# 5 EPISODES GẦN NHẤT của ${characterProfile.name} (continuity context — KHÔNG được contradict)
${recentBlock}

# FACTS đã established về ${characterProfile.name} (từ story_continuity table)
${factsBlock}

# BRAND VALUES POOL (chọn 1-2 — ưu tiên least-used để cover đều)
${valuesBlock}

# LOGO PLACEMENTS POOL (chọn 3-5 cho tập này, watermark luôn auto-include)
${logoBlock}

${episodeIdeaSeed ? `# EPISODE IDEA SEED (admin gợi ý — bạn có thể dùng hoặc bỏ qua)\n${episodeIdeaSeed}\n` : ''}

# YOUR TASK

Viết 1 tập "Sonder Stories" theo 6-layer structure:
1. CONTINUITY first — đọc kỹ recent episodes + facts. KHÔNG contradict.
2. Pick 1-2 brand values từ pool (least-used preferred).
3. Pick 3-5 logo placements (watermark auto, + contextual).
4. Tạo title 4-7 từ bí ẩn.
5. Generate 6 layers đầy đủ với voiceover VN + visual prompt ENG.
6. 2-layer hook: surface (algo) + arc (loyalty payoff với recent eps).
7. Generate new_facts để extend continuity (1-3 facts).
8. Caption FB poetic, 1-2 hashtag, KHÔNG CTA.

Output JSON only.`;
}

// ═══════════════════════════════════════════════════════════
// Claude call — Sonnet 4.6 với continuity injection
// ═══════════════════════════════════════════════════════════

async function callClaude(system: string, user: string, maxTokens = 4500): Promise<string> {
  const apiKey = getSetting('anthropic_api_key') || process.env.CLAUDE_API_KEY;
  if (!apiKey) throw new Error('anthropic_api_key not set (settings or CLAUDE_API_KEY env)');

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
      timeout: 240_000,   // 4 min — Claude có thể slow với long prompt
    }
  );

  const text = ((r.data?.content || []).map((b: any) => b?.text || '').join('') || '').trim();
  if (!text) throw new Error('Claude returned empty response');
  return text;
}

// ═══════════════════════════════════════════════════════════
// JSON extraction helper (robust)
// ═══════════════════════════════════════════════════════════

function extractJSON(raw: string): any {
  // Strip markdown fences nếu Claude quên
  let cleaned = raw.trim();
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');

  try {
    return JSON.parse(cleaned);
  } catch {
    // Fallback: find first { ... last }
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (!m) throw new Error(`Cannot parse JSON. First 300 chars: ${raw.slice(0, 300)}`);
    return JSON.parse(m[0]);
  }
}

// ═══════════════════════════════════════════════════════════
// Validation — ensure script passes 13-item checklist (skill)
// ═══════════════════════════════════════════════════════════

const FORBIDDEN_NARRATION = [
  /sonder/i,                          // never mention brand name in narration
  /khách\s*sạn/i,                     // không "khách sạn"
  /đặt\s*phòng/i,                     // không "đặt phòng"
  /inbox/i,
  /gọi\s*ngay/i,
  /\bcam\s*kết\b/i,
  /\btự\s*hào\b/i,
  /trải\s*nghiệm\s*khó\s*quên/i,
  /khám\s*phá/i,
  /tinh\s*hoa/i,
  /đỉnh\s*cao/i,
];

function validateScript(script: AnthologyScript): { ok: boolean; warnings: string[]; errors: string[] } {
  const warnings: string[] = [];
  const errors: string[] = [];

  // 1. 6 layers exists
  if (!Array.isArray(script.layers) || script.layers.length !== 6) {
    errors.push(`layers must be exactly 6, got ${script.layers?.length}`);
  }

  // 2. Layer order
  const expectedOrder: LayerName[] = ['hook', 'context', 'encounter', 'sensory', 'reflection', 'closing'];
  if (script.layers && script.layers.length === 6) {
    for (let i = 0; i < 6; i++) {
      if (script.layers[i].layer_name !== expectedOrder[i]) {
        errors.push(`layer ${i + 1} expected "${expectedOrder[i]}", got "${script.layers[i].layer_name}"`);
      }
    }
  }

  // 3. Forbidden words in narration (all layers + hooks)
  const allNarration = [
    script.hook_surface,
    script.hook_arc,
    ...script.layers.map((l) => l.voiceover_text),
  ].join(' \n ');

  for (const re of FORBIDDEN_NARRATION) {
    if (re.test(allNarration)) {
      errors.push(`forbidden word/pattern found in narration: ${re}`);
    }
  }

  // 4. Hook length (8-15 từ surface)
  const hookWords = (script.hook_surface || '').trim().split(/\s+/).length;
  if (hookWords < 6 || hookWords > 18) {
    warnings.push(`hook_surface has ${hookWords} words (target 8-15)`);
  }

  // 5. Total duration 50-100s sane window
  if (script.total_duration_target_sec < 50 || script.total_duration_target_sec > 100) {
    warnings.push(`total_duration_target_sec=${script.total_duration_target_sec} outside 50-100s`);
  }

  // 6. Brand values 1-2
  if (!Array.isArray(script.brand_values_used) || script.brand_values_used.length === 0 || script.brand_values_used.length > 2) {
    warnings.push(`brand_values_used should be 1-2, got ${script.brand_values_used?.length}`);
  }

  // 7. Logo placements 3-5
  if (!Array.isArray(script.logo_placements_used) || script.logo_placements_used.length < 2 || script.logo_placements_used.length > 6) {
    warnings.push(`logo_placements_used should be 3-5, got ${script.logo_placements_used?.length}`);
  }

  // 8. Hashtags ≤2
  if (Array.isArray(script.hashtags) && script.hashtags.length > 3) {
    warnings.push(`hashtags should be 1-2, got ${script.hashtags.length} (will trim)`);
  }

  return { ok: errors.length === 0, warnings, errors };
}

// ═══════════════════════════════════════════════════════════
// Normalize — trim + defaults
// ═══════════════════════════════════════════════════════════

function normalizeScript(parsed: any, pick: TodayPick, location: any, activeArc: any): AnthologyScript {
  const layers: AnthologyLayer[] = (parsed.layers || []).map((l: any, idx: number) => ({
    layer_no: l.layer_no || idx + 1,
    layer_name: l.layer_name as LayerName,
    voiceover_text: String(l.voiceover_text || '').trim(),
    visual_prompt: String(l.visual_prompt || '').trim(),
    duration_target_sec: Number(l.duration_target_sec) || [4, 12, 25, 12, 12, 6][idx] || 10,
    notes: l.notes ? String(l.notes).slice(0, 200) : undefined,
  }));

  // Fill duration if total missing
  const totalDur = Number(parsed.total_duration_target_sec) || layers.reduce((s, l) => s + l.duration_target_sec, 0);

  return {
    title: String(parsed.title || 'Tập không tên').slice(0, 80).trim(),
    primary_character: pick.primary,
    secondary_characters: Array.isArray(parsed.secondary_characters) && parsed.secondary_characters.length
      ? parsed.secondary_characters.slice(0, 3)
      : (pick.secondary || []),
    location_slug: parsed.location_slug || location.slug,
    is_crossover: pick.is_crossover,
    arc_slug: parsed.arc_slug || activeArc?.arc_slug || pick.arc_slug,
    arc_episode_no: Number(parsed.arc_episode_no) || (activeArc ? (activeArc.episodes_published || 0) + 1 : undefined),
    arc_beat: parsed.arc_beat || 'standalone',
    hook_surface: String(parsed.hook_surface || '').trim().slice(0, 240),
    hook_arc: String(parsed.hook_arc || parsed.hook_surface || '').trim().slice(0, 240),
    layers,
    caption_text: String(parsed.caption_text || '').trim().slice(0, 600),
    hashtags: Array.isArray(parsed.hashtags)
      ? parsed.hashtags.slice(0, 2).map((h: any) => String(h).replace(/^#*/, '#'))
      : ['#sondervn'],
    brand_values_used: Array.isArray(parsed.brand_values_used)
      ? parsed.brand_values_used.slice(0, 2).map((v: any) => String(v))
      : [],
    logo_placements_used: Array.isArray(parsed.logo_placements_used)
      ? parsed.logo_placements_used.slice(0, 6).map((p: any) => String(p))
      : ['watermark'],
    new_facts: Array.isArray(parsed.new_facts)
      ? parsed.new_facts.slice(0, 5).map((f: any) => ({
          fact_key: String(f.fact_key || '').slice(0, 120),
          fact_value: String(f.fact_value || '').slice(0, 400),
          notes: f.notes ? String(f.notes).slice(0, 200) : undefined,
        })).filter((f: any) => f.fact_key && f.fact_value)
      : [],
    bgm_mood: (['warm', 'calm', 'cinematic', 'intimate', 'uplifting'].includes(parsed.bgm_mood)
      ? parsed.bgm_mood
      : 'warm') as AnthologyScript['bgm_mood'],
    total_duration_target_sec: Math.round(totalDur),
  };
}

// ═══════════════════════════════════════════════════════════
// MAIN ENTRY
// ═══════════════════════════════════════════════════════════

export interface GenerateOpts {
  pick: TodayPick;
  episodeIdeaSeed?: string;          // admin có thể inject 1 idea hint
  retryOnValidationFail?: boolean;   // default true — retry 1 lần nếu fail
}

export interface GenerateResult {
  script: AnthologyScript;
  raw_response: string;
  validation: { ok: boolean; warnings: string[]; errors: string[] };
  retry_count: number;
}

/**
 * Generate full anthology script với continuity injection.
 *
 * Flow:
 *   1. Load character + secondary + location + arc + recent eps + facts
 *   2. Build user prompt với ALL context
 *   3. Call Claude Sonnet 4.6 (system prompt = locked philosophy)
 *   4. Parse + normalize + validate
 *   5. Retry 1 lần nếu validation fail (re-prompt với errors)
 */
export async function generateAnthologyScript(opts: GenerateOpts): Promise<GenerateResult> {
  const { pick, episodeIdeaSeed, retryOnValidationFail = true } = opts;

  // 1. Load primary character
  const characterProfile = getCharacter(pick.primary);
  if (!characterProfile) {
    throw new Error(`character not found: ${pick.primary}`);
  }

  // 2. Load secondary if crossover
  let secondaryProfiles: any[] = [];
  if (pick.is_crossover && pick.secondary && pick.secondary.length) {
    secondaryProfiles = pick.secondary
      .map((s) => getCharacter(s))
      .filter((c) => c);
  }

  // 3. Pick location
  const location = pickLocationForCharacter(pick.primary);
  if (!location) throw new Error(`no location for character ${pick.primary}`);

  // 4. Active arc
  const activeArc = pick.arc_slug
    ? db.prepare(`SELECT * FROM story_arcs WHERE arc_slug = ?`).get(pick.arc_slug) as any
    : getActiveArc(pick.primary);

  // 5. Recent episodes (continuity)
  const recentEpisodes = getRecentEpisodes(pick.primary, 5);

  // 6. Character facts
  const characterFacts = getCharacterFacts(pick.primary, 30);

  // 7. Brand values + logo placements pool
  const { values: brandValuesPool } = pickBrandValuesForEpisode();
  const allValues = db.prepare(`SELECT * FROM story_brand_values ORDER BY appearance_count ASC`).all() as any[];
  const logoPlacementsPool = db.prepare(`SELECT * FROM story_logo_placements`).all() as any[];

  // 8. Build user prompt
  const userPrompt = buildUserPrompt({
    pick,
    characterProfile,
    secondaryProfiles,
    location,
    activeArc,
    recentEpisodes,
    characterFacts,
    brandValuesPool: allValues,            // give Claude full pool, hint least-used
    logoPlacementsPool,
    episodeIdeaSeed,
  });

  console.log(`[anthology-script] generating for ${pick.primary}${pick.is_crossover ? ` + ${pick.secondary?.join(',')}` : ''} | arc=${activeArc?.arc_slug || 'none'} | recent_eps=${recentEpisodes.length} | facts=${characterFacts.length}`);

  // 9. Call Claude
  let raw = await callClaude(SYSTEM_PROMPT, userPrompt, 4500);
  let parsed = extractJSON(raw);
  let script = normalizeScript(parsed, pick, location, activeArc);
  let validation = validateScript(script);
  let retryCount = 0;

  // 10. Retry on hard errors (forbidden words, missing layers)
  if (!validation.ok && retryOnValidationFail) {
    retryCount = 1;
    console.warn(`[anthology-script] validation fail (${validation.errors.length} errors), retry 1...`);
    const retryPrompt = `${userPrompt}\n\n# RETRY — ERRORS từ lần trước (FIX):\n${validation.errors.map((e) => `- ${e}`).join('\n')}\n\nGenerate lại JSON với fix.`;
    raw = await callClaude(SYSTEM_PROMPT, retryPrompt, 4500);
    parsed = extractJSON(raw);
    script = normalizeScript(parsed, pick, location, activeArc);
    validation = validateScript(script);
  }

  if (!validation.ok) {
    console.warn(`[anthology-script] still failing after retry: ${validation.errors.join(' | ')}`);
  }
  if (validation.warnings.length) {
    console.log(`[anthology-script] warnings: ${validation.warnings.join(' | ')}`);
  }

  console.log(`[anthology-script] OK title="${script.title}" duration=${script.total_duration_target_sec}s values=[${script.brand_values_used.join(',')}] logos=[${script.logo_placements_used.join(',')}]`);

  return { script, raw_response: raw, validation, retry_count: retryCount };
}

// ═══════════════════════════════════════════════════════════
// Persist new_facts after publish (called by orchestrator)
// ═══════════════════════════════════════════════════════════

export function persistNewFacts(script: AnthologyScript, episodeId: number): number {
  let saved = 0;
  for (const f of script.new_facts) {
    try {
      db.prepare(`
        INSERT INTO story_continuity (fact_key, fact_value, established_episode_id, established_at, notes)
        VALUES (?, ?, ?, ?, ?)
      `).run(f.fact_key, f.fact_value, episodeId, Date.now(), f.notes || null);
      saved++;
    } catch (e: any) {
      console.warn(`[anthology-script] persistFact "${f.fact_key}" fail: ${e?.message}`);
    }
  }
  return saved;
}

/**
 * Get full voiceover text concatenated (cho TTS pipeline).
 * Returns: 1 string với "\n\n" between layers.
 */
export function getFullVoiceoverText(script: AnthologyScript): string {
  return script.layers.map((l) => l.voiceover_text).join('\n\n');
}

/**
 * Get per-layer voiceover (cho per-segment TTS — preferred for tighter sync).
 */
export function getPerLayerVoiceovers(script: AnthologyScript): Array<{ layer_no: number; layer_name: LayerName; text: string; duration_target_sec: number }> {
  return script.layers.map((l) => ({
    layer_no: l.layer_no,
    layer_name: l.layer_name,
    text: l.voiceover_text,
    duration_target_sec: l.duration_target_sec,
  }));
}

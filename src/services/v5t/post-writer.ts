/**
 * V5T Post Writer — caption + 3 hook variants + hashtags.
 *
 * Reference: skill sonder-content-v5t
 *
 * Pipeline:
 *   1. Pick post type (40% carousel / 30% single / 15% poll / 15% question)
 *   2. Pick theme (60% saigon_insider / 40% sonder_bts)
 *   3. Pick 3 distinct hook patterns
 *   4. Generate caption body via LLM (Claude/Qwen)
 *   5. Generate 3 hook lines (different patterns)
 *   6. Pick 3-5 hashtags from Sonder niche library
 *   7. (If poll) Generate poll question + 2-4 options
 *   8. Save v5t_posts row
 */

import { db } from '../../db';
import { generate } from '../router';
import type { V5TPost, V5TPostType, V5TTheme, V5THookPattern } from './types';

/**
 * Robust JSON extraction — handles markdown code fences, leading/trailing text,
 * truncation, unclosed quotes/braces. Mirrors vision-analyzer.extractJSON logic.
 * Returns null only if no usable structure found.
 */
function safeExtractJSON(raw: string): any | null {
  if (!raw) return null;
  // 1. Direct
  try { return JSON.parse(raw); } catch {}

  // 2. Strip markdown fences
  let cleaned = raw
    .replace(/^```(?:json|JSON)?\s*\n?/m, '')
    .replace(/\n?\s*```\s*$/m, '')
    .trim();
  try { return JSON.parse(cleaned); } catch {}

  // 3. Extract first {...} and try to repair
  const m = cleaned.match(/\{[\s\S]*\}/);
  if (m) {
    try { return JSON.parse(m[0]); } catch {}
    // Repair: balance quotes/brackets/braces
    let repaired = m[0];
    if (!repaired.trimEnd().endsWith('}')) {
      const qc = (repaired.match(/"/g) || []).length;
      if (qc % 2 !== 0) repaired += '"';
      const ob = (repaired.match(/\{/g) || []).length;
      const cb = (repaired.match(/\}/g) || []).length;
      for (let i = 0; i < ob - cb; i++) repaired += '}';
      try { return JSON.parse(repaired); } catch {}
    }
  }
  return null;
}

/* ───────── Sonder niche hashtag library ───────── */

const SONDER_HASHTAGS: Record<V5TTheme, string[]> = {
  saigon_insider: [
    '#sondervn', '#saigoninsider', '#saigonsongchamtai',
    '#saigon24h', '#anbansaigon', '#diachisaigon',
    '#caphesaigon', '#phosaigon', '#hemsaigon',
    '#saigonbinhdi', '#saigonyene', '#saigonvelive',
    '#localsaigon', '#vietnamtravel', '#saigonpov',
  ],
  sonder_bts: [
    '#sondervn', '#sonderhotel', '#boutiquehotelsaigon',
    '#saigonhotel', '#staycationsaigon', '#airbnbsaigon',
    '#luutrunho', '#dochoanhotel', '#sonderairport',
    '#sondervn_q1', '#sondervn_binhthanh', '#sondervn_phunhuan',
    '#hostelsaigon', '#guesthousesaigon',
  ],
};

function pickHashtags(theme: V5TTheme, count = 4): string[] {
  const pool = SONDER_HASHTAGS[theme];
  const shuffled = [...pool].sort(() => Math.random() - 0.5);
  // Always include #sondervn first
  return ['#sondervn', ...shuffled.filter(h => h !== '#sondervn').slice(0, count - 1)];
}

/* ───────── Theme + type rotation ───────── */

function pickTheme(): V5TTheme {
  const recent5 = db.prepare(
    `SELECT theme FROM v5t_posts ORDER BY id DESC LIMIT 5`,
  ).all() as Array<{ theme: V5TTheme }>;

  const insiderCount = recent5.filter(r => r.theme === 'saigon_insider').length;
  if (recent5.length >= 5) {
    if (insiderCount < 3) return 'saigon_insider';
  }
  return Math.random() < 0.6 ? 'saigon_insider' : 'sonder_bts';
}

function pickPostType(): V5TPostType {
  // 60% tips_post, 40% story_post
  return Math.random() < 0.6 ? 'tips_post' : 'story_post';
}

function pick3HookPatterns(theme: V5TTheme): [V5THookPattern, V5THookPattern, V5THookPattern] {
  const candidates: V5THookPattern[] = theme === 'saigon_insider'
    ? ['textural_asmr', 'time_location', 'observational', 'numerical_serial', 'object_character']
    : ['textural_asmr', 'observational', 'expectation_reality', 'object_character', 'guest_pov'];
  const shuffled = [...candidates].sort(() => Math.random() - 0.5);
  return [shuffled[0], shuffled[1], shuffled[2]];
}

/* ───────── LLM gen ───────── */

/** Quick firewall pre-check at post-writer stage — block risky photos BEFORE compose. */
async function isPhotoSafe(imagePath: string): Promise<boolean> {
  const enabled = require('../../db').getSetting('v5t_postwriter_firewall_enabled') !== 'false';
  if (!enabled) return true;
  try {
    const fs = require('fs');
    if (!fs.existsSync(imagePath)) return false;
    const { isImageSafeToPublish } = require('../copyright/verifier');
    const threshold = parseInt(require('../../db').getSetting('v5t_copyright_block_threshold') || '60', 10);
    const r = await isImageSafeToPublish(imagePath, { threshold });
    if (!r.ok) {
      console.warn(`[v5t-post-writer] 🛡️ skip photo ${imagePath.split('/').pop()} — copyright risk ${r.assessment.risk_score}/${r.assessment.risk_level}: ${r.assessment.risk_reasons.slice(0, 2).join('; ')}`);
    }
    return r.ok;
  } catch (e: any) {
    console.warn('[v5t-post-writer] firewall check fail (fail-open):', e?.message);
    return true;
  }
}

/** Pick best photo from v5_footage for given type, return path + context.
 *
 * 🛡️ COPYRIGHT-AWARE (2026-05-11): skips photos blocked by pre-publish firewall.
 *
 * NO-DUPLICATE GUARANTEE:
 *   - Excludes any photo linked to a v5t_post (any status) via v5t_post_images
 *   - Falls back to least-used only if inventory exhausted
 *
 * Algorithm now tries up to 10 candidates per layer (matched / any-never-used / oldest)
 * and rejects firewall-blocked. If all 10 layers exhaust, returns null → post skipped.
 */
async function pickPhotoForPost(type: V5TPostType, theme: V5TTheme): Promise<{
  footage_id: number;
  path: string;
  description: string | null;
  location: string | null;
  moment_tag: string | null;
} | null> {
  const preferContentType = type === 'tips_post' ? 'tips' : 'story';
  const triedIds: number[] = [];
  const MAX_ATTEMPTS = 10;

  // Helper — build NOT IN clause for tried_ids exclusion
  const tryExclusionSql = () => triedIds.length > 0
    ? `AND id NOT IN (${triedIds.map(() => '?').join(',')})`
    : '';

  // Layer 1: matching content_type AND never-used
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const matched = db.prepare(
      `SELECT id, path, notes, location, character, moment_tag
       FROM v5_footage
       WHERE (media_type = 'image' OR media_type IS NULL)
         AND notes LIKE ?
         AND NOT EXISTS (SELECT 1 FROM v5t_post_images vpi WHERE vpi.footage_id = v5_footage.id)
         ${tryExclusionSql()}
       ORDER BY RANDOM()
       LIMIT 1`,
    ).get(`%content_type:${preferContentType}%`, ...triedIds) as any;

    if (!matched) break;
    triedIds.push(matched.id);

    if (await isPhotoSafe(matched.path)) {
      console.log(`[v5t-post-writer] picked photo id=${matched.id} (matched content_type=${preferContentType}, never-used, firewall-OK)`);
      return {
        footage_id: matched.id, path: matched.path,
        description: extractDescriptionFromNotes(matched.notes),
        location: matched.location, moment_tag: matched.moment_tag,
      };
    }
  }

  // Layer 2: any never-used (relax content_type)
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const anyRow = db.prepare(
      `SELECT id, path, notes, location, character, moment_tag
       FROM v5_footage
       WHERE (media_type = 'image' OR media_type IS NULL)
         AND NOT EXISTS (SELECT 1 FROM v5t_post_images vpi WHERE vpi.footage_id = v5_footage.id)
         ${tryExclusionSql()}
       ORDER BY RANDOM()
       LIMIT 1`,
    ).get(...triedIds) as any;

    if (!anyRow) break;
    triedIds.push(anyRow.id);

    if (await isPhotoSafe(anyRow.path)) {
      console.log(`[v5t-post-writer] picked photo id=${anyRow.id} (any never-used, firewall-OK)`);
      return {
        footage_id: anyRow.id, path: anyRow.path,
        description: extractDescriptionFromNotes(anyRow.notes),
        location: anyRow.location, moment_tag: anyRow.moment_tag,
      };
    }
  }

  // Layer 3: oldest-used (inventory exhausted) — also firewall-gated
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const oldest = db.prepare(
      `SELECT vf.id, vf.path, vf.notes, vf.location, vf.character, vf.moment_tag,
              MAX(COALESCE(vp.created_at, 0)) AS last_used_at
       FROM v5_footage vf
       LEFT JOIN v5t_post_images vpi ON vpi.footage_id = vf.id
       LEFT JOIN v5t_posts vp ON vp.id = vpi.post_id
       WHERE (vf.media_type = 'image' OR vf.media_type IS NULL)
         ${triedIds.length > 0 ? `AND vf.id NOT IN (${triedIds.map(() => '?').join(',')})` : ''}
       GROUP BY vf.id
       ORDER BY last_used_at ASC, RANDOM()
       LIMIT 1`,
    ).get(...triedIds) as any;

    if (!oldest) break;
    triedIds.push(oldest.id);

    if (await isPhotoSafe(oldest.path)) {
      console.warn(`[v5t-post-writer] ⚠️ inventory exhausted — reusing oldest id=${oldest.id} (last used ${oldest.last_used_at ? new Date(oldest.last_used_at).toISOString() : 'never'}, firewall-OK)`);
      return {
        footage_id: oldest.id, path: oldest.path,
        description: extractDescriptionFromNotes(oldest.notes),
        location: oldest.location, moment_tag: oldest.moment_tag,
      };
    }
  }

  console.warn(`[v5t-post-writer] 🚫 no safe photo found after ${triedIds.length} attempts (all firewall-blocked or inventory empty)`);
  return null;
}

function extractDescriptionFromNotes(notes: string | null): string | null {
  if (!notes) return null;
  // notes format: "gdrive_id:xxx | <description>"
  const m = notes.match(/\|\s*(.+)$/);
  return m ? m[1].trim() : null;
}

async function generateCaptionBody(opts: {
  type: V5TPostType;
  theme: V5TTheme;
  photo_context?: { description: string | null; location: string | null; moment_tag: string | null };
}): Promise<{
  body: string;
  poll_question?: string;
  poll_options?: string[];
}> {
  const themeGuide = opts.theme === 'saigon_insider'
    ? `Theme: SÀI GÒN INSIDER GUIDE — góc nhìn riêng về Sài Gòn (quán phở 6h sáng, cafe Vy, hẻm Bình Thạnh, mưa chiều).`
    : `Theme: SONDER BEHIND-THE-SCENE — moment hành động cụ thể tại Sonder. Chú Tuấn pha trà, sảnh đèn vàng đêm mưa, khách check-in muộn.`;

  let typeGuide = '';
  if (opts.type === 'tips_post') {
    typeGuide = `TIPS POST format — practical local guide:
Title kiểu "5 quán phở hẻm sâu Bình Thạnh" / "3 cafe yên đêm Q1 dân local hay tới" / "4 góc Sài Gòn 5h sáng đẹp nhất".
Caption format:
  Line 1: Hook 1 dòng (number + topic)
  Body: Liệt kê 3-5 tips cụ thể, mỗi tip 1-2 dòng:
    - Tên quán/địa điểm + đường + giờ + 1 detail đặc biệt
    - VD: "Phở Bà Tám — đường Hoàng Văn Thụ, mở 5h30. Nước dùng ngọt từ xương heo, không bột ngọt."
  Closing: 1 dòng poetic (KHÔNG CTA, KHÔNG mention Sonder)
Total ~80-150 từ. Concrete, useful, locals-only feel.`;
  } else if (opts.type === 'story_post') {
    typeGuide = `STORY POST format — moment thật tại Sonder:
Caption format:
  Line 1: Hook 1 dòng grounded (giờ + địa điểm cụ thể)
  Body: 4-6 dòng kể 1 moment cụ thể (chú Tuấn, lễ tân, khách quen)
  Closing: 1 dòng poetic ý tự thành
Total 50-80 từ. POV "mình" intimate.`;
  }

  const photoContext = opts.photo_context?.description
    ? `\nẢNH ĐÍNH KÈM (mô tả thực): "${opts.photo_context.description}"\nLocation: ${opts.photo_context.location || 'unknown'}\nMoment: ${opts.photo_context.moment_tag || 'unknown'}\n→ Caption MUST kể chuyện THEO nội dung ảnh, không random.`
    : '';

  const systemPrompt = `Em là content strategist Sonder Vietnam. Viết FB post.

PHILOSOPHY (BẮT BUỘC):
- POV "mình" intimate
- KHÔNG mention "Sonder", "đặt phòng", "khách sạn" trong body (chỉ #sondervn ở hashtag)
- Brand value qua HÀNH ĐỘNG, không TUYÊN BỐ
- KHÔNG hard-sell, KHÔNG engagement bait ("Hỏi thật nhé", "Còn chần chừ")
- Tên VN thật (Linh, Tuấn, Vy, Khanh, Hà)
- Văn thơ, cụ thể, sensory
${photoContext}

${themeGuide}

${typeGuide}

OUTPUT JSON:
{
  "body": "<caption full theo type guide>"
}`;

  // Try LLM up to 2 times — if first attempt returns malformed JSON,
  // retry with stricter "ONLY JSON, no markdown, no commentary" instruction.
  let lastErr = '';
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const userPrompt = attempt === 1
        ? 'Generate JSON only.'
        : 'Trả về CHỈ JSON hợp lệ, không markdown ```, không text trước/sau. Chỉ {"body": "..."}';
      const text = (await generate({
        task: 'caption',
        system: systemPrompt,
        user: userPrompt,
      })).trim();

      const parsed = safeExtractJSON(text);
      if (!parsed || !parsed.body) {
        lastErr = `pass${attempt}: no JSON or empty body — raw[:150]: ${text.slice(0, 150)}`;
        if (attempt === 1) continue;
        throw new Error(lastErr);
      }

      return {
        body: parsed.body,
        poll_question: parsed.poll_question,
        poll_options: parsed.poll_options,
      };
    } catch (e: any) {
      lastErr = e.message;
      if (attempt === 1) continue;
      console.warn('[v5t-post-writer] body gen fail (final):', lastErr);
      throw e;
    }
  }
  throw new Error(lastErr || 'unknown body gen fail');
}

async function generateHookLine(
  theme: V5TTheme,
  pattern: V5THookPattern,
  bodyContext: string,
): Promise<string> {
  const patternGuide: Record<V5THookPattern, string> = {
    textural_asmr: 'Macro/sensory description. VD: "Hơi nóng từ ly trà gừng. 6h sáng."',
    time_location: '<giờ chính xác>. <địa điểm cụ thể>. VD: "5h45 sáng. Hẻm Bình Thạnh."',
    observational: '1 chi tiết người khác bỏ qua. VD: "Đèn hành lang vàng. Không có đèn LED."',
    expectation_reality: '<Expectation>. Nhưng <reality>. VD: "Tưởng đêm SG ồn. Hoá ra phòng này yên hơn nhà cũ."',
    numerical_serial: '<Ngày/Tuần/Lần thứ N>. <hành động>. VD: "Lần thứ 4 anh Khanh đến Sonder Airport."',
    object_character: 'Object first, character reveal sau. VD: "Chìa khoá đồng. Tay Linh xoay nhẹ."',
    guest_pov: 'Real guest perspective. VD: "Cô Hà 62t. Lần đầu đi máy bay 1 mình thăm Linh."',
  };

  const systemPrompt = `Generate 1 dòng hook đầu tiên cho FB post (max 12 từ tiếng Việt).

PATTERN: ${pattern}
GUIDE: ${patternGuide[pattern]}

THEME: ${theme}
BODY CONTEXT: ${bodyContext}

Output JSON:
{ "hook": "<1 dòng max 12 từ>" }

Hook MUST cụ thể + thơ + grounded. KHÔNG generic.`;

  try {
    const text = (await generate({
      task: 'caption',
      system: systemPrompt,
      user: 'Generate hook JSON only.',
    })).trim();
    const parsed = safeExtractJSON(text);
    if (!parsed) return '';
    return String(parsed.hook || '').trim();
  } catch {
    return '';
  }
}

/* ───────── Main entry ───────── */

export async function generateV5TPost(opts?: {
  type?: V5TPostType;
  theme?: V5TTheme;
  generated_by?: string;
}): Promise<V5TPost | null> {
  const type = opts?.type || pickPostType();
  const theme = opts?.theme || pickTheme();
  console.log(`[v5t-post-writer] generating type=${type} theme=${theme}`);

  try {
    // 0. Pick photo first (so caption can match ảnh) — now firewall-gated (async)
    const photo = await pickPhotoForPost(type, theme);
    if (!photo) {
      console.warn(`[v5t-post-writer] no safe photo available — skip post (all candidates firewall-blocked or inventory empty)`);
      return null;
    }

    // 1. Generate body với context từ ảnh
    const body = await generateCaptionBody({
      type,
      theme,
      photo_context: {
        description: photo.description,
        location: photo.location,
        moment_tag: photo.moment_tag,
      },
    });

    // 2. Pick 3 hook patterns
    const [pA, pB, pC] = pick3HookPatterns(theme);

    // 3. Generate 3 hook lines (parallel)
    const bodyContext = body.body.slice(0, 200);
    const [hookA, hookB, hookC] = await Promise.all([
      generateHookLine(theme, pA, bodyContext),
      generateHookLine(theme, pB, bodyContext),
      generateHookLine(theme, pC, bodyContext),
    ]);

    // 4. Compose 3 full captions (hook + body) + hashtags
    const hashtags = pickHashtags(theme, 4);
    const tagsLine = hashtags.join(' ');

    const captionA = `${hookA}\n\n${body.body}\n\n${tagsLine}`;
    const captionB = `${hookB}\n\n${body.body}\n\n${tagsLine}`;
    const captionC = `${hookC}\n\n${body.body}\n\n${tagsLine}`;

    // 5. Persist to DB — save picked_footage_id so composer renders the SAME photo
    // we wrote the caption for (caption-image consistency + no-duplicate propagation).
    const now = Date.now();
    const r = db.prepare(
      `INSERT INTO v5t_posts
       (type, theme, hook_pattern, caption_a, caption_b, caption_c,
        hashtags, poll_question, poll_options,
        status, generated_by, picked_footage_id, created_at)
       VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?)`,
    ).run(
      type, theme,
      captionA, captionB, captionC,
      JSON.stringify(hashtags),
      body.poll_question || null,
      body.poll_options ? JSON.stringify(body.poll_options) : null,
      opts?.generated_by || 'manual',
      photo.footage_id,
      now,
    );

    const id = r.lastInsertRowid as number;
    console.log(`[v5t-post-writer] ✅ generated post id=${id} type=${type} theme=${theme}`);

    return {
      id,
      type,
      theme,
      hook_pattern: null,
      caption_a: captionA,
      caption_b: captionB,
      caption_c: captionC,
      hashtags,
      poll_question: body.poll_question,
      poll_options: body.poll_options,
      status: 'draft',
      generated_by: opts?.generated_by || 'manual',
      created_at: now,
    };
  } catch (e: any) {
    console.error('[v5t-post-writer] FATAL:', e.message);
    return null;
  }
}

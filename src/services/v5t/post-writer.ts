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

async function generateCaptionBody(opts: {
  type: V5TPostType;
  theme: V5TTheme;
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

  const systemPrompt = `Em là content strategist Sonder Vietnam. Viết FB post.

PHILOSOPHY (BẮT BUỘC):
- POV "mình" intimate
- KHÔNG mention "Sonder", "đặt phòng", "khách sạn" trong body (chỉ #sondervn ở hashtag)
- Brand value qua HÀNH ĐỘNG, không TUYÊN BỐ
- KHÔNG hard-sell, KHÔNG engagement bait ("Hỏi thật nhé", "Còn chần chừ")
- Tên VN thật (Linh, Tuấn, Vy, Khanh, Hà)
- Văn thơ, cụ thể, sensory

${themeGuide}

${typeGuide}

OUTPUT JSON:
{
  "body": "<caption full theo type guide>"
}`;

  try {
    const text = (await generate({
      task: 'caption',
      system: systemPrompt,
      user: 'Generate JSON only.',
    })).trim();

    const m = text.match(/\{[\s\S]*\}/);
    if (!m) throw new Error('no JSON');
    const parsed = JSON.parse(m[0]);

    return {
      body: parsed.body || '',
      poll_question: parsed.poll_question,
      poll_options: parsed.poll_options,
    };
  } catch (e: any) {
    console.warn('[v5t-post-writer] body gen fail:', e.message);
    throw e;
  }
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
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return '';
    const parsed = JSON.parse(m[0]);
    return (parsed.hook || '').trim();
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
    // 1. Generate body (and poll fields if applicable)
    const body = await generateCaptionBody({ type, theme });

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

    // 5. Persist to DB
    const now = Date.now();
    const r = db.prepare(
      `INSERT INTO v5t_posts
       (type, theme, hook_pattern, caption_a, caption_b, caption_c,
        hashtags, poll_question, poll_options,
        status, generated_by, created_at)
       VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)`,
    ).run(
      type, theme,
      captionA, captionB, captionC,
      JSON.stringify(hashtags),
      body.poll_question || null,
      body.poll_options ? JSON.stringify(body.poll_options) : null,
      opts?.generated_by || 'manual',
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

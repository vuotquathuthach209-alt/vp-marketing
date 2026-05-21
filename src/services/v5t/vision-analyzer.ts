/**
 * V5T Vision Analyzer — Gemini Vision describes image content.
 *
 * Reference: skill sonder-content-v5t (caption "kể chuyện theo ảnh")
 *
 * Workflow:
 *   image → Gemini Vision (free, fast) → JSON {description, location, character, moment_tag, content_type}
 *   → use to:
 *     1. Tag v5_footage row for retrieval
 *     2. Inject as context for caption gen (post-writer)
 *
 * Cost: Gemini Flash Vision = $0.0001/image (effectively free)
 *
 * Retry strategy (Phase 6 fix — 60/96 fail rate before):
 *   1. Pass 1: rich prompt + responseMimeType=application/json (stricter)
 *   2. Pass 2 fallback: simpler prompt + manual JSON extraction (markdown wrappers, embedded text)
 *   3. Tag diversity: expanded location + moment_tag enums to break "phong_ngu" repetition.
 */

import * as fs from 'fs';
import axios from 'axios';
import { getSetting } from '../../db';

export interface VisionAnalysis {
  description: string;                  // 1-2 sentence description
  location: string | null;              // expanded enum (see prompt)
  character: string | null;             // tuan | linh | vy | khanh | ha | tai | guest | no_face
  moment_tag: string;                   // kebab-case tag, more diverse vocabulary
  content_type: 'tips' | 'story' | 'general';  // suggested post type fit
  vietnamese_keywords: string[];        // top 5 VN keywords for this image
}

/** Strict prompt — primary attempt */
const RICH_PROMPT = `Phân tích ảnh từ Sonder boutique guesthouse Việt Nam.

CHỈ trả về JSON HỢP LỆ (không markdown, không text trước/sau, không backticks):
{
  "description": "1-2 câu tiếng Việt mô tả cụ thể nội dung ảnh, KHÔNG văn vẻ chung chung",
  "location": "chọn 1: airport | q1 | binh_thanh | phu_nhuan | cafe_vy | street | restaurant | pho_quan | cafe | hem | market | room_view | bathroom | lobby | balcony | hallway | bedroom | rooftop | other",
  "character": "tuan | linh | vy | khanh | ha | tai | guest | no_face | null",
  "moment_tag": "kebab_case 2-4 từ mô tả MOMENT cụ thể, ĐỪNG dùng 'phong_ngu' / 'phong_ngu_lang_man' nếu có thể chọn tag cụ thể hơn. VD tốt: pha_tra_gung, ban_lam_viec_dem, view_ban_cong_mua, dia_pho_bo_tai, hem_chieu_nang, sanh_check_in, cafe_phin_sang, ban_an_gia_dinh, decor_tuong_hoa, giuong_goi_trang",
  "content_type": "tips | story | general",
  "vietnamese_keywords": ["5","keywords","tiếng","Việt","cụ_thể"]
}

content_type guide:
- tips: ảnh quán ăn / cafe / địa điểm Sài Gòn (street food, hẻm, rooftop view) → suitable for "5 quán phở..." tips
- story: ảnh moment Sonder (chú Tuấn pha trà, sảnh đêm, khách check-in) → narrative
- general: ảnh chung (phòng đẹp, decor, food close-up) → either fit

QUAN TRỌNG:
- moment_tag PHẢI ĐA DẠNG, đừng lặp lại "phong_ngu_lang_man" cho mọi ảnh phòng — phân biệt cụ thể: giuong_trang, ban_lam_viec, view_ban_cong, decor_tuong, anh_sang_cua_so, etc.
- description PHẢI CỤ THỂ về NỘI DUNG, không generic.
- Trả CHỈ JSON, không thêm gì.`;

/** Simpler prompt — retry attempt */
const SIMPLE_PROMPT = `Describe this photo. Return ONLY this JSON, nothing else:
{"description":"1 sentence Vietnamese","location":"q1|binh_thanh|phu_nhuan|airport|street|cafe|restaurant|room_view|bathroom|lobby|balcony|hallway|bedroom|rooftop|other","character":"tuan|linh|guest|no_face|null","moment_tag":"2-4 words kebab_case specific","content_type":"tips|story|general","vietnamese_keywords":["5","words"]}`;

/** Robust JSON extraction — handles markdown wrappers, leading/trailing text, truncation */
function extractJSON(raw: string): any | null {
  if (!raw) return null;

  // 1. Try direct parse
  try {
    return JSON.parse(raw);
  } catch {}

  // 2. Strip markdown code fences (```json ... ``` or ``` ... ```)
  let cleaned = raw
    .replace(/^```(?:json|JSON)?\s*\n?/m, '')
    .replace(/\n?\s*```\s*$/m, '')
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch {}

  // 3. Extract first {...} block (greedy)
  const m = cleaned.match(/\{[\s\S]*\}/);
  if (m) {
    try {
      return JSON.parse(m[0]);
    } catch {}

    // 3a. Try to repair common issues — unterminated strings near end
    let repaired = m[0];
    // If JSON looks truncated mid-string, close it
    if (!repaired.trimEnd().endsWith('}')) {
      // Count unmatched quotes
      const quoteCount = (repaired.match(/"/g) || []).length;
      if (quoteCount % 2 !== 0) repaired += '"';
      // Close arrays
      const openBrackets = (repaired.match(/\[/g) || []).length;
      const closeBrackets = (repaired.match(/\]/g) || []).length;
      for (let i = 0; i < openBrackets - closeBrackets; i++) repaired += ']';
      // Close objects
      const openBraces = (repaired.match(/\{/g) || []).length;
      const closeBraces = (repaired.match(/\}/g) || []).length;
      for (let i = 0; i < openBraces - closeBraces; i++) repaired += '}';
      try {
        return JSON.parse(repaired);
      } catch {}
    }
  }

  // 4. Field-by-field regex extraction (last resort)
  const description = raw.match(/"description"\s*:\s*"([^"]{3,500})"/)?.[1];
  const location = raw.match(/"location"\s*:\s*"([^"]+)"/)?.[1];
  const character = raw.match(/"character"\s*:\s*"?([a-z_]+|null)"?/)?.[1];
  const moment_tag = raw.match(/"moment_tag"\s*:\s*"([^"]+)"/)?.[1];
  const content_type = raw.match(/"content_type"\s*:\s*"(tips|story|general)"/)?.[1];

  if (description || moment_tag) {
    return {
      description: description || '',
      location: location || null,
      character: character || null,
      moment_tag: moment_tag || 'general',
      content_type: content_type || 'general',
      vietnamese_keywords: [],
    };
  }

  return null;
}

async function callGemini(opts: {
  apiKey: string;
  prompt: string;
  base64: string;
  mimeType: string;
  maxTokens: number;
  temperature: number;
}): Promise<string | null> {
  try {
    const r = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent?key=${opts.apiKey}`,
      {
        contents: [{
          parts: [
            { text: opts.prompt },
            { inline_data: { mime_type: opts.mimeType, data: opts.base64 } },
          ],
        }],
        generationConfig: {
          temperature: opts.temperature,
          maxOutputTokens: opts.maxTokens,
          responseMimeType: 'application/json',
        },
      },
      { timeout: 30000 },
    );
    return r.data?.candidates?.[0]?.content?.parts?.[0]?.text || null;
  } catch (e: any) {
    console.warn('[v5t-vision] gemini call fail:', e?.response?.data?.error?.message || e.message);
    return null;
  }
}

export async function analyzeImageContent(imagePath: string): Promise<VisionAnalysis | null> {
  const apiKey = getSetting('google_api_key') || process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    console.warn('[v5t-vision] google_api_key not configured');
    return null;
  }

  if (!fs.existsSync(imagePath)) {
    console.warn(`[v5t-vision] file not found: ${imagePath}`);
    return null;
  }

  const imageData = fs.readFileSync(imagePath);
  const base64 = imageData.toString('base64');
  const ext = imagePath.toLowerCase();
  const mimeType = ext.endsWith('.png') ? 'image/png'
                 : ext.endsWith('.webp') ? 'image/webp'
                 : 'image/jpeg';

  // ─── Pass 1: rich prompt, larger token budget, low temp ───
  const text1 = await callGemini({
    apiKey, base64, mimeType,
    prompt: RICH_PROMPT,
    maxTokens: 1024,   // was 500 — caused truncation on rich responses
    temperature: 0.1,  // was 0.2 — lower for more reliable JSON
  });

  if (text1) {
    const parsed = extractJSON(text1);
    if (parsed && (parsed.description || parsed.moment_tag)) {
      return normalize(parsed);
    }
    console.warn(`[v5t-vision] pass1 parse fail for ${imagePath.split(/[\\/]/).pop()}, trying simpler prompt`);
  }

  // ─── Pass 2: simpler prompt fallback ───
  const text2 = await callGemini({
    apiKey, base64, mimeType,
    prompt: SIMPLE_PROMPT,
    maxTokens: 800,
    temperature: 0.05,
  });

  if (text2) {
    const parsed = extractJSON(text2);
    if (parsed && (parsed.description || parsed.moment_tag)) {
      return normalize(parsed);
    }
    console.warn(`[v5t-vision] pass2 parse fail too — raw[:200]: ${text2.slice(0, 200)}`);
  }

  return null;
}

/** Normalize parsed object → VisionAnalysis with safe defaults */
function normalize(parsed: any): VisionAnalysis {
  // Validate moment_tag — reject overused defaults to encourage diversity
  let momentTag = String(parsed.moment_tag || 'general').toLowerCase().trim();
  // Convert dashes to underscores for consistency
  momentTag = momentTag.replace(/-/g, '_').replace(/[^a-z0-9_]/g, '');
  if (!momentTag || momentTag.length < 3) momentTag = 'general';

  // Normalize location
  let location: string | null = null;
  if (parsed.location && parsed.location !== 'null' && parsed.location !== null) {
    location = String(parsed.location).toLowerCase().trim().replace(/-/g, '_');
  }

  // Normalize character
  let character: string | null = null;
  if (parsed.character && parsed.character !== 'null' && parsed.character !== null && parsed.character !== 'no_face') {
    character = String(parsed.character).toLowerCase().trim();
  } else if (parsed.character === 'no_face') {
    character = 'no_face';
  }

  // Validate content_type
  const contentType = ['tips', 'story', 'general'].includes(parsed.content_type)
    ? parsed.content_type
    : 'general';

  // Keywords array
  const keywords = Array.isArray(parsed.vietnamese_keywords)
    ? parsed.vietnamese_keywords.slice(0, 8).map((k: any) => String(k).trim()).filter(Boolean)
    : [];

  return {
    description: String(parsed.description || '').trim().slice(0, 500),
    location,
    character,
    moment_tag: momentTag,
    content_type: contentType,
    vietnamese_keywords: keywords,
  };
}

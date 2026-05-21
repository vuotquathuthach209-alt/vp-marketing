/**
 * SEO Alt-Text generator — Vietnamese + English alt text via Gemini Vision.
 *
 * Workflow:
 *   1. Discover images that lack alt (or have weak generic alt)
 *      → from v5_footage rows (Sonder's photo library) OR seo_pages images
 *   2. Call Gemini Vision on each image
 *   3. Generate VI + EN alt text (≤125 chars each, descriptive but not keyword-stuffed)
 *   4. Save to seo_image_alt for admin review + apply
 *
 * Re-uses v5t/vision-analyzer Gemini infrastructure — no new API calls needed.
 */

import * as fs from 'fs';
import axios from 'axios';
import { db, getSetting } from '../../db';

const PROMPT = `Bạn là chuyên gia SEO. Phân tích ảnh này và tạo alt text cho website khách sạn.

Trả về CHỈ JSON (không markdown, không text khác):
{
  "alt_vi": "1 câu tiếng Việt mô tả ảnh, 60-125 ký tự, CỤ THỂ về nội dung, KHÔNG keyword stuffing",
  "alt_en": "1 sentence English describing the image, 60-125 chars, specific content, no keyword stuffing",
  "keywords": ["3-5", "Vietnamese", "keywords", "relevant", "to-image"]
}

QUY TẮC:
- alt_vi/en PHẢI mô tả NỘI DUNG ảnh (vd: "Sảnh khách sạn đèn vàng với bàn lễ tân gỗ tối")
- KHÔNG viết "ảnh khách sạn đẹp" / "hotel photo" — quá chung chung
- KHÔNG dùng tên thương hiệu nếu không thấy logo cụ thể
- alt_vi viết tiếng Việt tự nhiên, không dấu cứng`;

interface VisionResult {
  alt_vi: string;
  alt_en: string;
  keywords: string[];
}

async function callVision(imagePath: string, apiKey: string): Promise<VisionResult | null> {
  if (!fs.existsSync(imagePath)) return null;
  try {
    const imageData = fs.readFileSync(imagePath);
    const base64 = imageData.toString('base64');
    const mime = imagePath.toLowerCase().endsWith('.png') ? 'image/png'
               : imagePath.toLowerCase().endsWith('.webp') ? 'image/webp' : 'image/jpeg';

    const r = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent?key=${apiKey}`,
      {
        contents: [{ parts: [{ text: PROMPT }, { inline_data: { mime_type: mime, data: base64 } }] }],
        generationConfig: { temperature: 0.2, maxOutputTokens: 500, responseMimeType: 'application/json' },
      },
      { timeout: 30_000 },
    );
    const text = r.data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) return null;
    const parsed = JSON.parse(text);
    return {
      alt_vi: String(parsed.alt_vi || '').trim().slice(0, 200),
      alt_en: String(parsed.alt_en || '').trim().slice(0, 200),
      keywords: Array.isArray(parsed.keywords) ? parsed.keywords.slice(0, 8).map(String) : [],
    };
  } catch (e: any) {
    console.warn('[seo-alt] vision fail:', e?.response?.data?.error?.message || e?.message);
    return null;
  }
}

/** Generate alt-text suggestions for all v5_footage images (Sonder photo library). */
export async function generateAltsForFootage(opts?: { limit?: number }): Promise<{
  scanned: number;
  generated: number;
  skipped: number;
  errors: string[];
}> {
  const result = { scanned: 0, generated: 0, skipped: 0, errors: [] as string[] };
  const apiKey = getSetting('google_api_key') || process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    result.errors.push('google_api_key not configured');
    return result;
  }

  const limit = opts?.limit || 50;
  // Pick footage rows that don't yet have alt-text suggestion
  const rows = db.prepare(
    `SELECT vf.id, vf.path, vf.filename
     FROM v5_footage vf
     WHERE (vf.media_type = 'image' OR vf.media_type IS NULL)
       AND vf.path IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM seo_image_alt sia WHERE sia.image_url = vf.path
       )
     ORDER BY vf.id DESC
     LIMIT ?`,
  ).all(limit) as Array<{ id: number; path: string; filename: string }>;

  result.scanned = rows.length;
  console.log(`[seo-alt] generating for ${rows.length} footage images...`);

  for (const row of rows) {
    try {
      const v = await callVision(row.path, apiKey);
      if (!v) {
        result.skipped++;
        continue;
      }
      db.prepare(
        `INSERT OR REPLACE INTO seo_image_alt
         (image_url, page_url, current_alt, current_alt_lang,
          suggested_alt_vi, suggested_alt_en, vision_keywords, status, created_at)
         VALUES (?, ?, NULL, NULL, ?, ?, ?, 'pending', ?)`,
      ).run(row.path, null, v.alt_vi, v.alt_en, JSON.stringify(v.keywords), Date.now());
      result.generated++;
      await new Promise((r) => setTimeout(r, 200)); // throttle
    } catch (e: any) {
      result.errors.push(`footage #${row.id}: ${e?.message}`);
    }
  }

  console.log(`[seo-alt] DONE: generated=${result.generated} skipped=${result.skipped} errors=${result.errors.length}`);
  return result;
}

/** Generate alt for an arbitrary URL (downloads image first). Used by sondervn.com crawl. */
export async function generateAltForUrl(imageUrl: string, pageUrl?: string): Promise<{ ok: boolean; alt_vi?: string; alt_en?: string; error?: string }> {
  const apiKey = getSetting('google_api_key') || process.env.GOOGLE_API_KEY;
  if (!apiKey) return { ok: false, error: 'google_api_key not configured' };

  // Download image to temp file
  try {
    const r = await axios.get(imageUrl, { responseType: 'arraybuffer', timeout: 20_000, maxContentLength: 10 * 1024 * 1024 });
    const buf = Buffer.from(r.data);
    const tmp = `/tmp/seo-img-${Date.now()}.jpg`;
    fs.writeFileSync(tmp, buf);
    const v = await callVision(tmp, apiKey);
    try { fs.unlinkSync(tmp); } catch {}
    if (!v) return { ok: false, error: 'vision returned null' };

    db.prepare(
      `INSERT OR REPLACE INTO seo_image_alt
       (image_url, page_url, current_alt, current_alt_lang,
        suggested_alt_vi, suggested_alt_en, vision_keywords, status, created_at)
       VALUES (?, ?, NULL, NULL, ?, ?, ?, 'pending', ?)`,
    ).run(imageUrl, pageUrl || null, v.alt_vi, v.alt_en, JSON.stringify(v.keywords), Date.now());

    return { ok: true, alt_vi: v.alt_vi, alt_en: v.alt_en };
  } catch (e: any) {
    return { ok: false, error: e?.message };
  }
}

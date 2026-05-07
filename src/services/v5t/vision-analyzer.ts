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
 */

import * as fs from 'fs';
import axios from 'axios';
import { getSetting } from '../../db';

export interface VisionAnalysis {
  description: string;                  // 1-2 sentence description
  location: string | null;              // airport | q1 | binh_thanh | phu_nhuan | cafe_vy | street | restaurant | other
  character: string | null;             // tuan | linh | vy | khanh | ha | tai | guest | no_face
  moment_tag: string;                   // kebab-case tag, e.g. "pha_tra_gung", "san_dem_mua"
  content_type: 'tips' | 'story' | 'general';  // suggested post type fit
  vietnamese_keywords: string[];        // top 5 VN keywords for this image
}

export async function analyzeImageContent(imagePath: string): Promise<VisionAnalysis | null> {
  const apiKey = getSetting('google_api_key') || process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    console.warn('[v5t-vision] google_api_key not configured');
    return null;
  }

  try {
    const imageData = fs.readFileSync(imagePath);
    const base64 = imageData.toString('base64');
    const mimeType = imagePath.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';

    const prompt = `Analyze this photo from Sonder boutique guesthouse Vietnam.

Output STRICT JSON only:
{
  "description": "<1-2 câu tiếng Việt mô tả hình. VD: 'Sảnh khách sạn đèn vàng ấm. Một cốc trà gừng đặt trên quầy gỗ.'>",
  "location": "<chọn 1: airport | q1 | binh_thanh | phu_nhuan | cafe_vy | street | restaurant | other>",
  "character": "<chọn nếu có người: tuan (lễ tân nam middle-aged) | linh (cô gái 28t Việt) | guest | no_face | null nếu không có người>",
  "moment_tag": "<kebab-case 1 tag chính. VD: pha_tra_gung, san_dem_mua, view_phong, hanh_lang_den_vang, mon_an_pho>",
  "content_type": "<tips | story | general>",
  "vietnamese_keywords": ["<5 keywords tiếng Việt mô tả ảnh>"]
}

content_type guide:
- "tips": ảnh quán ăn / cafe / địa điểm Sài Gòn → suitable for "5 quán phở..." tips post
- "story": ảnh moment Sonder (chú Tuấn pha trà, sảnh đêm, khách check-in) → suitable for narrative
- "general": ảnh chung (view, decoration, food close-up) → either fit

KHÔNG văn vẻ. JSON only.`;

    const r = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
      {
        contents: [{
          parts: [
            { text: prompt },
            { inline_data: { mime_type: mimeType, data: base64 } },
          ],
        }],
        generationConfig: {
          temperature: 0.2,
          maxOutputTokens: 500,
          responseMimeType: 'application/json',
        },
      },
      { timeout: 30000 },
    );

    const text = r.data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) return null;

    const parsed = JSON.parse(text);
    return {
      description: parsed.description || '',
      location: parsed.location && parsed.location !== 'null' ? parsed.location : null,
      character: parsed.character && parsed.character !== 'null' ? parsed.character : null,
      moment_tag: parsed.moment_tag || 'general',
      content_type: parsed.content_type || 'general',
      vietnamese_keywords: parsed.vietnamese_keywords || [],
    };
  } catch (e: any) {
    console.warn('[v5t-vision] analyze fail:', e?.response?.data?.error?.message || e.message);
    return null;
  }
}

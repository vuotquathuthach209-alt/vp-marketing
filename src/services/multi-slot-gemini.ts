/**
 * Multi-Slot Gemini Extractor — fill gaps mà deterministic extractor miss.
 *
 * Trigger: khi deterministic extract < 2 slot VÀ message dài > 15 chars.
 * Gemini phân tích toàn bộ message + return all slots detected.
 * Merge với deterministic (deterministic thắng ưu tiên).
 *
 * Cost: ~0.02 xu/1k tokens với gemini-2.5-flash. Batch size nhỏ nên OK.
 */

import { ExtractedSlots } from './slot-extractor';

const GEMINI_SYSTEM = `Bạn là AI phân tích nhu cầu khách đặt phòng khách sạn Việt Nam.
Trích xuất TẤT CẢ slot có trong tin nhắn khách.

Schema JSON output:
{
  "property_type": "hotel|homestay|villa|apartment|resort|guesthouse|hostel|null",
  "area": "tên khu vực nếu có (vd: Q1, Tân Bình, Sân bay, Bình Thạnh)|null",
  "city": "Ho Chi Minh|Hanoi|Da Nang|Nha Trang|Phu Quoc|null",
  "checkin_hint": "mô tả ngày nếu có (vd: 'hôm nay', '25/5', 'tuần sau', 'cuối tuần')|null",
  "nights": "số đêm nếu có|null",
  "months": "số tháng nếu có|null",
  "guests_adults": "số người lớn|null",
  "guests_children": "số trẻ em|null",
  "budget_min": "số VND|null",
  "budget_max": "số VND|null",
  "rental_sub_mode": "hourly|nightly|monthly|null"
}

QUY TẮC:
- KHÔNG bịa info không có trong message
- Budget: "1 chai" = 1000000, "500k" = 500000, "1tr" = 1000000
- Property type detection: "khách sạn"=hotel, "homestay"/"nhà dân"=homestay,
  "căn hộ"/"chdv"=apartment, "villa"/"biệt thự"=villa
- "2 người" = {adults: 2}; "gia đình 4" = {adults: 2, children: 2}
- Chỉ output JSON, không prose. Null field nếu không có.`;

export async function extractSlotsGemini(msg: string): Promise<ExtractedSlots | null> {
  if (msg.length < 15) return null;  // too short, rely on deterministic

  try {
    const { smartCascade } = require('./smart-cascade');
    const result = await smartCascade({
      system: GEMINI_SYSTEM,
      user: `Tin nhắn khách: "${msg}"\n\nOutput JSON:`,
      json: true,
      temperature: 0.1,
      maxTokens: 400,
      startFrom: 'gemini_flash',  // prefer fastest
    });

    const parsed = JSON.parse(result.text);

    // Map Gemini output → ExtractedSlots
    const out: ExtractedSlots = {};

    if (parsed.property_type && ['hotel', 'homestay', 'villa', 'apartment', 'resort', 'guesthouse', 'hostel'].includes(parsed.property_type)) {
      out.property_type = parsed.property_type;
    }
    if (parsed.area) {
      out.area = {
        area: parsed.area,
        normalized: parsed.area,
        type: 'district',
        city: parsed.city || 'Ho Chi Minh',
        district: parsed.area,
      };
    }
    if (parsed.checkin_hint || parsed.nights) {
      out.dates = {};
      if (parsed.nights) out.dates.nights = Number(parsed.nights);
      // If hint is actual date (25/5) → parse
      if (parsed.checkin_hint && /\d+[\/\-]\d+/.test(parsed.checkin_hint)) {
        const m = parsed.checkin_hint.match(/(\d{1,2})[\/\-](\d{1,2})/);
        if (m) {
          const now = new Date();
          out.dates.checkin_date = `${now.getFullYear()}-${String(m[2]).padStart(2, '0')}-${String(m[1]).padStart(2, '0')}`;
        }
      }
    }
    if (parsed.guests_adults) {
      out.guests = { adults: Number(parsed.guests_adults) };
      if (parsed.guests_children) out.guests.children = Number(parsed.guests_children);
    }
    if (parsed.budget_min || parsed.budget_max) {
      out.budget = {};
      if (parsed.budget_min) out.budget.min = Number(parsed.budget_min);
      if (parsed.budget_max) out.budget.max = Number(parsed.budget_max);
    }
    if (parsed.months) out.months = Number(parsed.months);
    if (parsed.rental_sub_mode && ['hourly', 'nightly', 'monthly'].includes(parsed.rental_sub_mode)) {
      out.rental_sub_mode = parsed.rental_sub_mode;
    }

    return out;
  } catch (e: any) {
    console.warn('[multi-slot-gemini] fail:', e?.message);
    return null;
  }
}

/**
 * Merge Gemini-extracted với deterministic. Deterministic thắng nếu có conflict.
 */
export function mergeExtractedSlots(deterministic: ExtractedSlots, gemini: ExtractedSlots | null): ExtractedSlots {
  if (!gemini) return deterministic;
  const out: ExtractedSlots = { ...deterministic };

  if (!out.property_type && gemini.property_type) out.property_type = gemini.property_type;
  if (!out.area && gemini.area) out.area = gemini.area;
  if (!out.dates && gemini.dates) out.dates = gemini.dates;
  else if (out.dates && gemini.dates) {
    // Fill individual fields
    if (!out.dates.checkin_date && gemini.dates.checkin_date) out.dates.checkin_date = gemini.dates.checkin_date;
    if (!out.dates.nights && gemini.dates.nights) out.dates.nights = gemini.dates.nights;
  }
  if (!out.guests && gemini.guests) out.guests = gemini.guests;
  if (!out.budget && gemini.budget) out.budget = gemini.budget;
  if (!out.months && gemini.months) out.months = gemini.months;
  if (!out.rental_sub_mode && gemini.rental_sub_mode) out.rental_sub_mode = gemini.rental_sub_mode;

  return out;
}

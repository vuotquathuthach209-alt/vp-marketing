/**
 * Hotel Knowledge Synthesizer
 *
 * Input: raw OTA hotel data (bất kỳ schema nào)
 * Output: structured hotel_knowledge data (VN bot-ready)
 *
 * Pipeline:
 *   1. Build prompt (system + few-shot + raw data JSON)
 *   2. Call Gemini 2.5 Flash (primary) — qua router task='etl_synthesize'
 *   3. If Gemini 429/timeout → router tự fallback sang Qwen local
 *   4. Parse + validate JSON
 *   5. Retry 1 lần với temperature=0 nếu schema invalid
 */
import { generate } from './router';

export interface OtaRawHotel {
  id: number | string;           // OTA hotel ID
  name: string;
  address?: string;
  city?: string;
  district?: string;
  latitude?: number;
  longitude?: number;
  phone?: string;
  star_rating?: number;
  description?: string;
  amenities?: any;                // array hoặc object tùy schema OTA
  property_type?: string;         // apartment | homestay | hotel | resort | villa | ...
  rooms?: Array<{
    id?: string | number;
    name: string;
    price?: number;
    price_weekend?: number;
    price_hourly?: number;
    max_guests?: number;
    bed_type?: string;
    size_m2?: number;
    description?: string;
    photos?: string[];
    amenities?: any;
  }>;
  policies?: any;                 // check-in/out, cancellation, etc.
  [key: string]: any;             // tolerate unknown fields
}

export interface SynthesizedHotel {
  name_canonical: string;
  name_en?: string;
  ai_summary_vi: string;          // 2-3 câu VN
  ai_summary_en?: string;         // 2-3 câu EN
  city: string;
  district?: string;
  address?: string;
  latitude?: number;
  longitude?: number;
  phone?: string;
  star_rating?: number;
  target_segment?: string;        // 'family'|'couple'|'business'|'backpacker'|'mixed'
  property_type?: string;         // 'apartment'|'homestay'|'hotel'|'resort'|'villa'|'guesthouse'|'hostel'
  rental_type?: string;           // 'per_night'|'per_hour'|'per_month'|'mixed'
  brand_voice?: string;           // 'formal'|'friendly'|'luxury'|'casual'
  usp_top3: string[];             // ["Gần sân bay 1.5km", "Bếp trong phòng", ...]
  nearby_landmarks?: {
    airport_km?: number;
    beach_km?: number;
    center_km?: number;
    landmarks?: Array<{ name: string; km: number }>;
  };
  rooms: Array<{
    room_key: string;
    display_name_vi: string;
    display_name_en?: string;
    price_weekday: number;
    price_weekend: number;
    price_hourly?: number;
    max_guests: number;
    bed_config?: string;
    size_m2?: number;
    amenities?: string[];
    description_vi?: string;
  }>;
  amenities: Array<{
    category: string;
    name_vi: string;
    name_en?: string;
    free?: boolean;
    hours?: string;
  }>;
  policies?: {
    checkin_time?: string;
    checkout_time?: string;
    cancellation_text?: string;
    deposit_percent?: number;
    pet_allowed?: boolean;
    child_policy?: string;
    payment_methods?: string[];
  };
}

// v7.4: Compact prompt — data đã được phễu classify sạch, Gemini chỉ làm creative
const CREATIVE_ONLY_PROMPT = `Bạn viết nội dung marketing tiếng Việt cho chatbot khách sạn.

Tôi đã phân loại + chuẩn hóa data rồi. BẠN CHỈ CẦN viết:
1. ai_summary_vi: 2-3 câu tiếng Việt tự nhiên, nêu điểm nổi bật + phù hợp ai.
2. ai_summary_en: 2-3 câu English equivalent.
3. usp_top3: 3 điểm bán hàng nổi bật (mỗi dòng ngắn gọn, không dài).
4. room_display_names: array optional, đổi tên phòng kỹ thuật → tên VN thân thiện.
5. brand_voice: formal | friendly | luxury | casual

INPUT JSON đã được phễu xử lý sạch (property_type, pricing, services, tier, segment đã xác định).
BẠN KHÔNG CẦN phán đoán property_type, giá, hay dịch vụ — DÙNG Y NGUYÊN.

OUTPUT JSON strict:
{
  "ai_summary_vi": "...",
  "ai_summary_en": "...",
  "usp_top3": ["...", "...", "..."],
  "brand_voice": "friendly"
}`;

const SYSTEM_PROMPT = `Bạn là AI chuyên tổng hợp dữ liệu khách sạn từ OTA thành structured data cho chatbot.

NHIỆM VỤ: Đọc dữ liệu thô từ OTA (JSON bất kỳ schema), trích xuất và chuẩn hóa theo schema bên dưới.

YÊU CẦU OUTPUT:
- JSON STRICT đúng schema, không markdown, không text thừa.
- ai_summary_vi: 2-3 câu tiếng Việt thân thiện, nêu điểm nổi bật + phân khúc.
- usp_top3: CHỌN 3 USP thực sự nổi bật (không fill cho đủ nếu không có).
- room display_name_vi: đổi tên kỹ thuật thành tên gần gũi ("STANDARD 2PAX LG BD" → "Phòng Standard Giường lớn 2 khách").
- amenities: chỉ list tiện ích HIỆN CÓ (có wifi thật mới điền, đừng giả định).
- Giá: nếu raw có price thì dùng, không thì 0.
- Không bịa thông tin. Nếu thiếu → để undefined.

VỀ property_type và rental_type (QUAN TRỌNG — theo model KD Sonder):

Sonder có 2 NHÓM SẢN PHẨM KHÁC BIỆT:
1. **property_type="apartment"** = **Căn hộ dịch vụ thuê THÁNG** (long-term rental)
   - Đặc điểm: full bếp, máy giặt riêng, điện nước bao trọn
   - Target: expat, freelancer, người chuyển công tác
   - rental_type = "per_month"
   - Giá thường 3-10 triệu/tháng
   - URL: /homestay trên website
   - ai_summary_vi PHẢI nói: "căn hộ dịch vụ cho thuê theo THÁNG"

2. **property_type="homestay" | "hotel" | "villa" | "resort" | "guesthouse"** = **Thuê theo ĐÊM** (short-term)
   - Target: khách du lịch
   - rental_type = "per_night"
   - Giá thường 400k-2M/đêm
   - URL: /khach-san
   - ai_summary_vi PHẢI nói: "thuê theo đêm"

KHÔNG NHẦM: Sonder "apartment" KHÔNG phải serviced short-term hotel. Là căn hộ cho thuê dài hạn theo tháng (kèm bếp, giặt, điện nước).

Luôn PRESERVE property_type theo input. Suy luận rental_type từ property_type.

SCHEMA JSON output:
{
  "name_canonical": "<tên chuẩn>",
  "name_en": "<tên EN nếu có>",
  "ai_summary_vi": "<2-3 câu VN>",
  "ai_summary_en": "<2-3 câu EN>",
  "city": "<TP chính>",
  "district": "<quận/huyện>",
  "address": "<địa chỉ đầy đủ>",
  "latitude": <number>,
  "longitude": <number>,
  "phone": "<sđt>",
  "star_rating": <1-5>,
  "target_segment": "family|couple|business|backpacker|mixed",
  "property_type": "apartment|homestay|hotel|resort|villa|guesthouse|hostel",
  "brand_voice": "formal|friendly|luxury|casual",
  "rental_type": "per_night|per_hour|per_month|mixed",
  "usp_top3": ["...", "...", "..."],
  "nearby_landmarks": { "airport_km": <num>, "beach_km": <num>, "center_km": <num> },
  "rooms": [
    {
      "room_key": "<unique key>",
      "display_name_vi": "<tên VN>",
      "display_name_en": "<tên EN>",
      "price_weekday": <num>,
      "price_weekend": <num>,
      "price_hourly": <num>,
      "max_guests": <num>,
      "bed_config": "<VD: 1 King>",
      "size_m2": <num>,
      "amenities": ["wifi", "tv", "..."],
      "description_vi": "<1 câu>"
    }
  ],
  "amenities": [
    { "category": "<VD food>", "name_vi": "Buffet sáng", "name_en": "Breakfast buffet", "free": true, "hours": "6h30-10h" }
  ],
  "policies": {
    "checkin_time": "14:00",
    "checkout_time": "12:00",
    "cancellation_text": "...",
    "deposit_percent": 30,
    "pet_allowed": false,
    "child_policy": "...",
    "payment_methods": ["VNPay", "tiền mặt"]
  }
}`;

const FEW_SHOT_EXAMPLE = `
VÍ DỤ (đầu vào raw → đầu ra chuẩn):

INPUT RAW:
{
  "id": 42,
  "name": "SONDER APARTMENT - AIRPORT",
  "address": "B12 Bạch Đằng, P.2, Tân Bình, HCM",
  "latitude": 10.819,
  "longitude": 106.657,
  "description": "Canho gan san bay noi bai 1.5km, day du tien nghi",
  "rooms": [
    { "id": "RS01", "name": "DLX 2PAX KING", "price": 1200000, "price_weekend": 1400000, "max_guests": 2 },
    { "id": "RS02", "name": "STD 2PAX QUEEN", "price": 800000, "max_guests": 2 }
  ],
  "has_wifi": true, "has_parking": true, "airport_distance_km": 1.5
}

OUTPUT JSON:
{
  "name_canonical": "Sonder Apartment Airport",
  "name_en": "Sonder Apartment Airport",
  "ai_summary_vi": "Căn hộ dịch vụ cao cấp tại Tân Bình, chỉ cách sân bay Tân Sơn Nhất 1.5km. Phù hợp cho khách doanh nhân và khách bay sớm, đầy đủ tiện nghi với wifi miễn phí và bãi đỗ xe.",
  "ai_summary_en": "Premium serviced apartment in Tan Binh, just 1.5km from Tan Son Nhat Airport. Ideal for business travelers and early-morning flyers, with free wifi and parking.",
  "city": "HCM",
  "district": "Tân Bình",
  "address": "B12 Bạch Đằng, P.2, Tân Bình, HCM",
  "latitude": 10.819,
  "longitude": 106.657,
  "target_segment": "business",
  "brand_voice": "friendly",
  "usp_top3": ["Cách sân bay Tân Sơn Nhất chỉ 1.5km", "Wifi miễn phí tốc độ cao", "Có bãi đỗ xe riêng"],
  "nearby_landmarks": { "airport_km": 1.5 },
  "rooms": [
    { "room_key": "RS01", "display_name_vi": "Phòng Deluxe Giường King 2 khách", "display_name_en": "Deluxe King Room", "price_weekday": 1200000, "price_weekend": 1400000, "max_guests": 2, "bed_config": "1 King" },
    { "room_key": "RS02", "display_name_vi": "Phòng Standard Giường Queen 2 khách", "display_name_en": "Standard Queen Room", "price_weekday": 800000, "price_weekend": 800000, "max_guests": 2, "bed_config": "1 Queen" }
  ],
  "amenities": [
    { "category": "connectivity", "name_vi": "Wifi miễn phí", "name_en": "Free wifi", "free": true },
    { "category": "parking", "name_vi": "Bãi đỗ xe", "name_en": "Parking", "free": true }
  ]
}
`;

function buildPrompt(raw: OtaRawHotel): string {
  return `${FEW_SHOT_EXAMPLE}

INPUT RAW (synthesize bây giờ):
${JSON.stringify(raw, null, 2)}

OUTPUT JSON (strict, no markdown):`;
}

function stripJsonFences(text: string): string {
  return text.replace(/```json/gi, '').replace(/```/g, '').trim();
}

function extractJson(text: string): string | null {
  const cleaned = stripJsonFences(text);
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  return cleaned.slice(start, end + 1);
}

function validate(result: any): { valid: boolean; reason?: string } {
  if (!result || typeof result !== 'object') return { valid: false, reason: 'not an object' };
  if (!result.name_canonical || typeof result.name_canonical !== 'string') return { valid: false, reason: 'missing name_canonical' };
  if (!result.ai_summary_vi || result.ai_summary_vi.length < 20) return { valid: false, reason: 'invalid ai_summary_vi' };
  if (!Array.isArray(result.usp_top3)) return { valid: false, reason: 'usp_top3 not array' };
  if (!Array.isArray(result.rooms)) return { valid: false, reason: 'rooms not array' };
  if (!Array.isArray(result.amenities)) return { valid: false, reason: 'amenities not array' };
  return { valid: true };
}

export async function synthesizeHotel(raw: OtaRawHotel): Promise<{
  ok: boolean;
  data?: SynthesizedHotel;
  provider?: string;
  error?: string;
  retried?: boolean;
}> {
  // v7.4: Qua phễu trước — structured input sạch, Gemini chỉ làm creative
  let usingFunnel = false;
  let structured: any = null;
  let user: string;
  let system: string;
  try {
    const { runFunnel, buildGeminiPromptFromStructured } = require('./data-funnel');
    structured = runFunnel(raw);
    if (structured._issues?.length > 0) {
      console.log(`[funnel] #${structured.id} issues: ${structured._issues.join(', ')}`);
    }
    user = `${buildGeminiPromptFromStructured(structured)}\n\nViết creative text (JSON strict, no markdown):`;
    system = CREATIVE_ONLY_PROMPT;
    usingFunnel = true;
  } catch (e: any) {
    console.warn('[funnel] fail, fallback to full Gemini prompt:', e?.message);
    user = buildPrompt(raw);
    system = SYSTEM_PROMPT;
  }
  let raw_text: string;
  let retried = false;

  try {
    raw_text = await generate({ task: 'etl_synthesize', system, user });
  } catch (e: any) {
    return { ok: false, error: `generate fail: ${e?.message || e}` };
  }

  // Parse
  console.log(`[synth] raw output preview (len=${raw_text?.length || 0}):`, (raw_text || '').slice(0, 200));
  let jsonStr = extractJson(raw_text);
  if (!jsonStr) {
    console.warn('[synth] no JSON in first attempt, retrying stricter');
    // Retry với prompt stricter
    try {
      raw_text = await generate({
        task: 'etl_synthesize',
        system: SYSTEM_PROMPT + '\n\nCRITICAL: Output ONLY valid JSON, nothing else. No markdown, no explanation.',
        user,
      });
      console.log('[synth] retry output preview:', (raw_text || '').slice(0, 200));
      jsonStr = extractJson(raw_text);
      retried = true;
    } catch (e: any) {
      return { ok: false, error: `retry fail: ${e?.message || e}`, retried: true };
    }
    if (!jsonStr) return { ok: false, error: 'no JSON in output', retried: true };
  }

  let parsed: any;
  try { parsed = JSON.parse(jsonStr); } catch (e: any) {
    return { ok: false, error: `JSON parse fail: ${e?.message}`, retried };
  }

  const v = validate(parsed);
  if (!v.valid) return { ok: false, error: `validation: ${v.reason}`, retried };

  // v7.4: MERGE structured (rule-based) INTO Gemini output — structured WINS
  if (usingFunnel && structured) {
    // Gemini only contributed: ai_summary_vi/en, usp_top3, brand_voice, room_display_names
    parsed.name_canonical = structured.name;
    parsed.property_type = structured.property_type;
    parsed.rental_type = structured.rental_type;
    parsed.target_segment = structured.target_segment_hint;
    parsed.address = structured.address;
    parsed.city = structured.city;
    parsed.district = structured.district;
    parsed.latitude = structured.latitude;
    parsed.longitude = structured.longitude;
    parsed.phone = structured.phone;
    parsed.star_rating = structured.star_rating;

    // Rooms derived from pricing (apartment) or raw rooms (short stay)
    parsed.rooms = [];
    if (structured.product_group === 'long_term_apartment' && structured.pricing.monthly) {
      parsed.rooms = [
        {
          room_key: `${structured.id}_monthly`,
          display_name_vi: `Phòng thuê tháng ${structured.name}`,
          display_name_en: `Monthly apartment ${structured.name}`,
          price_weekday: structured.pricing.monthly.min,
          price_weekend: structured.pricing.monthly.max,
          max_guests: 2,
          description_vi: `Căn hộ dịch vụ cho thuê tháng. ${structured.included_services.join(', ')}.`,
        },
      ];
    } else if (structured.pricing.daily) {
      const rawRooms = (structured._raw?.rooms || []);
      parsed.rooms = rawRooms.length > 0
        ? rawRooms.map((r: any) => ({
            room_key: String(r.id || r.name || Math.random()),
            display_name_vi: r.name || 'Phòng',
            price_weekday: r.price || structured.pricing.daily!.min,
            price_weekend: r.price_weekend || r.price || structured.pricing.daily!.min,
            price_hourly: r.price_hourly,
            max_guests: r.max_guests || 2,
            bed_config: r.bed_type,
          }))
        : [
            {
              room_key: `${structured.id}_default`,
              display_name_vi: `Phòng ${structured.name}`,
              price_weekday: structured.pricing.daily.min,
              price_weekend: structured.pricing.daily.max || structured.pricing.daily.min,
              max_guests: 2,
            },
          ];
    }

    // Amenities from structured.included_services + flags
    parsed.amenities = structured.included_services.map((s: string) => ({
      category: 'general',
      name_vi: s,
      free: true,
    }));

    // Policies from rules
    parsed.policies = {
      checkin_time: structured.rules.checkin_time,
      checkout_time: structured.rules.checkout_time,
      deposit_percent: structured.rules.deposit_months ? 100 : undefined,
    };

    // Keep _scraped for legacy code paths
    (parsed as any)._scraped = {
      product_group: structured.product_group,
      monthly_price_from: structured.pricing.monthly?.min,
      monthly_price_to: structured.pricing.monthly?.max,
      daily_price: structured.pricing.daily?.min,
      min_stay_months: structured.rules.min_stay_months,
      deposit_months: structured.rules.deposit_months,
      utilities_included: structured.flags.utilities_included,
      full_kitchen: structured.flags.has_kitchen,
      washing_machine: structured.flags.has_laundry,
      accepts_sonder_escrow: structured.flags.accepts_escrow,
      included_services: structured.included_services,
      property_tier: structured.property_tier,
      issues: structured._issues,
    };
  } else {
    // Fallback: old logic
    if (raw.property_type && typeof raw.property_type === 'string') {
      parsed.property_type = raw.property_type.toLowerCase();
    }
    if (parsed.property_type) {
      const { classifyProduct } = require('./product-taxonomy');
      const c = classifyProduct(parsed.property_type);
      parsed.rental_type = c.rental_type;
    }
    if ((raw as any)._scraped) (parsed as any)._scraped = (raw as any)._scraped;
    if (raw.address) parsed.address = raw.address;
    if (raw.city) parsed.city = raw.city;
    if (raw.district) parsed.district = raw.district;
    if (raw.latitude) parsed.latitude = raw.latitude;
    if (raw.longitude) parsed.longitude = raw.longitude;
  }

  return { ok: true, data: parsed as SynthesizedHotel, retried };
}

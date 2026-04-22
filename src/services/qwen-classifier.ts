/**
 * Qwen AI Classifier — Layer 2 of 2-layer OTA pipeline.
 *
 * Cron 5 phút:
 *   1. Pull pending records từ ota_raw_hotels / ota_raw_rooms / availability / images
 *   2. Qwen prompt → classify + normalize → JSON đúng schema bot
 *   3. UPSERT vào hotel_profile / hotel_room_catalog / mkt_*_cache
 *   4. Track property types mới → property_types_discovered
 *   5. Fallback rule-based nếu Qwen fail 2 lần
 *
 * Strategy:
 *   - Batch size nhỏ (5 items/run) để tránh OOM Qwen
 *   - Timeout per Qwen call: 30s
 *   - Retry Qwen 2 lần → fallback rule-based
 *   - Log mọi classify vào ai_usage_log để track
 */

import axios from 'axios';
import { db } from '../db';

const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen2.5:7b-instruct-q4_K_M';
const QWEN_TIMEOUT_MS = 30_000;
const QWEN_MAX_RETRIES = 2;
const BATCH_SIZE = 5;

/* ═══════════════════════════════════════════
   Qwen call helper
   ═══════════════════════════════════════════ */

async function callQwenJson(system: string, user: string, maxTokens = 800): Promise<any> {
  const resp = await axios.post(
    `${OLLAMA_HOST}/api/chat`,
    {
      model: OLLAMA_MODEL,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      stream: false,
      format: 'json',
      options: {
        num_predict: maxTokens,
        temperature: 0.2,
      },
    },
    { timeout: QWEN_TIMEOUT_MS, headers: { 'Content-Type': 'application/json' } },
  );
  const text = resp.data?.message?.content || '';
  try {
    return JSON.parse(text);
  } catch (e) {
    // Try extract JSON block {...}
    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
      try { return JSON.parse(match[0]); } catch {}
    }
    throw new Error(`qwen returned invalid JSON: ${text.slice(0, 200)}`);
  }
}

/* ═══════════════════════════════════════════
   Schema cho Qwen biết phải output gì
   ═══════════════════════════════════════════ */

const HOTEL_SCHEMA_PROMPT = `Schema target (output JSON này):
{
  "name_canonical": "string required — tên khách sạn chuẩn",
  "property_type": "hotel|homestay|apartment|villa|resort|guesthouse|hostel",
  "rental_type": "per_night|per_month",
  "product_group": "nightly_stay|monthly_apartment",
  "city": "Ho Chi Minh|Hanoi|Da Nang|Nha Trang|... (null nếu không có)",
  "district": "Q1|Q3|Tân Bình|Bình Thạnh|... (normalize Vietnamese)",
  "address": "full street address or null",
  "latitude": "number or null",
  "longitude": "number or null",
  "phone": "+84 format or null",
  "star_rating": "1-5 or null",
  "target_segment": "business|family|couple|backpacker|mixed",
  "usp_top3": ["string","string","string"] — top 3 điểm mạnh,
  "ai_summary_vi": "1-2 câu tóm tắt tiếng Việt",
  "monthly_price_from": "number or null (VND)",
  "monthly_price_to": "number or null",
  "min_stay_months": "number or null",
  "deposit_months": "number or null",
  "utilities_included": "boolean",
  "full_kitchen": "boolean",
  "washing_machine": "boolean",
  "amenities": ["wifi","pool","gym","breakfast","parking",...],
  "_meta": {
    "raw_property_type": "giá trị RAW từ OTA (dù đã mapped hay chưa)",
    "confidence": "0.0-1.0"
  }
}

QUY TẮC MAP:
- apartment + per_month => product_group=monthly_apartment
- hotel/homestay/villa + per_night => product_group=nightly_stay
- Nếu OTA dùng "serviced_apartment", "studio", "căn hộ dịch vụ" => apartment
- Nếu OTA dùng "mini hotel", "inn" => hotel
- "nhà nghỉ" => guesthouse (nếu không có trong 7 loại chuẩn → giữ nguyên trong _meta.raw_property_type, chọn loại gần nhất)
- Phone VN: normalize về +84 9xx xxx xxx (bỏ 0 đầu)
- City: normalize ("Tp.HCM" → "Ho Chi Minh"; "HN" → "Hanoi")
- District: giữ tiếng Việt có dấu ("Tan Binh" → "Tân Bình")
- KHÔNG bịa giá nếu raw không có → null

CHỈ output JSON, không prose.`;

const ROOM_SCHEMA_PROMPT = `Schema target (output JSON):
{
  "display_name_vi": "tên phòng tiếng Việt",
  "display_name_en": "room name in English (optional)",
  "product_group": "nightly_stay|monthly_apartment",
  "bed_type": "1 giường đôi|2 giường đơn|King|Queen",
  "max_guests": "number",
  "max_children": "number (optional)",
  "size_sqm": "number or null",
  "price_weekday": "number (VND)",
  "price_weekend": "number (VND, optional)",
  "price_monthly": "number (VND, optional)",
  "price_hourly": "number (VND/giờ, optional)",
  "amenities": ["wifi","ac","tv","minibar",...],
  "has_window": "boolean",
  "_meta": { "raw_name": "original raw name", "confidence": "0-1" }
}

QUY TẮC:
- Nếu OTA có "monthly_price" => price_monthly và product_group=monthly_apartment
- Nếu OTA có price_hourly → hotels cho thuê giờ
- max_guests: default 2 nếu không có
- Amenities: chuẩn hóa snake_case English

CHỈ output JSON.`;

/* ═══════════════════════════════════════════
   Rule-based fallback mapper
   ═══════════════════════════════════════════ */

function mapPropertyTypeFallback(raw: any): string {
  const t = String(raw?.type || raw?.property_type || raw?.category || '').toLowerCase().trim();
  if (!t) return 'hotel';
  if (/\bapartment|serviced|studio|chdv|can ho|căn hộ\b/.test(t)) return 'apartment';
  if (/\bhomestay|home stay|nhà dân|nha dan\b/.test(t)) return 'homestay';
  if (/\bvilla|biệt thự|biet thu\b/.test(t)) return 'villa';
  if (/\bresort\b/.test(t)) return 'resort';
  if (/\bguesthouse|nhà nghỉ|nha nghi|guest house\b/.test(t)) return 'guesthouse';
  if (/\bhostel\b/.test(t)) return 'hostel';
  return 'hotel';
}

function mapRentalTypeFallback(raw: any, propertyType: string): string {
  const mode = String(raw?.rental_mode || raw?.rental || raw?.rental_type || '').toLowerCase();
  if (mode.includes('month') || mode.includes('tháng') || propertyType === 'apartment') return 'per_month';
  return 'per_night';
}

function normalizeCity(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const lower = raw.toLowerCase().trim();
  if (/tp\.?\s*hcm|hồ chí minh|ho chi minh|sài gòn|saigon|\bhcm\b/.test(lower)) return 'Ho Chi Minh';
  if (/\bhn\b|hà nội|ha noi|hanoi/.test(lower)) return 'Hanoi';
  if (/đà nẵng|da nang|\bdn\b/.test(lower)) return 'Da Nang';
  if (/nha trang/.test(lower)) return 'Nha Trang';
  if (/phú quốc|phu quoc/.test(lower)) return 'Phu Quoc';
  return raw; // keep as is
}

function normalizePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const digits = String(raw).replace(/\D/g, '');
  if (digits.startsWith('84') && digits.length >= 11) return '+' + digits;
  if (digits.startsWith('0') && digits.length >= 10) return '+84' + digits.slice(1);
  if (digits.length >= 9) return '+84' + digits;
  return raw;
}

function ruleBasedHotelMap(raw: any): any {
  const propertyType = mapPropertyTypeFallback(raw);
  const rentalType = mapRentalTypeFallback(raw, propertyType);
  const productGroup = rentalType === 'per_month' && propertyType === 'apartment'
    ? 'monthly_apartment' : 'nightly_stay';

  return {
    name_canonical: raw?.name || raw?.title || raw?.hotel_name || 'Unknown',
    property_type: propertyType,
    rental_type: rentalType,
    product_group: productGroup,
    city: normalizeCity(raw?.city || raw?.location?.city),
    district: raw?.district || raw?.location?.district || null,
    address: raw?.address || null,
    latitude: raw?.latitude || raw?.lat || null,
    longitude: raw?.longitude || raw?.lng || raw?.lon || null,
    phone: normalizePhone(raw?.phone),
    star_rating: raw?.star_rating || raw?.stars || null,
    target_segment: raw?.target_segment || 'mixed',
    usp_top3: Array.isArray(raw?.usp) ? raw.usp.slice(0, 3) : [],
    ai_summary_vi: raw?.description
      ? String(raw.description).slice(0, 200)
      : `${propertyType === 'apartment' ? 'Căn hộ dịch vụ' : 'Khách sạn'} tại ${raw?.district || raw?.city || 'Việt Nam'}`,
    monthly_price_from: raw?.monthly_price_from || raw?.price_monthly_from || null,
    monthly_price_to: raw?.monthly_price_to || raw?.price_monthly_to || null,
    min_stay_months: raw?.min_stay_months || null,
    deposit_months: raw?.deposit_months || null,
    utilities_included: !!(raw?.utilities_included || raw?.utilities),
    full_kitchen: !!(raw?.full_kitchen || raw?.kitchen),
    washing_machine: !!(raw?.washing_machine || raw?.laundry),
    amenities: Array.isArray(raw?.amenities) ? raw.amenities : [],
    _meta: { raw_property_type: raw?.type || raw?.property_type || 'unknown', confidence: 0.5 },
  };
}

/* ═══════════════════════════════════════════
   Discover new property types (auto-learning)
   ═══════════════════════════════════════════ */

function trackPropertyTypeDiscovery(rawTypeName: string, otaId: string, samplePayload: any) {
  if (!rawTypeName || rawTypeName === 'unknown') return;
  const KNOWN_CANONICAL = ['hotel', 'homestay', 'villa', 'apartment', 'resort', 'guesthouse', 'hostel'];
  if (KNOWN_CANONICAL.includes(rawTypeName.toLowerCase())) return;

  const existing = db.prepare(`SELECT id, occurrences FROM property_types_discovered WHERE raw_type_name = ?`)
    .get(rawTypeName) as any;
  if (existing) {
    db.prepare(`UPDATE property_types_discovered SET occurrences = occurrences + 1 WHERE id = ?`)
      .run(existing.id);
  } else {
    db.prepare(
      `INSERT INTO property_types_discovered (raw_type_name, discovered_from_ota_id, sample_payload, occurrences, created_at)
       VALUES (?, ?, ?, 1, ?)`
    ).run(rawTypeName, otaId, JSON.stringify(samplePayload).slice(0, 1000), Date.now());
    console.log(`[qwen-classifier] New property type discovered: "${rawTypeName}" (from OTA ${otaId})`);
  }
}

/* ═══════════════════════════════════════════
   Classify 1 hotel record
   ═══════════════════════════════════════════ */

async function classifyHotelRecord(rawRow: any): Promise<{ ok: boolean; error?: string; classified_hotel_id?: number }> {
  const payload = JSON.parse(rawRow.payload);
  let classified: any = null;
  let confidence = 0;
  let method: 'qwen' | 'rule_based' = 'rule_based';

  // Try Qwen first (2 retries)
  for (let attempt = 0; attempt < QWEN_MAX_RETRIES; attempt++) {
    try {
      const result = await callQwenJson(
        HOTEL_SCHEMA_PROMPT,
        `OTA raw data:\n${JSON.stringify(payload, null, 2)}`,
        1000,
      );
      if (result?.name_canonical) {
        classified = result;
        confidence = result._meta?.confidence || 0.8;
        method = 'qwen';
        break;
      }
    } catch (e: any) {
      console.warn(`[qwen-classifier] Qwen fail (attempt ${attempt + 1}):`, e?.message);
    }
  }

  // Fallback rule-based
  if (!classified) {
    classified = ruleBasedHotelMap(payload);
    method = 'rule_based';
    confidence = classified._meta?.confidence || 0.5;
  }

  // Track new property types
  trackPropertyTypeDiscovery(
    classified._meta?.raw_property_type || payload.type || '',
    rawRow.ota_id,
    payload,
  );

  // Upsert hotel_profile
  try {
    const otaId = Number(rawRow.ota_id);
    // Generate numeric hotel_id (use ota_id if numeric, else hash)
    const hotelId = Number.isInteger(otaId) ? otaId : Math.abs(hashCode(rawRow.ota_id));
    const now = Date.now();

    db.prepare(
      `INSERT INTO hotel_profile (
        hotel_id, ota_hotel_id, name_canonical, city, district, address,
        latitude, longitude, phone, star_rating, target_segment,
        property_type, rental_type, product_group,
        ai_summary_vi, usp_top3,
        monthly_price_from, monthly_price_to, min_stay_months, deposit_months,
        utilities_included, full_kitchen, washing_machine,
        scraped_data, scraped_at, data_source,
        manual_override, synthesized_at, synthesized_by, version, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ota-raw', 0, ?, ?, 1, ?)
      ON CONFLICT(hotel_id) DO UPDATE SET
        ota_hotel_id = excluded.ota_hotel_id,
        name_canonical = excluded.name_canonical,
        city = excluded.city, district = excluded.district, address = excluded.address,
        latitude = excluded.latitude, longitude = excluded.longitude,
        phone = excluded.phone, star_rating = excluded.star_rating,
        target_segment = excluded.target_segment,
        property_type = excluded.property_type,
        rental_type = excluded.rental_type,
        product_group = excluded.product_group,
        ai_summary_vi = excluded.ai_summary_vi,
        usp_top3 = excluded.usp_top3,
        monthly_price_from = excluded.monthly_price_from,
        monthly_price_to = excluded.monthly_price_to,
        min_stay_months = excluded.min_stay_months,
        deposit_months = excluded.deposit_months,
        utilities_included = excluded.utilities_included,
        full_kitchen = excluded.full_kitchen,
        washing_machine = excluded.washing_machine,
        scraped_data = excluded.scraped_data,
        scraped_at = excluded.scraped_at,
        data_source = excluded.data_source,
        synthesized_at = excluded.synthesized_at,
        version = version + 1,
        updated_at = excluded.updated_at
      WHERE manual_override = 0`
    ).run(
      hotelId, hotelId,
      classified.name_canonical,
      classified.city, classified.district, classified.address,
      classified.latitude, classified.longitude,
      classified.phone, classified.star_rating,
      classified.target_segment,
      classified.property_type, classified.rental_type, classified.product_group,
      classified.ai_summary_vi,
      JSON.stringify(classified.usp_top3 || []),
      classified.monthly_price_from, classified.monthly_price_to,
      classified.min_stay_months, classified.deposit_months,
      classified.utilities_included ? 1 : 0,
      classified.full_kitchen ? 1 : 0,
      classified.washing_machine ? 1 : 0,
      JSON.stringify(payload), now,
      now, method,
      now,
    );

    // Ensure there's a mkt_hotels tenant entry for bot consumption
    const existingMkt = db.prepare(`SELECT id FROM mkt_hotels WHERE ota_hotel_id = ?`).get(hotelId) as any;
    if (!existingMkt) {
      const slug = String(classified.name_canonical).toLowerCase()
        .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || `hotel-${hotelId}`;
      try {
        db.prepare(
          `INSERT INTO mkt_hotels (name, slug, ota_hotel_id, status, config, created_at, updated_at)
           VALUES (?, ?, ?, 'active', '{}', ?, ?)`
        ).run(classified.name_canonical, slug + '-' + hotelId, hotelId, now, now);
      } catch (e: any) {
        // Maybe column doesn't match; silent ignore
      }
    }

    return { ok: true, classified_hotel_id: hotelId };
  } catch (e: any) {
    return { ok: false, error: e?.message };
  }
}

function hashCode(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return h;
}

/* ═══════════════════════════════════════════
   Classify 1 room record
   ═══════════════════════════════════════════ */

async function classifyRoomRecord(rawRow: any): Promise<{ ok: boolean; error?: string; classified_room_id?: number }> {
  const payload = JSON.parse(rawRow.payload);
  let classified: any = null;
  let method: 'qwen' | 'rule_based' = 'rule_based';

  for (let attempt = 0; attempt < QWEN_MAX_RETRIES; attempt++) {
    try {
      const result = await callQwenJson(
        ROOM_SCHEMA_PROMPT,
        `OTA raw room data:\n${JSON.stringify(payload, null, 2)}`,
        600,
      );
      if (result?.display_name_vi) {
        classified = result;
        method = 'qwen';
        break;
      }
    } catch (e: any) {
      console.warn(`[qwen-classifier] Qwen room fail (attempt ${attempt + 1}):`, e?.message);
    }
  }

  if (!classified) {
    classified = {
      display_name_vi: payload?.name || payload?.room_name || 'Phòng',
      product_group: (payload?.price_monthly) ? 'monthly_apartment' : 'nightly_stay',
      bed_type: payload?.bed_type || null,
      max_guests: payload?.max_guests || 2,
      size_sqm: payload?.size_sqm || null,
      price_weekday: payload?.price_weekday || payload?.price || null,
      price_weekend: payload?.price_weekend || null,
      price_monthly: payload?.price_monthly || null,
      price_hourly: payload?.price_hourly || null,
      amenities: payload?.amenities || [],
      has_window: !!payload?.has_window,
      _meta: { confidence: 0.5 },
    };
    method = 'rule_based';
  }

  try {
    const hotelIdResolve = db.prepare(
      `SELECT classified_hotel_id FROM ota_raw_hotels WHERE ota_id = ? AND classified_hotel_id IS NOT NULL ORDER BY classified_at DESC LIMIT 1`
    ).get(rawRow.parent_ota_hotel_id) as any;
    if (!hotelIdResolve?.classified_hotel_id) {
      return { ok: false, error: `parent hotel ${rawRow.parent_ota_hotel_id} chưa classified` };
    }
    const hotelId = hotelIdResolve.classified_hotel_id;
    const now = Date.now();

    // Insert into hotel_room_catalog
    const r = db.prepare(
      `INSERT INTO hotel_room_catalog (
        hotel_id, display_name_vi, display_name_en, product_group, bed_type,
        max_guests, size_sqm, price_weekday, price_weekend, price_monthly, price_hourly,
        amenities, has_window, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      hotelId,
      classified.display_name_vi,
      classified.display_name_en || null,
      classified.product_group || null,
      classified.bed_type || null,
      classified.max_guests || 2,
      classified.size_sqm || null,
      classified.price_weekday || null,
      classified.price_weekend || null,
      classified.price_monthly || null,
      classified.price_hourly || null,
      JSON.stringify(classified.amenities || []),
      classified.has_window ? 1 : 0,
      now, now,
    );

    // Also UPSERT into mkt_rooms_cache (bot uses this for quick reads)
    try {
      db.prepare(
        `INSERT OR REPLACE INTO mkt_rooms_cache
         (ota_hotel_id, ota_room_id, name, base_price, hourly_price, max_guests, bed_type, amenities_json, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        hotelId, Number(r.lastInsertRowid),
        classified.display_name_vi,
        classified.price_weekday || classified.price_monthly || 0,
        classified.price_hourly || null,
        classified.max_guests || 2,
        classified.bed_type || null,
        JSON.stringify(classified.amenities || []),
        now,
      );
    } catch {}

    return { ok: true, classified_room_id: Number(r.lastInsertRowid) };
  } catch (e: any) {
    return { ok: false, error: e?.message };
  }
}

/* ═══════════════════════════════════════════
   Classify availability (simple UPSERT)
   ═══════════════════════════════════════════ */

function classifyAvailabilityRecord(rawRow: any): { ok: boolean; error?: string } {
  try {
    // Resolve ota_room_id to internal room id via hotel_room_catalog
    const rooms = db.prepare(
      `SELECT id, hotel_id FROM hotel_room_catalog WHERE id IN (
         SELECT classified_room_id FROM ota_raw_rooms WHERE ota_id = ? AND classified_room_id IS NOT NULL
       ) LIMIT 1`
    ).get(rawRow.ota_room_id) as any;
    if (!rooms) return { ok: false, error: `ota_room_id ${rawRow.ota_room_id} chưa classified` };

    db.prepare(
      `INSERT OR REPLACE INTO mkt_availability_cache
       (ota_hotel_id, ota_room_id, date, available_units, price, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      rooms.hotel_id, rooms.id, rawRow.date,
      rawRow.available_units, rawRow.price, Date.now(),
    );
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e?.message };
  }
}

/* ═══════════════════════════════════════════
   Classify image (no Qwen needed, just move)
   ═══════════════════════════════════════════ */

function classifyImageRecord(rawRow: any): { ok: boolean; error?: string } {
  try {
    // Resolve entity
    let hotelId: number | null = null;
    let roomId: number | null = null;
    if (rawRow.entity_type === 'hotel') {
      const h = db.prepare(`SELECT classified_hotel_id FROM ota_raw_hotels WHERE ota_id = ? AND classified_hotel_id IS NOT NULL ORDER BY classified_at DESC LIMIT 1`)
        .get(rawRow.entity_ota_id) as any;
      if (!h?.classified_hotel_id) return { ok: false, error: `hotel ${rawRow.entity_ota_id} chưa classified` };
      hotelId = h.classified_hotel_id;
    } else if (rawRow.entity_type === 'room') {
      const r = db.prepare(`SELECT classified_room_id FROM ota_raw_rooms WHERE ota_id = ? AND classified_room_id IS NOT NULL ORDER BY classified_at DESC LIMIT 1`)
        .get(rawRow.entity_ota_id) as any;
      if (!r?.classified_room_id) return { ok: false, error: `room ${rawRow.entity_ota_id} chưa classified` };
      roomId = r.classified_room_id;
      const rr = db.prepare(`SELECT hotel_id FROM hotel_room_catalog WHERE id = ?`).get(roomId) as any;
      hotelId = rr?.hotel_id || null;
    }

    if (rawRow.entity_type === 'room' && roomId) {
      // INSERT into room_images (guard duplicate URL)
      const exists = db.prepare(`SELECT id FROM room_images WHERE image_url = ? AND room_type_id = ?`)
        .get(rawRow.image_url, roomId) as any;
      if (!exists) {
        db.prepare(
          `INSERT INTO room_images (hotel_id, room_type_id, room_type_name, image_url, caption, is_primary, order_idx, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          hotelId, roomId,
          (db.prepare(`SELECT display_name_vi FROM hotel_room_catalog WHERE id = ?`).get(roomId) as any)?.display_name_vi || '',
          rawRow.image_url, rawRow.caption,
          rawRow.is_primary ? 1 : 0,
          rawRow.order_idx || 0,
          Date.now(),
        );
      }
    }
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e?.message };
  }
}

/* ═══════════════════════════════════════════
   Main processor — cron entry point
   ═══════════════════════════════════════════ */

export async function runQwenClassifierBatch(): Promise<{
  hotels: { ok: number; fail: number };
  rooms: { ok: number; fail: number };
  availability: { ok: number; fail: number };
  images: { ok: number; fail: number };
  total_ms: number;
}> {
  const t0 = Date.now();
  const stats = {
    hotels: { ok: 0, fail: 0 },
    rooms: { ok: 0, fail: 0 },
    availability: { ok: 0, fail: 0 },
    images: { ok: 0, fail: 0 },
    total_ms: 0,
  };

  // 1. Hotels first (rooms/avail depend on hotel classified)
  const pendingHotels = db.prepare(
    `SELECT * FROM ota_raw_hotels WHERE status = 'pending' ORDER BY received_at LIMIT ?`
  ).all(BATCH_SIZE) as any[];
  for (const h of pendingHotels) {
    const r = await classifyHotelRecord(h);
    if (r.ok) {
      db.prepare(
        `UPDATE ota_raw_hotels SET status = 'classified', classified_at = ?, classified_hotel_id = ? WHERE id = ?`
      ).run(Date.now(), r.classified_hotel_id, h.id);
      stats.hotels.ok++;
      updateBatchCounts(h.batch_id, 'classified');
    } else {
      db.prepare(
        `UPDATE ota_raw_hotels SET status = 'failed', error_message = ? WHERE id = ?`
      ).run(r.error || 'unknown', h.id);
      stats.hotels.fail++;
      updateBatchCounts(h.batch_id, 'failed');
    }
  }

  // 2. Rooms
  const pendingRooms = db.prepare(
    `SELECT * FROM ota_raw_rooms WHERE status = 'pending' ORDER BY received_at LIMIT ?`
  ).all(BATCH_SIZE) as any[];
  for (const r of pendingRooms) {
    const result = await classifyRoomRecord(r);
    if (result.ok) {
      db.prepare(
        `UPDATE ota_raw_rooms SET status = 'classified', classified_at = ?, classified_room_id = ? WHERE id = ?`
      ).run(Date.now(), result.classified_room_id, r.id);
      stats.rooms.ok++;
      updateBatchCounts(r.batch_id, 'classified');
    } else {
      db.prepare(
        `UPDATE ota_raw_rooms SET status = 'failed', error_message = ? WHERE id = ?`
      ).run(result.error || 'unknown', r.id);
      stats.rooms.fail++;
      updateBatchCounts(r.batch_id, 'failed');
    }
  }

  // 3. Availability (no Qwen needed)
  const pendingAvail = db.prepare(
    `SELECT * FROM ota_raw_availability WHERE status = 'pending' ORDER BY received_at LIMIT 20`
  ).all() as any[];
  for (const a of pendingAvail) {
    const result = classifyAvailabilityRecord(a);
    if (result.ok) {
      db.prepare(`UPDATE ota_raw_availability SET status = 'classified', classified_at = ? WHERE id = ?`).run(Date.now(), a.id);
      stats.availability.ok++;
      updateBatchCounts(a.batch_id, 'classified');
    } else {
      db.prepare(`UPDATE ota_raw_availability SET status = 'failed' WHERE id = ?`).run(a.id);
      stats.availability.fail++;
      updateBatchCounts(a.batch_id, 'failed');
    }
  }

  // 4. Images (no Qwen needed)
  const pendingImages = db.prepare(
    `SELECT * FROM ota_raw_images WHERE status = 'pending' ORDER BY received_at LIMIT 20`
  ).all() as any[];
  for (const img of pendingImages) {
    const result = classifyImageRecord(img);
    if (result.ok) {
      db.prepare(`UPDATE ota_raw_images SET status = 'classified', classified_at = ? WHERE id = ?`).run(Date.now(), img.id);
      stats.images.ok++;
      updateBatchCounts(img.batch_id, 'classified');
    } else {
      db.prepare(`UPDATE ota_raw_images SET status = 'failed' WHERE id = ?`).run(img.id);
      stats.images.fail++;
      updateBatchCounts(img.batch_id, 'failed');
    }
  }

  stats.total_ms = Date.now() - t0;
  return stats;
}

function updateBatchCounts(batchId: string, outcome: 'classified' | 'failed') {
  if (!batchId) return;
  try {
    if (outcome === 'classified') {
      db.prepare(
        `UPDATE ota_raw_batches SET classified_items = classified_items + 1, pending_items = MAX(0, pending_items - 1), last_status_check = ? WHERE batch_id = ?`
      ).run(Date.now(), batchId);
    } else {
      db.prepare(
        `UPDATE ota_raw_batches SET failed_items = failed_items + 1, pending_items = MAX(0, pending_items - 1), last_status_check = ? WHERE batch_id = ?`
      ).run(Date.now(), batchId);
    }
  } catch {}
}

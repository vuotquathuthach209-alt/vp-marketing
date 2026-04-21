/**
 * Hotel Knowledge Storage — upsert synthesized data vào 5 tables.
 * Cũng export query helpers cho bot dispatcher.
 */
import { db } from '../db';
import { SynthesizedHotel } from './hotel-synthesizer';
import { embed, encodeEmbedding } from './embedder';
import { geocode } from './geocoder';

/** Simple geohash implementation cho VN */
function geohashEncode(lat: number, lon: number, precision = 6): string {
  const BASE32 = '0123456789bcdefghjkmnpqrstuvwxyz';
  let latRange = [-90, 90], lonRange = [-180, 180];
  let hash = '', bits = 0, bit = 0, even = true;
  while (hash.length < precision) {
    const range = even ? lonRange : latRange;
    const value = even ? lon : lat;
    const mid = (range[0] + range[1]) / 2;
    if (value >= mid) { bits = (bits << 1) | 1; range[0] = mid; }
    else { bits = (bits << 1); range[1] = mid; }
    even = !even;
    bit++;
    if (bit === 5) {
      hash += BASE32[bits];
      bits = 0; bit = 0;
    }
  }
  return hash;
}

export async function upsertKnowledge(
  hotelId: number,
  otaHotelId: number | null,
  data: SynthesizedHotel,
  synthesizedBy: string,
): Promise<void> {
  const now = Date.now();

  // 1. hotel_profile — auto-geocode nếu thiếu lat/lon (fallback chain)
  let lat = data.latitude, lon = data.longitude;
  if (!lat || !lon) {
    const candidates = [
      data.address ? `${data.address}, ${data.district || ''}, ${data.city || ''}, Vietnam` : null,
      data.address ? `${data.address}, ${data.city || ''}, Vietnam` : null,
      data.district && data.city ? `${data.district}, ${data.city}, Vietnam` : null,
      data.city ? `${data.city}, Vietnam` : null,
    ].filter(Boolean) as string[];
    for (const q of candidates) {
      try {
        const g = await geocode(q);
        if (g) {
          lat = g.latitude;
          lon = g.longitude;
          console.log(`[hotel_knowledge] geocoded #${hotelId} via "${q.slice(0, 50)}": ${lat},${lon}`);
          break;
        }
      } catch {}
    }
  }
  const geohash = (lat && lon) ? geohashEncode(lat, lon, 6) : null;

  // Read existing version + manual_override flag
  const existing = db.prepare(
    `SELECT version, manual_override FROM hotel_profile WHERE hotel_id = ?`
  ).get(hotelId) as any;

  if (existing?.manual_override) {
    console.log(`[hotel_knowledge] skip #${hotelId} (manual_override=true)`);
    return;
  }

  const version = (existing?.version || 0) + 1;

  db.prepare(
    `INSERT INTO hotel_profile (
      hotel_id, ota_hotel_id, name_canonical, name_en, city, district, address,
      latitude, longitude, geohash, phone, star_rating, target_segment, property_type, rental_type, brand_voice,
      ai_summary_vi, ai_summary_en, usp_top3, nearby_landmarks,
      manual_override, synthesized_at, synthesized_by, version, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)
    ON CONFLICT(hotel_id) DO UPDATE SET
      ota_hotel_id = excluded.ota_hotel_id,
      name_canonical = excluded.name_canonical,
      name_en = excluded.name_en,
      city = excluded.city,
      district = excluded.district,
      address = excluded.address,
      latitude = excluded.latitude,
      longitude = excluded.longitude,
      geohash = excluded.geohash,
      phone = excluded.phone,
      star_rating = excluded.star_rating,
      target_segment = excluded.target_segment,
      property_type = excluded.property_type,
      rental_type = excluded.rental_type,
      brand_voice = excluded.brand_voice,
      ai_summary_vi = excluded.ai_summary_vi,
      ai_summary_en = excluded.ai_summary_en,
      usp_top3 = excluded.usp_top3,
      nearby_landmarks = excluded.nearby_landmarks,
      synthesized_at = excluded.synthesized_at,
      synthesized_by = excluded.synthesized_by,
      version = excluded.version,
      updated_at = excluded.updated_at`
  ).run(
    hotelId, otaHotelId,
    data.name_canonical,
    data.name_en || null,
    data.city || null,
    data.district || null,
    data.address || null,
    data.latitude || null,
    data.longitude || null,
    geohash,
    data.phone || null,
    data.star_rating || null,
    data.target_segment || null,
    data.property_type || null,
    data.rental_type || 'per_night',
    data.brand_voice || null,
    data.ai_summary_vi,
    data.ai_summary_en || null,
    JSON.stringify(data.usp_top3 || []),
    data.nearby_landmarks ? JSON.stringify(data.nearby_landmarks) : null,
    now, synthesizedBy, version, now,
  );
  // override lat/lon với geocoded values
  if (lat && lon && lat !== data.latitude) {
    db.prepare(`UPDATE hotel_profile SET latitude = ?, longitude = ?, geohash = ? WHERE hotel_id = ?`)
      .run(lat, lon, geohash, hotelId);
  }

  // v7.3: Save scraped fields (product_group, monthly pricing, services)
  const scraped = (data as any)._scraped;
  if (scraped) {
    db.prepare(
      `UPDATE hotel_profile SET
        product_group = ?,
        monthly_price_from = ?,
        monthly_price_to = ?,
        min_stay_months = ?,
        deposit_months = ?,
        utilities_included = ?,
        full_kitchen = ?,
        washing_machine = ?,
        scraped_data = ?,
        scraped_at = ?,
        data_source = 'scraper'
       WHERE hotel_id = ?`
    ).run(
      scraped.product_group || null,
      scraped.monthly_price_from || null,
      scraped.monthly_price_to || null,
      scraped.min_stay_months || null,
      scraped.deposit_months || null,
      scraped.utilities_included ? 1 : 0,
      scraped.full_kitchen ? 1 : 0,
      scraped.washing_machine ? 1 : 0,
      JSON.stringify(scraped),
      Date.now(),
      hotelId,
    );
  }

  // 2. rooms — replace all for this hotel
  db.prepare(`DELETE FROM hotel_room_catalog WHERE hotel_id = ?`).run(hotelId);
  const roomInsert = db.prepare(
    `INSERT INTO hotel_room_catalog (
      hotel_id, room_key, display_name_vi, display_name_en,
      price_weekday, price_weekend, price_hourly, max_guests,
      bed_config, size_m2, amenities, photos_urls, description_vi, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const r of (data.rooms || [])) {
    roomInsert.run(
      hotelId,
      r.room_key || r.display_name_vi.slice(0, 20),
      r.display_name_vi,
      r.display_name_en || null,
      r.price_weekday || 0,
      r.price_weekend || r.price_weekday || 0,
      r.price_hourly || null,
      r.max_guests || 2,
      r.bed_config || null,
      r.size_m2 || null,
      r.amenities ? JSON.stringify(r.amenities) : null,
      (r as any).photos_urls ? JSON.stringify((r as any).photos_urls) : null,
      r.description_vi || null,
      now,
    );
  }

  // 3. amenities — replace all
  db.prepare(`DELETE FROM hotel_amenities WHERE hotel_id = ?`).run(hotelId);
  const amInsert = db.prepare(
    `INSERT INTO hotel_amenities (hotel_id, category, name_vi, name_en, free, hours, note, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const a of (data.amenities || [])) {
    amInsert.run(
      hotelId,
      a.category || 'other',
      a.name_vi,
      a.name_en || null,
      a.free === false ? 0 : 1,
      a.hours || null,
      null,
      now,
    );
  }

  // 4. policies
  if (data.policies) {
    db.prepare(
      `INSERT INTO hotel_policies (
        hotel_id, checkin_time, checkout_time, cancellation_text,
        deposit_percent, pet_allowed, child_policy, payment_methods, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(hotel_id) DO UPDATE SET
        checkin_time = excluded.checkin_time,
        checkout_time = excluded.checkout_time,
        cancellation_text = excluded.cancellation_text,
        deposit_percent = excluded.deposit_percent,
        pet_allowed = excluded.pet_allowed,
        child_policy = excluded.child_policy,
        payment_methods = excluded.payment_methods,
        updated_at = excluded.updated_at`
    ).run(
      hotelId,
      data.policies.checkin_time || null,
      data.policies.checkout_time || null,
      data.policies.cancellation_text || null,
      data.policies.deposit_percent || null,
      data.policies.pet_allowed ? 1 : 0,
      data.policies.child_policy || null,
      data.policies.payment_methods ? JSON.stringify(data.policies.payment_methods) : null,
      now,
    );
  }

  // 5. embeddings — 4 chunks per hotel
  await rebuildEmbeddings(hotelId, data);
}

async function rebuildEmbeddings(hotelId: number, data: SynthesizedHotel): Promise<void> {
  db.prepare(`DELETE FROM hotel_knowledge_embeddings WHERE hotel_id = ?`).run(hotelId);
  const chunks: Array<{ type: string; text: string }> = [
    { type: 'profile', text: `${data.name_canonical}. ${data.ai_summary_vi} USP: ${(data.usp_top3 || []).join('; ')}` },
    { type: 'location', text: `${data.name_canonical} địa chỉ ${data.address || ''} ${data.city || ''} ${data.district || ''}` },
    { type: 'amenities', text: (data.amenities || []).map(a => a.name_vi).join(', ') },
    { type: 'rooms', text: (data.rooms || []).map(r => `${r.display_name_vi} giá ${r.price_weekday}đ`).join('; ') },
  ];
  const ins = db.prepare(
    `INSERT INTO hotel_knowledge_embeddings (hotel_id, chunk_type, chunk_text, embedding, created_at)
     VALUES (?, ?, ?, ?, ?)`
  );
  for (const c of chunks) {
    if (!c.text || c.text.length < 5) continue;
    try {
      const vec = await embed(c.text);
      const buf = vec ? encodeEmbedding(vec) : null;
      ins.run(hotelId, c.type, c.text, buf, Date.now());
    } catch {}
  }
}

/** Query helpers for bot dispatcher — tự động resolve mkt_hotel_id → ota_hotel_id */
export function getProfile(mktHotelId: number): any {
  const k = resolveKnowledgeHotelId(mktHotelId);
  if (!k) return null;
  const row = db.prepare(`SELECT * FROM hotel_profile WHERE hotel_id = ?`).get(k) as any;
  if (!row) return null;
  try { row.usp_top3 = JSON.parse(row.usp_top3 || '[]'); } catch { row.usp_top3 = []; }
  try { row.nearby_landmarks = row.nearby_landmarks ? JSON.parse(row.nearby_landmarks) : {}; } catch { row.nearby_landmarks = {}; }
  try { row.scraped_data = row.scraped_data ? JSON.parse(row.scraped_data) : {}; } catch { row.scraped_data = {}; }
  row.utilities_included = !!row.utilities_included;
  row.full_kitchen = !!row.full_kitchen;
  row.washing_machine = !!row.washing_machine;
  return row;
}

export function getRooms(mktHotelId: number): any[] {
  const k = resolveKnowledgeHotelId(mktHotelId);
  if (!k) return [];
  const rows = db.prepare(`SELECT * FROM hotel_room_catalog WHERE hotel_id = ? ORDER BY price_weekday`).all(k) as any[];
  return rows.map(r => {
    try { r.amenities = r.amenities ? JSON.parse(r.amenities) : []; } catch { r.amenities = []; }
    try { r.photos_urls = r.photos_urls ? JSON.parse(r.photos_urls) : []; } catch { r.photos_urls = []; }
    return r;
  });
}

export function getAmenities(mktHotelId: number): any[] {
  const k = resolveKnowledgeHotelId(mktHotelId);
  if (!k) return [];
  return db.prepare(`SELECT * FROM hotel_amenities WHERE hotel_id = ?`).all(k) as any[];
}

export function getPolicies(mktHotelId: number): any {
  const k = resolveKnowledgeHotelId(mktHotelId);
  if (!k) return null;
  return db.prepare(`SELECT * FROM hotel_policies WHERE hotel_id = ?`).get(k);
}

/** Has knowledge been built for this hotel? Resolve via mkt_hotels.ota_hotel_id mapping nếu có. */
export function hasKnowledge(mktHotelId: number): boolean {
  const k = resolveKnowledgeHotelId(mktHotelId);
  if (!k) return false;
  const r = db.prepare(`SELECT 1 FROM hotel_profile WHERE hotel_id = ? LIMIT 1`).get(k);
  return !!r;
}

/**
 * Map mkt_hotels.id (tenant) → hotel_profile.hotel_id (OTA hotel).
 * Priority:
 *   1. mkt_hotels.ota_hotel_id (explicit mapping)
 *   2. mkt_hotels.id === hotel_profile.hotel_id (fallback, legacy)
 */
export function resolveKnowledgeHotelId(mktHotelId: number): number | null {
  try {
    const row = db.prepare(`SELECT ota_hotel_id FROM mkt_hotels WHERE id = ?`).get(mktHotelId) as any;
    if (row?.ota_hotel_id) return row.ota_hotel_id;
  } catch {}
  // Fallback: treat mktHotelId as knowledge hotel_id directly
  const r = db.prepare(`SELECT hotel_id FROM hotel_profile WHERE hotel_id = ?`).get(mktHotelId);
  return r ? mktHotelId : null;
}

/** Count total hotels with knowledge */
export function countHotels(): number {
  const r = db.prepare(`SELECT COUNT(*) AS n FROM hotel_profile`).get() as any;
  return r?.n || 0;
}

/**
 * v10 Đợt 1: Get unified bot context in 1 query.
 * Đọc từ v_hotel_bot_context view — gộp tất cả hotel data bot cần.
 * Prefer mkt_hotel_id; fallback ota_hotel_id nếu mkt_id không có.
 */
export function getBotContext(mktHotelId: number): any {
  try {
    // Try by mkt_hotel_id first
    let row = db.prepare(
      `SELECT * FROM v_hotel_bot_context WHERE mkt_hotel_id = ?`
    ).get(mktHotelId) as any;
    // Fallback: có thể mktHotelId thực ra là ota_hotel_id
    if (!row || !row.profile_hotel_id) {
      const alt = db.prepare(
        `SELECT * FROM v_hotel_bot_context WHERE ota_hotel_id = ?`
      ).get(mktHotelId) as any;
      if (alt && alt.profile_hotel_id) row = alt;
    }
    if (!row) return null;
    // Parse JSON fields
    try { row.usp_top3 = row.usp_top3 ? JSON.parse(row.usp_top3) : []; } catch { row.usp_top3 = []; }
    try { row.nearby_landmarks = row.nearby_landmarks ? JSON.parse(row.nearby_landmarks) : {}; } catch { row.nearby_landmarks = {}; }
    try { row.scraped_data = row.scraped_data ? JSON.parse(row.scraped_data) : {}; } catch { row.scraped_data = {}; }
    row.full_kitchen = !!row.full_kitchen;
    row.washing_machine = !!row.washing_machine;
    row.utilities_included = !!row.utilities_included;
    return row;
  } catch (e: any) {
    console.warn('[getBotContext] fail:', e?.message);
    return null;
  }
}

/** Tất cả rooms từ view (resolves mkt_hotel_id → ota_hotel_id tự động) */
export function getBotRooms(mktHotelId: number): any[] {
  try {
    const rows = db.prepare(
      `SELECT * FROM v_hotel_rooms WHERE mkt_hotel_id = ? OR ota_hotel_id = ? ORDER BY price_weekday ASC`
    ).all(mktHotelId, mktHotelId) as any[];
    return rows.map((r: any) => {
      try { r.amenities = r.amenities ? JSON.parse(r.amenities) : []; } catch { r.amenities = []; }
      try { r.photos_urls = r.photos_urls ? JSON.parse(r.photos_urls) : []; } catch { r.photos_urls = []; }
      return r;
    });
  } catch { return []; }
}

/** Amenities grouped by category */
export function getBotAmenities(mktHotelId: number): Record<string, any[]> {
  try {
    const rows = db.prepare(
      `SELECT * FROM v_hotel_amenities WHERE mkt_hotel_id = ? OR ota_hotel_id = ?`
    ).all(mktHotelId, mktHotelId) as any[];
    const grouped: Record<string, any[]> = {};
    for (const r of rows) {
      const cat = r.category || 'general';
      if (!grouped[cat]) grouped[cat] = [];
      grouped[cat].push(r);
    }
    return grouped;
  } catch { return {}; }
}

import { haversineKm } from './geocoder';

/**
 * Search hotels gần 1 điểm (lat/lon) trong bán kính km.
 * Trả về top-N sorted by distance.
 */
export interface HotelSearchResult {
  hotel_id: number;
  name: string;
  city: string;
  district: string;
  distance_km: number;
  min_price: number;
  star_rating: number | null;
  property_type: string | null;
  ai_summary_vi: string;
  usp_top3: string[];
}

export function searchNearby(opts: {
  lat: number;
  lon: number;
  radius_km?: number;
  limit?: number;
  min_guests?: number;
  max_price?: number;
  city?: string;
  property_type?: string;      // 'apartment'|'homestay'|'hotel'|...
}): HotelSearchResult[] {
  const radius = opts.radius_km || 10;
  const limit = opts.limit || 5;

  const cityFilter = opts.city ? `AND LOWER(city) = LOWER(?)` : '';
  const typeFilter = opts.property_type ? `AND LOWER(property_type) = LOWER(?)` : '';
  const params: any[] = [];
  if (opts.city) params.push(opts.city);
  if (opts.property_type) params.push(opts.property_type);

  const profiles = db.prepare(
    `SELECT hotel_id, name_canonical, city, district, latitude, longitude, star_rating,
            property_type, ai_summary_vi, usp_top3
     FROM hotel_profile
     WHERE latitude IS NOT NULL AND longitude IS NOT NULL ${cityFilter} ${typeFilter}`
  ).all(...params) as any[];

  const results: HotelSearchResult[] = [];
  for (const p of profiles) {
    const dist = haversineKm(opts.lat, opts.lon, p.latitude, p.longitude);
    if (dist > radius) continue;

    let roomSql = `SELECT MIN(price_weekday) AS min_price FROM hotel_room_catalog WHERE hotel_id = ?`;
    const roomParams: any[] = [p.hotel_id];
    if (opts.min_guests) {
      roomSql = `SELECT MIN(price_weekday) AS min_price FROM hotel_room_catalog WHERE hotel_id = ? AND max_guests >= ?`;
      roomParams.push(opts.min_guests);
    }
    const r = db.prepare(roomSql).get(...roomParams) as any;
    const minPrice = r?.min_price || 0;
    if (opts.max_price && minPrice > opts.max_price) continue;

    let usps: string[] = [];
    try { usps = JSON.parse(p.usp_top3 || '[]'); } catch {}

    results.push({
      hotel_id: p.hotel_id,
      name: p.name_canonical,
      city: p.city,
      district: p.district,
      distance_km: +dist.toFixed(1),
      min_price: minPrice,
      star_rating: p.star_rating,
      property_type: p.property_type,
      ai_summary_vi: p.ai_summary_vi || '',
      usp_top3: usps,
    });
  }

  results.sort((a, b) => a.distance_km - b.distance_km);
  return results.slice(0, limit);
}

/**
 * Search hotels by city + district (fallback nếu không có lat/lon).
 */
export function searchByArea(opts: { city?: string; district?: string; limit?: number; max_price?: number; min_guests?: number; property_type?: string }): HotelSearchResult[] {
  const limit = opts.limit || 5;
  const conds: string[] = [];
  const params: any[] = [];
  if (opts.city) { conds.push(`LOWER(city) LIKE LOWER(?)`); params.push(`%${opts.city}%`); }
  if (opts.district) { conds.push(`LOWER(district) LIKE LOWER(?)`); params.push(`%${opts.district}%`); }
  if (opts.property_type) { conds.push(`LOWER(property_type) = LOWER(?)`); params.push(opts.property_type); }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  const profiles = db.prepare(
    `SELECT hotel_id, name_canonical, city, district, star_rating, property_type, ai_summary_vi, usp_top3
     FROM hotel_profile ${where} LIMIT ?`
  ).all(...params, limit) as any[];

  const results: HotelSearchResult[] = [];
  for (const p of profiles) {
    let roomSql = `SELECT MIN(price_weekday) AS min_price FROM hotel_room_catalog WHERE hotel_id = ?`;
    const roomParams: any[] = [p.hotel_id];
    if (opts.min_guests) {
      roomSql += ` AND max_guests >= ?`;
      roomParams.push(opts.min_guests);
    }
    const r = db.prepare(roomSql).get(...roomParams) as any;
    const minPrice = r?.min_price || 0;
    if (opts.max_price && minPrice > opts.max_price) continue;

    let usps: string[] = [];
    try { usps = JSON.parse(p.usp_top3 || '[]'); } catch {}
    results.push({
      hotel_id: p.hotel_id,
      name: p.name_canonical,
      city: p.city,
      district: p.district,
      distance_km: 0,
      min_price: minPrice,
      star_rating: p.star_rating,
      property_type: p.property_type,
      ai_summary_vi: p.ai_summary_vi || '',
      usp_top3: usps,
    });
  }
  return results;
}

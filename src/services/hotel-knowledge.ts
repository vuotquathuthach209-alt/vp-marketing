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

  // 1. hotel_profile — auto-geocode nếu thiếu lat/lon
  let lat = data.latitude, lon = data.longitude;
  if ((!lat || !lon) && data.address) {
    try {
      const g = await geocode(`${data.address}, ${data.district || ''} ${data.city || ''} Vietnam`);
      if (g) {
        lat = g.latitude;
        lon = g.longitude;
        console.log(`[hotel_knowledge] geocoded #${hotelId}: ${lat},${lon}`);
      }
    } catch {}
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
      latitude, longitude, geohash, phone, star_rating, target_segment, brand_voice,
      ai_summary_vi, ai_summary_en, usp_top3, nearby_landmarks,
      manual_override, synthesized_at, synthesized_by, version, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)
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

/** Query helpers for bot dispatcher */
export function getProfile(hotelId: number): any {
  const row = db.prepare(`SELECT * FROM hotel_profile WHERE hotel_id = ?`).get(hotelId) as any;
  if (!row) return null;
  try { row.usp_top3 = JSON.parse(row.usp_top3 || '[]'); } catch { row.usp_top3 = []; }
  try { row.nearby_landmarks = row.nearby_landmarks ? JSON.parse(row.nearby_landmarks) : {}; } catch { row.nearby_landmarks = {}; }
  return row;
}

export function getRooms(hotelId: number): any[] {
  const rows = db.prepare(`SELECT * FROM hotel_room_catalog WHERE hotel_id = ? ORDER BY price_weekday`).all(hotelId) as any[];
  return rows.map(r => {
    try { r.amenities = r.amenities ? JSON.parse(r.amenities) : []; } catch { r.amenities = []; }
    try { r.photos_urls = r.photos_urls ? JSON.parse(r.photos_urls) : []; } catch { r.photos_urls = []; }
    return r;
  });
}

export function getAmenities(hotelId: number): any[] {
  return db.prepare(`SELECT * FROM hotel_amenities WHERE hotel_id = ?`).all(hotelId) as any[];
}

export function getPolicies(hotelId: number): any {
  return db.prepare(`SELECT * FROM hotel_policies WHERE hotel_id = ?`).get(hotelId);
}

/** Has knowledge been built for this hotel? */
export function hasKnowledge(hotelId: number): boolean {
  const r = db.prepare(`SELECT 1 FROM hotel_profile WHERE hotel_id = ? LIMIT 1`).get(hotelId);
  return !!r;
}

/** Count total hotels with knowledge */
export function countHotels(): number {
  const r = db.prepare(`SELECT COUNT(*) AS n FROM hotel_profile`).get() as any;
  return r?.n || 0;
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
}): HotelSearchResult[] {
  const radius = opts.radius_km || 10;
  const limit = opts.limit || 5;

  const cityFilter = opts.city ? `AND LOWER(city) = LOWER(?)` : '';
  const params: any[] = [];
  if (opts.city) params.push(opts.city);

  const profiles = db.prepare(
    `SELECT hotel_id, name_canonical, city, district, latitude, longitude, star_rating,
            ai_summary_vi, usp_top3
     FROM hotel_profile
     WHERE latitude IS NOT NULL AND longitude IS NOT NULL ${cityFilter}`
  ).all(...params) as any[];

  const results: HotelSearchResult[] = [];
  for (const p of profiles) {
    const dist = haversineKm(opts.lat, opts.lon, p.latitude, p.longitude);
    if (dist > radius) continue;

    // Lookup cheapest room, optionally filter by price/guests
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
export function searchByArea(opts: { city?: string; district?: string; limit?: number; max_price?: number; min_guests?: number }): HotelSearchResult[] {
  const limit = opts.limit || 5;
  const conds: string[] = [];
  const params: any[] = [];
  if (opts.city) { conds.push(`LOWER(city) LIKE LOWER(?)`); params.push(`%${opts.city}%`); }
  if (opts.district) { conds.push(`LOWER(district) LIKE LOWER(?)`); params.push(`%${opts.district}%`); }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  const profiles = db.prepare(
    `SELECT hotel_id, name_canonical, city, district, star_rating, ai_summary_vi, usp_top3
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
      ai_summary_vi: p.ai_summary_vi || '',
      usp_top3: usps,
    });
  }
  return results;
}

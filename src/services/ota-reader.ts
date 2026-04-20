/**
 * OTA Reader — đọc data từ OTA server (103.153.73.97 / OTA-WEB).
 *
 * CHƯA implement — chờ:
 *  1. SSH pubkey access được setup
 *  2. Xác định DB type (MySQL/Postgres/MongoDB)
 *  3. Connection params
 *
 * Hiện tại: expose mock data từ mkt_hotels_cache + mkt_rooms_cache (đã có sẵn)
 * để test Phase 1 synthesizer + knowledge storage.
 */
import { db } from '../db';
import { OtaRawHotel } from './hotel-synthesizer';

/**
 * Stub: đọc OTA data từ cache tables hiện có để test.
 * Khi OTA server được connect, thay thế bằng query trực tiếp.
 */
export function readMockHotels(): OtaRawHotel[] {
  const hotels = db.prepare(`SELECT * FROM mkt_hotels_cache LIMIT 10`).all() as any[];
  return hotels.map(h => {
    const rooms = db.prepare(`SELECT * FROM mkt_rooms_cache WHERE ota_hotel_id = ?`).all(h.id || h.ota_hotel_id || 1) as any[];
    return {
      id: h.id || h.ota_hotel_id || 1,
      name: h.name || 'Unknown Hotel',
      address: h.address,
      city: h.city,
      district: h.district,
      latitude: h.latitude,
      longitude: h.longitude,
      phone: h.phone,
      star_rating: h.star_rating,
      description: h.description,
      rooms: rooms.map(r => ({
        id: r.id,
        name: r.name,
        price: r.base_price,
        price_hourly: r.hourly_price,
        max_guests: r.max_guests,
        bed_type: r.bed_type,
        amenities: r.amenities ? tryParseJSON(r.amenities) : undefined,
      })),
    } as OtaRawHotel;
  });
}

function tryParseJSON(s: string): any {
  try { return JSON.parse(s); } catch { return s; }
}

/**
 * TODO Phase 2: Real OTA connection.
 * Placeholder signature để code sẵn sàng.
 */
export async function readOtaHotels(opts: { limit?: number; since?: number } = {}): Promise<OtaRawHotel[]> {
  // For now, return mock data
  // In Phase 2: connect to OTA DB, apply incremental filter (updated_at > since)
  const mocks = readMockHotels();
  if (opts.limit) return mocks.slice(0, opts.limit);
  return mocks;
}

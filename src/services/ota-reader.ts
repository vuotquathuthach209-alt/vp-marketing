/**
 * OTA Reader — đọc data từ OTA server.
 *
 * ⚠️ HỢP ĐỒNG CỨNG: CHỈ ĐỌC (read-only).
 * Mọi query đều phải đi qua `otaQueryReadOnly()` từ ota-readonly-guard.ts.
 * Guard sẽ throw `OtaReadOnlyViolation` ngay lập tức nếu phát hiện:
 *   - Statement không phải SELECT/SHOW/DESCRIBE/EXPLAIN/WITH
 *   - Từ khóa ghi (INSERT/UPDATE/DELETE/DROP/etc.)
 *   - Multi-statement injection
 *
 * Status:
 *   - MOCK mode: đọc từ mkt_hotels_cache (local SQLite) để test Phase 1
 *   - REAL mode: chờ setup SSH access + DB connection info
 */
import { db } from '../db';
import { OtaRawHotel } from './hotel-synthesizer';
import { otaQueryReadOnly, assertReadOnly } from './ota-readonly-guard';

// ── MOCK mode (Phase 1) ─────────────────────────────────────
function tryParseJSON(s: string): any {
  try { return JSON.parse(s); } catch { return s; }
}

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

// ── REAL mode (Phase 2 — sẵn sàng plug-in) ──────────────────
let realExecutor: ((sql: string, params: any[]) => Promise<any[]>) | null = null;

/**
 * Gán connection executor (từ mysql2/pg/mongodb client).
 * Executor chỉ được gọi khi SQL đã pass guard.
 */
export function setOtaExecutor(exec: (sql: string, params: any[]) => Promise<any[]>): void {
  realExecutor = exec;
}

export function isOtaConnected(): boolean {
  return realExecutor !== null;
}

async function realQuery<T = any>(sql: string, params: any[] = []): Promise<T[]> {
  if (!realExecutor) throw new Error('OTA executor chưa được config. Gọi setOtaExecutor() trước.');
  return otaQueryReadOnly<T>(sql, params, realExecutor);
}

/**
 * Main entry — đọc OTA hotels (mock hoặc real tùy connection status).
 */
export async function readOtaHotels(opts: { limit?: number; since?: number } = {}): Promise<OtaRawHotel[]> {
  if (!isOtaConnected()) {
    // Phase 1: use mock data
    const mocks = readMockHotels();
    if (opts.limit) return mocks.slice(0, opts.limit);
    return mocks;
  }

  // Phase 2: real OTA query (chỉ SELECT, guard enforce)
  // TODO: template SQL sẽ điều chỉnh khi biết schema OTA thật
  const sinceClause = opts.since
    ? `WHERE updated_at > ${Math.floor(opts.since / 1000)}`
    : '';
  const limitClause = opts.limit ? `LIMIT ${Math.max(1, Math.min(5000, opts.limit))}` : 'LIMIT 500';

  const sql = `SELECT * FROM hotels ${sinceClause} ${limitClause}`;

  // Guard validates before executor runs
  assertReadOnly(sql);
  const hotels = await realQuery<any>(sql);

  // Fetch rooms for each hotel (also read-only)
  const result: OtaRawHotel[] = [];
  for (const h of hotels) {
    const rooms = await realQuery<any>(`SELECT * FROM rooms WHERE hotel_id = ?`, [h.id]);
    result.push({
      id: h.id,
      name: h.name,
      address: h.address,
      city: h.city,
      district: h.district,
      latitude: h.latitude,
      longitude: h.longitude,
      phone: h.phone,
      star_rating: h.star_rating,
      description: h.description,
      rooms: rooms.map((r: any) => ({
        id: r.id,
        name: r.name,
        price: r.price,
        price_hourly: r.hourly_price,
        max_guests: r.max_guests,
        bed_type: r.bed_type,
      })),
    });
  }

  return result;
}

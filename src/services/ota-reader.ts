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
 * Main entry — đọc OTA hotels, source of truth priority:
 *   1. Web SSR scraper (sondervn.com) — phản ánh đúng DB với FULL fields (monthly price, services)
 *   2. Public API /api/hotels — fallback nếu scraper fail
 *   3. DB direct (future)
 *   4. Mock data (dev only)
 */
export async function readOtaHotels(opts: { limit?: number; since?: number } = {}): Promise<OtaRawHotel[]> {
  // Phase 2.1 (NEW): Web SSR scraper — source of truth
  try {
    const { scrapeAllHotels, healthCheck } = require('./sondervn-scraper');
    const h = await healthCheck();
    if (h.ok) {
      console.log(`[ota-reader] scraper: ${h.apartments} apartments + ${h.hotels} hotels`);
      const all = await scrapeAllHotels();
      const limited = opts.limit ? all.slice(0, opts.limit) : all;
      return limited;
    } else {
      console.warn('[ota-reader] scraper unhealthy:', h.error);
    }
  } catch (e: any) {
    console.warn('[ota-reader] scraper fail:', e?.message);
  }

  // Phase 2: Fallback to public API
  try {
    const { listAllHotels, toOtaRawHotel, checkOtaApi } = require('./ota-api-client');
    const health = await checkOtaApi();
    if (health.ok) {
      const apiHotels = await listAllHotels({ perPage: opts.limit ? Math.min(opts.limit, 50) : 50 });
      console.log(`[ota-reader] API fallback returned ${apiHotels.length} hotels`);
      const limited = opts.limit ? apiHotels.slice(0, opts.limit) : apiHotels;
      return limited.map(toOtaRawHotel);
    }
  } catch (e: any) {
    console.warn('[ota-reader] API fail:', e?.message);
  }

  // Phase 2b: DB direct query (future — khi có SSH/VPN access)
  if (isOtaConnected()) {
    const sinceClause = opts.since ? `WHERE updated_at > ${Math.floor(opts.since / 1000)}` : '';
    const limitClause = opts.limit ? `LIMIT ${Math.max(1, Math.min(5000, opts.limit))}` : 'LIMIT 500';
    const sql = `SELECT * FROM hotels ${sinceClause} ${limitClause}`;
    assertReadOnly(sql);
    const hotels = await realQuery<any>(sql);
    const result: OtaRawHotel[] = [];
    for (const h of hotels) {
      const rooms = await realQuery<any>(`SELECT * FROM rooms WHERE hotel_id = ?`, [h.id]);
      result.push({
        id: h.id, name: h.name, address: h.address, city: h.city, district: h.district,
        latitude: h.latitude, longitude: h.longitude, phone: h.phone,
        star_rating: h.star_rating, description: h.description,
        rooms: rooms.map((r: any) => ({
          id: r.id, name: r.name, price: r.price, price_hourly: r.hourly_price,
          max_guests: r.max_guests, bed_type: r.bed_type,
        })),
      });
    }
    return result;
  }

  // Phase 1 fallback: mock data
  console.log('[ota-reader] Using mock data (no API/DB connection)');
  const mocks = readMockHotels();
  if (opts.limit) return mocks.slice(0, opts.limit);
  return mocks;
}

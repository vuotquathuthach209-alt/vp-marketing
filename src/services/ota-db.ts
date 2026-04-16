import { Pool, PoolClient } from 'pg';
import { db, getSetting, setSetting } from '../db';

/**
 * Sprint 9 — OTA Database Connector (READ-ONLY)
 *
 * Kết nối đến PostgreSQL OTA trên Google Cloud SQL.
 * CHỈ ĐỌC — không INSERT/UPDATE/DELETE.
 *
 * Tables đọc:
 *   hotels, room_types, rooms, room_availability,
 *   bookings, guests, customers, pricing_rules, coupons
 */

let pool: Pool | null = null;

export interface OtaDbConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  ssl: boolean;
}

/** Get OTA DB config from settings */
export function getOtaDbConfig(): OtaDbConfig | null {
  const raw = getSetting('ota_db_config');
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Save OTA DB config */
export function saveOtaDbConfig(cfg: OtaDbConfig) {
  setSetting('ota_db_config', JSON.stringify(cfg));
  // Reset pool to reconnect
  if (pool) {
    pool.end().catch(() => {});
    pool = null;
  }
}

/** Get or create connection pool */
function getPool(): Pool | null {
  if (pool) return pool;
  const cfg = getOtaDbConfig();
  if (!cfg) return null;

  pool = new Pool({
    host: cfg.host,
    port: cfg.port,
    database: cfg.database,
    user: cfg.user,
    password: cfg.password,
    ssl: cfg.ssl ? { rejectUnauthorized: false } : false,
    max: 3, // Read-only, low concurrency
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
    // IMPORTANT: Application name to identify read-only client
    application_name: 'vp-marketing-readonly',
  });

  pool.on('error', (err) => {
    console.error('[ota-db] Pool error:', err.message);
    pool = null;
  });

  return pool;
}

/** Execute a read-only query */
async function query<T = any>(sql: string, params: any[] = []): Promise<T[]> {
  const p = getPool();
  if (!p) throw new Error('OTA DB chưa cấu hình. Vào Cấu hình → OTA Database.');

  // Safety: reject any write operations
  const upper = sql.trim().toUpperCase();
  if (
    upper.startsWith('INSERT') ||
    upper.startsWith('UPDATE') ||
    upper.startsWith('DELETE') ||
    upper.startsWith('DROP') ||
    upper.startsWith('ALTER') ||
    upper.startsWith('CREATE') ||
    upper.startsWith('TRUNCATE')
  ) {
    throw new Error('OTA DB là READ-ONLY. Không cho phép ghi dữ liệu.');
  }

  const client = await p.connect();
  try {
    // Set transaction to read-only for extra safety
    await client.query('SET TRANSACTION READ ONLY');
    const result = await client.query(sql, params);
    return result.rows as T[];
  } finally {
    client.release();
  }
}

/** Test connection */
export async function testOtaConnection(): Promise<{ ok: boolean; message: string; version?: string }> {
  try {
    const rows = await query<{ version: string }>('SELECT version()');
    return { ok: true, message: 'Kết nối thành công!', version: rows[0]?.version };
  } catch (e: any) {
    return { ok: false, message: e.message };
  }
}

// ═══════════════════════════════════════════════
// HOTEL DATA QUERIES
// ═══════════════════════════════════════════════

export interface OtaHotel {
  id: number;
  name: string;
  slug: string;
  address: string | null;
  city: string | null;
  district: string | null;
  star_rating: number | null;
  phone: string | null;
  check_in_time: string;
  check_out_time: string;
  amenities: any;
  status: string;
  supports_hourly: boolean;
  cancellation_policy: any;
  owner_name: string | null;
  owner_email: string | null;
}

/** Lấy danh sách khách sạn active */
export async function getOtaHotels(): Promise<OtaHotel[]> {
  return query<OtaHotel>(`
    SELECT h.id, h.name, h.slug, h.address, h.city, h.district,
           h.star_rating, h.phone, h.check_in_time, h.check_out_time,
           h.amenities, h.status, h.supports_hourly, h.cancellation_policy,
           o.full_name as owner_name, o.email as owner_email
    FROM hotels h
    LEFT JOIN hotel_owners o ON o.id = h.owner_id
    WHERE h.status = 'active' AND h.deleted_at IS NULL
    ORDER BY h.id
  `);
}

/** Lấy thông tin 1 hotel */
export async function getOtaHotel(hotelId: number): Promise<OtaHotel | null> {
  const rows = await query<OtaHotel>(`
    SELECT h.id, h.name, h.slug, h.address, h.city, h.district,
           h.star_rating, h.phone, h.check_in_time, h.check_out_time,
           h.amenities, h.status, h.supports_hourly, h.cancellation_policy,
           o.full_name as owner_name, o.email as owner_email
    FROM hotels h
    LEFT JOIN hotel_owners o ON o.id = h.owner_id
    WHERE h.id = $1
  `, [hotelId]);
  return rows[0] || null;
}

// ═══════════════════════════════════════════════
// ROOM TYPES & ROOMS
// ═══════════════════════════════════════════════

export interface OtaRoomType {
  id: number;
  hotel_id: number;
  name: string;
  description: string | null;
  max_guests: number;
  bed_type: string | null;
  amenities: any;
  base_price: number;
  hourly_price: number | null;
  additional_hour_price: number | null;
  hourly_min_hours: number;
  status: string;
  room_count: number;
  available_count: number;
}

/** Lấy loại phòng + số lượng phòng trống */
export async function getOtaRoomTypes(hotelId: number): Promise<OtaRoomType[]> {
  return query<OtaRoomType>(`
    SELECT rt.id, rt.hotel_id, rt.name, rt.description,
           rt.max_guests, rt.bed_type, rt.amenities,
           rt.base_price::int, rt.hourly_price::int,
           rt.additional_hour_price::int, rt.hourly_min_hours,
           rt.status,
           COUNT(r.id) FILTER (WHERE r.status = 'available') as room_count,
           COUNT(r.id) FILTER (WHERE r.status = 'available'
             AND r.housekeeping_status = 'clean') as available_count
    FROM room_types rt
    LEFT JOIN rooms r ON r.room_type_id = rt.id AND r.hotel_id = rt.hotel_id
    WHERE rt.hotel_id = $1 AND rt.status = 'active'
    GROUP BY rt.id
    ORDER BY rt.base_price
  `, [hotelId]);
}

export interface OtaRoom {
  id: number;
  hotel_id: number;
  room_type_id: number;
  room_number: string;
  floor: number | null;
  status: string;
  housekeeping_status: string;
  room_type_name: string;
  base_price: number;
}

/** Lấy danh sách phòng */
export async function getOtaRooms(hotelId: number): Promise<OtaRoom[]> {
  return query<OtaRoom>(`
    SELECT r.id, r.hotel_id, r.room_type_id, r.room_number, r.floor,
           r.status, r.housekeeping_status,
           rt.name as room_type_name, rt.base_price::int
    FROM rooms r
    JOIN room_types rt ON rt.id = r.room_type_id
    WHERE r.hotel_id = $1
    ORDER BY r.room_number
  `, [hotelId]);
}

// ═══════════════════════════════════════════════
// ROOM AVAILABILITY (phòng trống theo ngày)
// ═══════════════════════════════════════════════

export interface OtaAvailability {
  room_id: number;
  room_number: string;
  room_type_name: string;
  date: string;
  price: number | null;
  status: string;
}

/** Check phòng trống theo khoảng ngày */
export async function checkAvailability(
  hotelId: number,
  checkinDate: string,   // YYYY-MM-DD
  checkoutDate: string,  // YYYY-MM-DD
  roomTypeId?: number
): Promise<{ available: OtaRoom[]; unavailable_dates: OtaAvailability[] }> {
  // Tìm phòng bị blocked/booked trong khoảng ngày
  const unavailable = await query<OtaAvailability>(`
    SELECT ra.room_id, r.room_number, rt.name as room_type_name,
           ra.date::text, ra.price::int, ra.status
    FROM room_availability ra
    JOIN rooms r ON r.id = ra.room_id
    JOIN room_types rt ON rt.id = r.room_type_id
    WHERE ra.hotel_id = $1
      AND ra.date >= $2::date AND ra.date < $3::date
      AND ra.status != 'available'
      ${roomTypeId ? 'AND r.room_type_id = $4' : ''}
    ORDER BY ra.date, r.room_number
  `, roomTypeId ? [hotelId, checkinDate, checkoutDate, roomTypeId] : [hotelId, checkinDate, checkoutDate]);

  const blockedRoomIds = new Set(unavailable.map(u => u.room_id));

  // Phòng available = không có trong blocked list
  const allRooms = await query<OtaRoom>(`
    SELECT r.id, r.hotel_id, r.room_type_id, r.room_number, r.floor,
           r.status, r.housekeeping_status,
           rt.name as room_type_name, rt.base_price::int
    FROM rooms r
    JOIN room_types rt ON rt.id = r.room_type_id
    WHERE r.hotel_id = $1 AND r.status = 'available'
      ${roomTypeId ? 'AND r.room_type_id = $2' : ''}
    ORDER BY r.room_number
  `, roomTypeId ? [hotelId, roomTypeId] : [hotelId]);

  const available = allRooms.filter(r => !blockedRoomIds.has(r.id));

  return { available, unavailable_dates: unavailable };
}

// ═══════════════════════════════════════════════
// BOOKINGS (read booking data from OTA)
// ═══════════════════════════════════════════════

export interface OtaBooking {
  id: number;
  booking_code: string;
  hotel_id: number;
  room_number: string;
  room_type_name: string;
  guest_name: string;
  guest_phone: string | null;
  guest_email: string | null;
  booking_type: string;
  checkin_date: string;
  checkout_date: string;
  nights: number;
  guests_count: number;
  total_price: number;
  paid_amount: number;
  payment_status: string;
  booking_status: string;
  channel_name: string | null;
  special_requests: string | null;
  created_at: string;
}

/** Lấy bookings của hotel (mới nhất trước) */
export async function getOtaBookings(hotelId: number, limit = 50): Promise<OtaBooking[]> {
  return query<OtaBooking>(`
    SELECT b.id, b.booking_code, b.hotel_id,
           r.room_number, rt.name as room_type_name,
           g.full_name as guest_name, g.phone as guest_phone, g.email as guest_email,
           b.booking_type::text, b.checkin_date::text, b.checkout_date::text,
           b.nights, b.guests_count,
           b.total_price::int, b.paid_amount::int,
           b.payment_status, b.booking_status, b.channel_name,
           b.special_requests, b.created_at::text
    FROM bookings b
    JOIN rooms r ON r.id = b.room_id
    JOIN room_types rt ON rt.id = b.room_type_id
    JOIN guests g ON g.id = b.guest_id
    WHERE b.hotel_id = $1 AND b.deleted_at IS NULL
    ORDER BY b.created_at DESC
    LIMIT $2
  `, [hotelId, limit]);
}

/** Booking hôm nay (checkin/checkout) */
export async function getTodayBookings(hotelId: number): Promise<{
  checkins: OtaBooking[];
  checkouts: OtaBooking[];
  inhouse: OtaBooking[];
}> {
  const today = new Date().toISOString().split('T')[0];

  const checkins = await query<OtaBooking>(`
    SELECT b.id, b.booking_code, b.hotel_id,
           r.room_number, rt.name as room_type_name,
           g.full_name as guest_name, g.phone as guest_phone, g.email as guest_email,
           b.booking_type::text, b.checkin_date::text, b.checkout_date::text,
           b.nights, b.guests_count,
           b.total_price::int, b.paid_amount::int,
           b.payment_status, b.booking_status, b.channel_name,
           b.special_requests, b.created_at::text
    FROM bookings b
    JOIN rooms r ON r.id = b.room_id
    JOIN room_types rt ON rt.id = b.room_type_id
    JOIN guests g ON g.id = b.guest_id
    WHERE b.hotel_id = $1 AND b.checkin_date = $2::date
      AND b.booking_status IN ('CONFIRMED','CHECKED_IN')
      AND b.deleted_at IS NULL
    ORDER BY b.created_at
  `, [hotelId, today]);

  const checkouts = await query<OtaBooking>(`
    SELECT b.id, b.booking_code, b.hotel_id,
           r.room_number, rt.name as room_type_name,
           g.full_name as guest_name, g.phone as guest_phone, g.email as guest_email,
           b.booking_type::text, b.checkin_date::text, b.checkout_date::text,
           b.nights, b.guests_count,
           b.total_price::int, b.paid_amount::int,
           b.payment_status, b.booking_status, b.channel_name,
           b.special_requests, b.created_at::text
    FROM bookings b
    JOIN rooms r ON r.id = b.room_id
    JOIN room_types rt ON rt.id = b.room_type_id
    JOIN guests g ON g.id = b.guest_id
    WHERE b.hotel_id = $1 AND b.checkout_date = $2::date
      AND b.booking_status = 'CHECKED_IN'
      AND b.deleted_at IS NULL
    ORDER BY b.created_at
  `, [hotelId, today]);

  const inhouse = await query<OtaBooking>(`
    SELECT b.id, b.booking_code, b.hotel_id,
           r.room_number, rt.name as room_type_name,
           g.full_name as guest_name, g.phone as guest_phone, g.email as guest_email,
           b.booking_type::text, b.checkin_date::text, b.checkout_date::text,
           b.nights, b.guests_count,
           b.total_price::int, b.paid_amount::int,
           b.payment_status, b.booking_status, b.channel_name,
           b.special_requests, b.created_at::text
    FROM bookings b
    JOIN rooms r ON r.id = b.room_id
    JOIN room_types rt ON rt.id = b.room_type_id
    JOIN guests g ON g.id = b.guest_id
    WHERE b.hotel_id = $1
      AND b.checkin_date <= $2::date AND b.checkout_date > $2::date
      AND b.booking_status = 'CHECKED_IN'
      AND b.deleted_at IS NULL
    ORDER BY r.room_number
  `, [hotelId, today]);

  return { checkins, checkouts, inhouse };
}

// ═══════════════════════════════════════════════
// PRICING RULES
// ═══════════════════════════════════════════════

export interface OtaPricingRule {
  id: number;
  hotel_id: number;
  name: string;
  rule_type: string;
  conditions: any;
  adjustment_type: string;
  adjustment_value: number;
  priority: number;
  is_active: boolean;
  valid_from: string | null;
  valid_to: string | null;
}

/** Lấy pricing rules active */
export async function getOtaPricingRules(hotelId: number): Promise<OtaPricingRule[]> {
  return query<OtaPricingRule>(`
    SELECT id, hotel_id, name, rule_type, conditions,
           adjustment_type, adjustment_value::int, priority,
           is_active, valid_from::text, valid_to::text
    FROM pricing_rules
    WHERE hotel_id = $1 AND is_active = true
    ORDER BY priority DESC
  `, [hotelId]);
}

// ═══════════════════════════════════════════════
// COUPONS / PROMOTIONS
// ═══════════════════════════════════════════════

export interface OtaCoupon {
  id: number;
  hotel_id: number;
  code: string;
  description: string | null;
  discount_type: string;
  discount_value: number;
  min_nights: number;
  valid_from: string | null;
  valid_to: string | null;
  is_active: boolean;
  used_count: number;
  max_uses: number | null;
}

/** Lấy coupon/promotion đang active */
export async function getOtaCoupons(hotelId: number): Promise<OtaCoupon[]> {
  return query<OtaCoupon>(`
    SELECT id, hotel_id, code, description,
           discount_type, discount_value::int,
           min_nights, valid_from::text, valid_to::text,
           is_active, used_count, max_uses
    FROM coupons
    WHERE hotel_id = $1 AND is_active = true
      AND (valid_to IS NULL OR valid_to >= CURRENT_DATE)
    ORDER BY created_at DESC
  `, [hotelId]);
}

// ═══════════════════════════════════════════════
// STATS & DASHBOARD DATA
// ═══════════════════════════════════════════════

export interface OtaHotelStats {
  total_rooms: number;
  available_rooms: number;
  today_checkins: number;
  today_checkouts: number;
  inhouse_guests: number;
  month_bookings: number;
  month_revenue: number;
  occupancy_rate: number;
}

/** Dashboard stats cho 1 hotel */
export async function getOtaHotelStats(hotelId: number): Promise<OtaHotelStats> {
  const today = new Date().toISOString().split('T')[0];
  const monthStart = today.substring(0, 7) + '-01';

  const [rooms] = await query<{ total: number; available: number }>(`
    SELECT COUNT(*) as total,
           COUNT(*) FILTER (WHERE status = 'available') as available
    FROM rooms WHERE hotel_id = $1
  `, [hotelId]);

  const [todayCounts] = await query<{ checkins: number; checkouts: number; inhouse: number }>(`
    SELECT
      COUNT(*) FILTER (WHERE checkin_date = $2::date AND booking_status IN ('CONFIRMED','CHECKED_IN')) as checkins,
      COUNT(*) FILTER (WHERE checkout_date = $2::date AND booking_status = 'CHECKED_IN') as checkouts,
      COUNT(*) FILTER (WHERE checkin_date <= $2::date AND checkout_date > $2::date AND booking_status = 'CHECKED_IN') as inhouse
    FROM bookings WHERE hotel_id = $1 AND deleted_at IS NULL
  `, [hotelId, today]);

  const [monthStats] = await query<{ bookings: number; revenue: number }>(`
    SELECT COUNT(*) as bookings, COALESCE(SUM(total_price), 0)::int as revenue
    FROM bookings
    WHERE hotel_id = $1
      AND created_at >= $2::date
      AND booking_status NOT IN ('CANCELLED','NO_SHOW')
      AND deleted_at IS NULL
  `, [hotelId, monthStart]);

  const totalRooms = rooms?.total || 1;
  const occupancy = totalRooms > 0
    ? Math.round(((todayCounts?.inhouse || 0) / totalRooms) * 100)
    : 0;

  return {
    total_rooms: rooms?.total || 0,
    available_rooms: rooms?.available || 0,
    today_checkins: todayCounts?.checkins || 0,
    today_checkouts: todayCounts?.checkouts || 0,
    inhouse_guests: todayCounts?.inhouse || 0,
    month_bookings: monthStats?.bookings || 0,
    month_revenue: monthStats?.revenue || 0,
    occupancy_rate: occupancy,
  };
}

/** Lấy hình ảnh phòng từ OTA DB */
export async function getOtaRoomImages(hotelId: number): Promise<Array<{room_type_id: number; room_type_name: string; image_url: string; caption: string}>> {
  try {
    // Try room_type_images table first
    return await query(`
      SELECT rti.room_type_id, rt.name as room_type_name,
             rti.image_url, COALESCE(rti.caption, '') as caption
      FROM room_type_images rti
      JOIN room_types rt ON rt.id = rti.room_type_id
      WHERE rt.hotel_id = $1 AND rt.status = 'active'
      ORDER BY rt.name, rti.display_order
    `, [hotelId]);
  } catch {
    // Fallback: try images column on room_types
    try {
      const rows = await query<{id: number; name: string; images: any}>(`
        SELECT id, name, images FROM room_types
        WHERE hotel_id = $1 AND status = 'active'
      `, [hotelId]);
      const result: any[] = [];
      for (const r of rows) {
        const imgs = Array.isArray(r.images) ? r.images : [];
        for (const img of imgs) {
          const url = typeof img === 'string' ? img : img?.url;
          if (url) result.push({ room_type_id: r.id, room_type_name: r.name, image_url: url, caption: '' });
        }
      }
      return result;
    } catch {
      return [];
    }
  }
}

/** Close pool on shutdown */
export function closeOtaPool() {
  if (pool) {
    pool.end().catch(() => {});
    pool = null;
  }
}

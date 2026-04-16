import { db } from '../db';
import {
  getOtaDbConfig,
  getOtaHotels,
  getOtaRoomTypes,
  getOtaBookings,
  getOtaHotel,
} from './ota-db';

/**
 * Sprint 9 Phase 1 — OTA Data Sync Cache
 *
 * Sync data từ OTA DB (read-only) → MKT DB local cache.
 * - Hotels + Rooms: mỗi 6h
 * - Bookings: mỗi 1h
 *
 * KHÔNG ghi gì lên OTA DB.
 */

/** Sync tất cả hotels từ OTA → mkt_hotels_cache */
export async function syncHotelsCache(): Promise<number> {
  if (!getOtaDbConfig()) return 0;

  try {
    const hotels = await getOtaHotels();
    const now = Date.now();

    const upsert = db.prepare(`
      INSERT INTO mkt_hotels_cache (ota_hotel_id, name, slug, address, city, district, star_rating, phone,
        check_in_time, check_out_time, amenities, cancellation_policy, owner_name, owner_email, synced_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(ota_hotel_id) DO UPDATE SET
        name=excluded.name, slug=excluded.slug, address=excluded.address,
        city=excluded.city, district=excluded.district, star_rating=excluded.star_rating,
        phone=excluded.phone, check_in_time=excluded.check_in_time, check_out_time=excluded.check_out_time,
        amenities=excluded.amenities, cancellation_policy=excluded.cancellation_policy,
        owner_name=excluded.owner_name, owner_email=excluded.owner_email, synced_at=excluded.synced_at
    `);

    const tx = db.transaction(() => {
      for (const h of hotels) {
        upsert.run(
          h.id, h.name, h.slug, h.address, h.city, h.district,
          h.star_rating, h.phone, h.check_in_time, h.check_out_time,
          JSON.stringify(h.amenities), JSON.stringify(h.cancellation_policy),
          h.owner_name, h.owner_email, now
        );
      }
    });
    tx();

    console.log(`[ota-sync] Synced ${hotels.length} hotels`);
    return hotels.length;
  } catch (e: any) {
    console.error('[ota-sync] syncHotelsCache failed:', e.message);
    return 0;
  }
}

/** Sync room types cho 1 hotel hoặc tất cả linked hotels */
export async function syncRoomsCache(otaHotelId?: number): Promise<number> {
  if (!getOtaDbConfig()) return 0;

  try {
    // Lấy danh sách hotel cần sync
    let hotelIds: number[] = [];
    if (otaHotelId) {
      hotelIds = [otaHotelId];
    } else {
      // Sync cho tất cả hotels trong cache
      const cached = db.prepare(`SELECT ota_hotel_id FROM mkt_hotels_cache`).all() as { ota_hotel_id: number }[];
      hotelIds = cached.map(c => c.ota_hotel_id);
    }

    const now = Date.now();
    let total = 0;

    const upsert = db.prepare(`
      INSERT INTO mkt_rooms_cache (ota_hotel_id, ota_room_type_id, name, base_price, hourly_price,
        max_guests, bed_type, amenities, room_count, available_count, synced_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(ota_hotel_id, ota_room_type_id) DO UPDATE SET
        name=excluded.name, base_price=excluded.base_price, hourly_price=excluded.hourly_price,
        max_guests=excluded.max_guests, bed_type=excluded.bed_type, amenities=excluded.amenities,
        room_count=excluded.room_count, available_count=excluded.available_count, synced_at=excluded.synced_at
    `);

    for (const hid of hotelIds) {
      try {
        const roomTypes = await getOtaRoomTypes(hid);
        const tx = db.transaction(() => {
          for (const rt of roomTypes) {
            upsert.run(
              hid, rt.id, rt.name, rt.base_price, rt.hourly_price,
              rt.max_guests, rt.bed_type, JSON.stringify(rt.amenities),
              rt.room_count, rt.available_count, now
            );
          }
        });
        tx();
        total += roomTypes.length;
      } catch (e: any) {
        console.error(`[ota-sync] syncRooms hotel ${hid}:`, e.message);
      }
    }

    console.log(`[ota-sync] Synced ${total} room types across ${hotelIds.length} hotels`);
    return total;
  } catch (e: any) {
    console.error('[ota-sync] syncRoomsCache failed:', e.message);
    return 0;
  }
}

/** Sync bookings cho 1 hotel hoặc tất cả */
export async function syncBookingsCache(otaHotelId?: number): Promise<number> {
  if (!getOtaDbConfig()) return 0;

  try {
    let hotelIds: number[] = [];
    if (otaHotelId) {
      hotelIds = [otaHotelId];
    } else {
      const cached = db.prepare(`SELECT ota_hotel_id FROM mkt_hotels_cache`).all() as { ota_hotel_id: number }[];
      hotelIds = cached.map(c => c.ota_hotel_id);
    }

    const now = Date.now();
    let total = 0;

    const upsert = db.prepare(`
      INSERT INTO mkt_bookings_cache (ota_booking_id, ota_hotel_id, booking_code, room_number, room_type_name,
        guest_name, guest_phone, booking_type, checkin_date, checkout_date, nights,
        total_price, payment_status, booking_status, channel_name, synced_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(ota_booking_id) DO UPDATE SET
        room_number=excluded.room_number, guest_name=excluded.guest_name,
        payment_status=excluded.payment_status, booking_status=excluded.booking_status,
        synced_at=excluded.synced_at
    `);

    for (const hid of hotelIds) {
      try {
        const bookings = await getOtaBookings(hid, 100);
        const tx = db.transaction(() => {
          for (const b of bookings) {
            upsert.run(
              b.id, hid, b.booking_code, b.room_number, b.room_type_name,
              b.guest_name, b.guest_phone, b.booking_type,
              b.checkin_date, b.checkout_date, b.nights,
              b.total_price, b.payment_status, b.booking_status, b.channel_name, now
            );
          }
        });
        tx();
        total += bookings.length;
      } catch (e: any) {
        console.error(`[ota-sync] syncBookings hotel ${hid}:`, e.message);
      }
    }

    console.log(`[ota-sync] Synced ${total} bookings across ${hotelIds.length} hotels`);
    return total;
  } catch (e: any) {
    console.error('[ota-sync] syncBookingsCache failed:', e.message);
    return 0;
  }
}

/** Auto-generate wiki entries từ OTA hotel data (cho chatbot) */
export async function autoGenWikiFromOta(mktHotelId: number, otaHotelId: number): Promise<number> {
  if (!getOtaDbConfig()) return 0;

  try {
    const hotel = await getOtaHotel(otaHotelId);
    if (!hotel) return 0;

    const roomTypes = await getOtaRoomTypes(otaHotelId);
    const now = Date.now();
    let count = 0;

    const upsertWiki = db.prepare(`
      INSERT INTO knowledge_wiki (namespace, slug, title, content, tags, always_inject, active, hotel_id, updated_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
      ON CONFLICT(namespace, slug) DO UPDATE SET
        title=excluded.title, content=excluded.content, tags=excluded.tags,
        hotel_id=excluded.hotel_id, updated_at=excluded.updated_at
    `);

    // Hotel overview
    const hotelContent = [
      `# ${hotel.name}`,
      hotel.address ? `Dia chi: ${hotel.address}` : '',
      hotel.city ? `Thanh pho: ${hotel.city}` : '',
      hotel.star_rating ? `Hang sao: ${hotel.star_rating} sao` : '',
      hotel.phone ? `Hotline: ${hotel.phone}` : '',
      hotel.check_in_time ? `Check-in: ${hotel.check_in_time}` : '',
      hotel.check_out_time ? `Check-out: ${hotel.check_out_time}` : '',
      hotel.amenities ? `Tien nghi: ${JSON.stringify(hotel.amenities)}` : '',
    ].filter(Boolean).join('\n');

    upsertWiki.run('business', `hotel-${otaHotelId}-overview`, `${hotel.name} - Tong quan`,
      hotelContent, '["hotel","overview"]', 1, mktHotelId, now, now);
    count++;

    // Room types
    for (const rt of roomTypes) {
      const roomContent = [
        `# ${rt.name}`,
        `Gia co ban: ${rt.base_price.toLocaleString('vi-VN')} VND/dem`,
        rt.hourly_price ? `Gia theo gio: ${rt.hourly_price.toLocaleString('vi-VN')} VND` : '',
        `Suc chua: ${rt.max_guests} khach`,
        rt.bed_type ? `Loai giuong: ${rt.bed_type}` : '',
        rt.amenities ? `Tien nghi: ${JSON.stringify(rt.amenities)}` : '',
        `So phong: ${rt.room_count} (con trong: ${rt.available_count})`,
      ].filter(Boolean).join('\n');

      upsertWiki.run('product', `room-${otaHotelId}-${rt.id}`, rt.name,
        roomContent, '["room","pricing"]', 0, mktHotelId, now, now);
      count++;
    }

    console.log(`[ota-sync] Auto-generated ${count} wiki entries for hotel ${hotel.name}`);
    return count;
  } catch (e: any) {
    console.error('[ota-sync] autoGenWiki failed:', e.message);
    return 0;
  }
}

/** Full sync all — called by cron */
export async function runFullSync() {
  console.log('[ota-sync] Starting full sync...');
  const hotels = await syncHotelsCache();
  const rooms = await syncRoomsCache();
  console.log(`[ota-sync] Full sync done: ${hotels} hotels, ${rooms} room types`);
}

/** Booking sync — called by cron (more frequent) */
export async function runBookingSync() {
  const count = await syncBookingsCache();
  console.log(`[ota-sync] Booking sync done: ${count} bookings`);
}

// Get cached data (for quick access without hitting OTA DB)
export function getCachedHotels() {
  return db.prepare(`SELECT * FROM mkt_hotels_cache ORDER BY name`).all();
}

export function getCachedRoomTypes(otaHotelId: number) {
  return db.prepare(`SELECT * FROM mkt_rooms_cache WHERE ota_hotel_id = ? ORDER BY base_price`).all(otaHotelId);
}

export function getCachedBookings(otaHotelId: number, limit = 50) {
  return db.prepare(`SELECT * FROM mkt_bookings_cache WHERE ota_hotel_id = ? ORDER BY checkin_date DESC LIMIT ?`).all(otaHotelId, limit);
}

/**
 * Sync Hub — Seed test data.
 * Populate sync_availability với dữ liệu realistic cho 14 ngày tới,
 * cover tất cả active hotels + room types.
 *
 * Chạy 1 lần khi bật feature. OTA team push sẽ override dần.
 */

import { db } from '../db';
import { upsertAvailability } from './sync-hub';

interface SeedOptions {
  days?: number;
  totalRoomsRange?: [number, number];
  availabilityRate?: [number, number];  // % available, random trong range
  peakDates?: string[];                   // dates override with low availability
}

export function seedAvailability(opts: SeedOptions = {}): { hotels: number; rooms: number; rows: number } {
  const days = opts.days || 14;
  const [minTotal, maxTotal] = opts.totalRoomsRange || [5, 15];
  const [minAvail, maxAvail] = opts.availabilityRate || [0.3, 0.9];
  const peakDates = opts.peakDates || [
    '2026-04-30', '2026-05-01', '2026-05-02',  // 30/4 - 1/5 - 2/5
    '2026-09-02', '2026-09-03',                 // 2/9
    '2026-12-24', '2026-12-25', '2026-12-31',   // Giáng Sinh + New Year
    '2027-01-01', '2027-01-29', '2027-01-30',   // Tết Âm 2027
  ];

  // Load all active hotels + their rooms
  const hotels = db.prepare(
    `SELECT DISTINCT mh.ota_hotel_id as hotel_id, hp.name_canonical
     FROM mkt_hotels mh
     LEFT JOIN hotel_profile hp ON hp.hotel_id = mh.ota_hotel_id
     WHERE mh.status = 'active'`
  ).all() as any[];

  let rowCount = 0;
  let roomCount = 0;

  for (const hotel of hotels) {
    const rooms = db.prepare(
      `SELECT id, room_key, display_name_vi, price_weekday, price_weekend, max_guests
       FROM hotel_room_catalog
       WHERE hotel_id = ?`
    ).all(hotel.hotel_id) as any[];

    // Fallback nếu hotel_room_catalog empty: tạo 2 generic room types
    let roomList = rooms;
    if (rooms.length === 0) {
      roomList = [
        { room_key: 'STANDARD', display_name_vi: 'Phòng tiêu chuẩn', price_weekday: 600000, price_weekend: 700000, max_guests: 2 },
        { room_key: 'DELUXE', display_name_vi: 'Phòng Deluxe', price_weekday: 900000, price_weekend: 1100000, max_guests: 2 },
      ];
    }

    for (const room of roomList) {
      roomCount++;
      const total = Math.floor(minTotal + Math.random() * (maxTotal - minTotal));

      for (let d = 0; d < days; d++) {
        const date = new Date();
        date.setUTCHours(0, 0, 0, 0);
        date.setUTCDate(date.getUTCDate() + d);
        const dateStr = date.toISOString().slice(0, 10);

        // Peak dates → low availability
        const isPeak = peakDates.includes(dateStr);
        const availRate = isPeak
          ? Math.random() * 0.2  // 0-20% available
          : minAvail + Math.random() * (maxAvail - minAvail);
        const available = Math.max(0, Math.floor(total * availRate));

        // Weekend: use weekend price
        const dayOfWeek = date.getUTCDay();
        const isWeekend = dayOfWeek === 5 || dayOfWeek === 6;  // Fri/Sat
        const price = isWeekend ? room.price_weekend : room.price_weekday;

        upsertAvailability({
          hotel_id: hotel.hotel_id,
          room_type_code: room.room_key || `ROOM_${room.id || d}`,
          date_str: dateStr,
          total_rooms: total,
          available_rooms: available,
          base_price: price || 600000,
          stop_sell: false,
          source: 'seed',
        });
        rowCount++;
      }
    }
  }

  console.log(`[sync-seed] Seeded ${rowCount} rows across ${hotels.length} hotels × ${roomCount} room types`);
  return { hotels: hotels.length, rooms: roomCount, rows: rowCount };
}

/** Clean all seed data. */
export function clearSeedData(): number {
  const r = db.prepare(`DELETE FROM sync_availability WHERE source = 'seed'`).run();
  return r.changes;
}

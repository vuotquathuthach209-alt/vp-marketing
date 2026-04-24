/**
 * Auto-sync new hotels từ OTA API → bot DB.
 *
 * Purpose: khi khách sạn mới đăng ký trên OTA, bot TỰ ĐỘNG thêm vào
 * danh sách auto-post (không cần manual trigger).
 *
 * Flow:
 *   1. Fetch tất cả hotels từ OTA API
 *   2. For each: check hotel_profile + mkt_hotels có chưa
 *   3. Nếu chưa → INSERT + set mkt_hotels.status = 'active' (ready for auto-post)
 *   4. Nếu có nhưng data lỗi thời → UPDATE scraped_data
 *
 * Run: cron mỗi 6h qua scheduler.
 */

import { db } from '../../db';

/**
 * Ensure a hotel from OTA exists in bot tables.
 * Returns: 'created' | 'updated' | 'unchanged'
 */
function upsertHotelFromOta(otaHotel: any): 'created' | 'updated' | 'unchanged' {
  const id = parseInt(String(otaHotel.id), 10);
  if (!id) return 'unchanged';
  const now = Date.now();

  try {
    // 1. hotel_profile
    const existing = db.prepare(`SELECT hotel_id, scraped_at FROM hotel_profile WHERE hotel_id = ?`).get(id) as any;

    // Extract property type + build scraped_data
    const propType = (() => {
      const t = (otaHotel.propertyType || '').toLowerCase();
      if (t.includes('apartment') || t.includes('chdv')) return 'apartment';
      if (t.includes('villa')) return 'villa';
      if (t.includes('homestay')) return 'homestay';
      if (t.includes('resort')) return 'resort';
      if (t.includes('guesthouse')) return 'guesthouse';
      return 'hotel';
    })();

    const scrapedData = {
      review_avg: otaHotel.reviewAvg || null,
      review_count: otaHotel.reviewCount || 0,
      is_verified: !!otaHotel.isVerified,
      images: otaHotel.images || [],
      coverImage: otaHotel.coverImage || null,
      description: otaHotel.description || '',
      source: 'ota_sync',
      synced_at: now,
    };

    if (!existing) {
      // INSERT new
      db.prepare(`
        INSERT INTO hotel_profile
          (hotel_id, ota_hotel_id, name_canonical, city, district, address,
           star_rating, phone, property_type, scraped_data, scraped_at, version, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
      `).run(
        id, id,
        otaHotel.name || 'Unknown',
        otaHotel.city || 'Ho Chi Minh',
        otaHotel.district || null,
        otaHotel.address || null,
        otaHotel.starRating || null,
        otaHotel.phone || null,
        propType,
        JSON.stringify(scrapedData),
        now,
        now,
      );

      // 2. mkt_hotels — ensure record + status = active
      const mktExisting = db.prepare(`SELECT id FROM mkt_hotels WHERE ota_hotel_id = ?`).get(id);
      if (!mktExisting) {
        const features = JSON.stringify({ chatbot: true, autopilot: true, booking: true });
        db.prepare(`
          INSERT INTO mkt_hotels (ota_hotel_id, name, slug, plan, status, config, features,
                                   max_posts_per_day, max_pages, activated_at, created_at, updated_at)
          VALUES (?, ?, ?, 'free', 'active', '{}', ?, 5, 2, ?, ?, ?)
        `).run(
          id,
          otaHotel.name || 'Hotel ' + id,
          otaHotel.slug || ('hotel-' + id),
          features,
          now, now, now,
        );
        console.log(`[ota-sync] ✅ created hotel_profile + mkt_hotels for #${id} ${otaHotel.name}`);
      }
      return 'created';
    }

    // UPDATE existing — only if scraped_at > 24h old hoặc review changed
    const age = now - (existing.scraped_at || 0);
    if (age < 24 * 3600_000) return 'unchanged';     // skip recently synced

    db.prepare(`
      UPDATE hotel_profile
      SET name_canonical = ?, city = ?, district = ?, address = ?,
          star_rating = ?, phone = ?, property_type = ?,
          scraped_data = ?, scraped_at = ?, updated_at = ?
      WHERE hotel_id = ?
    `).run(
      otaHotel.name || 'Unknown',
      otaHotel.city || 'Ho Chi Minh',
      otaHotel.district || null,
      otaHotel.address || null,
      otaHotel.starRating || null,
      otaHotel.phone || null,
      propType,
      JSON.stringify(scrapedData),
      now, now,
      id,
    );
    return 'updated';
  } catch (e: any) {
    console.warn(`[ota-sync] upsert hotel ${id} fail:`, e?.message);
    return 'unchanged';
  }
}

export async function syncNewHotelsFromOta(): Promise<{
  created: number;
  updated: number;
  unchanged: number;
  errors: number;
  total: number;
}> {
  const result = { created: 0, updated: 0, unchanged: 0, errors: 0, total: 0 };
  try {
    const { listAllHotels } = require('../ota-api-client');
    const hotels = await listAllHotels({ maxPages: 10, perPage: 50 });
    result.total = hotels.length;

    for (const h of hotels) {
      try {
        const r = upsertHotelFromOta(h);
        result[r]++;
      } catch (e: any) {
        result.errors++;
        console.warn(`[ota-sync] error hotel ${h.id}:`, e?.message);
      }
    }

    console.log(`[ota-sync] done: ${result.created} created, ${result.updated} updated, ${result.unchanged} unchanged, ${result.errors} errors out of ${result.total}`);

    if (result.created > 0) {
      try {
        const { notifyAll } = require('../telegram');
        notifyAll(
          `🏨 *OTA Auto-Sync*: ${result.created} hotel mới đã được add vào bot\n` +
          `• Updated: ${result.updated}\n` +
          `• Total network: ${result.total}\n\n` +
          `Các hotel mới sẽ tự động vào auto-post rotation từ ngày mai.`
        ).catch(() => {});
      } catch {}
    }
  } catch (e: any) {
    console.error('[ota-sync] fatal:', e?.message);
  }
  return result;
}

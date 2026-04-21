/**
 * Đợt 1.2 + 1.3: Fix hotel_id linking + seed brand_voice + re-seed rooms.
 *
 * 1. Với mỗi hotel trong hotel_profile mà chưa có mkt_hotels → tạo.
 * 2. Set brand_voice='friendly' cho tất cả hotels (theo user spec).
 * 3. Cleanup mkt_rooms_cache rows ota_hotel_id=999 (dummy data).
 * 4. Verify v_hotel_bot_context view returns đầy đủ data.
 */
import { db } from '../db';

async function main() {
  const now = Date.now();

  console.log('=== Step 1: Auto-create mkt_hotels cho hotels scraped ===');
  const profiles = db.prepare(
    `SELECT hp.hotel_id, hp.ota_hotel_id, hp.name_canonical, hp.city, hp.district
     FROM hotel_profile hp
     WHERE hp.ota_hotel_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM mkt_hotels mh WHERE mh.ota_hotel_id = hp.ota_hotel_id)`
  ).all() as any[];

  let created = 0;
  for (const p of profiles) {
    const slug = (p.name_canonical || 'hotel-' + p.ota_hotel_id)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
    try {
      db.prepare(
        `INSERT INTO mkt_hotels (ota_hotel_id, name, slug, plan, status, config, features, max_posts_per_day, max_pages, activated_at, created_at, updated_at)
         VALUES (?, ?, ?, 'pro', 'active', '{}', '{"chatbot":true,"autopilot":true,"booking":true,"analytics":true,"ab_test":true}', 5, 5, ?, ?, ?)`
      ).run(p.ota_hotel_id, p.name_canonical, slug, now, now, now);
      created++;
      console.log(`  Created mkt_hotel cho ota_hotel_id=${p.ota_hotel_id} (${p.name_canonical})`);
    } catch (e: any) {
      console.warn(`  Fail create mkt_hotel for ota_hotel_id=${p.ota_hotel_id}:`, e?.message);
    }
  }
  console.log(`  Total created: ${created}`);

  console.log('\n=== Step 2: Set brand_voice=friendly cho tất cả hotels ===');
  const bvResult = db.prepare(
    `UPDATE hotel_profile SET brand_voice = 'friendly', updated_at = ? WHERE brand_voice IS NULL OR brand_voice = ''`
  ).run(now);
  console.log(`  Updated ${bvResult.changes} hotel_profile rows`);

  console.log('\n=== Step 3: Cleanup dummy mkt_rooms_cache (ota_hotel_id=999) ===');
  const cleanupResult = db.prepare(`DELETE FROM mkt_rooms_cache WHERE ota_hotel_id = 999`).run();
  console.log(`  Deleted ${cleanupResult.changes} dummy rows`);

  console.log('\n=== Step 4: Verify v_hotel_bot_context ===');
  const ctx = db.prepare(
    `SELECT mkt_hotel_id, ota_hotel_id, name, brand_voice, product_group, rooms_count, amenities_count, has_policies, price_min_vnd
     FROM v_hotel_bot_context`
  ).all();
  console.table(ctx);

  console.log('\n=== Step 5: Verify v_hotel_rooms ===');
  const rooms = db.prepare(`SELECT mkt_hotel_id, room_key, display_name_vi, price_weekday FROM v_hotel_rooms`).all();
  console.table(rooms);

  console.log('\n=== Step 6: mkt_hotels final state ===');
  const mhs = db.prepare(`SELECT id, ota_hotel_id, name, slug, plan, status FROM mkt_hotels ORDER BY id`).all();
  console.table(mhs);

  console.log('\n✅ Đợt 1.2 + brand voice done');
}

main().catch(e => { console.error('FAIL:', e); process.exit(1); });

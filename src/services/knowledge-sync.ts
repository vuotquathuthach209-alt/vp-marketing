/**
 * Knowledge Sync — populate Tier 2 (RAG embeddings) + Tier 3 (Wiki) từ Tier 1 (SQL facts).
 *
 * Architecture: xem .claude/skills/sonder-ecosystem/SKILL.md
 *
 * Flow:
 *   1. Read hotel_profile + hotel_room_catalog + hotel_amenities + hotel_policies
 *   2. Generate chunks theo category (description / amenity / usp / nearby / policy)
 *   3. Embed MiniLM → save hotel_knowledge_embeddings
 *   4. Also populate Tier 3 wiki per hotel (auto slug per namespace)
 *
 * Cron: daily 3:00 AM (sau retention cleanup 2:00 AM)
 * Manual trigger: POST /api/knowledge/rebuild/:hotel_id
 */

import { db } from '../db';
import { embed, encodeEmbedding } from './embedder';

export type ChunkType =
  | 'description'      // mô tả chung về hotel
  | 'usp'              // điểm mạnh (unique selling points)
  | 'amenity'          // mỗi amenity 1 chunk (wifi, pool, gym, ...)
  | 'nearby'           // landmark xung quanh (generic)
  | 'policy'           // chính sách (cancel, pet, smoking)
  | 'room_feature'     // đặc điểm phòng (size, bed, max guests, price)
  | 'faq'              // FAQ per hotel
  | 'review'           // review snippets từ khách cũ
  | 'testimonial'      // testimonial (quote + tác giả)
  | 'promotion'        // deals/ưu đãi hiện tại
  | 'seasonal'         // ưu đãi theo mùa (Tet, Summer, ...)
  | 'transport'        // cách di chuyển đến hotel (airport, metro, taxi)
  | 'dining'           // nhà hàng/quán ăn gần
  | 'attraction'       // điểm du lịch nổi tiếng gần
  | 'house_rule'       // quy định nhà (check-in time, noise, visitor)
  | 'neighborhood'     // giới thiệu khu vực xung quanh
  | 'host_story'       // câu chuyện host (nếu homestay)
  | 'safety'           // an toàn (smoke alarm, emergency contacts)
  | 'wellness'         // spa, gym, massage services
  | 'business'         // business center, meeting rooms
  | 'family'           // family-friendly features (cradle, kids menu)
  | 'accessibility'    // wheelchair, elevator, disability support
  | 'pet'              // pet-friendly details
  | 'longstay_benefit' // benefits cho long-stay guest (CHDV)
  | 'loyalty'          // loyalty program, repeat guest perks
  | 'sustainability';  // eco-friendly practices

interface Chunk {
  chunk_type: ChunkType;
  chunk_text: string;
  source?: string;
}

/* ═══════════════════════════════════════════
   Chunk generation từ structured data
   ═══════════════════════════════════════════ */

function chunksForHotel(hotelId: number): Chunk[] {
  const chunks: Chunk[] = [];

  // 1. Hotel profile
  const profile = db.prepare(
    `SELECT name_canonical, property_type, city, district, address, star_rating,
            ai_summary_vi, usp_top3, target_segment,
            monthly_price_from, monthly_price_to, min_stay_months, deposit_months,
            utilities_included, full_kitchen, washing_machine
     FROM hotel_profile WHERE hotel_id = ?`
  ).get(hotelId) as any;

  if (!profile) return chunks;

  // Description chunk
  const descParts: string[] = [];
  descParts.push(`${profile.name_canonical}`);
  if (profile.property_type) descParts.push(`thuộc loại ${profile.property_type}`);
  if (profile.star_rating) descParts.push(`đạt ${profile.star_rating} sao`);
  if (profile.district && profile.city) descParts.push(`tọa lạc tại ${profile.district}, ${profile.city}`);
  if (profile.address) descParts.push(`địa chỉ ${profile.address}`);
  if (profile.ai_summary_vi) descParts.push(profile.ai_summary_vi);
  if (profile.target_segment) descParts.push(`phù hợp đối tượng ${profile.target_segment}`);
  chunks.push({
    chunk_type: 'description',
    chunk_text: descParts.join('. ') + '.',
    source: 'hotel_profile',
  });

  // USP chunks
  try {
    const usps = JSON.parse(profile.usp_top3 || '[]');
    for (const usp of usps) {
      if (typeof usp === 'string' && usp.length > 5) {
        chunks.push({ chunk_type: 'usp', chunk_text: `Điểm mạnh của ${profile.name_canonical}: ${usp}.`, source: 'usp_top3' });
      }
    }
  } catch {}

  // 2. Rooms
  const rooms = db.prepare(
    `SELECT display_name_vi, max_guests, bed_config, size_m2, price_weekday, price_weekend, price_hourly, amenities
     FROM hotel_room_catalog WHERE hotel_id = ?`
  ).all(hotelId) as any[];
  for (const r of rooms) {
    const parts: string[] = [`Phòng ${r.display_name_vi} tại ${profile.name_canonical}`];
    if (r.max_guests) parts.push(`tối đa ${r.max_guests} khách`);
    if (r.bed_config) parts.push(r.bed_config);
    if (r.size_m2) parts.push(`${r.size_m2}m²`);
    if (r.price_weekday) parts.push(`giá ${r.price_weekday.toLocaleString('vi-VN')}₫/đêm`);
    if (r.price_weekend && r.price_weekend !== r.price_weekday) parts.push(`cuối tuần ${r.price_weekend.toLocaleString('vi-VN')}₫`);
    if (r.price_hourly) parts.push(`theo giờ ${r.price_hourly.toLocaleString('vi-VN')}₫/giờ`);
    chunks.push({
      chunk_type: 'room_feature',
      chunk_text: parts.join(', ') + '.',
      source: 'hotel_room_catalog',
    });
    // Amenities per room
    try {
      const amenities = JSON.parse(r.amenities || '[]');
      if (Array.isArray(amenities) && amenities.length) {
        chunks.push({
          chunk_type: 'amenity',
          chunk_text: `Phòng ${r.display_name_vi} tại ${profile.name_canonical} có: ${amenities.join(', ')}.`,
          source: 'room_amenities',
        });
      }
    } catch {}
  }

  // 3. Hotel-level amenities
  try {
    const amenities = db.prepare(`SELECT amenity_name, amenity_category FROM hotel_amenities WHERE hotel_id = ?`).all(hotelId) as any[];
    // Group by category
    const byCat: Record<string, string[]> = {};
    for (const a of amenities) {
      const cat = a.amenity_category || 'general';
      if (!byCat[cat]) byCat[cat] = [];
      byCat[cat].push(a.amenity_name);
    }
    for (const [cat, names] of Object.entries(byCat)) {
      chunks.push({
        chunk_type: 'amenity',
        chunk_text: `${profile.name_canonical} có các tiện nghi ${cat}: ${names.join(', ')}.`,
        source: 'hotel_amenities',
      });
    }
  } catch {}

  // 4. Policies
  try {
    const policies = db.prepare(
      `SELECT checkin_time, checkout_time, cancellation_policy, pet_policy, smoking_policy,
              age_restriction, child_policy, payment_methods
       FROM hotel_policies WHERE hotel_id = ?`
    ).get(hotelId) as any;
    if (policies) {
      const pparts: string[] = [];
      if (policies.checkin_time) pparts.push(`Check-in từ ${policies.checkin_time}`);
      if (policies.checkout_time) pparts.push(`check-out đến ${policies.checkout_time}`);
      if (policies.cancellation_policy) pparts.push(`Hủy phòng: ${policies.cancellation_policy}`);
      if (policies.pet_policy) pparts.push(`Thú cưng: ${policies.pet_policy}`);
      if (policies.smoking_policy) pparts.push(`Hút thuốc: ${policies.smoking_policy}`);
      if (policies.child_policy) pparts.push(`Trẻ em: ${policies.child_policy}`);
      if (policies.payment_methods) pparts.push(`Thanh toán: ${policies.payment_methods}`);
      if (pparts.length) {
        chunks.push({
          chunk_type: 'policy',
          chunk_text: `Chính sách ${profile.name_canonical}: ${pparts.join('. ')}.`,
          source: 'hotel_policies',
        });
      }
    }
  } catch {}

  // 5. Monthly-specific info (CHDV)
  if (profile.property_type === 'apartment' && profile.monthly_price_from) {
    const parts = [`${profile.name_canonical} cho thuê tháng`];
    parts.push(`giá từ ${profile.monthly_price_from.toLocaleString('vi-VN')}₫/tháng`);
    if (profile.monthly_price_to) parts.push(`đến ${profile.monthly_price_to.toLocaleString('vi-VN')}₫/tháng`);
    if (profile.min_stay_months) parts.push(`thuê tối thiểu ${profile.min_stay_months} tháng`);
    if (profile.deposit_months) parts.push(`đặt cọc ${profile.deposit_months} tháng`);
    const services: string[] = [];
    if (profile.utilities_included) services.push('điện nước bao trọn');
    if (profile.full_kitchen) services.push('bếp đầy đủ');
    if (profile.washing_machine) services.push('máy giặt riêng');
    if (services.length) parts.push(`bao gồm ${services.join(', ')}`);
    chunks.push({
      chunk_type: 'description',
      chunk_text: parts.join(', ') + '.',
      source: 'monthly_apartment',
    });
  }

  // 6. Nearby landmarks (từ hotel_profile.nearby_landmarks JSON array nếu có)
  try {
    const pf = db.prepare(`SELECT nearby_landmarks FROM hotel_profile WHERE hotel_id = ?`).get(hotelId) as any;
    if (pf?.nearby_landmarks) {
      const landmarks = JSON.parse(pf.nearby_landmarks);
      if (Array.isArray(landmarks) && landmarks.length) {
        chunks.push({
          chunk_type: 'nearby',
          chunk_text: `${profile.name_canonical} gần các địa điểm: ${landmarks.join(', ')}.`,
          source: 'nearby_landmarks',
        });
      }
    }
  } catch {}

  // 7. Rich content sections (từ scraped_data.content_sections nếu OTA đẩy)
  try {
    const pf = db.prepare(`SELECT scraped_data FROM hotel_profile WHERE hotel_id = ?`).get(hotelId) as any;
    if (pf?.scraped_data) {
      const scraped = JSON.parse(pf.scraped_data);
      const cs = scraped.content_sections || scraped.contentSections || {};

      // Brand story
      if (cs.brand_story) {
        chunks.push({ chunk_type: 'description', chunk_text: `${profile.name_canonical} — ${cs.brand_story}`, source: 'brand_story' });
      }
      // Host story (homestay)
      if (cs.host_story) {
        chunks.push({ chunk_type: 'host_story', chunk_text: `Chủ nhà ${profile.name_canonical}: ${cs.host_story}`, source: 'host_story' });
      }
      // House rules
      if (Array.isArray(cs.house_rules)) {
        chunks.push({
          chunk_type: 'house_rule',
          chunk_text: `Quy định tại ${profile.name_canonical}: ${cs.house_rules.join('. ')}.`,
          source: 'house_rules',
        });
      }
      // Transport
      if (cs.transport) {
        const transportStr = typeof cs.transport === 'string' ? cs.transport : JSON.stringify(cs.transport);
        chunks.push({ chunk_type: 'transport', chunk_text: `Di chuyển đến ${profile.name_canonical}: ${transportStr}`, source: 'transport' });
      }
      // Nearby dining
      if (Array.isArray(cs.nearby_dining)) {
        chunks.push({
          chunk_type: 'dining',
          chunk_text: `Các quán ăn gần ${profile.name_canonical}: ${cs.nearby_dining.join(', ')}.`,
          source: 'nearby_dining',
        });
      }
      // Attractions
      if (Array.isArray(cs.attractions)) {
        chunks.push({
          chunk_type: 'attraction',
          chunk_text: `Địa điểm du lịch gần ${profile.name_canonical}: ${cs.attractions.join(', ')}.`,
          source: 'attractions',
        });
      }
      // Neighborhood
      if (cs.neighborhood) {
        chunks.push({ chunk_type: 'neighborhood', chunk_text: `Khu vực ${profile.name_canonical}: ${cs.neighborhood}`, source: 'neighborhood' });
      }
      // Promotions
      if (Array.isArray(cs.promotions)) {
        for (const p of cs.promotions) {
          const text = typeof p === 'string' ? p : `${p.title || 'Ưu đãi'}: ${p.discount || ''} ${p.description || ''}${p.valid_until ? ` (đến ${p.valid_until})` : ''}`;
          chunks.push({ chunk_type: 'promotion', chunk_text: `Ưu đãi ${profile.name_canonical}: ${text}`, source: 'promotions' });
        }
      }
      // Seasonal offers
      if (Array.isArray(cs.seasonal_offers)) {
        for (const s of cs.seasonal_offers) {
          const text = typeof s === 'string' ? s : `${s.title || s.name || 'Ưu đãi mùa'}: ${s.description || ''}`;
          chunks.push({ chunk_type: 'seasonal', chunk_text: `Mùa ưu đãi ${profile.name_canonical}: ${text}`, source: 'seasonal' });
        }
      }
      // Reviews summary
      if (cs.reviews_summary) {
        chunks.push({ chunk_type: 'review', chunk_text: `Đánh giá ${profile.name_canonical}: ${cs.reviews_summary}`, source: 'reviews_summary' });
      }
      // Testimonials
      if (Array.isArray(cs.testimonials)) {
        for (const t of cs.testimonials) {
          const text = typeof t === 'string' ? t : `"${t.quote || ''}" — ${t.name || 'Khách'}${t.stars ? ` ${t.stars}⭐` : ''}`;
          chunks.push({ chunk_type: 'testimonial', chunk_text: `Khách nói về ${profile.name_canonical}: ${text}`, source: 'testimonials' });
        }
      }
      // Safety
      if (Array.isArray(cs.safety_features)) {
        chunks.push({
          chunk_type: 'safety',
          chunk_text: `An toàn tại ${profile.name_canonical}: ${cs.safety_features.join(', ')}.`,
          source: 'safety',
        });
      }
      // Wellness
      if (Array.isArray(cs.wellness_services)) {
        chunks.push({
          chunk_type: 'wellness',
          chunk_text: `Dịch vụ wellness ${profile.name_canonical}: ${cs.wellness_services.join(', ')}.`,
          source: 'wellness',
        });
      }
      // Business
      if (Array.isArray(cs.business_features) || cs.business_center) {
        const features = cs.business_features || [cs.business_center];
        chunks.push({
          chunk_type: 'business',
          chunk_text: `Dịch vụ business ${profile.name_canonical}: ${features.join(', ')}.`,
          source: 'business',
        });
      }
      // Family features
      if (Array.isArray(cs.family_features)) {
        chunks.push({
          chunk_type: 'family',
          chunk_text: `Dành cho gia đình tại ${profile.name_canonical}: ${cs.family_features.join(', ')}.`,
          source: 'family',
        });
      }
      // Accessibility
      if (Array.isArray(cs.accessibility_features)) {
        chunks.push({
          chunk_type: 'accessibility',
          chunk_text: `Hỗ trợ người khuyết tật tại ${profile.name_canonical}: ${cs.accessibility_features.join(', ')}.`,
          source: 'accessibility',
        });
      }
      // Pet
      if (cs.pet_policy || cs.pet_friendly) {
        const text = cs.pet_policy || `Chấp nhận thú cưng${cs.pet_friendly ? '' : ' (liên hệ)'}`;
        chunks.push({ chunk_type: 'pet', chunk_text: `${profile.name_canonical} về thú cưng: ${text}`, source: 'pet' });
      }
      // Long-stay benefits (CHDV)
      if (Array.isArray(cs.longstay_benefits) && profile.property_type === 'apartment') {
        chunks.push({
          chunk_type: 'longstay_benefit',
          chunk_text: `Ưu đãi ở dài hạn ${profile.name_canonical}: ${cs.longstay_benefits.join(', ')}.`,
          source: 'longstay',
        });
      }
      // Loyalty
      if (cs.loyalty_program) {
        const text = typeof cs.loyalty_program === 'string' ? cs.loyalty_program
          : `${cs.loyalty_program.name || 'Loyalty'}: ${cs.loyalty_program.benefits || cs.loyalty_program.description || ''}`;
        chunks.push({ chunk_type: 'loyalty', chunk_text: `Chương trình khách thân thiết ${profile.name_canonical}: ${text}`, source: 'loyalty' });
      }
      // Sustainability
      if (Array.isArray(cs.sustainability_practices)) {
        chunks.push({
          chunk_type: 'sustainability',
          chunk_text: `Thực hành bền vững tại ${profile.name_canonical}: ${cs.sustainability_practices.join(', ')}.`,
          source: 'sustainability',
        });
      }
      // FAQs (per-hotel)
      if (Array.isArray(cs.faqs)) {
        for (const f of cs.faqs) {
          const q = typeof f === 'string' ? f : (f.question || f.q || '');
          const a = typeof f === 'string' ? '' : (f.answer || f.a || '');
          if (q) {
            chunks.push({
              chunk_type: 'faq',
              chunk_text: `[FAQ ${profile.name_canonical}] ${q}${a ? ' → ' + a : ''}`,
              source: 'faqs',
            });
          }
        }
      }
    }
  } catch (e: any) {
    console.warn(`[chunksForHotel] parse content_sections fail for hotel ${hotelId}:`, e?.message);
  }

  return chunks;
}

/* ═══════════════════════════════════════════
   Embed + store
   ═══════════════════════════════════════════ */

export async function rebuildEmbeddings(hotelId: number): Promise<{ chunks_deleted: number; chunks_created: number; wiki_generated: number; duration_ms: number }> {
  const t0 = Date.now();
  // Clear old embeddings for this hotel
  const delResult = db.prepare(`DELETE FROM hotel_knowledge_embeddings WHERE hotel_id = ?`).run(hotelId);

  // Generate new chunks
  const chunks = chunksForHotel(hotelId);
  const now = Date.now();
  let created = 0;

  for (const c of chunks) {
    try {
      const vec = await embed(c.chunk_text);
      if (!vec) continue;
      const embeddingBuffer = encodeEmbedding(vec);
      db.prepare(
        `INSERT INTO hotel_knowledge_embeddings (hotel_id, chunk_type, chunk_text, embedding, created_at)
         VALUES (?, ?, ?, ?, ?)`
      ).run(hotelId, c.chunk_type, c.chunk_text, embeddingBuffer, now);
      created++;
    } catch (e: any) {
      console.warn(`[knowledge-sync] embed fail for hotel ${hotelId}:`, e?.message);
    }
  }

  // Auto-generate Tier 3 Wiki (từ content_sections)
  const wikiCount = autoGenerateWikiFromHotel(hotelId);

  return {
    chunks_deleted: delResult.changes,
    chunks_created: created,
    wiki_generated: wikiCount,
    duration_ms: Date.now() - t0,
  };
}

/**
 * Rebuild embeddings cho TẤT CẢ hotels active.
 * + Auto-generate Wiki entries từ content_sections (KHÔNG admin UI — AI-populated).
 */
export async function rebuildAllEmbeddings(): Promise<{
  hotels_processed: number;
  total_chunks: number;
  total_deleted: number;
  wiki_auto_generated: number;
  duration_ms: number;
}> {
  const t0 = Date.now();
  const hotels = db.prepare(
    `SELECT DISTINCT hp.hotel_id FROM hotel_profile hp
     WHERE EXISTS (SELECT 1 FROM mkt_hotels mh WHERE mh.ota_hotel_id = hp.hotel_id AND mh.status = 'active')`
  ).all() as any[];

  let totalCreated = 0;
  let totalDeleted = 0;
  let wikiGen = 0;
  for (const h of hotels) {
    try {
      const r = await rebuildEmbeddings(h.hotel_id);  // already includes autoGenerateWiki
      totalCreated += r.chunks_created;
      totalDeleted += r.chunks_deleted;
      wikiGen += r.wiki_generated;
    } catch (e: any) {
      console.warn(`[knowledge-sync] rebuild hotel ${h.hotel_id} fail:`, e?.message);
    }
  }
  return {
    hotels_processed: hotels.length,
    total_chunks: totalCreated,
    total_deleted: totalDeleted,
    wiki_auto_generated: wikiGen,
    duration_ms: Date.now() - t0,
  };
}

/**
 * Auto-populate Tier 3 Wiki entries từ hotel content_sections.
 * Cross-hotel content (brand, policies, location guides) được aggregate.
 * Called trong rebuild cron — KHÔNG cần admin edit thủ công.
 *
 * Returns: số wiki entries đã upsert.
 */
function autoGenerateWikiFromHotel(hotelId: number): number {
  const now = Date.now();
  let count = 0;

  try {
    const profile = db.prepare(
      `SELECT name_canonical, city, district, scraped_data, ai_summary_vi FROM hotel_profile WHERE hotel_id = ?`
    ).get(hotelId) as any;
    if (!profile) return 0;

    const scraped = profile.scraped_data ? JSON.parse(profile.scraped_data) : {};
    const cs = scraped.content_sections || {};

    // Auto-wiki: hotel_info (individual hotel profile)
    if (profile.ai_summary_vi) {
      const content = [
        `# ${profile.name_canonical}`,
        '',
        profile.ai_summary_vi,
        '',
        profile.district ? `**Khu vực**: ${profile.district}${profile.city ? ', ' + profile.city : ''}` : '',
        cs.brand_story ? `## Về chúng tôi\n${cs.brand_story}` : '',
        cs.host_story ? `## Chủ nhà\n${cs.host_story}` : '',
        Array.isArray(cs.house_rules) && cs.house_rules.length ? `## Quy định\n- ${cs.house_rules.join('\n- ')}` : '',
        cs.transport ? `## Di chuyển\n${typeof cs.transport === 'string' ? cs.transport : JSON.stringify(cs.transport)}` : '',
      ].filter(Boolean).join('\n');

      upsertWiki('hotel_info', `hotel-${hotelId}`, profile.name_canonical, content, `hotel,${profile.district || ''},${profile.city || ''}`);
      count++;
    }

    // Auto-wiki: location_guide per district (aggregate từ các hotels cùng district)
    if (profile.district) {
      const sameDistrictHotels = db.prepare(
        `SELECT name_canonical, property_type FROM hotel_profile WHERE district = ?
         AND EXISTS (SELECT 1 FROM mkt_hotels WHERE ota_hotel_id = hotel_profile.hotel_id AND status = 'active')`
      ).all(profile.district) as any[];
      if (sameDistrictHotels.length) {
        const districtSlug = (profile.district || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/\s+/g, '-');
        const content = [
          `# Khu vực ${profile.district}, ${profile.city || ''}`,
          '',
          `Sonder có ${sameDistrictHotels.length} chỗ ở tại khu ${profile.district}:`,
          ...sameDistrictHotels.map((h: any) => `- ${h.name_canonical} (${h.property_type})`),
          '',
          cs.neighborhood ? `## Giới thiệu khu vực\n${cs.neighborhood}` : '',
          Array.isArray(cs.attractions) ? `## Địa điểm du lịch gần\n- ${cs.attractions.join('\n- ')}` : '',
          Array.isArray(cs.nearby_dining) ? `## Ăn uống\n- ${cs.nearby_dining.join('\n- ')}` : '',
          cs.transport ? `## Di chuyển\n${typeof cs.transport === 'string' ? cs.transport : JSON.stringify(cs.transport)}` : '',
        ].filter(Boolean).join('\n');

        upsertWiki('location', `area-${districtSlug}`, `Khu vực ${profile.district}`, content, `location,${profile.district},${profile.city || ''}`);
        count++;
      }
    }

    // Auto-wiki: promotions (global aggregate)
    if (Array.isArray(cs.promotions) && cs.promotions.length) {
      const content = [
        `# Ưu đãi hiện tại — ${profile.name_canonical}`,
        '',
        ...cs.promotions.map((p: any) => {
          if (typeof p === 'string') return `- ${p}`;
          return `- **${p.title || 'Ưu đãi'}**: ${p.discount || ''} ${p.description || ''}${p.valid_until ? ` _(đến ${p.valid_until})_` : ''}`;
        }),
      ].join('\n');
      upsertWiki('promotions', `promo-hotel-${hotelId}`, `Ưu đãi ${profile.name_canonical}`, content, `promotion,deal,sale,${profile.district || ''}`);
      count++;
    }

    // Auto-wiki: policies per hotel (overrides global)
    if (Array.isArray(cs.house_rules) && cs.house_rules.length) {
      const content = [
        `# Quy định ${profile.name_canonical}`,
        '',
        ...cs.house_rules.map((r: string) => `- ${r}`),
      ].join('\n');
      upsertWiki('policies', `rules-hotel-${hotelId}`, `Quy định ${profile.name_canonical}`, content, `policy,rule,${profile.district || ''}`);
      count++;
    }

    // Auto-wiki: reviews summary
    if (cs.reviews_summary) {
      const content = [
        `# Đánh giá khách ${profile.name_canonical}`,
        '',
        cs.reviews_summary,
        Array.isArray(cs.testimonials) && cs.testimonials.length ? '\n## Testimonials\n' + cs.testimonials.map((t: any) => {
          if (typeof t === 'string') return `> ${t}`;
          return `> "${t.quote}" — ${t.name || 'Khách'}${t.stars ? ` ${'⭐'.repeat(t.stars)}` : ''}`;
        }).join('\n\n') : '',
      ].filter(Boolean).join('\n');
      upsertWiki('reviews', `reviews-hotel-${hotelId}`, `Đánh giá ${profile.name_canonical}`, content, `review,testimonial,${profile.district || ''}`);
      count++;
    }
  } catch (e: any) {
    console.warn(`[knowledge-sync] auto-wiki hotel ${hotelId} fail:`, e?.message);
  }

  return count;
}

function upsertWiki(namespace: string, slug: string, title: string, content: string, tags?: string): void {
  const now = Date.now();
  try {
    const existing = db.prepare(`SELECT id FROM knowledge_wiki WHERE namespace = ? AND slug = ?`).get(namespace, slug) as any;
    if (existing) {
      db.prepare(
        `UPDATE knowledge_wiki SET title = ?, content = ?, tags = ?, active = 1, updated_at = ? WHERE id = ?`
      ).run(title, content, tags || null, now, existing.id);
    } else {
      db.prepare(
        `INSERT INTO knowledge_wiki (namespace, slug, title, content, tags, active, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 1, ?, ?)`
      ).run(namespace, slug, title, content, tags || null, now, now);
    }
  } catch (e: any) {
    console.warn(`[knowledge-sync] upsertWiki fail:`, e?.message);
  }
}

/* ═══════════════════════════════════════════
   Query: semantic search across chunks
   ═══════════════════════════════════════════ */

import { decodeEmbedding, cosine } from './embedder';

export interface SemanticHit {
  hotel_id: number;
  hotel_name?: string;
  chunk_type: ChunkType;
  chunk_text: string;
  score: number;
}

/**
 * Semantic search: embed question + cosine với all chunks.
 * @param hotelIds — nếu truyền → chỉ search trong các hotels này; else all active
 */
export async function semanticSearch(
  query: string,
  opts: { hotelIds?: number[]; topK?: number; minScore?: number; chunkTypes?: ChunkType[] } = {},
): Promise<SemanticHit[]> {
  const topK = opts.topK || 5;
  const minScore = opts.minScore || 0.5;

  const queryVec = await embed(query);
  if (!queryVec) return [];

  let sql = `SELECT e.hotel_id, e.chunk_type, e.chunk_text, e.embedding, hp.name_canonical
             FROM hotel_knowledge_embeddings e
             LEFT JOIN hotel_profile hp ON hp.hotel_id = e.hotel_id`;
  const conditions: string[] = [];
  const params: any[] = [];
  if (opts.hotelIds?.length) {
    conditions.push(`e.hotel_id IN (${opts.hotelIds.map(() => '?').join(',')})`);
    params.push(...opts.hotelIds);
  } else {
    // Default: only active hotels
    conditions.push(`EXISTS (SELECT 1 FROM mkt_hotels mh WHERE mh.ota_hotel_id = e.hotel_id AND mh.status = 'active')`);
  }
  if (opts.chunkTypes?.length) {
    conditions.push(`e.chunk_type IN (${opts.chunkTypes.map(() => '?').join(',')})`);
    params.push(...opts.chunkTypes);
  }
  if (conditions.length) sql += ` WHERE ${conditions.join(' AND ')}`;

  const rows = db.prepare(sql).all(...params) as any[];

  const hits: SemanticHit[] = [];
  for (const row of rows) {
    try {
      const vec = decodeEmbedding(row.embedding);
      const score = cosine(queryVec, vec);
      if (score >= minScore) {
        hits.push({
          hotel_id: row.hotel_id,
          hotel_name: row.name_canonical,
          chunk_type: row.chunk_type,
          chunk_text: row.chunk_text,
          score,
        });
      }
    } catch {}
  }
  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, topK);
}

/* ═══════════════════════════════════════════
   Wiki (Tier 3) query
   ═══════════════════════════════════════════ */

export interface WikiResult {
  slug: string;
  namespace: string;
  title: string;
  content: string;
  tags?: string;
}

export function searchWiki(query: string, namespace?: string, limit = 3): WikiResult[] {
  try {
    let sql = `SELECT slug, namespace, title, content, tags FROM knowledge_wiki WHERE active = 1`;
    const params: any[] = [];
    if (namespace) { sql += ` AND namespace = ?`; params.push(namespace); }
    // Simple LIKE search — có thể upgrade FTS5 sau
    sql += ` AND (title LIKE ? OR content LIKE ? OR tags LIKE ?)`;
    const like = `%${query}%`;
    params.push(like, like, like);
    sql += ` LIMIT ?`;
    params.push(limit);
    return db.prepare(sql).all(...params) as any;
  } catch (e) {
    return [];
  }
}

/** Get all wiki entries in a namespace (admin view) */
export function getWikiByNamespace(namespace: string): WikiResult[] {
  try {
    return db.prepare(
      `SELECT slug, namespace, title, content, tags FROM knowledge_wiki WHERE namespace = ? AND active = 1`
    ).all(namespace) as any;
  } catch { return []; }
}

/* ═══════════════════════════════════════════
   Unified query — Tier 1 + 2 + 3 combined
   ═══════════════════════════════════════════ */

export interface UnifiedAnswer {
  tier: 'facts' | 'semantic' | 'wiki' | 'none';
  answer_snippets: string[];
  confidence: number;
  metadata?: any;
}

/**
 * Smart query resolver: auto pick tier based on query.
 * - Structured (price, availability, capacity) → Tier 1 SQL
 * - Semantic (descriptions, amenities vague) → Tier 2 RAG
 * - Meta (brand, policy global) → Tier 3 Wiki
 */
export async function unifiedQuery(
  query: string,
  hotelIds?: number[],
): Promise<UnifiedAnswer> {
  const q = query.toLowerCase();

  // Meta/wiki signals
  if (/\b(sonder là gì|giới thiệu|brand|thương hiệu|thanh toán|phương thức|chính sách chung|quy định)\b/i.test(q)) {
    const wikiHits = searchWiki(query);
    if (wikiHits.length) {
      return {
        tier: 'wiki',
        answer_snippets: wikiHits.map(h => `[${h.title}] ${h.content.slice(0, 300)}`),
        confidence: 0.8,
        metadata: { hits: wikiHits.length },
      };
    }
  }

  // Semantic
  const hits = await semanticSearch(query, { hotelIds, topK: 3, minScore: 0.4 });
  if (hits.length) {
    return {
      tier: 'semantic',
      answer_snippets: hits.map(h => `[${h.hotel_name || 'hotel-' + h.hotel_id}] ${h.chunk_text}`),
      confidence: hits[0].score,
      metadata: { top_score: hits[0].score, count: hits.length },
    };
  }

  return { tier: 'none', answer_snippets: [], confidence: 0 };
}

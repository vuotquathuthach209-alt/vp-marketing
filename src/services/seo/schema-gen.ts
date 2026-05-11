/**
 * Schema.org JSON-LD generator for hotel pages.
 *
 * Generates Hotel + LocalBusiness markup that Google understands for rich snippets:
 *   - star rating
 *   - price range
 *   - address + geo
 *   - amenities (list of LocationFeatureSpecification)
 *   - reviews (aggregate)
 *
 * Output: ready-to-embed <script type="application/ld+json"> JSON string.
 */

import { db } from '../../db';

interface HotelData {
  hotel_id: number;
  name: string;
  url?: string;
  city?: string;
  district?: string;
  address?: string;
  latitude?: number;
  longitude?: number;
  phone?: string;
  star_rating?: number;
  description?: string;
  price_min?: number;
  price_max?: number;
  amenities?: string[];
  review_avg?: number;
  review_count?: number;
  images?: string[];
}

/** Build Hotel schema JSON-LD for a single hotel row. */
export function generateHotelSchema(h: HotelData): object {
  const schema: any = {
    '@context': 'https://schema.org',
    '@type': 'Hotel',
    name: h.name,
    url: h.url || undefined,
    description: h.description || undefined,
    image: h.images && h.images.length > 0 ? h.images : undefined,
  };

  if (h.phone) schema.telephone = h.phone;

  if (h.address || h.city) {
    schema.address = {
      '@type': 'PostalAddress',
      streetAddress: h.address || undefined,
      addressLocality: h.district || undefined,
      addressRegion: h.city || undefined,
      addressCountry: 'VN',
    };
  }

  if (typeof h.latitude === 'number' && typeof h.longitude === 'number') {
    schema.geo = {
      '@type': 'GeoCoordinates',
      latitude: h.latitude,
      longitude: h.longitude,
    };
  }

  if (h.star_rating && h.star_rating > 0) {
    schema.starRating = { '@type': 'Rating', ratingValue: h.star_rating };
  }

  if (h.price_min && h.price_max) {
    // Format as VND price range
    schema.priceRange = `${h.price_min.toLocaleString('vi-VN')} - ${h.price_max.toLocaleString('vi-VN')} VND`;
  }

  if (h.amenities && h.amenities.length > 0) {
    schema.amenityFeature = h.amenities.map((a) => ({
      '@type': 'LocationFeatureSpecification',
      name: a,
      value: true,
    }));
  }

  if (h.review_avg && h.review_count) {
    schema.aggregateRating = {
      '@type': 'AggregateRating',
      ratingValue: h.review_avg,
      reviewCount: h.review_count,
      bestRating: 5,
      worstRating: 1,
    };
  }

  return schema;
}

/** Build LocalBusiness schema (slightly different, complements Hotel for local SEO). */
export function generateLocalBusinessSchema(h: HotelData): object {
  return {
    '@context': 'https://schema.org',
    '@type': 'LodgingBusiness',
    name: h.name,
    url: h.url || undefined,
    telephone: h.phone || undefined,
    address: h.address
      ? {
          '@type': 'PostalAddress',
          streetAddress: h.address,
          addressLocality: h.district || undefined,
          addressRegion: h.city || undefined,
          addressCountry: 'VN',
        }
      : undefined,
    geo: typeof h.latitude === 'number' && typeof h.longitude === 'number'
      ? {
          '@type': 'GeoCoordinates',
          latitude: h.latitude,
          longitude: h.longitude,
        }
      : undefined,
    image: h.images && h.images.length > 0 ? h.images[0] : undefined,
    priceRange: h.price_min && h.price_max
      ? `${h.price_min.toLocaleString('vi-VN')} - ${h.price_max.toLocaleString('vi-VN')} VND`
      : undefined,
  };
}

/** Strip undefined values recursively (cleaner output). */
function clean(obj: any): any {
  if (Array.isArray(obj)) return obj.map(clean).filter((x) => x !== undefined);
  if (obj && typeof obj === 'object') {
    const out: any = {};
    for (const [k, v] of Object.entries(obj)) {
      const c = clean(v);
      if (c !== undefined && c !== null && !(Array.isArray(c) && c.length === 0)) out[k] = c;
    }
    return out;
  }
  return obj;
}

/** Generate + persist schemas for all hotels in DB. */
export function generateAllHotelSchemas(opts?: { baseUrl?: string }): {
  generated: number;
  skipped: number;
  errors: string[];
} {
  const result = { generated: 0, skipped: 0, errors: [] as string[] };
  const baseUrl = (opts?.baseUrl || 'https://sondervn.com').replace(/\/+$/, '');

  // Pull hotels from hotel_profile + hotel_amenities + hotel_reviews
  const hotels = db.prepare(
    `SELECT hotel_id, name_canonical AS name, city, district, address,
            latitude, longitude, phone, star_rating, ai_summary_vi AS description,
            monthly_price_from, monthly_price_to, ota_hotel_id
     FROM hotel_profile`,
  ).all() as any[];

  for (const h of hotels) {
    if (!h.name) {
      result.skipped++;
      continue;
    }
    try {
      // Pull amenities
      const amenities = (db.prepare(
        `SELECT amenity_name FROM hotel_amenities WHERE hotel_id = ? LIMIT 30`,
      ).all(h.hotel_id) as any[]).map((a) => a.amenity_name).filter(Boolean);

      // Pull review stats
      const rev = db.prepare(
        `SELECT AVG(rating) AS avg, COUNT(*) AS n FROM hotel_reviews WHERE hotel_id = ?`,
      ).get(h.hotel_id) as { avg: number | null; n: number } | undefined;

      const data: HotelData = {
        hotel_id: h.hotel_id,
        name: h.name,
        url: h.ota_hotel_id ? `${baseUrl}/khach-san/${h.ota_hotel_id}` : undefined,
        city: h.city || undefined,
        district: h.district || undefined,
        address: h.address || undefined,
        latitude: typeof h.latitude === 'number' ? h.latitude : undefined,
        longitude: typeof h.longitude === 'number' ? h.longitude : undefined,
        phone: h.phone || undefined,
        star_rating: typeof h.star_rating === 'number' && h.star_rating > 0 ? h.star_rating : undefined,
        description: h.description || undefined,
        price_min: h.monthly_price_from || undefined,
        price_max: h.monthly_price_to || undefined,
        amenities: amenities.length > 0 ? amenities : undefined,
        review_avg: rev?.avg || undefined,
        review_count: rev?.n || undefined,
      };

      const hotelSchema = clean(generateHotelSchema(data));
      const lbSchema = clean(generateLocalBusinessSchema(data));

      const now = Date.now();
      // Upsert (one Hotel + one LodgingBusiness per hotel)
      db.prepare(`DELETE FROM seo_schemas WHERE hotel_id = ?`).run(h.hotel_id);
      db.prepare(
        `INSERT INTO seo_schemas (hotel_id, schema_type, schema_json, applied_to_url, generated_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(h.hotel_id, 'Hotel', JSON.stringify(hotelSchema, null, 2), data.url || null, now);
      db.prepare(
        `INSERT INTO seo_schemas (hotel_id, schema_type, schema_json, applied_to_url, generated_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(h.hotel_id, 'LodgingBusiness', JSON.stringify(lbSchema, null, 2), data.url || null, now);
      result.generated++;
    } catch (e: any) {
      result.errors.push(`hotel #${h.hotel_id}: ${e?.message}`);
    }
  }

  return result;
}

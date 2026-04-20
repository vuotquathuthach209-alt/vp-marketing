/**
 * Sonder Web SSR Scraper — nguồn data chính xác nhất cho bot.
 *
 * Strategy: Web sondervn.com SSR render từ OTA DB với FULL fields.
 * API public /api/hotels chỉ có basic fields (minPrice) — không đủ.
 *
 * Scrape 2 pages:
 *   - /homestay → initialApartments (apartments thuê THÁNG)
 *     Fields: monthlyPriceFrom/To, minStayMonths, depositMonths,
 *             utilitiesIncluded, fullKitchen, washingMachine, etc.
 *   - /khach-san → initialHotels (hotels + homestays thuê ĐÊM)
 *     Fields: minPrice, checkIn/OutTime, lat, lng, etc.
 *
 * Web luôn phản ánh DB mới nhất (SSR).
 * Bot scrape scheduled + on-demand → always up-to-date.
 *
 * HTTP GET only → read-only contract maintained.
 */
import axios from 'axios';
import { OtaRawHotel } from './hotel-synthesizer';

const BASE_URL = 'https://sondervn.com';
const USER_AGENT = 'vp-marketing-scraper/1.0 (compat; etl)';

// Raw shape from /homestay initialApartments
export interface ScrapedApartment {
  id: string;
  name: string;
  slug: string;
  city: string;
  district: string;
  starRating: number;
  address?: string;
  lat?: number;
  lng?: number;
  amenities: string[];
  coverImage: string | null;
  images: string[];
  propertyType: string;  // 'apartment'

  // Monthly pricing fields (apartment-specific)
  monthlyPrice?: number;           // aggregate?
  monthlyPriceFrom?: number;
  monthlyPriceTo?: number;
  minStayMonths?: number;
  depositMonths?: number;
  depositText?: string;
  utilitiesIncluded?: boolean;
  fullKitchen?: boolean;
  washingMachine?: boolean;
  acceptsSonderEscrow?: boolean;
}

// Raw shape from /khach-san initialHotels
export interface ScrapedHotel {
  id: string;
  name: string;
  slug: string;
  city: string;
  district: string;
  starRating: number;
  amenities: string[];
  coverImage: string | null;
  images: string[] | null;
  checkInTime?: string;
  checkOutTime?: string;
  propertyType: string;  // 'hotel' | 'homestay' | 'resort' | 'villa'
  address?: string;
  lat?: number;
  lng?: number;
  minPrice?: string;        // nightly
  isVerified?: boolean;
  selfCheckinEnabled?: boolean;
}

async function fetchHtml(path: string): Promise<string> {
  const resp = await axios.get(BASE_URL + path, {
    timeout: 25000,
    headers: { 'User-Agent': USER_AGENT, 'Accept': 'text/html' },
    httpsAgent: new (require('https').Agent)({ rejectUnauthorized: false }),
  });
  return String(resp.data);
}

/**
 * Extract escaped JSON array from Next.js SSR payload.
 * Handle \\" escape level in RSC push().
 */
function extractJsonArray(html: string, key: string): any[] | null {
  const idx = html.indexOf(key);
  if (idx < 0) return null;

  // After key, find opening [ (possibly preceded by :\")
  let start = html.indexOf('[', idx);
  if (start < 0) return null;

  // Count bracket depth, respecting escaped quotes
  let depth = 0;
  let inString = false;
  let escape = false;
  let end = -1;

  for (let i = start; i < html.length; i++) {
    const ch = html[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\') { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '[') depth++;
    else if (ch === ']') {
      depth--;
      if (depth === 0) { end = i; break; }
    }
  }
  if (end < 0) return null;

  // Raw escaped string
  let raw = html.slice(start, end + 1);

  // Progressively unescape: \\\" → \" → "
  // The payload comes through multiple JSON encoding layers.
  let attempts = 0;
  while (attempts < 4 && raw.includes('\\"')) {
    try {
      return JSON.parse(raw);
    } catch {
      // Unescape one level
      raw = raw.replace(/\\\\/g, '__SLASHSLASH__')
               .replace(/\\"/g, '"')
               .replace(/__SLASHSLASH__/g, '\\');
      attempts++;
    }
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

// Pagination config
const MAX_PAGES = 50;              // safety cap: 50 pages × 20/page = 1000 hotels
const RATE_LIMIT_MS = 1000;        // 1 request/second
const DEFAULT_PER_PAGE = 20;

async function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * Scrape paginated list. Next.js SSR sẽ trả khác nhau cho mỗi page
 * khi có nhiều hotels (> 1 page).
 *
 * Strategy: scrape page=1, check có pagination không, loop đến page cuối.
 * Deduplicate theo ID phòng khi page=N trả cùng data (1-hotel edge case).
 */
async function scrapePaginated<T extends { id: string }>(
  pathBase: string,
  jsonKey: string,
  onPage?: (page: number, items: T[]) => void,
): Promise<T[]> {
  const seenIds = new Set<string>();
  const all: T[] = [];

  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = `${pathBase}?page=${page}`;
    let items: T[] = [];
    try {
      const html = await fetchHtml(url);
      const arr = extractJsonArray(html, jsonKey) as T[] | null;
      items = arr || [];
    } catch (e: any) {
      console.warn(`[scraper] page ${page} ${pathBase} fail:`, e?.message);
      break;
    }

    // Deduplicate by ID
    let newCount = 0;
    for (const item of items) {
      if (item.id && !seenIds.has(String(item.id))) {
        seenIds.add(String(item.id));
        all.push(item);
        newCount++;
      }
    }

    if (onPage) onPage(page, items);

    // Stop conditions:
    // - Page trả empty array
    // - Page trả data nhưng KHÔNG có ID mới (chỉ duplicate)
    //   → nghĩa là web không thực sự paginate hoặc đã hết
    if (items.length === 0 || newCount === 0) {
      break;
    }

    // Rate limit
    if (page < MAX_PAGES) await sleep(RATE_LIMIT_MS);
  }

  return all;
}

export async function scrapeApartments(): Promise<ScrapedApartment[]> {
  return scrapePaginated<ScrapedApartment>('/homestay', 'initialApartments',
    (p, items) => console.log(`[scraper] /homestay page ${p}: ${items.length} apartments`));
}

export async function scrapeHotels(): Promise<ScrapedHotel[]> {
  return scrapePaginated<ScrapedHotel>('/khach-san', 'initialHotels',
    (p, items) => console.log(`[scraper] /khach-san page ${p}: ${items.length} hotels`));
}

/** Combined scrape — merge both into OtaRawHotel format for synthesizer */
export async function scrapeAllHotels(): Promise<OtaRawHotel[]> {
  const [apartments, hotels] = await Promise.all([
    scrapeApartments().catch(e => { console.warn('[scraper] apt fail:', e?.message); return []; }),
    scrapeHotels().catch(e => { console.warn('[scraper] hotel fail:', e?.message); return []; }),
  ]);

  const result: OtaRawHotel[] = [];

  for (const a of apartments) {
    // Build included services for apartment
    const services: string[] = [];
    if (a.fullKitchen) services.push('Bếp đầy đủ');
    if (a.washingMachine) services.push('Máy giặt riêng');
    if (a.utilitiesIncluded) services.push('Điện nước bao trọn');
    if (a.amenities?.includes('wifi')) services.push('Wifi');

    // Apartment listing không expose address → không gán fallback
    // (để bot hiển thị chỉ district + city, tránh lặp)
    const address = a.address && a.address !== 'undefined' ? a.address : undefined;

    result.push({
      id: a.id,
      name: a.name,
      slug: a.slug,
      city: a.city,
      district: a.district,
      address,
      latitude: a.lat,
      longitude: a.lng,
      star_rating: a.starRating,
      amenities: a.amenities,
      property_type: 'apartment',
      // Custom structured fields scraper output
      description: `Căn hộ dịch vụ cho thuê theo tháng. ${services.length > 0 ? 'Bao gồm: ' + services.join(', ') : ''}. Giá từ ${a.monthlyPriceFrom?.toLocaleString('vi-VN') || '?'}đ đến ${a.monthlyPriceTo?.toLocaleString('vi-VN') || '?'}đ/tháng, thuê tối thiểu ${a.minStayMonths || '?'} tháng, cọc ${a.depositMonths || '?'} tháng.`,
      // Attach pricing info vào rooms[] để synthesizer không mất info
      rooms: [
        {
          id: `${a.id}_monthly`,
          name: `Phòng thuê tháng ${a.name}`,
          price: a.monthlyPriceFrom || 0,
          price_weekend: a.monthlyPriceTo || a.monthlyPriceFrom || 0,
          max_guests: 2,
        },
      ],
      // Custom scraped fields
      _scraped: {
        product_group: 'long_term_apartment',
        monthly_price_from: a.monthlyPriceFrom,
        monthly_price_to: a.monthlyPriceTo,
        min_stay_months: a.minStayMonths,
        deposit_months: a.depositMonths,
        deposit_text: a.depositText,
        utilities_included: a.utilitiesIncluded,
        full_kitchen: a.fullKitchen,
        washing_machine: a.washingMachine,
        accepts_sonder_escrow: a.acceptsSonderEscrow,
        included_services: services,
      },
    } as any);
  }

  for (const h of hotels) {
    const minPrice = h.minPrice ? parseInt(String(h.minPrice), 10) : 0;
    result.push({
      id: h.id,
      name: h.name,
      slug: h.slug,
      city: h.city,
      district: h.district,
      address: h.address,
      latitude: h.lat,
      longitude: h.lng,
      star_rating: h.starRating,
      amenities: h.amenities,
      property_type: h.propertyType,
      description: `${h.propertyType === 'homestay' ? 'Homestay' : h.propertyType === 'hotel' ? 'Khách sạn' : 'Cơ sở lưu trú'} thuê theo đêm. Giá từ ${minPrice ? minPrice.toLocaleString('vi-VN') + 'đ/đêm' : 'liên hệ'}. Check-in ${h.checkInTime || '14:00'}, check-out ${h.checkOutTime || '12:00'}.`,
      rooms: [
        {
          id: `${h.id}_nightly`,
          name: `Phòng ${h.name}`,
          price: minPrice,
          max_guests: 2,
        },
      ],
      _scraped: {
        product_group: 'short_stay',
        daily_price: minPrice,
        checkin_time: h.checkInTime,
        checkout_time: h.checkOutTime,
        self_checkin: h.selfCheckinEnabled,
      },
    } as any);
  }

  return result;
}

/** Heath check */
export async function healthCheck(): Promise<{ ok: boolean; apartments: number; hotels: number; error?: string }> {
  try {
    const [aps, hts] = await Promise.all([scrapeApartments(), scrapeHotels()]);
    return { ok: true, apartments: aps.length, hotels: hts.length };
  } catch (e: any) {
    return { ok: false, apartments: 0, hotels: 0, error: e?.message };
  }
}

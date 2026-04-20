/**
 * OTA API Client — fetch hotel data qua public HTTP API.
 *
 * Endpoint: https://103.153.73.97/api/hotels
 * Method:   GET only (read-only by HTTP design)
 *
 * HỢP ĐỒNG CỨNG: CHỈ GỌI GET. Không POST/PUT/PATCH/DELETE.
 * Guard ở runtime chặn mọi request không phải GET.
 */
import axios, { AxiosRequestConfig } from 'axios';
import { trackEvent } from './events';
import { OtaRawHotel } from './hotel-synthesizer';

// Default OTA base URL — có thể override qua settings
const DEFAULT_OTA_BASE = process.env.OTA_API_BASE || 'https://103.153.73.97';

// Cho phép self-signed cert (OTA dùng IP, cert có thể không match)
const axiosClient = axios.create({
  timeout: 20000,
  httpsAgent: new (require('https').Agent)({ rejectUnauthorized: false }),
  headers: {
    'User-Agent': 'vp-marketing-etl/1.0',
    'Accept': 'application/json',
  },
});

export interface OtaApiHotel {
  id: string;
  name: string;
  slug: string;
  city: string;
  district: string;
  address: string;
  starRating: number;
  amenities: string[];
  coverImage: string | null;
  images: string[] | null;
  checkInTime: string;
  checkOutTime: string;
  propertyType: string;
  selfCheckinEnabled: boolean;
  isVerified: boolean;
  isFeatured: boolean;
  minPrice: string;
  reviewAvg: number | null;
  reviewCount: number;
  latitude?: number;
  longitude?: number;
  phone?: string;
  description?: string;
  rooms?: any[];
}

/**
 * Guard: chỉ cho phép HTTP GET.
 */
function assertReadOnlyHttp(method: string): void {
  if (method.toUpperCase() !== 'GET') {
    throw new Error(`[OTA API Guard] HTTP ${method} blocked — chỉ GET được phép`);
  }
}

async function guardedGet<T>(path: string, params?: Record<string, any>): Promise<T> {
  assertReadOnlyHttp('GET');
  const base = (globalThis as any).__OTA_BASE || DEFAULT_OTA_BASE;
  const url = `${base}${path}`;
  const t0 = Date.now();
  try {
    const cfg: AxiosRequestConfig = { params };
    const resp = await axiosClient.get<T>(url, cfg);
    // Sample audit log (10%)
    if (Math.random() < 0.1) {
      try { trackEvent({ event: 'ota_api_ok', meta: { path, ms: Date.now() - t0, status: resp.status } }); } catch {}
    }
    return resp.data;
  } catch (e: any) {
    try {
      trackEvent({
        event: 'ota_api_error',
        meta: { path, ms: Date.now() - t0, status: e?.response?.status, error: e?.message },
      });
    } catch {}
    throw e;
  }
}

/**
 * List hotels với pagination.
 */
export async function listHotels(opts: { page?: number; limit?: number } = {}): Promise<{
  hotels: OtaApiHotel[];
  pagination: { page: number; limit: number; total: number; totalPages: number };
}> {
  const params = {
    page: opts.page || 1,
    limit: Math.min(50, opts.limit || 50),
  };
  const resp = await guardedGet<{ success: boolean; data: OtaApiHotel[]; pagination: any }>(
    '/api/hotels',
    params,
  );
  if (!resp.success) throw new Error('OTA API returned success=false');
  return { hotels: resp.data || [], pagination: resp.pagination };
}

/**
 * Get single hotel by ID hoặc slug.
 */
export async function getHotelBySlug(slug: string): Promise<OtaApiHotel | null> {
  const r = await guardedGet<{ success: boolean; data: OtaApiHotel[] }>(
    '/api/hotels',
    { slug },
  );
  return r.data?.[0] || null;
}

/**
 * Fetch ALL hotels across pages.
 */
export async function listAllHotels(opts: { maxPages?: number; perPage?: number } = {}): Promise<OtaApiHotel[]> {
  const perPage = opts.perPage || 50;
  const maxPages = opts.maxPages || 100; // an toàn, tránh loop vô hạn
  const all: OtaApiHotel[] = [];
  let page = 1;
  while (page <= maxPages) {
    const { hotels, pagination } = await listHotels({ page, limit: perPage });
    all.push(...hotels);
    if (page >= pagination.totalPages) break;
    page++;
  }
  return all;
}

/**
 * Convert OtaApiHotel → OtaRawHotel (format cho synthesizer).
 */
export function toOtaRawHotel(h: OtaApiHotel): OtaRawHotel {
  return {
    id: h.id,
    name: h.name,
    address: h.address,
    city: h.city,
    district: h.district,
    latitude: h.latitude,
    longitude: h.longitude,
    phone: h.phone,
    star_rating: h.starRating,
    description: h.description,
    amenities: h.amenities,
    property_type: h.propertyType,
    rooms: (h.rooms && Array.isArray(h.rooms))
      ? h.rooms.map((r: any) => ({
          id: r.id,
          name: r.name || r.roomTypeName,
          price: parseInt(r.price || r.basePrice || h.minPrice || '0', 10),
          price_hourly: r.hourlyPrice ? parseInt(r.hourlyPrice, 10) : undefined,
          max_guests: r.maxGuests || 2,
          bed_type: r.bedType,
        }))
      : [
          // Fallback: tạo 1 "default room" từ minPrice nếu API không expose rooms detail
          {
            id: `${h.id}_default`,
            name: h.propertyType === 'apartment' ? 'Phòng tiêu chuẩn' : 'Phòng cơ bản',
            price: parseInt(h.minPrice || '0', 10),
            max_guests: 2,
          },
        ],
  };
}

/**
 * Heath check — test connection to OTA API.
 */
export async function checkOtaApi(): Promise<{ ok: boolean; hotels_total: number; error?: string }> {
  try {
    const { pagination } = await listHotels({ page: 1, limit: 1 });
    return { ok: true, hotels_total: pagination.total };
  } catch (e: any) {
    return { ok: false, hotels_total: 0, error: e?.message };
  }
}

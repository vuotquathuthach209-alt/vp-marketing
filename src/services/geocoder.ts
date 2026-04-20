/**
 * Geocoder — OSM Nominatim free API
 *
 * Input: address string (vd "B12 Bạch Đằng, Tân Bình, HCM")
 * Output: { lat, lon, geohash, display_name }
 *
 * Free tier: 1 request/second per IP.
 * Cache kết quả vào hotel_profile — không geocode lại nếu đã có lat/lon.
 */
import axios from 'axios';

const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
const USER_AGENT = 'vp-marketing-etl/1.0 (admin@sondervn.com)';
const RATE_LIMIT_MS = 1100;

let lastCall = 0;

export interface GeocodeResult {
  latitude: number;
  longitude: number;
  display_name: string;
  geohash?: string;
  confidence: number;
}

export function geohashEncode(lat: number, lon: number, precision = 6): string {
  const BASE32 = '0123456789bcdefghjkmnpqrstuvwxyz';
  let latRange = [-90, 90], lonRange = [-180, 180];
  let hash = '', bits = 0, bit = 0, even = true;
  while (hash.length < precision) {
    const value = even ? lon : lat;
    const range = even ? lonRange : latRange;
    const mid = (range[0] + range[1]) / 2;
    if (value >= mid) { bits = (bits << 1) | 1; range[0] = mid; }
    else { bits = (bits << 1); range[1] = mid; }
    even = !even;
    if (++bit === 5) {
      hash += BASE32[bits];
      bits = 0; bit = 0;
    }
  }
  return hash;
}

/** Haversine distance (km) giữa 2 điểm */
export function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/** Pace requests ≥ 1s apart */
async function paceThrottle(): Promise<void> {
  const now = Date.now();
  const elapsed = now - lastCall;
  if (elapsed < RATE_LIMIT_MS) {
    await new Promise(r => setTimeout(r, RATE_LIMIT_MS - elapsed));
  }
  lastCall = Date.now();
}

export async function geocode(address: string): Promise<GeocodeResult | null> {
  if (!address || address.trim().length < 5) return null;
  await paceThrottle();

  try {
    const resp = await axios.get(NOMINATIM_URL, {
      params: {
        q: address,
        format: 'json',
        addressdetails: 1,
        limit: 1,
        countrycodes: 'vn', // ưu tiên VN
      },
      headers: { 'User-Agent': USER_AGENT },
      timeout: 15000,
    });
    const arr = resp.data;
    if (!Array.isArray(arr) || arr.length === 0) return null;
    const r = arr[0];
    const lat = parseFloat(r.lat);
    const lon = parseFloat(r.lon);
    if (isNaN(lat) || isNaN(lon)) return null;
    return {
      latitude: lat,
      longitude: lon,
      display_name: r.display_name || address,
      geohash: geohashEncode(lat, lon, 6),
      confidence: parseFloat(r.importance || '0.5'),
    };
  } catch (e: any) {
    console.warn('[geocoder] fail:', e?.message);
    return null;
  }
}

/** Common VN landmarks with known coordinates (instant lookup, no API call) */
export const LANDMARKS_VN: Record<string, { lat: number; lon: number; city: string }> = {
  // Sân bay
  'sân bay tân sơn nhất': { lat: 10.818, lon: 106.652, city: 'HCM' },
  'sân bay tsn': { lat: 10.818, lon: 106.652, city: 'HCM' },
  'sân bay nội bài': { lat: 21.222, lon: 105.806, city: 'Hà Nội' },
  'sân bay đà nẵng': { lat: 16.054, lon: 108.202, city: 'Đà Nẵng' },
  'sân bay cam ranh': { lat: 11.998, lon: 109.219, city: 'Nha Trang' },
  // Trung tâm
  'quận 1': { lat: 10.774, lon: 106.700, city: 'HCM' },
  'q1': { lat: 10.774, lon: 106.700, city: 'HCM' },
  'bến thành': { lat: 10.772, lon: 106.698, city: 'HCM' },
  'bùi viện': { lat: 10.767, lon: 106.692, city: 'HCM' },
  'hồ gươm': { lat: 21.029, lon: 105.852, city: 'Hà Nội' },
  'hoàn kiếm': { lat: 21.029, lon: 105.852, city: 'Hà Nội' },
  'phố cổ': { lat: 21.033, lon: 105.850, city: 'Hà Nội' },
  'mỹ khê': { lat: 16.055, lon: 108.244, city: 'Đà Nẵng' },
  'sơn trà': { lat: 16.100, lon: 108.292, city: 'Đà Nẵng' },
  'bãi trước': { lat: 10.342, lon: 107.085, city: 'Vũng Tàu' },
  'đồi dương': { lat: 10.934, lon: 108.110, city: 'Phan Thiết' },
  // Khu du lịch
  'phú quốc': { lat: 10.289, lon: 103.984, city: 'Phú Quốc' },
  'nha trang': { lat: 12.248, lon: 109.195, city: 'Nha Trang' },
  'hội an': { lat: 15.880, lon: 108.338, city: 'Hội An' },
  'đà lạt': { lat: 11.940, lon: 108.458, city: 'Đà Lạt' },
  'sapa': { lat: 22.337, lon: 103.843, city: 'Sapa' },
  'ha long': { lat: 20.950, lon: 107.079, city: 'Hạ Long' },
};

export function findLandmark(text: string): { lat: number; lon: number; city: string; landmark: string } | null {
  const lower = text.toLowerCase();
  for (const [key, coord] of Object.entries(LANDMARKS_VN)) {
    if (lower.includes(key)) {
      return { ...coord, landmark: key };
    }
  }
  return null;
}

/**
 * Hotel Recommender — bot gợi ý khách sạn đa-hotel theo vị trí/ngân sách.
 *
 * Dùng khi intent router phát hiện:
 *   - "khách sạn gần X" (landmark hoặc địa danh)
 *   - "phòng dưới Yk ở Z"
 *   - user không đặt cho 1 hotel cụ thể mà hỏi chung
 *
 * Pipeline:
 *   1. Extract location từ message (landmark dictionary + keywords)
 *   2. Search knowledge base (nearby hoặc byArea)
 *   3. Format top-3 hotels thành câu trả lời tự nhiên VN
 *   4. Nếu không match → fallback RAG
 */
import { searchNearby, searchByArea, countHotels, HotelSearchResult } from './hotel-knowledge';
import { db } from '../db';
import { findLandmark } from './geocoder';
import { RouterSlots } from './intent-router';

const VN_CITY_KEYWORDS: Record<string, string> = {
  'sài gòn': 'HCM', 'tp.hcm': 'HCM', 'tphcm': 'HCM', 'hồ chí minh': 'HCM', 'hcm': 'HCM',
  'hà nội': 'Hanoi', 'hanoi': 'Hanoi', 'hn': 'Hanoi',
  'đà nẵng': 'Da Nang', 'da nang': 'Da Nang', 'dnag': 'Da Nang',
  'nha trang': 'Nha Trang', 'phú quốc': 'Phu Quoc', 'đà lạt': 'Da Lat',
  'hội an': 'Hoi An', 'vũng tàu': 'Vung Tau', 'sapa': 'Sapa',
  'hạ long': 'Ha Long', 'phan thiết': 'Phan Thiet',
};

const PROPERTY_TYPE_KEYWORDS: Record<string, string> = {
  'homestay': 'homestay',
  'home stay': 'homestay',
  'nhà dân': 'homestay',
  'căn hộ': 'apartment',
  'can ho': 'apartment',
  'apartment': 'apartment',
  'service apartment': 'apartment',
  'khách sạn': 'hotel',
  'khach san': 'hotel',
  'hotel': 'hotel',
  'resort': 'resort',
  'villa': 'villa',
  'biệt thự': 'villa',
  'nhà nghỉ': 'guesthouse',
  'guesthouse': 'guesthouse',
  'hostel': 'hostel',
};

const PROPERTY_TYPE_VI: Record<string, string> = {
  apartment: 'Căn hộ dịch vụ',
  homestay: 'Homestay',
  hotel: 'Khách sạn',
  resort: 'Resort',
  villa: 'Villa',
  guesthouse: 'Nhà nghỉ',
  hostel: 'Hostel',
};

const DISTRICT_KEYWORDS = [
  'quận 1', 'q1', 'quận 3', 'q3', 'quận 5', 'q5', 'quận 7', 'q7',
  'bình thạnh', 'tân bình', 'gò vấp', 'phú nhuận', 'thủ đức',
  'hoàn kiếm', 'ba đình', 'đống đa', 'cầu giấy', 'tây hồ',
  'hải châu', 'sơn trà', 'ngũ hành sơn',
];

function extractCity(msg: string): string | null {
  const lower = msg.toLowerCase();
  for (const [kw, city] of Object.entries(VN_CITY_KEYWORDS)) {
    if (lower.includes(kw)) return city;
  }
  return null;
}

function extractDistrict(msg: string): string | null {
  const lower = msg.toLowerCase();
  for (const d of DISTRICT_KEYWORDS) {
    if (lower.includes(d)) return d;
  }
  return null;
}

function extractPropertyType(msg: string): string | null {
  const lower = msg.toLowerCase();
  // Ưu tiên keyword dài trước (vd "căn hộ" trước "hộ")
  const sorted = Object.entries(PROPERTY_TYPE_KEYWORDS).sort((a, b) => b[0].length - a[0].length);
  for (const [kw, type] of sorted) {
    if (lower.includes(kw)) return type;
  }
  return null;
}

function formatPrice(n: number): string {
  if (!n) return 'giá liên hệ';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'tr';
  if (n >= 1_000) return (n / 1_000).toFixed(0) + 'k';
  return n.toString();
}

function formatStar(n: number | null): string {
  if (!n || n < 1) return '';
  return ' ' + '⭐'.repeat(Math.min(5, Math.round(n)));
}

export interface RecommendContext {
  message: string;
  slots: RouterSlots;
  historyTail: string[];
}

export interface RecommendResult {
  type: 'recommended' | 'no_match' | 'no_knowledge';
  reply: string;
  hotels?: HotelSearchResult[];
  meta?: {
    search_type: 'nearby' | 'byArea' | 'fallback';
    city?: string;
    district?: string;
    landmark?: string;
    radius_km?: number;
    property_type?: string;
  };
}

/**
 * Main entry — tính câu gợi ý.
 * Trả null nếu không có tín hiệu location-search → để RAG xử lý bình thường.
 */
export function recommend(ctx: RecommendContext): RecommendResult | null {
  if (countHotels() === 0) return { type: 'no_knowledge', reply: '' };

  const msg = ctx.message;
  const landmark = findLandmark(msg);
  const city = extractCity(msg) || (landmark ? landmark.city : null);
  const district = extractDistrict(msg);
  const propertyType = extractPropertyType(msg);
  const priceLimit = ctx.slots.price_limit;
  const minGuests = ctx.slots.guests;

  let hotels: HotelSearchResult[] = [];
  let searchType: 'nearby' | 'byArea' | 'fallback' = 'fallback';

  // Strategy 1: nearby landmark
  if (landmark) {
    hotels = searchNearby({
      lat: landmark.lat,
      lon: landmark.lon,
      radius_km: 15,
      limit: 3,
      max_price: priceLimit,
      min_guests: minGuests,
      property_type: propertyType || undefined,
    });
    searchType = 'nearby';
  }

  // Strategy 2: by city/district
  if (hotels.length === 0 && (city || district)) {
    hotels = searchByArea({
      city: city || undefined,
      district: district || undefined,
      limit: 3,
      max_price: priceLimit,
      min_guests: minGuests,
      property_type: propertyType || undefined,
    });
    searchType = 'byArea';
  }

  // Strategy 3: property type only (user hỏi chung "có homestay nào không")
  if (hotels.length === 0 && propertyType) {
    hotels = searchByArea({
      property_type: propertyType,
      limit: 5,
      max_price: priceLimit,
      min_guests: minGuests,
    });
    searchType = 'byArea';
  }

  // Strategy 3b: Fallback broader — user hỏi "hotel" nhưng chỉ có homestay/villa (all nightly) → list them
  if (hotels.length === 0 && propertyType === 'hotel') {
    for (const similar of ['homestay', 'villa', 'guesthouse', 'resort']) {
      const found = searchByArea({
        property_type: similar,
        limit: 5,
        max_price: priceLimit,
        min_guests: minGuests,
      });
      hotels.push(...found);
    }
    hotels = hotels.slice(0, 5);
    searchType = 'byArea';
  }

  // No search signal → let RAG handle
  if (!landmark && !city && !district && !propertyType) return null;

  // Found match
  if (hotels.length > 0) {
    const lines = hotels.map((h, i) => {
      const loc = h.distance_km > 0
        ? `cách ${landmark?.landmark || 'điểm bạn hỏi'} ~${h.distance_km}km`
        : `${h.district ? h.district + ', ' : ''}${h.city}`;
      const price = h.min_price > 0 ? `từ ${formatPrice(h.min_price)}đ/đêm` : 'giá liên hệ';
      const star = formatStar(h.star_rating);
      const typeLabel = h.property_type ? `[${PROPERTY_TYPE_VI[h.property_type] || h.property_type}] ` : '';
      const usp = h.usp_top3[0] ? ` — ${h.usp_top3[0]}` : '';
      return `${i + 1}. ${typeLabel}🏨 **${h.name}**${star} (${loc}) — ${price}${usp}`;
    }).join('\n');

    const typeFilter = propertyType ? `${PROPERTY_TYPE_VI[propertyType]}` : 'lựa chọn';
    const intro = landmark
      ? `Dạ em tìm thấy ${hotels.length} ${typeFilter} gần ${landmark.landmark} ạ 😊`
      : propertyType
        ? `Dạ bên em có ${hotels.length} ${typeFilter}${district ? ' tại ' + district : city ? ' tại ' + city : ''} ạ`
        : `Dạ em có ${hotels.length} gợi ý tại ${district ? district + ', ' : ''}${city || 'khu vực bạn hỏi'} ạ`;

    const outro = hotels.length > 1
      ? '\n\nAnh/chị thấy hợp với option nào thì em tư vấn kỹ hơn nhé ạ.'
      : '\n\nAnh/chị có muốn biết thêm chi tiết không ạ?';

    return {
      type: 'recommended',
      reply: `${intro}\n\n${lines}${outro}`,
      hotels,
      meta: {
        search_type: searchType,
        city: city || undefined,
        district: district || undefined,
        landmark: landmark?.landmark,
        radius_km: landmark ? 15 : undefined,
      },
    };
  }

  // Found signal but no match → honest reply
  const typeLabel = propertyType ? PROPERTY_TYPE_VI[propertyType] : 'khách sạn';
  let reply = `Dạ em rất tiếc, hiện bên em chưa có ${typeLabel} nào`;
  if (landmark) reply += ` gần ${landmark.landmark}`;
  else if (district) reply += ` tại ${district}`;
  else if (city) reply += ` ở ${city}`;
  if (priceLimit) reply += ` trong tầm ${formatPrice(priceLimit)}đ`;
  reply += ` ạ 🙏\n\n`;

  // Gợi ý: nếu user hỏi type, đề xuất các type có sẵn
  if (propertyType) {
    const availableTypes = db.prepare(
      `SELECT DISTINCT property_type FROM hotel_profile WHERE property_type IS NOT NULL`
    ).all() as any[];
    const otherTypes = availableTypes
      .map(r => r.property_type)
      .filter(t => t !== propertyType)
      .map(t => PROPERTY_TYPE_VI[t] || t);
    if (otherTypes.length > 0) {
      reply += `Hiện bên em có các loại: ${otherTypes.join(', ')}. Anh/chị có muốn xem không ạ?`;
    } else {
      reply += `Anh/chị có muốn em gợi ý lựa chọn khác không ạ?`;
    }
  } else {
    reply += `Anh/chị có muốn em gợi ý các khu vực lân cận không ạ?`;
  }

  return { type: 'no_match', reply, meta: { search_type: searchType, city: city || undefined, district: district || undefined, landmark: landmark?.landmark, property_type: propertyType || undefined } };
}

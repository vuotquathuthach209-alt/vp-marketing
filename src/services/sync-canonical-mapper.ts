/**
 * Sync Canonical Mapper — OTA schema ↔ Bot MKT canonical schema.
 *
 * CRITICAL: đảm bảo hotel_id + location hierarchy + room detail được map đầy đủ
 *           để bot query được rich context khi tư vấn.
 *
 * Naming convention:
 *   OTA side:  hotel_id (INT), city, district, ward, address
 *   MKT side:  ota_hotel_id (FK), canonical_city, canonical_district, canonical_ward,
 *              landmarks_nearby (JSON), location_keywords (JSON for search)
 *
 * Mapper sẽ:
 *   1. Canonicalize location strings (lowercase, no diacritics cho search)
 *   2. Extract landmarks từ address text → landmarks_nearby
 *   3. Map room_type_id ↔ room_type_code (OTA dùng numeric, bot dùng slug)
 *   4. Preserve all raw fields trong `_raw_payload` để debug
 *
 * Usage:
 *   otaRow → toCanonicalHotel → INSERT hotel_profile
 *   canonicalHotel → toOtaPayload → POST OTA API
 */

export interface CanonicalLocation {
  city: string;                     // "Ho Chi Minh" / "Ha Noi"
  city_norm: string;                // "ho chi minh" (lowercase, no diacritics)
  district: string;                 // "Tân Bình" / "Quận 1"
  district_norm: string;            // "tan binh" / "q1"
  ward?: string;                    // "Phường 2"
  ward_norm?: string;
  address: string;                  // Full street address
  latitude?: number;
  longitude?: number;
  landmarks_nearby: string[];       // ["sân bay Tân Sơn Nhất", "bến xe Miền Đông"]
  location_keywords: string[];      // For bot search: ["sân bay", "tsn", "tan son nhat", "q.tb"]
}

export interface CanonicalHotel {
  ota_hotel_id: number;             // Primary key — stable across sync
  name_canonical: string;           // Normalized name: "Sonder Airport"
  name_variants: string[];          // ["Sonder Airport", "Sonder sân bay", "Sonder TSN"]
  property_type: 'hotel' | 'homestay' | 'villa' | 'apartment' | 'resort' | 'guesthouse' | 'hostel';
  rental_type: 'per_night' | 'per_hour' | 'per_month' | 'mixed';
  star_rating?: number;
  phone?: string;
  email?: string;
  check_in_time?: string;
  check_out_time?: string;
  location: CanonicalLocation;
  amenities: string[];              // ["wifi", "parking", "pool", "pet_allowed"]
  policies: {                       // Structured policies
    cancellation?: string;
    pet?: string;
    smoking?: string;
    deposit?: string;
  };
  cover_image_url?: string;
  images: string[];
  ai_summary_vi?: string;           // Bot-ready short summary
  usp_top3?: string[];              // Top 3 selling points
  min_price_per_night?: number;
  monthly_price_from?: number;
  sync_source: 'ota_api' | 'ota_db' | 'manual';
  synced_at: number;
  _raw_payload?: any;               // Keep raw for debugging
}

export interface CanonicalRoom {
  ota_hotel_id: number;
  room_type_id: number;             // OTA internal id
  room_type_code: string;           // Stable slug: "standard", "deluxe", "suite"
  display_name_vi: string;          // "Phòng Deluxe view thành phố"
  base_price?: number;              // VND/night
  hourly_price?: number;
  monthly_price?: number;
  max_guests: number;
  bed_config?: string;              // "1 king bed" / "2 twin"
  size_m2?: number;
  amenities: string[];
  images: string[];
  total_count: number;              // Tổng số phòng loại này
  synced_at: number;
}

export interface CanonicalBooking {
  ota_booking_id?: string;          // OTA PMS id (may be null nếu booking từ bot chưa push)
  mkt_booking_id?: number;          // Bot local id
  hotel_id: number;                 // = ota_hotel_id
  source: 'bot' | 'ota_direct' | 'booking_com' | 'agoda' | 'traveloka' | 'walk_in';
  channel_name?: string;            // Display name cho source
  room_type_code: string;
  checkin_date: string;             // ISO YYYY-MM-DD
  checkout_date: string;
  nights: number;
  guests_adults: number;
  guests_children?: number;
  total_price?: number;
  deposit_amount?: number;
  deposit_paid: boolean;
  guest_name?: string;
  guest_phone?: string;
  guest_email?: string;
  sender_id?: string;                // fb:xxx | zalo:xxx — cho bot context
  status: 'hold' | 'confirmed' | 'cancelled' | 'completed' | 'no_show';
  notes?: string;
  created_at: number;
  updated_at: number;
}

/* ═══════════════════════════════════════════
   LOCATION NORMALIZATION
   ═══════════════════════════════════════════ */

/**
 * Remove Vietnamese diacritics for search indexing.
 */
export function removeDiacritics(s: string): string {
  return (s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd').replace(/Đ/g, 'D')
    .toLowerCase();
}

const DISTRICT_ALIASES: Record<string, string[]> = {
  'tan binh': ['tan binh', 'tân bình', 'q tb', 'q.tb', 'qtb', 'quận tân bình'],
  'binh thanh': ['binh thanh', 'bình thạnh', 'q bt', 'q.bt', 'qbt', 'quận bình thạnh'],
  'q1': ['q1', 'q.1', 'quan 1', 'quận 1', 'district 1'],
  'q3': ['q3', 'q.3', 'quan 3', 'quận 3', 'district 3'],
  'q7': ['q7', 'q.7', 'quan 7', 'quận 7', 'district 7'],
  'go vap': ['go vap', 'gò vấp', 'q gv', 'quận gò vấp'],
  'phu nhuan': ['phu nhuan', 'phú nhuận', 'q pn'],
};

const LANDMARK_KEYWORDS: Record<string, string[]> = {
  'sân bay Tân Sơn Nhất': ['san bay tan son nhat', 'sân bay tsn', 'tsn', 'airport tsn', 'sân bay', 'san bay'],
  'bến xe Miền Đông': ['ben xe mien dong', 'bến xe miền đông', 'bxmd'],
  'chợ Bến Thành': ['cho ben thanh', 'chợ bến thành', 'ben thanh market'],
  'phố Tây Bùi Viện': ['bui vien', 'bùi viện', 'pho tay', 'phố tây'],
  'nhà thờ Đức Bà': ['nha tho duc ba', 'notre dame saigon'],
};

/**
 * Extract location keywords từ address + district để bot search.
 */
export function extractLocationKeywords(
  city?: string,
  district?: string,
  address?: string,
): { location_keywords: string[]; landmarks_nearby: string[] } {
  const text = [city, district, address].filter(Boolean).join(' ');
  const norm = removeDiacritics(text);

  const locationKeywords = new Set<string>();
  // Add district aliases
  for (const [canonical, aliases] of Object.entries(DISTRICT_ALIASES)) {
    if (aliases.some(a => norm.includes(removeDiacritics(a)))) {
      locationKeywords.add(canonical);
      aliases.forEach(a => locationKeywords.add(removeDiacritics(a)));
    }
  }

  const landmarks = new Set<string>();
  for (const [landmark, keywords] of Object.entries(LANDMARK_KEYWORDS)) {
    if (keywords.some(k => norm.includes(k))) {
      landmarks.add(landmark);
      // Add keywords to search index too
      keywords.forEach(k => locationKeywords.add(k));
    }
  }

  return {
    location_keywords: Array.from(locationKeywords),
    landmarks_nearby: Array.from(landmarks),
  };
}

/* ═══════════════════════════════════════════
   MAPPERS: OTA API → Canonical
   ═══════════════════════════════════════════ */

/**
 * Map OTA API response (OtaApiHotel) → CanonicalHotel.
 * Input shape: từ ota-api-client.ts listHotels() response.
 */
export function mapOtaApiToCanonical(ota: any): CanonicalHotel {
  const city = ota.city || 'Ho Chi Minh';
  const district = ota.district || '';
  const address = ota.address || '';

  const { location_keywords, landmarks_nearby } = extractLocationKeywords(city, district, address);

  // Detect property_type
  const type = (ota.propertyType || '').toLowerCase();
  const propertyType: CanonicalHotel['property_type'] =
    type.includes('apartment') || type.includes('chdv') ? 'apartment'
    : type.includes('villa') ? 'villa'
    : type.includes('homestay') ? 'homestay'
    : type.includes('resort') ? 'resort'
    : type.includes('guesthouse') ? 'guesthouse'
    : type.includes('hostel') ? 'hostel'
    : 'hotel';

  // Detect rental_type from fields
  const rentalType: CanonicalHotel['rental_type'] =
    propertyType === 'apartment' ? 'per_month'
    : ota.hourly_price ? 'per_hour'
    : 'per_night';

  return {
    ota_hotel_id: parseInt(String(ota.id), 10),
    name_canonical: ota.name,
    name_variants: buildNameVariants(ota.name),
    property_type: propertyType,
    rental_type: rentalType,
    star_rating: ota.starRating || undefined,
    phone: ota.phone || undefined,
    check_in_time: ota.checkInTime || undefined,
    check_out_time: ota.checkOutTime || undefined,
    location: {
      city,
      city_norm: removeDiacritics(city),
      district,
      district_norm: removeDiacritics(district),
      address,
      latitude: ota.latitude,
      longitude: ota.longitude,
      landmarks_nearby,
      location_keywords,
    },
    amenities: Array.isArray(ota.amenities) ? ota.amenities : [],
    policies: {},
    cover_image_url: ota.coverImage || undefined,
    images: Array.isArray(ota.images) ? ota.images : [],
    min_price_per_night: parseFloat(ota.minPrice) || undefined,
    sync_source: 'ota_api',
    synced_at: Date.now(),
    _raw_payload: ota,
  };
}

function buildNameVariants(name: string): string[] {
  if (!name) return [];
  const variants = new Set<string>();
  variants.add(name);
  variants.add(removeDiacritics(name));
  // Remove "Sonder", "Hotel", "Homestay" prefix/suffix to get bare name
  const bare = name.replace(/\b(Sonder|Hotel|Homestay|Villa|Resort)\b/gi, '').trim();
  if (bare && bare !== name) variants.add(bare);
  return Array.from(variants);
}

/**
 * Map OTA booking row (from MySQL OTA-WEB DB) → CanonicalBooking.
 */
export function mapOtaBookingToCanonical(row: any): CanonicalBooking {
  return {
    ota_booking_id: String(row.id || row.booking_code || ''),
    hotel_id: row.hotel_id,
    source: mapOtaChannelToSource(row.channel_name || row.source),
    channel_name: row.channel_name,
    room_type_code: row.room_type_code || slugify(row.room_type_name || 'standard'),
    checkin_date: row.checkin_date,
    checkout_date: row.checkout_date,
    nights: row.nights,
    guests_adults: row.guests || row.adults || 2,
    guests_children: row.children,
    total_price: row.total_price,
    deposit_amount: row.deposit_amount,
    deposit_paid: !!row.deposit_paid,
    guest_name: row.guest_name,
    guest_phone: row.guest_phone,
    guest_email: row.guest_email,
    status: mapOtaStatus(row.booking_status || row.status),
    notes: row.notes,
    created_at: row.created_at ? new Date(row.created_at).getTime() : Date.now(),
    updated_at: row.updated_at ? new Date(row.updated_at).getTime() : Date.now(),
  };
}

function mapOtaChannelToSource(channel?: string): CanonicalBooking['source'] {
  const c = (channel || '').toLowerCase();
  if (c.includes('booking')) return 'booking_com';
  if (c.includes('agoda')) return 'agoda';
  if (c.includes('traveloka')) return 'traveloka';
  if (c.includes('walk')) return 'walk_in';
  if (c.includes('bot') || c.includes('chat')) return 'bot';
  return 'ota_direct';
}

function mapOtaStatus(status?: string): CanonicalBooking['status'] {
  const s = (status || '').toLowerCase();
  if (s.includes('confirm')) return 'confirmed';
  if (s.includes('cancel')) return 'cancelled';
  if (s.includes('complete') || s.includes('done') || s.includes('checked')) return 'completed';
  if (s.includes('no_show')) return 'no_show';
  if (s.includes('hold') || s.includes('pending')) return 'hold';
  return 'confirmed';
}

function slugify(s: string): string {
  return removeDiacritics(s).replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

/* ═══════════════════════════════════════════
   MAPPER: Canonical → OTA API payload (for outbox push)
   ═══════════════════════════════════════════ */

/**
 * Convert bot booking → OTA API body.
 * Used by outbox worker when pushing push_booking op.
 */
export function mapCanonicalBookingToOtaPayload(booking: CanonicalBooking): any {
  return {
    hotel_id: booking.hotel_id,
    room_type_code: booking.room_type_code,
    checkin_date: booking.checkin_date,
    checkout_date: booking.checkout_date,
    nights: booking.nights,
    guests: booking.guests_adults + (booking.guests_children || 0),
    guests_adults: booking.guests_adults,
    guests_children: booking.guests_children,
    total_price: booking.total_price,
    deposit_amount: booking.deposit_amount,
    deposit_paid: booking.deposit_paid,
    guest_name: booking.guest_name,
    guest_phone: booking.guest_phone,
    guest_email: booking.guest_email,
    source: booking.source,                  // 'bot' → OTA knows it came from chat
    channel_ref: booking.sender_id,          // For OTA support team to trace
    mkt_booking_id: booking.mkt_booking_id,  // Let OTA link back
    notes: booking.notes,
    status: booking.status,
  };
}

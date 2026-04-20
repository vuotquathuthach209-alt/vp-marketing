/**
 * Data Funnel — Pipeline tiền xử lý TRƯỚC khi gửi Gemini.
 *
 * Mục tiêu: Gemini CHỈ làm việc creative (viết summary, USPs).
 * Tất cả classification + field extraction + validation do rule-based engine làm.
 *
 * Lợi ích:
 *   - Gemini KHÔNG hallucinate factual fields (giá, loại, dịch vụ)
 *   - Rẻ hơn ~40% token (prompt ngắn hơn, không cần few-shot phức tạp)
 *   - Dễ debug từng stage
 *   - Scale 10,000+ hotels vẫn ổn (rule engine chạy < 10ms/hotel)
 *
 * Pipeline:
 *   raw → extract → classify → validate → [Gemini creative] → merge → final
 */
import { OtaRawHotel } from './hotel-synthesizer';
import { classifyProduct } from './product-taxonomy';

// ═══════════════════════════════════════════════════════════
// STRUCTURED INPUT — định dạng chuẩn sau khi qua phễu
// ═══════════════════════════════════════════════════════════

export type ProductGroup = 'short_stay' | 'long_term_apartment';
export type PropertyTier = 'budget' | 'mid' | 'premium' | 'luxury';
export type TargetSegment = 'business' | 'family' | 'couple' | 'backpacker' | 'long_stay' | 'mixed';

export interface NormalizedPricing {
  monthly?: { min: number; max: number; currency: 'VND' };
  daily?: { min: number; max?: number; weekend?: number; currency: 'VND' };
  hourly?: { price: number; min_hours?: number; currency: 'VND' };
}

export interface NormalizedRules {
  min_stay_months?: number;
  deposit_months?: number;
  checkin_time?: string;
  checkout_time?: string;
  min_stay_nights?: number;
  cancellation_policy?: string;
}

export interface StructuredInput {
  // Authoritative fields (exact from source)
  id: string;
  name: string;
  slug?: string;
  address?: string;
  city?: string;
  district?: string;
  latitude?: number;
  longitude?: number;
  phone?: string;
  star_rating?: number;
  amenities: string[];
  images: string[];
  cover_image?: string;

  // Derived by classifier
  property_type: string;
  product_group: ProductGroup;
  rental_type: 'per_night' | 'per_month' | 'per_hour';
  property_tier: PropertyTier;
  target_segment_hint: TargetSegment;

  // Pricing (structured)
  pricing: NormalizedPricing;
  rules: NormalizedRules;
  included_services: string[];

  // Flags from extractor
  flags: {
    has_kitchen: boolean;
    has_laundry: boolean;
    has_pool: boolean;
    has_gym: boolean;
    has_spa: boolean;
    has_parking: boolean;
    has_restaurant: boolean;
    has_24h_reception: boolean;
    utilities_included: boolean;
    accepts_escrow: boolean;
    self_checkin: boolean;
  };

  // Raw for traceability
  _raw?: any;

  // Validation
  _issues: string[];
}

// ═══════════════════════════════════════════════════════════
// PHỄU 1: FIELD EXTRACTOR
// Extract + normalize fields từ bất kỳ input shape nào
// ═══════════════════════════════════════════════════════════

function safeStr(v: any): string | undefined {
  if (v === null || v === undefined) return undefined;
  const s = String(v).trim();
  return s.length > 0 ? s : undefined;
}

function safeNum(v: any): number | undefined {
  if (v === null || v === undefined || v === '') return undefined;
  const n = Number(v);
  return isFinite(n) && n > 0 ? n : undefined;
}

function safeArr(v: any): any[] {
  return Array.isArray(v) ? v : [];
}

function normalizeAmenity(a: string): string {
  return String(a || '').toLowerCase()
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractFlags(raw: any, scraped: any): StructuredInput['flags'] {
  const amStr = safeArr(raw.amenities).map(normalizeAmenity).join('|');
  const hasAny = (re: RegExp) => re.test(amStr);

  return {
    has_kitchen: !!scraped?.full_kitchen || hasAny(/kitchen|bếp|bep/i),
    has_laundry: !!scraped?.washing_machine || hasAny(/laundry|washer|giặt|giat/i),
    has_pool: hasAny(/pool|bể bơi|ho boi|hồ bơi/i),
    has_gym: hasAny(/gym|fitness/i),
    has_spa: hasAny(/spa/i),
    has_parking: hasAny(/parking|đỗ xe|do xe|đậu xe/i),
    has_restaurant: hasAny(/restaurant|nhà hàng|nha hang/i),
    has_24h_reception: hasAny(/reception[_\s]*24|24.hour|lễ tân 24/i),
    utilities_included: !!scraped?.utilities_included,
    accepts_escrow: !!scraped?.accepts_sonder_escrow,
    self_checkin: !!raw.selfCheckinEnabled,
  };
}

function extractPricing(raw: any, scraped: any, productGroup: ProductGroup): NormalizedPricing {
  const pricing: NormalizedPricing = {};

  // Monthly pricing (apartment)
  if (scraped?.monthly_price_from) {
    pricing.monthly = {
      min: scraped.monthly_price_from,
      max: scraped.monthly_price_to || scraped.monthly_price_from,
      currency: 'VND',
    };
  }

  // Daily pricing (short stay)
  const rooms = safeArr(raw.rooms);
  const nightlyPrices: number[] = [];
  for (const r of rooms) {
    const p = safeNum(r.price);
    if (p && (productGroup === 'short_stay' || p < 1_000_000)) nightlyPrices.push(p);
  }
  const minPrice = safeNum(scraped?.daily_price || raw.minPrice);
  if (minPrice && productGroup === 'short_stay') {
    nightlyPrices.push(minPrice);
  }
  if (nightlyPrices.length > 0) {
    pricing.daily = {
      min: Math.min(...nightlyPrices),
      max: Math.max(...nightlyPrices),
      currency: 'VND',
    };
  }

  // Hourly
  const hourlyPrices: number[] = [];
  for (const r of rooms) {
    const p = safeNum(r.price_hourly);
    if (p) hourlyPrices.push(p);
  }
  if (hourlyPrices.length > 0) {
    pricing.hourly = {
      price: Math.min(...hourlyPrices),
      currency: 'VND',
    };
  }

  return pricing;
}

function extractServices(raw: any, scraped: any, flags: StructuredInput['flags']): string[] {
  const services: string[] = [];
  if (flags.has_kitchen) services.push('Bếp đầy đủ');
  if (flags.has_laundry) services.push('Máy giặt riêng');
  if (flags.utilities_included) services.push('Điện nước bao trọn');
  if (flags.has_pool) services.push('Hồ bơi');
  if (flags.has_gym) services.push('Phòng gym');
  if (flags.has_spa) services.push('Spa');
  if (flags.has_parking) services.push('Bãi đỗ xe');
  if (flags.has_restaurant) services.push('Nhà hàng');
  if (flags.has_24h_reception) services.push('Lễ tân 24/7');
  if (flags.accepts_escrow) services.push('Sonder Escrow');
  if (flags.self_checkin) services.push('Tự check-in');
  services.push('Wifi'); // almost always
  return services;
}

export function extract(raw: OtaRawHotel): Partial<StructuredInput> {
  const scraped = (raw as any)._scraped;
  const propertyType = (raw.property_type || 'hotel').toLowerCase();
  const classification = classifyProduct(propertyType);

  const flags = extractFlags(raw, scraped);
  const pricing = extractPricing(raw, scraped, classification.group as ProductGroup);

  return {
    id: String(raw.id),
    name: safeStr(raw.name) || 'Unknown Hotel',
    slug: safeStr((raw as any).slug),
    address: safeStr(raw.address),
    city: safeStr(raw.city),
    district: safeStr(raw.district),
    latitude: safeNum(raw.latitude),
    longitude: safeNum(raw.longitude),
    phone: safeStr(raw.phone),
    star_rating: safeNum(raw.star_rating),
    amenities: safeArr(raw.amenities).map(normalizeAmenity).filter(Boolean),
    images: safeArr((raw as any).images),
    cover_image: safeStr((raw as any).cover_image),
    property_type: propertyType,
    product_group: classification.group as ProductGroup,
    rental_type: classification.rental_type as any,
    flags,
    pricing,
    rules: {
      min_stay_months: scraped?.min_stay_months,
      deposit_months: scraped?.deposit_months,
      checkin_time: scraped?.checkin_time || (raw as any).checkInTime,
      checkout_time: scraped?.checkout_time || (raw as any).checkOutTime,
    },
    included_services: extractServices(raw, scraped, flags),
    _raw: raw,
  };
}

// ═══════════════════════════════════════════════════════════
// PHỄU 2: PRODUCT CLASSIFIER (advanced)
// Tier + segment
// ═══════════════════════════════════════════════════════════

function classifyTier(input: Partial<StructuredInput>): PropertyTier {
  const star = input.star_rating || 0;
  if (star >= 5) return 'luxury';

  // Use pricing
  const monthly = input.pricing?.monthly;
  const daily = input.pricing?.daily;

  if (monthly) {
    const avg = (monthly.min + monthly.max) / 2;
    if (avg >= 15_000_000) return 'luxury';
    if (avg >= 8_000_000) return 'premium';
    if (avg >= 4_000_000) return 'mid';
    return 'budget';
  }

  if (daily) {
    const avg = (daily.min + (daily.max || daily.min)) / 2;
    if (avg >= 2_500_000) return 'luxury';
    if (avg >= 1_200_000) return 'premium';
    if (avg >= 600_000) return 'mid';
    return 'budget';
  }

  // Fallback by star
  if (star >= 4) return 'premium';
  if (star >= 3) return 'mid';
  return 'budget';
}

function classifySegment(input: Partial<StructuredInput>): TargetSegment {
  if (input.product_group === 'long_term_apartment') return 'long_stay';

  const flags = input.flags;
  if (!flags) return 'mixed';

  // Luxury amenities → couple/business
  if (flags.has_spa && flags.has_pool) return 'couple';
  if (flags.has_24h_reception && flags.has_parking && !flags.has_pool) return 'business';
  if (flags.has_pool && flags.has_restaurant) return 'family';

  // Low amenities → backpacker
  const tier = classifyTier(input);
  if (tier === 'budget') return 'backpacker';

  return 'mixed';
}

export function classify(input: Partial<StructuredInput>): Partial<StructuredInput> {
  return {
    ...input,
    property_tier: classifyTier(input),
    target_segment_hint: classifySegment(input),
  };
}

// ═══════════════════════════════════════════════════════════
// PHỄU 3: VALIDATOR
// ═══════════════════════════════════════════════════════════

export function validate(input: Partial<StructuredInput>): StructuredInput {
  const issues: string[] = [];
  if (!input.id) issues.push('missing_id');
  if (!input.name || input.name === 'Unknown Hotel') issues.push('missing_name');
  if (!input.property_type) issues.push('missing_property_type');
  if (!input.product_group) issues.push('missing_product_group');

  // Price sanity
  if (input.pricing?.monthly) {
    const m = input.pricing.monthly;
    if (m.min < 500_000 || m.min > 200_000_000) issues.push('monthly_min_outlier');
    if (m.max < m.min) issues.push('monthly_max_lt_min');
  }
  if (input.pricing?.daily) {
    const d = input.pricing.daily;
    if (d.min < 50_000 || d.min > 50_000_000) issues.push('daily_min_outlier');
  }

  // Apartment without monthly pricing → fallback
  if (input.product_group === 'long_term_apartment' && !input.pricing?.monthly) {
    issues.push('apartment_missing_monthly_price');
  }

  // No coordinates
  if (!input.latitude || !input.longitude) {
    issues.push('missing_coordinates');
  }

  return {
    id: input.id!,
    name: input.name!,
    slug: input.slug,
    address: input.address,
    city: input.city,
    district: input.district,
    latitude: input.latitude,
    longitude: input.longitude,
    phone: input.phone,
    star_rating: input.star_rating,
    amenities: input.amenities || [],
    images: input.images || [],
    cover_image: input.cover_image,
    property_type: input.property_type || 'hotel',
    product_group: input.product_group || 'short_stay',
    rental_type: input.rental_type || 'per_night',
    property_tier: input.property_tier || 'mid',
    target_segment_hint: input.target_segment_hint || 'mixed',
    pricing: input.pricing || {},
    rules: input.rules || {},
    included_services: input.included_services || [],
    flags: input.flags || {
      has_kitchen: false, has_laundry: false, has_pool: false, has_gym: false,
      has_spa: false, has_parking: false, has_restaurant: false, has_24h_reception: false,
      utilities_included: false, accepts_escrow: false, self_checkin: false,
    },
    _raw: input._raw,
    _issues: issues,
  };
}

// ═══════════════════════════════════════════════════════════
// FULL PIPELINE
// ═══════════════════════════════════════════════════════════

export function runFunnel(raw: OtaRawHotel): StructuredInput {
  const extracted = extract(raw);
  const classified = classify(extracted);
  const validated = validate(classified);
  return validated;
}

/**
 * Build compact prompt cho Gemini — chỉ cần creative text.
 * Không còn classification, pricing parse, v.v. — rule engine đã làm xong.
 */
export function buildGeminiPromptFromStructured(input: StructuredInput): string {
  const priceLine = input.pricing.monthly
    ? `${input.pricing.monthly.min.toLocaleString('vi-VN')}đ - ${input.pricing.monthly.max.toLocaleString('vi-VN')}đ/tháng`
    : input.pricing.daily
      ? `${input.pricing.daily.min.toLocaleString('vi-VN')}đ${input.pricing.daily.max && input.pricing.daily.max !== input.pricing.daily.min ? ' - ' + input.pricing.daily.max.toLocaleString('vi-VN') + 'đ' : ''}/đêm`
      : 'liên hệ';

  return JSON.stringify({
    name: input.name,
    type: input.property_type,
    group: input.product_group,
    tier: input.property_tier,
    segment: input.target_segment_hint,
    city: input.city,
    district: input.district,
    star_rating: input.star_rating,
    price: priceLine,
    services: input.included_services,
    rules: input.rules,
  }, null, 2);
}

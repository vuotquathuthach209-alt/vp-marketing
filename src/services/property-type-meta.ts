/**
 * Property Type Metadata
 *
 * Định nghĩa chính xác từng loại hình lưu trú + rental_type
 * để bot không nhầm "căn hộ dịch vụ thuê đêm" với "căn hộ cho thuê tháng".
 */

export type PropertyType = 'apartment' | 'homestay' | 'hotel' | 'resort' | 'villa' | 'guesthouse' | 'hostel';

export interface PropertyTypeMeta {
  /** Label tiếng Việt chuẩn cho bot nói */
  label_vi: string;
  /** Label tiếng Anh */
  label_en: string;
  /** Dạng thuê phổ biến */
  rental_type: 'per_night' | 'per_hour' | 'per_month' | 'mixed';
  /** Mô tả ngắn để bot dùng khi giới thiệu */
  description_vi: string;
  /** Gợi ý kèm khi user hỏi loại này */
  clarification_vi?: string;
  /** Icon / emoji */
  emoji: string;
}

export const PROPERTY_TYPE_META: Record<PropertyType, PropertyTypeMeta> = {
  apartment: {
    label_vi: 'Căn hộ dịch vụ',
    label_en: 'Serviced Apartment',
    rental_type: 'per_night',
    description_vi: 'Căn hộ có đầy đủ nội thất + bếp + phòng khách, cho thuê theo đêm hoặc theo tuần như khách sạn.',
    clarification_vi: '(thuê theo đêm, không phải thuê tháng dài hạn)',
    emoji: '🏢',
  },
  homestay: {
    label_vi: 'Homestay',
    label_en: 'Homestay',
    rental_type: 'per_night',
    description_vi: 'Nhà dân cho thuê, ấm cúng gần gũi, phù hợp khách gia đình hoặc nhóm bạn.',
    emoji: '🏡',
  },
  hotel: {
    label_vi: 'Khách sạn',
    label_en: 'Hotel',
    rental_type: 'per_night',
    description_vi: 'Khách sạn tiêu chuẩn với đầy đủ tiện ích và dịch vụ.',
    emoji: '🏨',
  },
  resort: {
    label_vi: 'Resort',
    label_en: 'Resort',
    rental_type: 'per_night',
    description_vi: 'Khu nghỉ dưỡng cao cấp, nhiều tiện ích giải trí.',
    emoji: '🌴',
  },
  villa: {
    label_vi: 'Villa',
    label_en: 'Villa',
    rental_type: 'per_night',
    description_vi: 'Biệt thự riêng tư có hồ bơi, sân vườn, phù hợp gia đình hoặc nhóm lớn.',
    emoji: '🏖️',
  },
  guesthouse: {
    label_vi: 'Nhà nghỉ',
    label_en: 'Guesthouse',
    rental_type: 'per_night',
    description_vi: 'Nhà nghỉ giá rẻ, tiện nghi cơ bản.',
    emoji: '🛏️',
  },
  hostel: {
    label_vi: 'Hostel',
    label_en: 'Hostel',
    rental_type: 'per_night',
    description_vi: 'Nhà trọ tập thể giá rẻ, phù hợp khách backpacker.',
    emoji: '🎒',
  },
};

export function getMeta(type: string | null | undefined): PropertyTypeMeta | null {
  if (!type) return null;
  const key = type.toLowerCase() as PropertyType;
  return PROPERTY_TYPE_META[key] || null;
}

/** Keyword match trong tin nhắn user → property type */
export function detectTypeFromMessage(msg: string): PropertyType | null {
  const lower = msg.toLowerCase();
  const mapping: Array<[RegExp, PropertyType]> = [
    [/\b(homestay|home stay|nhà dân)\b/i, 'homestay'],
    [/\b(resort)\b/i, 'resort'],
    [/\b(villa|biệt thự|biet thu)\b/i, 'villa'],
    [/\b(nhà nghỉ|nha nghi|guesthouse)\b/i, 'guesthouse'],
    [/\b(hostel)\b/i, 'hostel'],
    [/\b(căn hộ dịch vụ|serviced apartment|can ho dich vu)\b/i, 'apartment'],
    [/\b(căn hộ|can ho|apartment)\b/i, 'apartment'],
    [/\b(khách sạn|khach san|hotel)\b/i, 'hotel'],
  ];
  for (const [re, type] of mapping) {
    if (re.test(lower)) return type;
  }
  return null;
}

/** User có hỏi thuê tháng không? */
export function isMonthlyRentalQuery(msg: string): boolean {
  return /(thuê tháng|thue thang|per month|monthly|theo tháng|theo thang|dài hạn|dai han|long[- ]term|\d+\s*tháng|\d+\s*thang|hợp đồng thuê|thuê dài|thuê\s+\d+\s*tháng)/i.test(msg);
}

/** User có hỏi thuê giờ không? */
export function isHourlyRentalQuery(msg: string): boolean {
  return /\b(theo giờ|theo gio|thuê giờ|thue gio|per hour|hourly|2h|3h|4h|nghỉ giờ|nghi gio)\b/i.test(msg);
}

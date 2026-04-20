/**
 * Sonder Product Taxonomy
 *
 * Phân loại chính xác theo MODEL KINH DOANH của Sonder (sondervn.com):
 *
 * Group 1 — "monthly_apartment" (URL /homestay trên website):
 *   - OTA propertyType = "apartment"
 *   - Căn hộ dịch vụ thuê theo THÁNG
 *   - Giá: 3-5 triệu/tháng (ví dụ 3.6M-3.9M)
 *   - Đặc điểm: full bếp, máy giặt riêng, điện nước bao trọn
 *   - Target: expat, freelancer, người chuyển công tác, người cần ở lâu dài
 *
 * Group 2 — "nightly_stay" (URL /khach-san trên website):
 *   - OTA propertyType = "homestay" | "hotel" | "resort" | "villa" | "guesthouse"
 *   - Khách sạn/Homestay/Villa thuê theo ĐÊM
 *   - Giá: 400k-1.5M/đêm
 *   - Target: khách du lịch ngắn ngày, công tác
 */

export type ProductGroup = 'monthly_apartment' | 'nightly_stay';

export interface ProductClassification {
  group: ProductGroup;
  label_vi: string;           // Label chuẩn tiếng Việt
  rental_unit: 'tháng' | 'đêm';
  rental_type: 'per_month' | 'per_night';
  typical_stay: string;        // Gợi ý thời gian lưu trú
  description_vi: string;
  included_services?: string[]; // Dịch vụ đi kèm (thuê tháng)
  url_group: string;           // Website URL path
  emoji: string;
}

export function classifyProduct(propertyType: string | null | undefined): ProductClassification {
  const pt = (propertyType || '').toLowerCase().trim();

  if (pt === 'apartment') {
    return {
      group: 'monthly_apartment',
      label_vi: 'Căn hộ dịch vụ',
      rental_unit: 'tháng',
      rental_type: 'per_month',
      typical_stay: '1-6 tháng',
      description_vi: 'Căn hộ dịch vụ cho thuê theo tháng, đầy đủ tiện nghi như ở nhà — có bếp riêng, máy giặt riêng, điện nước bao trọn.',
      included_services: ['Bếp riêng', 'Máy giặt riêng', 'Điện nước bao trọn', 'Wifi', 'Dọn phòng định kỳ'],
      url_group: '/homestay',
      emoji: '🏢',
    };
  }

  if (pt === 'homestay') {
    return {
      group: 'nightly_stay',
      label_vi: 'Homestay',
      rental_unit: 'đêm',
      rental_type: 'per_night',
      typical_stay: '1-7 đêm',
      description_vi: 'Homestay thuê theo đêm, không gian ấm cúng, phù hợp khách du lịch.',
      url_group: '/khach-san',
      emoji: '🏡',
    };
  }

  if (pt === 'hotel') {
    return {
      group: 'nightly_stay',
      label_vi: 'Khách sạn',
      rental_unit: 'đêm',
      rental_type: 'per_night',
      typical_stay: '1-5 đêm',
      description_vi: 'Khách sạn thuê theo đêm với dịch vụ tiêu chuẩn.',
      url_group: '/khach-san',
      emoji: '🏨',
    };
  }

  if (pt === 'villa') {
    return {
      group: 'nightly_stay',
      label_vi: 'Villa',
      rental_unit: 'đêm',
      rental_type: 'per_night',
      typical_stay: '1-5 đêm',
      description_vi: 'Biệt thự thuê theo đêm, phù hợp gia đình hoặc nhóm lớn.',
      url_group: '/khach-san',
      emoji: '🏖️',
    };
  }

  if (pt === 'resort') {
    return {
      group: 'nightly_stay',
      label_vi: 'Resort',
      rental_unit: 'đêm',
      rental_type: 'per_night',
      typical_stay: '2-7 đêm',
      description_vi: 'Khu nghỉ dưỡng cao cấp, thuê theo đêm.',
      url_group: '/khach-san',
      emoji: '🌴',
    };
  }

  if (pt === 'guesthouse') {
    return {
      group: 'nightly_stay',
      label_vi: 'Nhà nghỉ',
      rental_unit: 'đêm',
      rental_type: 'per_night',
      typical_stay: '1-3 đêm',
      description_vi: 'Nhà nghỉ tiện nghi cơ bản, giá rẻ.',
      url_group: '/khach-san',
      emoji: '🛏️',
    };
  }

  // Default: nightly
  return {
    group: 'nightly_stay',
    label_vi: 'Cơ sở lưu trú',
    rental_unit: 'đêm',
    rental_type: 'per_night',
    typical_stay: '1-5 đêm',
    description_vi: 'Cơ sở lưu trú thuê theo đêm.',
    url_group: '/khach-san',
    emoji: '🏨',
  };
}

/** Format price theo đơn vị đúng của group */
export function formatPriceWithUnit(price: number, classification: ProductClassification): string {
  if (!price || price < 1) return 'giá liên hệ';
  const formatted = price.toLocaleString('vi-VN') + 'đ';
  return `${formatted}/${classification.rental_unit}`;
}

/** Detect intent của user: muốn thuê theo đêm hay theo tháng */
export type UserRentalIntent = 'monthly' | 'nightly' | 'hourly' | 'unknown';

export function detectRentalIntent(msg: string): UserRentalIntent {
  const lower = msg.toLowerCase();

  // Hourly trước (rõ nhất)
  if (/\b(theo giờ|theo gio|thuê giờ|thue gio|hourly|per hour|\d+\s*h\b|\d+\s*giờ)/i.test(lower)) {
    return 'hourly';
  }

  // Monthly markers
  if (/(thuê tháng|thue thang|theo tháng|theo thang|monthly|per month|\d+\s*tháng|\d+\s*thang|dài hạn|dai han|long[- ]term|căn hộ cho thuê|can ho cho thue|thuê căn hộ|thue can ho|ở lâu|o lau)/i.test(lower)) {
    return 'monthly';
  }

  // Nightly markers
  if (/(theo đêm|theo dem|\d+\s*đêm|\d+\s*dem|per night|nightly|qua đêm|qua dem|tối nay|toi nay|ngày mai|ngay mai|cuối tuần|cuoi tuan|\d+\s*ngày|\d+\s*ngay)/i.test(lower)) {
    return 'nightly';
  }

  return 'unknown';
}

/** Check match giữa rental intent và product group */
export function matchesIntent(classification: ProductClassification, intent: UserRentalIntent): boolean {
  if (intent === 'unknown') return true; // không filter
  if (intent === 'monthly' && classification.group === 'monthly_apartment') return true;
  if (intent === 'nightly' && classification.group === 'nightly_stay') return true;
  if (intent === 'hourly') return true; // hotels đều có thể thuê giờ
  return false;
}

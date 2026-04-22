/**
 * Slot Extractor — deterministic extractors cho booking FSM.
 *
 * Mục đích: parse tin nhắn Việt của khách → trích xuất các slot:
 *   property_type, area, dates, guests, budget, phone, months, rental_sub_mode, ...
 *
 * Dùng kết hợp với Gemini multi-slot extractor (Phase 3):
 *   - Deterministic chạy trước (fast, accurate cho patterns rõ)
 *   - Gemini fill gaps nếu message dài/phức tạp
 *
 * Không side-effect: tất cả pure functions.
 */

/* ═══════════════════════════════════════════
   Dictionaries
   ═══════════════════════════════════════════ */

const DISTRICT_DICT: Array<{ re: RegExp; canonical: string; city?: string }> = [
  // HCM
  { re: /\bq(uan|uận)\s*1\b|\bd1\b|\bdistrict\s*1\b/i, canonical: 'Q1', city: 'Ho Chi Minh' },
  { re: /\bq(uan|uận)\s*2\b|\bd2\b|thủ thiêm|thu thiem/i, canonical: 'Q2', city: 'Ho Chi Minh' },
  { re: /\bq(uan|uận)\s*3\b|\bd3\b/i, canonical: 'Q3', city: 'Ho Chi Minh' },
  { re: /\bq(uan|uận)\s*4\b|\bd4\b/i, canonical: 'Q4', city: 'Ho Chi Minh' },
  { re: /\bq(uan|uận)\s*5\b|\bd5\b|chợ lớn|cho lon/i, canonical: 'Q5', city: 'Ho Chi Minh' },
  { re: /\bq(uan|uận)\s*7\b|\bd7\b|phú mỹ hưng|phu my hung/i, canonical: 'Q7', city: 'Ho Chi Minh' },
  { re: /\bq(uan|uận)\s*10\b|\bd10\b/i, canonical: 'Q10', city: 'Ho Chi Minh' },
  { re: /tân bình|tan binh/i, canonical: 'Tân Bình', city: 'Ho Chi Minh' },
  { re: /bình thạnh|binh thanh/i, canonical: 'Bình Thạnh', city: 'Ho Chi Minh' },
  { re: /phú nhuận|phu nhuan/i, canonical: 'Phú Nhuận', city: 'Ho Chi Minh' },
  { re: /gò vấp|go vap/i, canonical: 'Gò Vấp', city: 'Ho Chi Minh' },
  { re: /thủ đức|thu duc/i, canonical: 'Thủ Đức', city: 'Ho Chi Minh' },
  { re: /tân phú|tan phu/i, canonical: 'Tân Phú', city: 'Ho Chi Minh' },
  // Hà Nội
  { re: /hoàn kiếm|hoan kiem/i, canonical: 'Hoàn Kiếm', city: 'Hanoi' },
  { re: /ba đình|ba dinh/i, canonical: 'Ba Đình', city: 'Hanoi' },
  { re: /đống đa|dong da/i, canonical: 'Đống Đa', city: 'Hanoi' },
  { re: /cầu giấy|cau giay/i, canonical: 'Cầu Giấy', city: 'Hanoi' },
  { re: /tây hồ|tay ho/i, canonical: 'Tây Hồ', city: 'Hanoi' },
];

const LANDMARK_DICT: Array<{ re: RegExp; landmark: string; district: string; city: string }> = [
  // HCM
  { re: /sân bay\s*(tsn|tân sơn nhất|tan son nhat)?|airport|\btsn\b/i, landmark: 'Sân bay Tân Sơn Nhất', district: 'Tân Bình', city: 'Ho Chi Minh' },
  { re: /chợ bến thành|ben thanh/i, landmark: 'Chợ Bến Thành', district: 'Q1', city: 'Ho Chi Minh' },
  { re: /bitexco|bixco/i, landmark: 'Bitexco', district: 'Q1', city: 'Ho Chi Minh' },
  { re: /nhà thờ đức bà|notre dame/i, landmark: 'Nhà thờ Đức Bà', district: 'Q1', city: 'Ho Chi Minh' },
  { re: /landmark 81|landmark81/i, landmark: 'Landmark 81', district: 'Bình Thạnh', city: 'Ho Chi Minh' },
  { re: /bến xe miền đông|mien dong/i, landmark: 'Bến xe Miền Đông', district: 'Bình Thạnh', city: 'Ho Chi Minh' },
  { re: /bến xe miền tây|mien tay/i, landmark: 'Bến xe Miền Tây', district: 'Bình Tân', city: 'Ho Chi Minh' },
  { re: /phú mỹ hưng|phu my hung/i, landmark: 'Phú Mỹ Hưng', district: 'Q7', city: 'Ho Chi Minh' },
  { re: /thảo điền|thao dien/i, landmark: 'Thảo Điền', district: 'Q2', city: 'Ho Chi Minh' },
  // Hà Nội
  { re: /hồ gươm|hoan kiem lake|ho guom/i, landmark: 'Hồ Gươm', district: 'Hoàn Kiếm', city: 'Hanoi' },
  { re: /hồ tây|ho tay|west lake/i, landmark: 'Hồ Tây', district: 'Tây Hồ', city: 'Hanoi' },
  { re: /sân bay nội bài|noi bai/i, landmark: 'Sân bay Nội Bài', district: 'Sóc Sơn', city: 'Hanoi' },
  { re: /phố cổ|old quarter/i, landmark: 'Phố cổ', district: 'Hoàn Kiếm', city: 'Hanoi' },
];

const CITY_DICT: Array<{ re: RegExp; canonical: string }> = [
  { re: /tp\.?\s*hcm|hồ chí minh|ho chi minh|sài gòn|saigon|\bhcm\b/i, canonical: 'Ho Chi Minh' },
  { re: /\bhn\b|hà nội|ha noi|hanoi/i, canonical: 'Hanoi' },
  { re: /đà nẵng|da nang|\bdn\b/i, canonical: 'Da Nang' },
  { re: /nha trang/i, canonical: 'Nha Trang' },
  { re: /phú quốc|phu quoc/i, canonical: 'Phu Quoc' },
  { re: /đà lạt|da lat|dalat/i, canonical: 'Da Lat' },
  { re: /vũng tàu|vung tau/i, canonical: 'Vung Tau' },
];

const PROPERTY_TYPE_DICT: Array<{ re: RegExp; type: 'hotel' | 'homestay' | 'villa' | 'apartment' | 'resort' | 'guesthouse' | 'hostel' }> = [
  { re: /\b(khách sạn|khach san|ks|hotel)\b/i, type: 'hotel' },
  { re: /\b(homestay|home stay|nhà dân|nha dan|b&b)\b/i, type: 'homestay' },
  { re: /\b(villa|biệt thự|biet thu)\b/i, type: 'villa' },
  { re: /\b(căn hộ dịch vụ|can ho dich vu|chdv|apartment|serviced)\b/i, type: 'apartment' },
  { re: /\b(can ho|căn hộ)\b/i, type: 'apartment' },
  { re: /\b(resort)\b/i, type: 'resort' },
  { re: /\b(guesthouse|guest house|nhà nghỉ|nha nghi)\b/i, type: 'guesthouse' },
  { re: /\b(hostel)\b/i, type: 'hostel' },
];

/* ═══════════════════════════════════════════
   Property type
   ═══════════════════════════════════════════ */

export function extractPropertyType(msg: string): 'hotel' | 'homestay' | 'villa' | 'apartment' | 'resort' | 'guesthouse' | 'hostel' | null {
  for (const entry of PROPERTY_TYPE_DICT) {
    if (entry.re.test(msg)) return entry.type;
  }
  return null;
}

/* ═══════════════════════════════════════════
   Area / district / city / landmark
   ═══════════════════════════════════════════ */

export interface AreaExtract {
  area: string;              // original text from user
  normalized: string;        // canonical name
  type: 'district' | 'landmark' | 'city';
  city: string;
  district?: string;
}

export function extractArea(msg: string): AreaExtract | null {
  // Try landmark first (more specific)
  for (const entry of LANDMARK_DICT) {
    const m = msg.match(entry.re);
    if (m) {
      return {
        area: m[0],
        normalized: entry.landmark,
        type: 'landmark',
        city: entry.city,
        district: entry.district,
      };
    }
  }
  // District
  for (const entry of DISTRICT_DICT) {
    const m = msg.match(entry.re);
    if (m) {
      return {
        area: m[0],
        normalized: entry.canonical,
        type: 'district',
        city: entry.city || 'Ho Chi Minh',
        district: entry.canonical,
      };
    }
  }
  // City
  for (const entry of CITY_DICT) {
    const m = msg.match(entry.re);
    if (m) {
      return {
        area: m[0],
        normalized: entry.canonical,
        type: 'city',
        city: entry.canonical,
      };
    }
  }
  return null;
}

/* ═══════════════════════════════════════════
   Dates (VN natural language)
   ═══════════════════════════════════════════ */

export interface DatesExtract {
  checkin_date?: string;    // YYYY-MM-DD
  checkout_date?: string;   // YYYY-MM-DD
  nights?: number;
}

function toIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addDays(d: Date, n: number): Date {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

export function extractDates(msg: string): DatesExtract {
  const out: DatesExtract = {};
  const today = new Date();
  today.setHours(12, 0, 0, 0); // avoid TZ issues
  const lower = msg.toLowerCase();

  // Relative keywords
  if (/hôm nay|tối nay|chiều nay/i.test(lower)) {
    out.checkin_date = toIsoDate(today);
  } else if (/ngày mai|mai\s*(đi|check)?/i.test(lower) && !out.checkin_date) {
    out.checkin_date = toIsoDate(addDays(today, 1));
  } else if (/ngày mốt|mốt\s*(đi|check)?/i.test(lower)) {
    out.checkin_date = toIsoDate(addDays(today, 2));
  } else if (/cuối tuần|weekend/i.test(lower)) {
    // Next Saturday
    const day = today.getDay(); // 0=Sun, 6=Sat
    const daysToSat = day === 6 ? 7 : (6 - day);
    out.checkin_date = toIsoDate(addDays(today, daysToSat));
    out.checkout_date = toIsoDate(addDays(today, daysToSat + 2));
    out.nights = 2;
  } else if (/tuần sau|tuần tới|next week/i.test(lower)) {
    out.checkin_date = toIsoDate(addDays(today, 7));
  } else if (/đầu tháng sau|next month/i.test(lower)) {
    const next = new Date(today);
    next.setMonth(next.getMonth() + 1);
    next.setDate(1);
    out.checkin_date = toIsoDate(next);
  }

  // Explicit dates: "25/5" or "25-27/5" or "25/05/2026"
  // Format: d/m or dd/mm or dd/mm/yyyy
  const rangeMatch = msg.match(/(\d{1,2})[\/\-.](\d{1,2})(?:[\/\-.](\d{2,4}))?\s*[-–—]\s*(\d{1,2})[\/\-.](\d{1,2})/);
  if (rangeMatch) {
    const [, d1, , y1, d2, m2] = rangeMatch;
    const year = y1 ? parseInt(y1.length === 2 ? '20' + y1 : y1, 10) : today.getFullYear();
    const month = parseInt(m2, 10);
    const day1 = parseInt(d1, 10);
    const day2 = parseInt(d2, 10);
    out.checkin_date = `${year}-${String(month).padStart(2, '0')}-${String(day1).padStart(2, '0')}`;
    out.checkout_date = `${year}-${String(month).padStart(2, '0')}-${String(day2).padStart(2, '0')}`;
    out.nights = Math.max(1, day2 - day1);
  } else {
    const singleMatch = msg.match(/(\d{1,2})[\/\-.](\d{1,2})(?:[\/\-.](\d{2,4}))?/);
    if (singleMatch) {
      const [, d, m, y] = singleMatch;
      const year = y ? parseInt(y.length === 2 ? '20' + y : y, 10) : today.getFullYear();
      const month = parseInt(m, 10);
      const day = parseInt(d, 10);
      if (day >= 1 && day <= 31 && month >= 1 && month <= 12) {
        out.checkin_date = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      }
    }
  }

  // Nights: "3 đêm", "2 ngày"
  const nightsMatch = msg.match(/(\d+)\s*(đêm|dem|night|ngày|ngay|day)s?\b/i);
  if (nightsMatch && !out.nights) {
    out.nights = parseInt(nightsMatch[1], 10);
    if (out.checkin_date && !out.checkout_date) {
      const d = new Date(out.checkin_date + 'T00:00:00Z');
      out.checkout_date = toIsoDate(addDays(d, out.nights));
    }
  }

  return out;
}

/* ═══════════════════════════════════════════
   Budget (VN currency)
   ═══════════════════════════════════════════ */

export interface BudgetExtract {
  min?: number;
  max?: number;
  per?: 'night' | 'month' | 'hour';
  no_filter?: boolean;
}

function parseVnPrice(token: string): number {
  // "1m" → 1_000_000; "500k" → 500_000; "1tr" → 1_000_000; "1 chai" → 1_000_000
  const lower = token.toLowerCase().replace(/[.,\s]/g, '');
  const num = parseFloat(lower);
  if (isNaN(num)) return 0;

  if (/triệu|trieu|tr\b|chai\b|củ\b|cu\b|m\b/.test(lower)) return Math.round(num * 1_000_000);
  if (/k\b|nghìn|nghin|ngàn|ngan/.test(lower)) return Math.round(num * 1_000);
  // If plain digits with commas (vd "500,000") — already correct
  if (num > 10_000) return Math.round(num);
  // Small number with no unit — ambiguous, assume "k" (thousand)
  return Math.round(num * 1_000);
}

export function extractBudget(msg: string): BudgetExtract {
  const lower = msg.toLowerCase();

  // No filter signals
  if (/tiền nào cũng được|giá nào cũng được|bao nhiêu cũng được|không quan tâm giá/i.test(lower)) {
    return { no_filter: true };
  }

  // Determine per
  let per: 'night' | 'month' | 'hour' | undefined;
  if (/\/\s*tháng|\/month|per month|1 tháng/i.test(lower)) per = 'month';
  else if (/\/\s*giờ|\/hour|\/h\b|1 giờ|1 tiếng|per hour|theo giờ/i.test(lower)) per = 'hour';
  else if (/\/\s*đêm|\/night|1 đêm|per night/i.test(lower)) per = 'night';

  // Range: "500k-1m" or "500-800k" or "1-2 triệu" or "1.5-2tr"
  const rangeMatch = msg.match(/(\d+(?:[.,]\d+)?)\s*(k|m|tr|triệu|trieu|chai|củ)?\s*[-–—đến to]+\s*(\d+(?:[.,]\d+)?)\s*(k|m|tr|triệu|trieu|chai|củ)?/i);
  if (rangeMatch) {
    const [, n1, u1, n2, u2] = rangeMatch;
    const unit2 = u2 || u1 || 'k';  // if only second has unit, use for both
    const unit1 = u1 || u2 || 'k';
    const min = parseVnPrice(`${n1}${unit1}`);
    const max = parseVnPrice(`${n2}${unit2}`);
    return { min, max, per };
  }

  // "dưới 500k" / "< 1tr" / "tối đa 800k"
  const maxMatch = msg.match(/(?:dưới|duoi|<|tối đa|toi da|max|không quá|khong qua|up to)\s*(\d+(?:[.,]\d+)?)\s*(k|m|tr|triệu|trieu|chai|củ)?/i);
  if (maxMatch) {
    const [, n, u] = maxMatch;
    return { max: parseVnPrice(`${n}${u || 'k'}`), per };
  }

  // "từ 500k trở lên" / "trên 500k" / "> 500k"
  const minMatch = msg.match(/(?:trên|tren|>|từ|tu|min|hơn|hon|above)\s*(\d+(?:[.,]\d+)?)\s*(k|m|tr|triệu|trieu|chai|củ)?(?:\s*trở lên)?/i);
  if (minMatch) {
    const [, n, u] = minMatch;
    return { min: parseVnPrice(`${n}${u || 'k'}`), per };
  }

  // "tầm 500k" / "khoảng 1tr" — ±10% tolerance
  const aroundMatch = msg.match(/(?:tầm|tam|khoảng|khoang|around|chừng|chung)\s*(\d+(?:[.,]\d+)?)\s*(k|m|tr|triệu|trieu|chai|củ)?/i);
  if (aroundMatch) {
    const [, n, u] = aroundMatch;
    const center = parseVnPrice(`${n}${u || 'k'}`);
    return { min: Math.round(center * 0.9), max: Math.round(center * 1.1), per };
  }

  return {};
}

/* ═══════════════════════════════════════════
   Guests
   ═══════════════════════════════════════════ */

export interface GuestsExtract {
  adults?: number;
  children?: number;
}

export function extractGuests(msg: string): GuestsExtract {
  const out: GuestsExtract = {};
  const lower = msg.toLowerCase();

  // "1 mình" / "đi 1 mình"
  if (/\b1\s*mình|đi\s*1\s*mình|một mình|solo/i.test(lower)) {
    out.adults = 1;
    return out;
  }

  // "gia đình 4" / "gia đình 5 người"
  const family = msg.match(/gia đình\s*(\d+)(?:\s*(?:người|nguoi))?/i);
  if (family) {
    const total = parseInt(family[1], 10);
    out.adults = 2;
    out.children = Math.max(0, total - 2);
    return out;
  }

  // "2 vợ chồng" / "2 vợ chồng 1 bé"
  const vochong = msg.match(/(?:2\s*)?vợ chồng(?:\s*(\d+)\s*(?:bé|con|child))?/i);
  if (vochong) {
    out.adults = 2;
    out.children = vochong[1] ? parseInt(vochong[1], 10) : 0;
    return out;
  }

  // "2 người lớn + 1 bé"
  const mixed = msg.match(/(\d+)\s*(?:người lớn|nguoi lon|adult).*?(\d+)\s*(?:trẻ|bé|con|child)/i);
  if (mixed) {
    out.adults = parseInt(mixed[1], 10);
    out.children = parseInt(mixed[2], 10);
    return out;
  }

  // "nhóm 5" / "5 khách" / "2 người" / "2 ng"
  const group = msg.match(/(?:nhóm|nhom|group)\s*(\d+)|(\d+)\s*(?:khách|khach|người|nguoi|ng|pax|guest)s?\b/i);
  if (group) {
    out.adults = parseInt(group[1] || group[2], 10);
    return out;
  }

  return out;
}

/* ═══════════════════════════════════════════
   Phone (VN mobile)
   ═══════════════════════════════════════════ */

export function extractPhone(msg: string): string | null {
  // VN mobile: 10 digits, start 03/05/07/08/09
  // Allow spaces/dashes: "09 12 34 56 78"
  const normalized = msg.replace(/[\s\-.]/g, '');
  const m = normalized.match(/(?:\+?84|0)(3|5|7|8|9)\d{8}/);
  if (!m) return null;
  const digits = m[0].replace(/^\+?84/, '0');
  return digits.length === 10 ? digits : null;
}

/* ═══════════════════════════════════════════
   Months (long-term rental)
   ═══════════════════════════════════════════ */

export function extractMonths(msg: string): number | null {
  // "3 tháng" / "thuê 6 tháng" / "nửa năm" / "1 năm"
  const monthsMatch = msg.match(/(\d+)\s*(?:tháng|thang|month)s?\b/i);
  if (monthsMatch) return parseInt(monthsMatch[1], 10);

  const lower = msg.toLowerCase();
  if (/nửa năm|nua nam|half year/i.test(lower)) return 6;
  if (/1\s*năm|một năm|one year|1\s*nam|mot nam/i.test(lower)) return 12;
  if (/2\s*năm|hai năm|two years|2\s*nam|hai nam/i.test(lower)) return 24;

  return null;
}

/* ═══════════════════════════════════════════
   Rental sub-mode (hourly vs nightly vs monthly)
   ═══════════════════════════════════════════ */

export function extractRentalSubMode(msg: string): 'hourly' | 'nightly' | 'monthly' | null {
  const lower = msg.toLowerCase();
  if (/theo giờ|thuê giờ|thuê theo giờ|\d+\s*(?:tiếng|giờ|h)\b|hourly/i.test(lower)) return 'hourly';
  if (/\d+\s*(?:tháng|month)s?\b|nửa năm|1 năm|long[- ]term|thuê tháng/i.test(lower)) return 'monthly';
  if (/\d+\s*(?:đêm|night|ngày|day)s?\b|overnight|qua đêm/i.test(lower)) return 'nightly';
  return null;
}

/* ═══════════════════════════════════════════
   Checkin time (for hourly bookings)
   ═══════════════════════════════════════════ */

export function extractCheckinTime(msg: string): string | null {
  // "5h sáng" / "14:00" / "2 giờ chiều"
  const hm = msg.match(/(\d{1,2})[:.h](\d{2})/);
  if (hm) return `${hm[1].padStart(2, '0')}:${hm[2]}`;
  const h = msg.match(/(\d{1,2})\s*(?:h|giờ|tiếng)\s*(sáng|trưa|chiều|tối)?/i);
  if (h) {
    let hour = parseInt(h[1], 10);
    const period = h[2]?.toLowerCase();
    if (period === 'chiều' && hour < 12) hour += 12;
    if (period === 'tối' && hour < 12) hour += 12;
    if (period === 'sáng' && hour === 12) hour = 0;
    return `${String(hour).padStart(2, '0')}:00`;
  }
  return null;
}

/* ═══════════════════════════════════════════
   Name (capture "mình tên A" / "tôi là B")
   ═══════════════════════════════════════════ */

export function extractName(msg: string): string | null {
  const m = msg.match(/(?:mình|tôi|em|anh|chị)\s*(?:tên|là|gọi là)\s*([A-ZĐÀÁẢÃẠĂẰẮẲẴẶÂẦẤẨẪẬÊỀẾỂỄỆÔỒỐỔỖỘƠỜỚỞỠỢƯỪỨỬỮỰÈÉẺẼẸÌÍỈĨỊÒÓỎÕỌÙÚỦŨỤỲÝỶỸỴa-zđàáảãạăằắẳẵặâầấẩẫậêềếểễệôồốổỗộơờớởỡợưừứửữựèéẻẽẹìíỉĩịòóỏõọùúủũụỳýỷỹỵ]{2,30}(?:\s+[A-Za-zÀ-ỹ]{2,30})*)/);
  if (m) return m[1].trim();
  return null;
}

/* ═══════════════════════════════════════════
   Email
   ═══════════════════════════════════════════ */

export function extractEmail(msg: string): string | null {
  const m = msg.match(/[\w.+-]+@[\w-]+\.[\w.-]+/);
  return m ? m[0] : null;
}

/* ═══════════════════════════════════════════
   Main extractor — gộp tất cả slot từ 1 message
   ═══════════════════════════════════════════ */

export interface ExtractedSlots {
  property_type?: string;
  area?: AreaExtract;
  dates?: DatesExtract;
  guests?: GuestsExtract;
  budget?: BudgetExtract;
  phone?: string;
  name?: string;
  email?: string;
  months?: number;
  rental_sub_mode?: 'hourly' | 'nightly' | 'monthly';
  checkin_time?: string;
}

export function extractAllSlots(msg: string): ExtractedSlots {
  const out: ExtractedSlots = {};
  const pt = extractPropertyType(msg);
  if (pt) out.property_type = pt;
  const area = extractArea(msg);
  if (area) out.area = area;
  const dates = extractDates(msg);
  if (Object.keys(dates).length) out.dates = dates;
  const guests = extractGuests(msg);
  if (Object.keys(guests).length) out.guests = guests;
  const budget = extractBudget(msg);
  if (Object.keys(budget).length) out.budget = budget;
  const phone = extractPhone(msg);
  if (phone) out.phone = phone;
  const name = extractName(msg);
  if (name) out.name = name;
  const email = extractEmail(msg);
  if (email) out.email = email;
  const months = extractMonths(msg);
  if (months) out.months = months;
  const rm = extractRentalSubMode(msg);
  if (rm) out.rental_sub_mode = rm;
  const ct = extractCheckinTime(msg);
  if (ct) out.checkin_time = ct;
  return out;
}

/** Count how many slots were extracted — useful để detect multi-slot messages */
export function countExtracted(slots: ExtractedSlots): number {
  let n = 0;
  if (slots.property_type) n++;
  if (slots.area) n++;
  if (slots.dates?.checkin_date || slots.dates?.nights) n++;
  if (slots.guests?.adults) n++;
  if (slots.budget && (slots.budget.min !== undefined || slots.budget.max !== undefined || slots.budget.no_filter)) n++;
  if (slots.phone) n++;
  if (slots.name) n++;
  if (slots.email) n++;
  if (slots.months) n++;
  if (slots.rental_sub_mode) n++;
  return n;
}

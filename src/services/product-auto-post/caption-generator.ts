/**
 * Caption Generator — 5 angles quay vòng cho product spotlight.
 *
 * Angles:
 *   - signature     : 1 ảnh best + brand story ("giới thiệu" hotel)
 *   - testimonial   : review 5⭐ + khách nói
 *   - price         : bảng giá + policy + USP (thứ 6, trước weekend)
 *   - location      : gần landmark (sân bay/Q1/Bình Thạnh), đi đâu
 *   - comparison    : "Sonder Airport vs Sonder Q1 — tùy nhu cầu"
 *
 * Rotation logic:
 *   - Thứ 2: signature
 *   - Thứ 3: comparison
 *   - Thứ 4: location
 *   - Thứ 5: testimonial
 *   - Thứ 6: price
 *   - Thứ 7: signature (khác hotel)
 *   - CN:    location (mood relax)
 *
 * LLM generation: dùng smartCascade (Gemini → Ollama → Groq fallback).
 * Brand voice: em/anh/chị, có "ạ", emoji vừa phải, CTA inbox/web.
 */

import crypto from 'crypto';
import { db } from '../../db';
import { HotelCandidate } from './picker';

export type Angle = 'signature' | 'comparison' | 'location' | 'testimonial' | 'price';

const DAY_TO_ANGLE: Record<number, Angle> = {
  1: 'signature',     // T2
  2: 'comparison',    // T3
  3: 'location',      // T4
  4: 'testimonial',   // T5
  5: 'price',         // T6
  6: 'signature',     // T7
  0: 'location',      // CN
};

/** Pick angle theo thứ trong tuần. */
export function pickAngleForDate(date: Date = new Date()): Angle {
  const vnDate = new Date(date.getTime() + 7 * 3600_000);    // UTC+7
  return DAY_TO_ANGLE[vnDate.getUTCDay()] || 'signature';
}

/**
 * Check if this angle has been used recently with this hotel.
 * Tránh repeat angle+hotel trong 30 ngày.
 */
export function isAngleRecentlyUsed(hotelId: number, angle: Angle, withinDays: number = 30): boolean {
  const cutoff = new Date(Date.now() - withinDays * 24 * 3600_000)
    .toISOString().slice(0, 10);
  try {
    const row = db.prepare(
      `SELECT 1 FROM auto_post_history
       WHERE hotel_id = ? AND angle_used = ? AND scheduled_date > ?
       LIMIT 1`
    ).get(hotelId, angle, cutoff);
    return !!row;
  } catch {
    return false;
  }
}

/**
 * Fallback: if preferred angle recently used, try next in rotation.
 */
export function pickAngleSmart(hotelId: number, preferredDate: Date = new Date()): Angle {
  const order: Angle[] = ['signature', 'location', 'testimonial', 'price', 'comparison'];
  const preferred = pickAngleForDate(preferredDate);
  // Put preferred first, rotate others
  const tryOrder: Angle[] = [preferred, ...order.filter(a => a !== preferred)];
  for (const a of tryOrder) {
    if (!isAngleRecentlyUsed(hotelId, a, 21)) return a;    // 3 tuần cooldown/angle
  }
  return preferred;     // fallback: dùng preferred dù recent
}

/**
 * Build prompt cho LLM based on angle.
 */
function buildPrompt(hotel: HotelCandidate, angle: Angle, imageContext?: string): string {
  const basePersona = `Bạn là Em — tư vấn viên của hệ thống Sonder (giới thiệu phòng lưu trú tại TP.HCM).

XƯNG HÔ BẮT BUỘC:
- Xưng "em", gọi khách "anh/chị" (tuyệt đối KHÔNG "bạn/tôi/mình/quý khách")
- Câu kết có "ạ" / "nhé ạ" / "dạ"
- Giọng thân thiện, lễ phép, không máy móc

KHÔNG DÙNG MARKDOWN (không **bold**, không # heading, không _italic_).
Viết plain text — FB/IG/Zalo đều hiển thị thẳng.

HOTEL INFO (dùng data này, KHÔNG bịa):
- Tên: ${hotel.name}
- Loại: ${hotel.property_type}
- Khu vực: ${hotel.district || 'TP.HCM'}
- Rating: ${hotel.rating?.toFixed(1) || 'chưa có'} (${hotel.review_count || 0} reviews)
- Giá từ: ${hotel.min_nightly_price ? Math.round(hotel.min_nightly_price / 1000) + 'k/đêm' : 'liên hệ'}${hotel.monthly_price_from ? ' hoặc ' + Math.round(hotel.monthly_price_from / 1_000_000) + 'tr/tháng (CHDV)' : ''}
- USP: ${hotel.usp_top3?.join(', ') || 'chưa có'}
${imageContext ? `- Ảnh context: ${imageContext}` : ''}

ĐỘ DÀI: 100-180 từ. 2-4 đoạn.

KẾT BÀI (bắt buộc):
- CTA rõ: "inbox em" hoặc "xem giá web sondervn.com"
- 3-5 hashtag: #SonderVN #StayInHCM #${hotel.property_type.charAt(0).toUpperCase() + hotel.property_type.slice(1)} + 1-2 custom`;

  const angleInstructions: Record<Angle, string> = {
    signature: `
ANGLE: Signature Shot — giới thiệu hotel qua 1 khoảnh khắc.

Mở bài: 1 chi tiết cụ thể + cảm xúc (VD: "Buổi sáng ở ${hotel.name}...", "Có 1 góc nhỏ tại...")
Thân bài: 2-3 USP nổi bật + 1 cảm giác khách trải nghiệm (không phải list tính năng khô khan)
Kết: CTA inbox để xem thêm ảnh + check lịch trống

TONE: storytelling, evocative, cảm xúc.
`,
    comparison: `
ANGLE: Comparison/Guide — so sánh hoặc giúp khách chọn.

Pattern: "Anh/chị đang phân vân X hay Y?" → giải quyết với context hotel này.
VD: "Ở gần sân bay hay Q1?" → ưu/khuyết của ${hotel.name} cho từng use case (business trip, family, couple)
Thân bài: 2-3 bullet ngắn gọn về ai phù hợp với hotel này
Kết: CTA "anh/chị nhu cầu nào, em tư vấn chỗ phù hợp nhất ạ"

TONE: consultative, helpful, không selly.
`,
    location: `
ANGLE: Location Story — landmarks gần + connectivity.

Mở bài: "${hotel.name} nằm ở ${hotel.district} — khoảng cách tới [landmark]..."
Thân bài:
  - 2-3 landmark cụ thể + thời gian di chuyển (taxi/xe máy)
  - 1 tip gì đặc biệt (VD: "gần Tân Bình Shopping Center, đi bộ 3 phút")
Kết: CTA "Anh/chị check-in ngày nào em tư vấn chỗ gần nhất ạ"

TONE: practical, informative.
`,
    testimonial: `
ANGLE: Guest Voice — review từ khách thật.

Mở bài: Quote ngắn từ khách hypothetical (em sáng tạo dựa trên rating ${hotel.rating?.toFixed(1)}, nhưng KHÔNG bịa fake number)
VD: "'Phòng sạch, nhân viên dễ thương' — review gần đây từ khách ở ${hotel.name}"
Thân bài: 2-3 điểm khách hay khen + cam kết của Sonder (giá minh bạch, hỗ trợ 24/7)
Kết: CTA "Đọc review full trên web hoặc inbox em để nghe thêm chia sẻ ạ"

TONE: authentic, social proof. KHÔNG được bịa số liệu cụ thể.
`,
    price: `
ANGLE: Price Transparency — bảng giá minh bạch, khách yên tâm.

Mở bài: "${hotel.name} — bảng giá anh/chị cần biết trước khi đặt:"
Thân bài:
  - Giá từ ${hotel.min_nightly_price ? Math.round(hotel.min_nightly_price / 1000) + 'k/đêm' : 'liên hệ'}
  - 2-3 chính sách: cuối tuần +20%, ở 3+ đêm -5%, hủy trước 48h hoàn 100%
  - KHÔNG phụ phí ẩn
Kết: CTA "Cho em ngày + số khách, em báo giá chính xác + giữ phòng 24h"

TONE: transparent, trustworthy, no pressure.
`,
  };

  return basePersona + '\n\n' + angleInstructions[angle];
}

/**
 * Generate caption via smartCascade LLM.
 */
export async function generateCaption(
  hotel: HotelCandidate,
  angle: Angle,
  opts: { imageContext?: string } = {},
): Promise<{ caption: string; angle: Angle; provider: string; ms: number } | null> {
  const t0 = Date.now();
  const prompt = buildPrompt(hotel, angle, opts.imageContext);

  try {
    const { smartCascade } = require('../smart-cascade');
    const result = await smartCascade({
      system: 'Bạn tạo bài đăng marketing cho Sonder. Luôn tuân thủ brand voice + CTA rõ ràng.',
      user: prompt,
      temperature: 0.8,      // cao hơn để creative
      maxTokens: 500,
      startFrom: 'gemini_flash',
    });

    let caption = (result.text || '').trim();
    // Remove markdown residue
    caption = caption
      .replace(/\*\*/g, '')
      .replace(/__/g, '')
      .replace(/^#+\s+/gm, '')
      .replace(/```[\s\S]*?```/g, '')
      .trim();

    // QA: check length
    if (caption.length < 80) {
      console.warn(`[caption-gen] too short (${caption.length} chars), rejected`);
      return null;
    }
    if (caption.length > 2200) {
      caption = caption.slice(0, 2150) + '...';
    }

    return {
      caption,
      angle,
      provider: result.provider || 'unknown',
      ms: Date.now() - t0,
    };
  } catch (e: any) {
    console.error('[caption-gen] fail:', e?.message);
    return null;
  }
}

/**
 * Hash caption for dedup (tránh caption trùng do LLM sinh giống nhau).
 */
export function captionHash(caption: string): string {
  const normalized = caption.toLowerCase().replace(/[^a-zA-Z0-9àáâãèéêìíòóôõùúăđĩũơưạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỷỹ\s]/g, '').trim();
  return crypto.createHash('md5').update(normalized).digest('hex').slice(0, 16);
}

/**
 * QA: check if caption covers brand essentials.
 */
export function validateCaption(caption: string, hotel: HotelCandidate): { ok: boolean; issues: string[] } {
  const issues: string[] = [];
  if (caption.length < 80) issues.push('too_short');
  if (caption.length > 2200) issues.push('too_long');
  // Persona check
  if (/\b(bạn|tôi|mình|quý khách)\b/i.test(caption)) issues.push('persona_violation_banned_pronoun');
  if (!/anh\/chị|anh\s|chị\s/i.test(caption)) issues.push('persona_missing_anh_chi');
  // CTA check
  if (!/inbox|sondervn|web|gọi|liên hệ|đặt phòng|xem thêm/i.test(caption)) issues.push('missing_cta');
  // Hotel name mention
  if (!caption.toLowerCase().includes(hotel.name.toLowerCase().split(' ')[0])) issues.push('hotel_name_not_mentioned');
  return { ok: issues.length === 0, issues };
}

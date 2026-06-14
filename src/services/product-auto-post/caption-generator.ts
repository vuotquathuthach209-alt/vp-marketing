/**
 * Caption Generator — 8 trụ nội dung (content pillars) quay vòng theo chiến lược 70/20/10.
 * (~70% nội dung kéo reach: story/giá trị/hậu trường · 20% giới thiệu sản phẩm · 10% chốt đơn)
 *
 * Pillars:
 *   - local_guide   : cẩm nang địa phương — đáng Lưu/Chia sẻ (reach mạnh nhất)
 *   - behind_scenes : hậu trường & con người — người thật, mộc (reach cao)
 *   - signature     : tour phòng / 1 khoảnh khắc đẹp (giới thiệu sản phẩm)
 *   - testimonial   : review 5⭐ thật + khách nói (niềm tin)
 *   - seasonal      : bắt trend & mùa/dịp (cửa sổ viral)
 *   - location      : gần landmark, connectivity, cuối tuần
 *   - price         : bảng giá minh bạch + ưu đãi (chốt đơn — tiết chế)
 *   - comparison    : giúp khách chọn giữa các lựa chọn (dự phòng)
 *
 * Rotation (lịch tuần video-first 2026):
 *   - T2: local_guide · T3: behind_scenes · T4: signature · T5: testimonial
 *   - T6: seasonal · T7: location · CN: price
 *
 * LLM generation: dùng smartCascade (Gemini → Ollama → Groq fallback).
 * Brand voice: em/anh/chị, có "ạ", emoji vừa phải, CTA inbox/web.
 */

import crypto from 'crypto';
import { db } from '../../db';
import { HotelCandidate } from './picker';

export type Angle = 'signature' | 'comparison' | 'location' | 'testimonial' | 'price' | 'behind_scenes' | 'local_guide' | 'seasonal' | 'travel_tips' | 'meme_trend' | 'healing' | 'interactive';

/** Trụ "GIỌNG TRẺ" — dí dỏm / chữa lành / tương tác → dùng persona creator trẻ (KHÔNG ép giọng tư vấn viên). */
const YOUTH_ANGLES = new Set<Angle>(['meme_trend', 'healing', 'interactive']);

const DAY_TO_ANGLE: Record<number, Angle> = {
  1: 'travel_tips',    // T2 — Mẹo du lịch (giá trị, đáng lưu) ⭐NEW
  2: 'signature',      // T3 — KS kể chuyện / khoảnh khắc đẹp
  3: 'meme_trend',     // T4 — Meme & bắt trend (dí dỏm, viral) ⭐NEW
  4: 'local_guide',    // T5 — Cẩm nang điểm đến (Save/Share)
  5: 'seasonal',       // T6 — Bắt trend mùa / rủ đi cuối tuần
  6: 'interactive',    // T7 — Tương tác / tag bạn (kéo comment) ⭐NEW
  0: 'healing',        // CN — Chữa lành & sống chậm (cảm xúc) ⭐NEW
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
  const order: Angle[] = ['travel_tips', 'signature', 'meme_trend', 'local_guide', 'seasonal', 'interactive', 'healing', 'testimonial', 'behind_scenes', 'location', 'price', 'comparison'];
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
  const isYouth = YOUTH_ANGLES.has(angle);

  // GIỌNG TRẺ (meme / chữa lành / tương tác) — creator trẻ, dí dỏm, bắt trend; KHÁC hẳn giọng tư vấn viên.
  const youthPersona = `Bạn là 1 content creator TRẺ, sáng tạo, bắt trend cho thương hiệu lưu trú Sonder (sondervn.com) — đối tượng là người trẻ Việt mê đi chơi.

GIỌNG VIẾT:
- Trẻ trung, dí dỏm, đời thường, bắt trend mạng xã hội Việt Nam.
- ĐƯỢC dùng "bạn", "tụi mình", "mình" — KHÔNG bắt buộc "anh/chị", KHÔNG cần "ạ" cuối câu, KHÔNG kiểu tư vấn viên cứng nhắc.
- Emoji hợp trend, vừa phải. KHÔNG sáo rỗng ("tuyệt vời", "đẳng cấp", "trải nghiệm khó quên").
- KHÔNG MARKDOWN (không **bold**, không #heading). Plain text. (Hashtag cuối bài được dùng #.)

BỐI CẢNH (chỉ gài KHÉO, KHÔNG bắt buộc nêu tên, TUYỆT ĐỐI không liệt kê kiểu quảng cáo):
- Thương hiệu Sonder — đặt phòng TRỰC TIẾP tại sondervn.com (rẻ hơn app trung gian).
- Khu vực có thể nhắc nhẹ nếu hợp: ${hotel.district || 'TP.HCM'}.

ĐỘ DÀI: 60-130 từ (riêng trụ tương tác NGẮN hơn).
KẾT BÀI: CTA SIÊU NHẸ về sondervn.com (mời, KHÔNG ép) + 4-6 hashtag bắt trend (#sondervn + du lịch/giới trẻ + khu vực).`;

  const basePersona = isYouth ? youthPersona : `Bạn là 1 AI content writer cho hệ thống tư vấn phòng lưu trú Sonder tại TP.HCM.

VIẾT POST Ở NGÔI THỨ 1 — nhân vật "em" (tư vấn viên Sonder).
Persona trong post:
- Bot tự xưng "em" (KHÔNG "Em là Em", KHÔNG "tôi", KHÔNG "mình")
- Gọi khách "anh/chị" (KHÔNG "bạn", KHÔNG "quý khách")
- Mở đầu không giới thiệu danh xưng — đi thẳng vào nội dung.

QUY TẮC BẮT BUỘC:
- Câu kết có "ạ" / "nhé ạ" / "dạ"
- Giọng thân thiện, lễ phép, không máy móc, như tư vấn viên thật
- KHÔNG viết câu kiểu "Em là Em" hoặc "Mình là..." — đi thẳng vào nội dung

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
ANGLE: Guest Voice — QUOTE TỪ REVIEW THẬT của khách đã ở.

CRITICAL: Nếu imageContext có chứa "REAL_REVIEW:", BẮT BUỘC dùng quote đó thay vì bịa.
Format review thật trong imageContext:
  REAL_REVIEW: rating=X.X, name="NGUYỄN A.", stay="4/2026", text="..."

Nếu có REAL_REVIEW trong context:
  Mở bài: "[quote từ review text, trích 1-2 câu hay nhất]" — [masked_name], đã ở tháng [stay_month_year]
  Thân bài: Expand lý do khách thích (dựa trên highlights trong review) + Sonder commits
  Kết: CTA "Còn nhiều chia sẻ khác anh/chị có thể xem trên web, hoặc inbox em nghe trực tiếp ạ"

Nếu KHÔNG có REAL_REVIEW (fallback): KHÔNG BỊA review. Thay vào đó dùng social proof khác như:
  "[Hotel] đang có rating [X.X]/5 từ [N] khách đã ở" + 2-3 USP + CTA inbox

TONE: authentic, social proof thật, tôn trọng khách.
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
    behind_scenes: `
ANGLE: Hậu trường & Con người — nội dung NGƯỜI THẬT, mộc, đời thường (reach tự nhiên cao nhất).

Mục tiêu: chạm cảm xúc + tạo thiện cảm. KHÔNG quảng cáo bóng bẩy, KHÔNG liệt kê tiện ích khô khan.
Mở bài (HOOK 3 giây — bắt buộc giật để người xem dừng lướt):
  VD "9h sáng ở ${hotel.name} trông như thế nào", "Thứ khách không thấy khi nhận phòng", "Một ngày của lễ tân Sonder".
Thân bài: 1 khoảnh khắc đời thường thật (set up phòng chuẩn chỉnh, pha nước chào khách, kiểm tra từng chi tiết trước giờ nhận phòng) + 1 hành động tử tế khiến khách an tâm.
Kết: CTA nhẹ "anh/chị muốn xem phòng thật thì inbox em nhé ạ".

TONE: gần gũi, chân thật, người thật việc thật.
`,
    local_guide: `
ANGLE: Cẩm nang địa phương — nội dung ĐÁNG LƯU & ĐÁNG CHIA SẺ (tăng Save + Share — tín hiệu reach mạnh nhất).

Mục tiêu: hữu ích tới mức khách lưu lại — không cần đặt phòng vẫn thấy giá trị, từ đó nhớ tới Sonder.
Mở bài (HOOK dạng danh sách):
  VD "5 quán ăn quanh ${hotel.district} dân địa phương mới biết", "Tới ${hotel.district} đừng bỏ lỡ 4 chỗ này".
Thân bài: 3-5 gợi ý cụ thể quanh khu (quán ăn / cà phê / điểm check-in / tiện ích) + mỗi gợi ý 1 dòng vì sao đáng đi. Lồng khéo: "ở ${hotel.name} đi bộ/vài phút là tới".
Kết: CTA nhẹ "lưu lại kẻo quên ạ — cần chỗ ở ngay khu này thì inbox em".

TONE: như người bạn địa phương chỉ đường. Cho giá trị trước, bán sau.
`,
    seasonal: `
ANGLE: Bắt trend & mùa — đón sóng dịp/lễ/mùa đang diễn ra để đúng lúc khách cần.

Mục tiêu: bám thời điểm hiện tại (cuối tuần, lễ, hè, mùa mưa, Tết, sự kiện...) → đúng nhu cầu, dễ lan.
Mở bài (HOOK theo dịp):
  VD "Cuối tuần này trốn nóng ở đâu?", "Hè tới rồi, đặt phòng ${hotel.district} trước kẻo hết".
Thân bài: nối dịp hiện tại với 1-2 lý do ${hotel.name} hợp dịp đó (mát, gần trung tâm/biển, hợp nhóm bạn/gia đình, tiện đi sự kiện).
Kết: CTA có tính thời điểm — CHỈ nói "còn ít phòng / chốt sớm" nếu ĐÚNG SỰ THẬT, tuyệt đối không khan hiếm giả.

TONE: đúng thời điểm, năng lượng, trung thực.
`,
    travel_tips: `
ANGLE: Mẹo du lịch — chia sẻ MẸO HỮU ÍCH đáng lưu (KHÔNG bán phòng trực tiếp).

Mục tiêu: cho giá trị thật → khách lưu lại + thấy Sonder "có tâm".
Mở bài (HOOK dạng mẹo): VD "Mẹo đặt phòng rẻ mà đẹp ít ai biết:", "3 thứ nên check trước khi đặt phòng:".
Thân bài: 3-4 mẹo NGẮN, thực tế, mỗi mẹo 1 dòng (VD: đặt tối Chủ nhật giá thường mềm hơn; luôn xem ảnh thật + review trước; hỏi rõ phụ phí kẻo bất ngờ; đặt trực tiếp web thường rẻ hơn app trung gian).
Kết: CTA nhẹ "lưu lại dùng dần nhé ạ — cần chỗ đặt phòng minh bạch giá thì có sondervn.com".

TONE: hữu ích, thân thiện, như người trong nghề mách nước. Cho giá trị trước, bán sau.
`,
    meme_trend: `
ANGLE: Meme & Bắt trend — nội dung DÍ DỎM, RELATABLE, bắt trend giới trẻ (người xem dừng lướt vì "đúng quá").

Mục tiêu: gây cười / gật gù "sao đúng vậy" → comment + share. KHÔNG bán phòng, chỉ giải trí + ngầm gợi nhớ Sonder.
Format (chọn 1 cho hợp): "POV: ...", "Không ai cả / Tuyệt đối không ai... / Tôi lúc 2h sáng: ...", "3 kiểu người khi đi du lịch", "Khi [tình huống] vs Khi [tình huống]".
Mở bài = HOOK meme CỰC relatable về du lịch / đặt phòng / đi chơi của giới trẻ (lương về là đi, hội bạn ngủ nướng, deadline dí vẫn muốn trốn, ảnh sống ảo vs thực tế...).
Thân: triển khai cái meme/insight đó vui vẻ, đời thường, chạm đúng tâm lý.
Kết: 1 câu chốt hài + CTA SIÊU NHẸ kiểu "thôi đi trốn cho lành 👉 sondervn.com" (không ép).

GIỌNG: trẻ, hài, bắt trend, dùng "tụi mình/bạn", emoji vui. KHÔNG cần "ạ", KHÔNG kiểu tư vấn viên.
`,
    healing: `
ANGLE: Chữa lành & Sống chậm — nội dung CẢM XÚC, aesthetic, bắt trend "chữa lành" của giới trẻ.

Mục tiêu: chạm cảm xúc (mệt mỏi, cần nghỉ, cần trốn) → khách thấy đồng điệu + lưu/share. Bán CỰC mềm.
Mở bài = HOOK cảm xúc nhẹ: VD "Đôi khi chữa lành chỉ là...", "Có những ngày chỉ muốn tắt hết thông báo và biến mất 1-2 hôm...".
Thân: vẽ ra 1 khung cảnh nghỉ ngơi đẹp, chậm rãi (ban công đầy nắng, ly cà phê, không báo thức, view yên tĩnh) — gắn NHẸ với không gian / khu ${hotel.district || 'mình thích'}.
Kết: lời mời nhẹ tự thưởng cho bản thân + CTA mềm "tìm 1 chỗ trốn cho cuối tuần: sondervn.com".

GIỌNG: nhẹ nhàng, thơ, đồng cảm, aesthetic. Ít emoji tinh tế (☁️ 🌿 🤍). KHÔNG selly, KHÔNG liệt kê tiện ích.
`,
    interactive: `
ANGLE: Tương tác — câu hỏi / poll / tag bạn để KÉO COMMENT (tín hiệu reach mạnh).

Mục tiêu: khiến người xem PHẢI comment hoặc tag bạn. NGẮN, vui, dễ trả lời.
Format (chọn 1): "Chọn 1: 🏖️ biển hay ⛰️ núi?", "Team nào đây: ... / ...", "Tag ngay đứa bạn 'nói đi là đi' của bạn 👀", "Điền vào chỗ trống: chuyến đi tiếp theo của tôi là ___".
Mở bài = câu hỏi / thử thách bắt trend.
Thân: 2-4 dòng, đưa 2 lựa chọn vui HOẶC 1 lời mời tag/cmt. Gài nhẹ ${hotel.district || ''} nếu hợp.
Kết: kêu gọi comment/tag RÕ + CTA nhẹ sondervn.com.

GIỌNG: vui, trẻ, tương tác cao, dùng "bạn/tụi mình", nhiều emoji. RẤT NGẮN (dưới 80 từ).
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
    // smart-cascade removed in 2026-05-11 pivot — use unified router instead.
    const { generate } = require('../router');
    const text = await generate({
      task: 'caption',
      system: 'Bạn tạo bài đăng marketing cho Sonder. Luôn tuân thủ brand voice + CTA rõ ràng.',
      user: prompt,
      temperature: 0.8,
      maxTokens: 500,
    });
    const result = { text, provider: 'router' };

    let caption = (result.text || '').trim();
    // Remove markdown residue
    caption = caption
      .replace(/\*\*/g, '')
      .replace(/__/g, '')
      .replace(/^#+\s+/gm, '')
      .replace(/```[\s\S]*?```/g, '')
      .trim();

    // v25: Persona post-process — auto-fix LLM slip-ups of banned pronouns.
    //      LLM đôi khi dùng "mình" reflexive ("giữ phòng cho mình") — replace bằng context-appropriate.
    //      ⚠️ BỎ QUA với trụ "giọng trẻ" (meme/chữa lành/tương tác) — giữ "bạn/tụi mình" cho tự nhiên.
    if (!YOUTH_ANGLES.has(angle)) caption = postProcessPersona(caption);

    // QA: check length (trụ tương tác được phép ngắn)
    const minLen = angle === 'interactive' ? 40 : 80;
    if (caption.length < minLen) {
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
 * Sinh KỊCH BẢN VIDEO NGẮN (Reels/TikTok 15-30s) từ caption đã có — chủ nhà/đội tự quay bằng điện thoại + đăng tay.
 * Nâng cấp 07/06/2026 theo best-practice content 2026: hook 1-3s quyết định giữ chân; quay ĐỜI THỰC (chủ nhà/khách/
 * hậu trường/khu phố) không chỉ tour phòng; có điểm giữ chân giữa video; CTA đặt TRỰC TIẾP; caption + hashtag sẵn để đăng.
 * (32% khách đã từng đặt phòng từ TikTok; Reels reach gấp 5-10 lần bài thường.)
 */
export async function generateReelScript(caption: string): Promise<string | null> {
  try {
    const { generate } = require('../router');
    const system = 'Bạn là content creator + đạo diễn video ngắn (Reels/TikTok) ngành lưu trú, bám chuẩn 2026. Nguyên tắc: (1) HOOK 1-3 giây quyết định người xem ở lại hay lướt — phải mạnh nhất; (2) quay ĐỜI THỰC, chân thật kiểu UGC (chủ nhà, khách, hậu trường, khu phố) chứ KHÔNG chỉ tour phòng trống; (3) cảm xúc + nét bản địa; (4) có 1 điểm bất ngờ giữa video để xem hết; (5) CTA dẫn về ĐẶT TRỰC TIẾP. Viết kịch bản quay bằng điện thoại — thực tế, dễ làm, không cần thiết bị chuyên nghiệp.';
    const user = `Dưới đây là 1 bài đăng về 1 chỗ lưu trú của Sonder (sondervn.com):
"""
${caption}
"""

Hãy biến nội dung trên thành 1 KỊCH BẢN VIDEO NGẮN (Reels/TikTok) 15-30 giây để tự quay bằng điện thoại rồi đăng tay. Trình bày ĐÚNG các mục sau, mỗi mục xuống dòng rõ ràng:

ĐỊNH DẠNG: chọn 1 kiểu hợp nội dung (Mở phòng bất ngờ / Mẹo của chủ nhà / Tour khu phố quanh đây / Khoảnh khắc của khách / Trước–sau / POV khách bước vào).
HOOK 1-3 GIÂY: 1 câu mở đầu CỰC mạnh khiến dừng lướt + ghi rõ kiểu hook (tò mò / khẳng định bất ngờ / câu hỏi) + chữ overlay khung hình đầu. Đây là phần quan trọng nhất.
SHOTLIST: 4-6 cảnh, mỗi cảnh ghi: số thứ tự + quay gì + góc máy + mấy giây. BẮT BUỘC có ít nhất 1 cảnh CÓ NGƯỜI (chủ nhà/khách/nhân viên) — không chỉ phòng trống.
CHỮ TRÊN MÀN HÌNH: text ngắn cho từng cảnh.
GIỮ CHÂN: 1 chi tiết bất ngờ/đắt giá đặt ở giữa video để người xem coi hết.
NHẠC/ÂM THANH: gợi ý thể loại nhạc đang trend phù hợp (mô tả thể loại, không cần tên bài).
CAPTION ĐĂNG KÈM: 2-3 câu cho phần mô tả video, kết bằng CTA mời ĐẶT TRỰC TIẾP tại sondervn.com (nhấn mạnh đặt trực tiếp, không qua app trung gian).
HASHTAG: 6-8 hashtag, gồm #sondervn + khu vực + loại hình lưu trú + du lịch Việt Nam.

Yêu cầu: tiếng Việt, gọi khách "anh/chị", giọng tự nhiên đời thường (không sáo rỗng). KHÔNG dùng markdown in đậm/nghiêng (không *, không **) — riêng mục HASHTAG được dùng dấu #. Tổng không quá 300 từ.`;
    const text = await generate({
      task: 'caption',
      system,
      user,
      temperature: 0.85,
      maxTokens: 950,
    });
    let script = (text || '').trim()
      .replace(/\*\*/g, '')
      .replace(/__/g, '')
      .replace(/^#+\s+/gm, '')
      .replace(/\`\`\`[\s\S]*?\`\`\`/g, '')
      .trim();
    if (script.length < 60) {
      console.warn('[reel-script] too short, rejected');
      return null;
    }
    if (script.length > 3000) script = script.slice(0, 2950) + '...';
    return script;
  } catch (e: any) {
    console.error('[reel-script] fail:', e?.message);
    return null;
  }
}

/**
 * v25: Post-process để fix LLM persona slip-ups.
 * LLM đôi khi dùng "mình" reflexive hoặc "bạn" formal — replace theo context.
 */
function postProcessPersona(text: string): string {
  let out = text;

  // "giữ phòng cho mình" → "giữ phòng cho anh/chị" (self-reference tới khách)
  // "cho mình biết" → "cho em biết"
  // "với mình" → "với em"
  out = out.replace(/\bcho\s+mình\s+(biết|gửi|xin|lấy|số)\b/gi, 'cho em $1');
  out = out.replace(/\bvới\s+mình\b/gi, 'với em');
  out = out.replace(/\b(inbox|nhắn|gọi|liên hệ)\s+mình\b/gi, '$1 em');
  out = out.replace(/\bgiữ\s+(phòng|chỗ|đơn)\s+cho\s+mình\b/gi, 'giữ $1 cho anh/chị');

  // "tôi" → "em" (trong context bot self-reference)
  out = out.replace(/\b(của\s+)?tôi\b/gi, '$1em');

  // "bạn" formal → "anh/chị"
  out = out.replace(/\bbạn\b/gi, 'anh/chị');

  // "mình" standalone (bot tự xưng) → "em"
  //   Chỉ match khi không trong compound word như "gia đình mình" (giữ nguyên)
  //   Pattern safe: mình at start hoặc sau dấu câu
  out = out.replace(/(^|[.,!?\s])Mình\b/g, '$1Em');
  // lowercase version
  out = out.replace(/(^|[.,!?]\s)mình\b/g, '$1em');

  // Cleanup: double spaces
  out = out.replace(/\s+/g, ' ').trim();

  return out;
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
export function validateCaption(caption: string, hotel: HotelCandidate, angle?: Angle): { ok: boolean; issues: string[] } {
  const issues: string[] = [];
  const strictPersona = !angle || !YOUTH_ANGLES.has(angle);   // trụ giọng trẻ: KHÔNG ép persona/tên KS
  if (caption.length < (angle === 'interactive' ? 40 : 80)) issues.push('too_short');
  if (caption.length > 2200) issues.push('too_long');
  // Persona check (bỏ với giọng trẻ)
  if (strictPersona && /\b(bạn|tôi|mình|quý khách)\b/i.test(caption)) issues.push('persona_violation_banned_pronoun');
  if (strictPersona && !/anh\/chị|anh\s|chị\s/i.test(caption)) issues.push('persona_missing_anh_chi');
  // CTA check
  if (!/inbox|sondervn|web|gọi|liên hệ|đặt phòng|xem thêm/i.test(caption)) issues.push('missing_cta');
  // Hotel name mention (bỏ với giọng trẻ — nội dung lifestyle không cần nêu tên KS)
  if (strictPersona && !caption.toLowerCase().includes(hotel.name.toLowerCase().split(' ')[0])) issues.push('hotel_name_not_mentioned');
  return { ok: issues.length === 0, issues };
}

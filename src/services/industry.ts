/**
 * Industry templates — unlock vertical expansion (BET 1).
 *
 * Mỗi industry có:
 *  - label, emoji
 *  - system_prompt suffix cho chatbot (xưng hô + hành vi phù hợp)
 *  - seed wiki entries (12-15 mục khởi động khi signup)
 *  - common intents (dùng sau này cho intent classifier riêng)
 *  - default features (ví dụ: hotel có booking flow, restaurant có menu, spa có appointment)
 */
import { db } from '../db';

export interface IndustryTemplate {
  id: string;
  label: string;
  emoji: string;
  system_prompt: string;
  wiki_seed: Array<{ title: string; content: string; tags: string[] }>;
  features: {
    booking?: boolean;
    appointment?: boolean;
    menu?: boolean;
    ecommerce_cart?: boolean;
  };
}

const INDUSTRIES: Record<string, IndustryTemplate> = {
  hotel: {
    id: 'hotel', label: 'Khách sạn / Homestay / Resort', emoji: '🏨',
    system_prompt: `Bạn là lễ tân khách sạn lịch sự, thân thiện, gọi khách là "anh/chị".
Ưu tiên: hỏi ngày nhận/trả phòng → tư vấn loại phòng phù hợp → chốt booking → xin SĐT để staff liên hệ.
Không bịa giá hoặc tiện nghi chưa có trong wiki.`,
    features: { booking: true },
    wiki_seed: [
      { title: 'Giờ nhận phòng / trả phòng', content: 'Check-in từ 14:00, check-out trước 12:00. Nhận phòng sớm / trả trễ tùy tình trạng phòng (có thể tính phí nửa ngày).', tags: ['gio', 'check-in'] },
      { title: 'Chính sách đặt cọc', content: 'Đặt cọc 50% giá trị đơn để giữ phòng. Hoàn 100% nếu hủy ≥ 48h trước check-in.', tags: ['dat-coc', 'huy'] },
      { title: 'Thanh toán', content: 'Chấp nhận tiền mặt, chuyển khoản, QR, Visa/Master. Xuất VAT theo yêu cầu.', tags: ['thanh-toan'] },
      { title: 'Ăn sáng', content: 'Ăn sáng buffet đã bao gồm trong giá phòng (6:30 - 10:00 hàng ngày).', tags: ['an-sang', 'tien-nghi'] },
      { title: 'Wifi + bãi đỗ xe', content: 'Wifi miễn phí tốc độ cao toàn khách sạn. Bãi đỗ xe máy miễn phí, ô tô 50k/đêm.', tags: ['wifi', 'dich-vu'] },
    ],
  },
  restaurant: {
    id: 'restaurant', label: 'Nhà hàng / Quán ăn / Cafe', emoji: '🍽️',
    system_prompt: `Bạn là nhân viên nhà hàng nhiệt tình, giới thiệu menu + nhận đặt bàn.
Hành vi: gợi ý món theo khẩu vị/số người → xác nhận ngày giờ đặt bàn → xin tên + SĐT.
Không tự ý giảm giá hoặc hứa khuyến mãi không có trong wiki.`,
    features: { appointment: true, menu: true },
    wiki_seed: [
      { title: 'Giờ mở cửa', content: 'Mở cửa 10:00 - 22:30 tất cả các ngày trong tuần. Nhận khách cuối lúc 22:00.', tags: ['gio-mo'] },
      { title: 'Đặt bàn', content: 'Đặt bàn trước tối thiểu 2h qua Zalo/hotline. Miễn phí. Giữ bàn 15 phút nếu khách đến muộn.', tags: ['dat-ban'] },
      { title: 'Tổ chức tiệc / sinh nhật', content: 'Nhận tiệc 20-100 khách, có phòng riêng. Trang trí sinh nhật miễn phí (bánh, bóng bay, card chúc). Đặt trước ≥ 1 ngày.', tags: ['tiec', 'sinh-nhat'] },
      { title: 'Menu đặc trưng', content: 'Món nổi bật: [cần KS cập nhật]. Giá set menu từ 199k/người. Thực đơn trẻ em riêng.', tags: ['menu'] },
      { title: 'Giao hàng / takeaway', content: 'Giao hàng qua ShopeeFood, GrabFood, GoFood. Đặt trực tiếp qua Zalo được giảm 10%.', tags: ['giao-hang'] },
    ],
  },
  spa: {
    id: 'spa', label: 'Spa / Salon / Massage', emoji: '💆',
    system_prompt: `Bạn là tư vấn viên spa chuyên nghiệp, gợi ý liệu trình phù hợp với nhu cầu khách.
Hành vi: hỏi tình trạng da/cơ thể + ngân sách → đề xuất liệu trình → xin lịch hẹn + SĐT.
Không chẩn đoán y khoa. Chỉ tư vấn trong phạm vi dịch vụ spa.`,
    features: { appointment: true },
    wiki_seed: [
      { title: 'Giờ hoạt động', content: 'Mở cửa 9:00 - 21:00. Đặt lịch qua Zalo/hotline. Khách nên đến trước 10 phút.', tags: ['gio-mo'] },
      { title: 'Dịch vụ chủ lực', content: 'Chăm sóc da mặt (từ 300k), massage body (từ 400k/60p), gội đầu dưỡng sinh (150k), triệt lông (từ 500k/vùng).', tags: ['dich-vu', 'gia'] },
      { title: 'Combo ưu đãi', content: 'Combo 5 buổi chăm sóc da giảm 20%. Combo 10 buổi giảm 30% + tặng 1 buổi miễn phí.', tags: ['combo', 'uu-dai'] },
      { title: 'Đặt lịch / hủy', content: 'Đặt trước ≥ 2h. Hủy lịch ≥ 3h trước giờ hẹn miễn phí. Báo muộn/no-show sẽ tính 30% phí.', tags: ['dat-lich', 'huy'] },
      { title: 'Sản phẩm sử dụng', content: 'Dùng mỹ phẩm có thương hiệu, có chứng nhận. Cam kết không chứa corticoid, paraben. An toàn cho da nhạy cảm.', tags: ['san-pham', 'an-toan'] },
    ],
  },
  clinic: {
    id: 'clinic', label: 'Phòng khám / Nha khoa / Thẩm mỹ', emoji: '🏥',
    system_prompt: `Bạn là lễ tân phòng khám, tiếp nhận lịch hẹn và tư vấn dịch vụ cơ bản.
KHÔNG tự ý chẩn đoán bệnh hoặc kê đơn. Luôn khuyên khách đến khám trực tiếp với bác sĩ.
Hành vi: hỏi triệu chứng khái quát → gợi ý chuyên khoa phù hợp → đặt lịch + xin SĐT.`,
    features: { appointment: true },
    wiki_seed: [
      { title: 'Giờ khám', content: 'Sáng 8:00 - 12:00, chiều 14:00 - 20:00. Nghỉ trưa 12:00-14:00. Mở cửa cả thứ 7 + chủ nhật.', tags: ['gio-mo'] },
      { title: 'Đặt lịch khám', content: 'Đặt qua Zalo/hotline. Miễn phí. Cần họ tên + SĐT + triệu chứng chính. Nhắc lịch trước 1h.', tags: ['dat-lich'] },
      { title: 'Bảo hiểm y tế', content: 'Chấp nhận BHYT và các loại bảo hiểm thương mại (Bảo Việt, Manulife, PVI, ...). Mang theo thẻ khi khám.', tags: ['bao-hiem'] },
      { title: 'Bảng giá dịch vụ', content: 'Khám tổng quát từ 200k, xét nghiệm máu 150k, siêu âm 200k, chụp X-quang 150k. [KS cập nhật chi tiết]', tags: ['gia'] },
      { title: 'Đội ngũ bác sĩ', content: 'Bác sĩ có ≥ 5 năm kinh nghiệm, tốt nghiệp Đại học Y. Danh sách cụ thể trên website.', tags: ['bac-si'] },
    ],
  },
  real_estate: {
    id: 'real_estate', label: 'Bất động sản / Môi giới', emoji: '🏡',
    system_prompt: `Bạn là môi giới BĐS chuyên nghiệp, tư vấn dự án/căn hộ/đất phù hợp.
Hành vi: hỏi ngân sách + khu vực + mục đích (ở/đầu tư) → gợi ý 2-3 option → xin SĐT để gửi brochure.
Không hứa tăng giá hay cam kết lợi nhuận cố định.`,
    features: { appointment: true },
    wiki_seed: [
      { title: 'Khu vực hoạt động', content: 'Chuyên BĐS tại [khu vực]. Có sản phẩm từ căn hộ 1.5 tỷ đến biệt thự 20 tỷ. [KS cập nhật]', tags: ['khu-vuc'] },
      { title: 'Hỗ trợ vay vốn', content: 'Liên kết 5 ngân hàng lớn (Vietcombank, BIDV, Techcombank, MB, ACB). Hỗ trợ vay đến 70% giá trị, lãi suất ưu đãi.', tags: ['vay', 'ngan-hang'] },
      { title: 'Phí môi giới', content: 'Miễn phí tư vấn. Phí môi giới do bên bán trả (theo thị trường 1-2%). Khách mua không trả phí môi giới.', tags: ['phi'] },
      { title: 'Quy trình mua', content: '1) Tư vấn → 2) Xem nhà → 3) Đặt cọc giữ chỗ → 4) Ký hợp đồng → 5) Thanh toán theo tiến độ → 6) Bàn giao/sổ hồng.', tags: ['quy-trinh'] },
    ],
  },
  education: {
    id: 'education', label: 'Trung tâm giáo dục / Gia sư', emoji: '🎓',
    system_prompt: `Bạn là tư vấn viên trung tâm giáo dục, giới thiệu khóa học phù hợp trình độ học viên.
Hành vi: hỏi trình độ/mục tiêu/tuổi → gợi ý khóa → mời test đầu vào miễn phí → xin SĐT phụ huynh.
Không hứa điểm số cụ thể khi không có căn cứ.`,
    features: { appointment: true },
    wiki_seed: [
      { title: 'Các khóa học', content: 'Tiếng Anh (IELTS, TOEIC, giao tiếp), Toán/Văn/Anh từ lớp 1-12, lập trình cho trẻ em. [KS cập nhật chi tiết]', tags: ['khoa-hoc'] },
      { title: 'Học phí', content: 'Từ 1.5tr-3.5tr/khóa 3 tháng tùy môn. Đăng ký theo khóa/combo 3 khóa giảm 10%, đăng ký nhóm ≥ 3 bạn giảm 15%.', tags: ['hoc-phi'] },
      { title: 'Giáo viên', content: 'Giáo viên có chứng chỉ sư phạm + chứng chỉ chuyên môn (IELTS 7.5+, TESOL,...). Kinh nghiệm 3+ năm.', tags: ['giao-vien'] },
      { title: 'Test đầu vào miễn phí', content: 'Test trình độ miễn phí để xếp lớp phù hợp. Đặt lịch qua hotline/Zalo, nhận kết quả + tư vấn trong 30 phút.', tags: ['test'] },
      { title: 'Lịch học', content: 'Linh hoạt: ca tối 18-20h, cuối tuần sáng/chiều. 2 buổi/tuần × 90 phút.', tags: ['lich-hoc'] },
    ],
  },
  ecommerce: {
    id: 'ecommerce', label: 'Shop online / E-commerce', emoji: '🛍️',
    system_prompt: `Bạn là nhân viên CSKH shop online, tư vấn sản phẩm + chốt đơn.
Hành vi: hỏi nhu cầu → giới thiệu 1-2 sản phẩm phù hợp → chốt size/màu → xin địa chỉ + SĐT giao hàng.
Không tự ý giảm giá ngoài khuyến mãi chính thức.`,
    features: { ecommerce_cart: true },
    wiki_seed: [
      { title: 'Phí ship / thời gian', content: 'Nội thành HN/HCM 20-30k, giao 1-2 ngày. Tỉnh 30-50k, 2-4 ngày. Đơn ≥ 500k miễn ship nội thành.', tags: ['ship', 'phi'] },
      { title: 'Đổi trả', content: 'Đổi trả trong 7 ngày nếu lỗi do shop hoặc sản phẩm không đúng mô tả. Khách chịu phí ship chiều đổi nếu đổi size/màu.', tags: ['doi-tra'] },
      { title: 'Thanh toán', content: 'COD (nhận hàng trả tiền), chuyển khoản, QR, ví MoMo/ZaloPay. Thanh toán trước được giảm 20k/đơn.', tags: ['thanh-toan'] },
      { title: 'Bảo hành', content: 'Bảo hành 12 tháng cho lỗi nhà sản xuất. Mang sản phẩm + hóa đơn đến shop hoặc gửi qua bưu điện.', tags: ['bao-hanh'] },
      { title: 'Khuyến mãi hiện tại', content: '[KS cập nhật theo tháng]. Follow fanpage + Zalo OA để nhận mã giảm giá mới nhất.', tags: ['uu-dai'] },
    ],
  },
  other: {
    id: 'other', label: 'Khác / Tùy chỉnh', emoji: '✨',
    system_prompt: `Bạn là trợ lý tư vấn của doanh nghiệp, trả lời thân thiện và chính xác.
Nếu không biết, thành thật nói "Em chưa có thông tin, anh/chị chờ em hỏi lại ạ" và xin SĐT.`,
    features: {},
    wiki_seed: [
      { title: 'Giờ hoạt động', content: '[Chủ doanh nghiệp cập nhật]', tags: ['gio-mo'] },
      { title: 'Dịch vụ chính', content: '[Chủ doanh nghiệp cập nhật danh sách dịch vụ]', tags: ['dich-vu'] },
      { title: 'Liên hệ', content: '[Số điện thoại, địa chỉ, website]', tags: ['lien-he'] },
    ],
  },
};

export function getIndustryTemplate(id: string): IndustryTemplate {
  return INDUSTRIES[id] || INDUSTRIES.hotel;
}

export function listIndustries(): Array<{ id: string; label: string; emoji: string }> {
  return Object.values(INDUSTRIES).map(i => ({ id: i.id, label: i.label, emoji: i.emoji }));
}

/** Seed wiki cho hotel mới khi signup, dựa trên industry đã chọn. */
export function seedIndustryWiki(hotelId: number, industryId: string): number {
  const tpl = getIndustryTemplate(industryId);
  const now = Date.now();
  const stmt = db.prepare(
    `INSERT INTO knowledge_wiki (namespace, slug, title, content, tags, always_inject, active, hotel_id, updated_at, created_at)
     VALUES ('industry-seed', ?, ?, ?, ?, 0, 1, ?, ?, ?)`
  );
  let count = 0;
  const tx = db.transaction(() => {
    for (const [i, e] of tpl.wiki_seed.entries()) {
      const slug = `seed-${hotelId}-${industryId}-${i}`;
      try {
        stmt.run(slug, e.title, e.content, JSON.stringify(e.tags || []), hotelId, now, now);
        count++;
      } catch { /* unique conflict, skip */ }
    }
  });
  tx();
  return count;
}

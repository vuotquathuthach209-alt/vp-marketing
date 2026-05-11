/**
 * Response Template Library.
 *
 * Admin curates pre-written responses → quick copy/paste when replying to reviews/comments.
 * NOT auto-send. Just a lookup library.
 *
 * Features:
 *   - Categorize (greeting, thanks, apology, info, response_positive/negative_review, etc.)
 *   - Tagged with trigger_keywords for fast lookup
 *   - Support {{variables}} (e.g. {{customer_name}}, {{hotel_name}})
 *   - Track use_count for "most used" sorting
 */

import { db } from '../../db';
import type { TemplateCategory, ResponseTemplate } from './types';

export interface RenderedTemplate {
  template_id: number;
  rendered: string;
  variables_used: Record<string, string>;
}

/** List templates with filter. */
export function listTemplates(opts?: {
  category?: TemplateCategory;
  language?: 'vi' | 'en';
  hotel_id?: number;
  active_only?: boolean;
}): ResponseTemplate[] {
  let sql = `SELECT * FROM care_templates WHERE 1=1`;
  const params: any[] = [];
  if (opts?.category) { sql += ` AND category = ?`; params.push(opts.category); }
  if (opts?.language) { sql += ` AND language = ?`; params.push(opts.language); }
  if (opts?.hotel_id !== undefined) {
    sql += ` AND (hotel_id = ? OR hotel_id IS NULL)`;
    params.push(opts.hotel_id);
  }
  if (opts?.active_only !== false) sql += ` AND active = 1`;
  sql += ` ORDER BY use_count DESC, updated_at DESC`;
  return db.prepare(sql).all(...params) as ResponseTemplate[];
}

/** Get single template. */
export function getTemplate(id: number): ResponseTemplate | null {
  return (db.prepare(`SELECT * FROM care_templates WHERE id = ?`).get(id) as any) || null;
}

/** Create/update template. */
export function upsertTemplate(t: Partial<ResponseTemplate> & {
  category: TemplateCategory;
  title: string;
  body: string;
  language?: 'vi' | 'en';
}): { id: number; created: boolean } {
  const now = Date.now();
  if (t.id) {
    db.prepare(
      `UPDATE care_templates SET
         category = ?, trigger_keywords = ?, language = ?, title = ?, body = ?,
         variables = ?, hotel_id = ?, active = ?, updated_at = ?
       WHERE id = ?`,
    ).run(
      t.category, t.trigger_keywords || '[]', t.language || 'vi', t.title, t.body,
      t.variables || '[]', t.hotel_id || null, t.active === 0 ? 0 : 1, now,
      t.id,
    );
    return { id: t.id, created: false };
  }
  const r = db.prepare(
    `INSERT INTO care_templates
     (category, trigger_keywords, language, title, body, variables, hotel_id, active, use_count, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
  ).run(
    t.category, t.trigger_keywords || '[]', t.language || 'vi', t.title, t.body,
    t.variables || '[]', t.hotel_id || null, t.active === 0 ? 0 : 1,
    now, now,
  );
  return { id: r.lastInsertRowid as number, created: true };
}

/** Delete template. */
export function deleteTemplate(id: number): boolean {
  const r = db.prepare(`DELETE FROM care_templates WHERE id = ?`).run(id);
  return r.changes > 0;
}

/** Render template with variables. {{customer_name}} → actual value. */
export function renderTemplate(id: number, variables: Record<string, string>): RenderedTemplate | null {
  const t = getTemplate(id);
  if (!t) return null;

  let rendered = t.body;
  for (const [k, v] of Object.entries(variables)) {
    rendered = rendered.replace(new RegExp(`{{\\s*${k}\\s*}}`, 'g'), v);
  }
  // Mark unused vars with [missing var]
  rendered = rendered.replace(/\{\{\s*(\w+)\s*\}\}/g, '[$1]');

  // Increment use_count
  db.prepare(`UPDATE care_templates SET use_count = use_count + 1 WHERE id = ?`).run(id);

  return { template_id: id, rendered, variables_used: variables };
}

/** Suggest templates that match given text (by keyword overlap). */
export function suggestTemplates(text: string, opts?: {
  language?: 'vi' | 'en';
  category?: TemplateCategory;
  limit?: number;
}): Array<ResponseTemplate & { match_score: number }> {
  const textLower = text.toLowerCase();
  const limit = opts?.limit || 5;

  let templates = listTemplates({
    language: opts?.language,
    category: opts?.category,
    active_only: true,
  });

  // Score by keyword overlap
  const scored = templates.map((t) => {
    let score = 0;
    try {
      const keywords: string[] = JSON.parse(t.trigger_keywords || '[]');
      for (const kw of keywords) {
        if (textLower.includes(String(kw).toLowerCase())) score += 1;
      }
    } catch {}
    // Boost by use_count (popularity bonus)
    score += Math.log(1 + (t.use_count || 0)) * 0.3;
    return { ...t, match_score: score };
  });

  scored.sort((a, b) => b.match_score - a.match_score);
  return scored.slice(0, limit);
}

/** Seed default templates (idempotent). Run on first boot or via admin command. */
export function seedDefaultTemplates(): number {
  const existing = db.prepare(`SELECT COUNT(*) AS n FROM care_templates`).get() as { n: number };
  if (existing.n > 0) return 0;

  const defaults: Array<Partial<ResponseTemplate>> = [
    {
      category: 'response_positive_review',
      title: 'Cảm ơn review tích cực (VI)',
      language: 'vi',
      body: `Cảm ơn anh/chị {{customer_name}} rất nhiều vì những đánh giá tích cực! 🙏

Sondervn rất vui khi đã đồng hành cùng anh/chị trong chuyến lưu trú vừa rồi. Chúng tôi sẽ chuyển lời khen ngợi đến khách sạn đối tác để họ tiếp tục phục vụ tốt hơn nữa.

Hẹn gặp lại anh/chị trong những lần đặt phòng tiếp theo tại sondervn.com! ✨`,
      trigger_keywords: JSON.stringify(['cảm ơn', 'tuyệt vời', 'tốt', 'hài lòng', 'recommend', 'thanks']),
      variables: JSON.stringify([{ name: 'customer_name', label: 'Tên khách', default: 'anh/chị' }]),
    },
    {
      category: 'response_negative_review',
      title: 'Xin lỗi + xử lý phản ánh tiêu cực (VI)',
      language: 'vi',
      body: `Chân thành cảm ơn anh/chị {{customer_name}} đã chia sẻ trải nghiệm.

Sondervn rất tiếc khi chuyến lưu trú không được như mong đợi. Chúng tôi sẽ liên hệ trực tiếp với khách sạn {{hotel_name}} để làm rõ vấn đề và phản hồi anh/chị trong vòng 24h.

Vui lòng gửi email mã đặt phòng về cs@sondervn.com để chúng tôi xử lý nhanh nhất. Mong anh/chị thông cảm. 🙏`,
      trigger_keywords: JSON.stringify(['bẩn', 'hôi', 'tệ', 'không hài lòng', 'phòng xấu', 'nhân viên', 'thái độ', 'lừa đảo', 'kiện']),
      variables: JSON.stringify([
        { name: 'customer_name', label: 'Tên khách', default: 'anh/chị' },
        { name: 'hotel_name', label: 'Tên khách sạn', default: '' },
      ]),
    },
    {
      category: 'response_question',
      title: 'Trả lời câu hỏi giá phòng (VI)',
      language: 'vi',
      body: `Chào anh/chị {{customer_name}}!

Giá phòng tại {{hotel_name}} dao động tuỳ ngày + loại phòng. Vui lòng tham khảo trực tiếp tại sondervn.com/khach-san/{{hotel_slug}} để xem giá realtime + đặt phòng nhanh.

Cần hỗ trợ thêm, anh/chị inbox hoặc gọi 094.288.3133 nhé.`,
      trigger_keywords: JSON.stringify(['giá phòng', 'bao nhiêu', 'cost', 'price', 'báo giá']),
      variables: JSON.stringify([
        { name: 'customer_name', label: 'Tên khách', default: 'anh/chị' },
        { name: 'hotel_name', label: 'Tên khách sạn', default: '' },
        { name: 'hotel_slug', label: 'Hotel slug URL', default: '' },
      ]),
    },
    {
      category: 'greeting',
      title: 'Chào mừng & giới thiệu (VI)',
      language: 'vi',
      body: `Chào anh/chị {{customer_name}}!

Cảm ơn anh/chị đã quan tâm Sondervn — nền tảng đặt phòng khách sạn chọn lọc tại Việt Nam.

Anh/chị tìm phòng ở khu vực nào ạ? Em sẽ gợi ý các options phù hợp nhất.`,
      trigger_keywords: JSON.stringify(['xin chào', 'hello', 'hi', 'chào']),
      variables: JSON.stringify([{ name: 'customer_name', label: 'Tên khách', default: 'anh/chị' }]),
    },
    {
      category: 'thanks',
      title: 'Cảm ơn chung (VI)',
      language: 'vi',
      body: `Cảm ơn anh/chị đã quan tâm. Có gì thắc mắc thêm cứ inbox em ạ! 🙌`,
      trigger_keywords: JSON.stringify(['cảm ơn', 'thanks', 'thank you']),
      variables: '[]',
    },
    {
      category: 'info_location',
      title: 'Hướng dẫn vị trí khách sạn (VI)',
      language: 'vi',
      body: `Chào anh/chị {{customer_name}}!

{{hotel_name}} nằm tại {{address}}.
Khoảng cách đến các điểm nổi bật: {{landmarks}}

Có thể di chuyển bằng: Grab (~30k), xe ôm (~20k), hoặc bus số {{bus_no}}.

Xem chi tiết + đặt phòng: sondervn.com/khach-san/{{hotel_slug}}`,
      trigger_keywords: JSON.stringify(['vị trí', 'địa chỉ', 'ở đâu', 'gần', 'di chuyển']),
      variables: JSON.stringify([
        { name: 'customer_name', label: 'Tên khách', default: 'anh/chị' },
        { name: 'hotel_name', label: 'Tên khách sạn', default: '' },
        { name: 'address', label: 'Địa chỉ', default: '' },
        { name: 'landmarks', label: 'Landmarks gần đó', default: '' },
        { name: 'bus_no', label: 'Số bus (nếu có)', default: '' },
        { name: 'hotel_slug', label: 'Hotel slug URL', default: '' },
      ]),
    },
  ];

  let created = 0;
  for (const t of defaults) {
    const r = upsertTemplate(t as any);
    if (r.created) created++;
  }
  console.log(`[care-templates] seeded ${created} default templates`);
  return created;
}

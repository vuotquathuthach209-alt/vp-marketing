/**
 * Gemini Intent Classifier — phân tích ý định khách + extract slots + kiểm tra knowledge base.
 *
 * Thay thế detectContentQuestion (regex) với AI smart classification.
 *
 * Flow:
 *   User message + knowledge context snapshot →
 *   Gemini classify:
 *     primary_intent: booking | info_question | greeting | farewell | complaint | chitchat | unclear
 *     sub_category: price | availability | dining | pet | wifi | ...
 *     in_knowledge_base: có data để answer không
 *     needs_clarification: nếu câu hỏi mơ hồ, hỏi lại
 *     extracted_slots: slots detected
 *
 * Latency: ~500-1500ms với Gemini Flash (acceptable for high-quality routing).
 * Fallback: rule-based nếu Gemini fail/timeout.
 */

import { db } from '../db';

export interface IntentAnalysis {
  primary_intent: 'booking' | 'info_question' | 'greeting' | 'farewell' | 'complaint' | 'chitchat' | 'unclear' | 'contact_info' | 'image_request';
  sub_category?: string;
  confidence: number;
  in_knowledge_base: boolean;
  needs_clarification: boolean;
  clarification_question?: string;
  extracted_slots: {
    property_type?: string;
    property_name?: string;
    area?: string;
    checkin_date?: string;
    nights?: number;
    months?: number;
    guests_adults?: number;
    guests_children?: number;
    budget_min?: number;
    budget_max?: number;
    phone?: string;
    name?: string;
  };
  suggested_answer?: string;
  reasoning?: string;
}

/**
 * Get snapshot of knowledge base for Gemini context.
 * Summary của hotels + chunk types available + common topics.
 */
function getKnowledgeSummary(): string {
  try {
    const hotels = db.prepare(
      `SELECT hp.name_canonical, hp.property_type, hp.district, hp.star_rating
       FROM hotel_profile hp
       WHERE EXISTS (SELECT 1 FROM mkt_hotels mh WHERE mh.ota_hotel_id = hp.hotel_id AND mh.status = 'active')`
    ).all() as any[];

    const chunkTypes = db.prepare(
      `SELECT DISTINCT chunk_type FROM hotel_knowledge_embeddings`
    ).all() as any[];

    const lines: string[] = [];
    lines.push('# Sonder knowledge base snapshot');
    lines.push('');
    lines.push('## Active hotels:');
    for (const h of hotels) {
      lines.push(`- ${h.name_canonical} (${h.property_type}, ${h.district || '?'}, ${h.star_rating || '?'}⭐)`);
    }
    lines.push('');
    lines.push('## Available knowledge types (RAG chunks):');
    lines.push(chunkTypes.map((c: any) => c.chunk_type).join(', '));
    lines.push('');
    lines.push('## Hotel types bot có: ' + [...new Set(hotels.map((h: any) => h.property_type))].join(', '));

    return lines.join('\n');
  } catch {
    return '(knowledge base info unavailable)';
  }
}

/**
 * Call Gemini to analyze intent.
 */
export async function analyzeIntent(msg: string, opts: { hasPrevContext?: boolean } = {}): Promise<IntentAnalysis | null> {
  // Fast-path: nếu msg rất ngắn, không cần Gemini
  if (msg.trim().length < 3) return null;

  const knowledge = getKnowledgeSummary();

  const system = `Bạn là AI phân tích ý định khách Việt Nam nhắn tin đặt phòng. Output JSON chính xác.

PHÂN LOẠI primary_intent:
- "booking": Khách muốn đặt phòng (có ngày, số khách, budget cụ thể hoặc ngỏ ý "mình muốn đặt", "book cho mình")
- "info_question": Hỏi thông tin KHÁCH SẠN (giá, availability, tiện nghi, vị trí, policy, ảnh, review, ...)
- "greeting": Chào hỏi ("chào", "hello", "alo", "xin chào")
- "farewell": Tạm biệt ("cảm ơn", "thank you", "hẹn gặp lại")
- "contact_info": Chỉ gửi SĐT hoặc tên + SĐT, không có câu hỏi
- "image_request": Xin ảnh/hình phòng
- "complaint": Phàn nàn, bức xúc
- "chitchat": Tán gẫu, không liên quan
- "unclear": Không hiểu, cần làm rõ

SUB_CATEGORY (nếu info_question/booking):
- price / availability / amenity / wifi / location / checkin_time / checkout / pet / safety / dining / transport / loyalty / promotion / review / room_type / accessibility / family / business / specific_hotel

in_knowledge_base: TRUE nếu bot có data để answer (xem knowledge snapshot), FALSE nếu nằm ngoài scope.

needs_clarification: TRUE nếu câu hỏi quá mơ hồ (vd "có gì không", "thế nào"). Kèm clarification_question cụ thể.

extracted_slots: slots detect được (property_type, area, dates, guests, budget, phone, name).
- "25/5" → checkin_date = "2026-05-25"
- "tuần sau" → checkin_date dynamic
- "2 người" → guests_adults = 2
- "dưới 1 triệu" → budget_max = 1000000
- "0912345678" → phone
- "Sonder Airport" → property_name

CHỈ output JSON, không prose.`;

  const userPrompt = `Knowledge base snapshot:\n${knowledge}\n\nPrevious context: ${opts.hasPrevContext ? 'YES (tiếp theo convo)' : 'NO (tin đầu)'}\n\nKhách nhắn: "${msg}"\n\nOutput JSON:`;

  try {
    const { smartCascade } = require('./smart-cascade');
    const result = await smartCascade({
      system,
      user: userPrompt,
      json: true,
      temperature: 0.1,
      maxTokens: 600,
      startFrom: 'gemini_flash',
    });

    let parsed: any;
    try {
      parsed = JSON.parse(result.text);
    } catch {
      // Try extract JSON block
      const m = result.text.match(/\{[\s\S]*\}/);
      if (!m) return null;
      parsed = JSON.parse(m[0]);
    }

    // Validate
    if (!parsed.primary_intent) return null;

    return {
      primary_intent: parsed.primary_intent,
      sub_category: parsed.sub_category,
      confidence: parsed.confidence || 0.7,
      in_knowledge_base: !!parsed.in_knowledge_base,
      needs_clarification: !!parsed.needs_clarification,
      clarification_question: parsed.clarification_question,
      extracted_slots: parsed.extracted_slots || {},
      suggested_answer: parsed.suggested_answer,
      reasoning: parsed.reasoning,
    };
  } catch (e: any) {
    console.warn('[gemini-intent] fail:', e?.message);
    return null;
  }
}

/**
 * Merge Gemini extracted slots vào ExtractedSlots format.
 */
export function geminiSlotsToExtracted(gs: IntentAnalysis['extracted_slots']): any {
  const out: any = {};
  if (gs.property_type) out.property_type = gs.property_type;
  if (gs.area) out.area = { area: gs.area, normalized: gs.area, type: 'district', city: 'Ho Chi Minh', district: gs.area };
  if (gs.checkin_date || gs.nights) {
    out.dates = {};
    if (gs.checkin_date) out.dates.checkin_date = gs.checkin_date;
    if (gs.nights) out.dates.nights = gs.nights;
  }
  if (gs.guests_adults) {
    out.guests = { adults: gs.guests_adults };
    if (gs.guests_children) out.guests.children = gs.guests_children;
  }
  if (gs.budget_min !== undefined || gs.budget_max !== undefined) {
    out.budget = {};
    if (gs.budget_min !== undefined) out.budget.min = gs.budget_min;
    if (gs.budget_max !== undefined) out.budget.max = gs.budget_max;
  }
  if (gs.months) out.months = gs.months;
  if (gs.phone) out.phone = gs.phone;
  if (gs.name) out.name = gs.name;
  return out;
}

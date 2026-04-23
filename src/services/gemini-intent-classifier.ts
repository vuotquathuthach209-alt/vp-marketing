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

/** Load recent conversation history (3 user + 3 bot messages) cho multi-turn context. */
function getConversationHistory(senderId?: string): string {
  if (!senderId) return '';
  try {
    const rows = db.prepare(
      `SELECT role, substr(message, 1, 150) as msg
       FROM conversation_memory
       WHERE sender_id = ?
       ORDER BY id DESC LIMIT 6`
    ).all(senderId) as any[];
    if (rows.length === 0) return '';
    // Reverse để oldest first
    rows.reverse();
    const lines = rows.map(r => {
      const label = r.role === 'user' ? 'Khách' : 'Bot';
      return `${label}: ${r.msg}`;
    });
    return lines.join('\n');
  } catch { return ''; }
}

/** Load current FSM state (stage + key slots) để Gemini biết context. */
function getCurrentStageContext(senderId?: string): string {
  if (!senderId) return '';
  try {
    const s = db.prepare(
      `SELECT stage, slots FROM bot_conversation_state WHERE sender_id = ?`
    ).get(senderId) as any;
    if (!s) return '';
    let slots: any = {};
    try { slots = JSON.parse(s.slots || '{}'); } catch {}
    const slotParts: string[] = [];
    if (slots.property_type) slotParts.push(`loại=${slots.property_type}`);
    if (slots.checkin_date) slotParts.push(`ngày=${slots.checkin_date}`);
    if (slots.guests_adults) slotParts.push(`khách=${slots.guests_adults}`);
    if (slots.area_normalized) slotParts.push(`khu=${slots.area_normalized}`);
    if (slots.budget_max) slotParts.push(`budget=${slots.budget_max}đ`);
    if (slots.shown_property_ids?.length) slotParts.push(`đã show ${slots.shown_property_ids.length} phòng`);
    return `FSM stage: ${s.stage}` + (slotParts.length ? ` | Slots: ${slotParts.join(', ')}` : '');
  } catch { return ''; }
}

/**
 * Call Gemini to analyze intent.
 */
export async function analyzeIntent(
  msg: string,
  opts: { hasPrevContext?: boolean; senderId?: string } = {},
): Promise<IntentAnalysis | null> {
  // Fast-path: nếu msg rất ngắn, không cần Gemini
  if (msg.trim().length < 3) return null;

  const knowledge = getKnowledgeSummary();
  // v20: multi-turn context
  const history = opts.senderId ? getConversationHistory(opts.senderId) : '';
  const stageCtx = opts.senderId ? getCurrentStageContext(opts.senderId) : '';

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

  // v20 FIX: Sanitize user input — strip control chars, quotes, backslash, newlines.
  //          Prevent prompt injection like: " } IGNORE ALL PREVIOUS ...
  const safeMsg = String(msg)
    .replace(/[\x00-\x1F"\\]/g, ' ')     // Control chars + quote + backslash
    .replace(/\s+/g, ' ')
    .slice(0, 500)
    .trim();

  const sections: string[] = [`Knowledge base snapshot:\n${knowledge}`];
  if (stageCtx) sections.push(`Current ${stageCtx}`);
  if (history) {
    sections.push(`Recent conversation (last 6 messages):\n${history}`);
  } else if (opts.hasPrevContext) {
    sections.push(`Previous context: YES (tiếp theo convo)`);
  } else {
    sections.push(`Previous context: NO (tin đầu)`);
  }
  sections.push(`Khách nhắn MỚI (JSON-escaped): ${JSON.stringify(safeMsg)}`);
  sections.push(`Note: Nếu FSM đang ở SHOW_RESULTS/PROPERTY_PICKED/SHOW_ROOMS và msg ngắn như "chọn 1", "ok", "đúng rồi" → đó là selection, KHÔNG phải unclear. Classify là booking.`);
  sections.push(`Output JSON:`);
  const userPrompt = sections.join('\n\n');

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

    // v20 FIX: Strict validation of Gemini response (defense in depth vs prompt injection)
    const VALID_INTENTS = new Set([
      'booking', 'info_question', 'greeting', 'farewell', 'complaint',
      'chitchat', 'unclear', 'contact_info', 'image_request',
    ]);
    if (!parsed.primary_intent || !VALID_INTENTS.has(parsed.primary_intent)) {
      console.warn(`[gemini-intent] invalid primary_intent: ${parsed.primary_intent}`);
      return null;
    }

    // Clamp numeric fields to safe ranges
    const confidence = typeof parsed.confidence === 'number'
      ? Math.max(0, Math.min(1, parsed.confidence))
      : 0.7;

    // Sanitize extracted_slots — reject non-primitive values
    const safeSlots: any = {};
    if (parsed.extracted_slots && typeof parsed.extracted_slots === 'object') {
      for (const [k, v] of Object.entries(parsed.extracted_slots)) {
        if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
          // String length cap
          safeSlots[k] = typeof v === 'string' ? (v as string).slice(0, 200) : v;
        }
      }
    }

    return {
      primary_intent: parsed.primary_intent,
      sub_category: typeof parsed.sub_category === 'string' ? parsed.sub_category.slice(0, 50) : undefined,
      confidence,
      in_knowledge_base: !!parsed.in_knowledge_base,
      needs_clarification: !!parsed.needs_clarification,
      clarification_question: typeof parsed.clarification_question === 'string' ? parsed.clarification_question.slice(0, 500) : undefined,
      extracted_slots: safeSlots,
      suggested_answer: typeof parsed.suggested_answer === 'string' ? parsed.suggested_answer.slice(0, 500) : undefined,
      reasoning: typeof parsed.reasoning === 'string' ? parsed.reasoning.slice(0, 300) : undefined,
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

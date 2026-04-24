/**
 * Template Suggester — v27B Agentic
 *
 * AI phân tích:
 *   1. Hội thoại bot "bị stuck" (stuck_turns ≥ 2)
 *   2. Hội thoại đã handoff (handoff_log — trigger_reason phổ biến)
 *   3. Template "hits thấp" nhưng khách vẫn hỏi (mismatched expectation)
 *   4. Câu hỏi lặp pattern chưa có template cover
 *
 * → Dùng Gemini (smartCascade) cluster + generate template proposals
 * → Lưu vào `agentic_template_suggestions` (status='pending')
 * → Admin review → approve/reject/edit
 *
 * Chạy:
 *   - Cron weekly tự động (scheduler.ts)
 *   - On-demand qua POST /api/agentic-templates/suggestions/analyze
 */

import { db } from '../../db';

export interface AnalysisSource {
  type: 'stuck_turns' | 'handoff_log' | 'low_hit_templates' | 'pattern_repeat';
  sample_size: number;
  threshold?: any;
}

export interface ConversationSnippet {
  sender_id: string;
  messages: Array<{ role: string; message: string; ts: number }>;
  stuck_turns?: number;
  handoff_reason?: string;
  intent?: string;
}

export interface TemplateSuggestion {
  suggested_id: string;
  category: string;
  description: string;
  content: string;
  trigger_conditions: any;
  quick_replies?: Array<{ title: string; payload: string }>;
  confidence: number;
  reasoning: string;
  evidence_count: number;
}

// ═══════════════════════════════════════════════════════════
// 1. GATHER EVIDENCE — 4 sources
// ═══════════════════════════════════════════════════════════

/**
 * Source 1: Hội thoại STUCK (bot lặp cùng stage 2+ turns).
 * → Dấu hiệu bot chưa có template phù hợp cho case này.
 */
export function gatherStuckConversations(limit: number = 30): ConversationSnippet[] {
  try {
    const rows = db.prepare(`
      SELECT s.sender_id, s.same_stage_count, s.stage
      FROM bot_conversation_state s
      WHERE s.same_stage_count >= 2
      ORDER BY s.updated_at DESC
      LIMIT ?
    `).all(limit) as any[];

    return rows.map(r => {
      const msgs = db.prepare(`
        SELECT role, message, created_at as ts FROM conversation_memory
        WHERE sender_id = ? ORDER BY id DESC LIMIT 10
      `).all(r.sender_id) as any[];
      return {
        sender_id: r.sender_id,
        messages: msgs.reverse(),
        stuck_turns: r.same_stage_count,
        intent: r.stage,
      };
    });
  } catch (e: any) {
    console.warn('[suggester] gatherStuck err:', e?.message);
    return [];
  }
}

/**
 * Source 2: Hội thoại đã handoff — trigger_reason + context.
 * → Bot không xử lý được, cần template mới.
 */
export function gatherHandoffConversations(limit: number = 30): ConversationSnippet[] {
  try {
    // Check if handoff_log table exists
    const exists = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='handoff_log'`).get();
    if (!exists) return [];

    const rows = db.prepare(`
      SELECT sender_id, trigger_reason, context_json, created_at
      FROM handoff_log
      WHERE created_at > ?
      ORDER BY created_at DESC
      LIMIT ?
    `).all(Date.now() - 30 * 24 * 3600 * 1000, limit) as any[];

    return rows.map(r => {
      const msgs = db.prepare(`
        SELECT role, message, created_at as ts FROM conversation_memory
        WHERE sender_id = ? AND created_at <= ?
        ORDER BY id DESC LIMIT 10
      `).all(r.sender_id, r.created_at) as any[];
      return {
        sender_id: r.sender_id,
        messages: msgs.reverse(),
        handoff_reason: r.trigger_reason,
      };
    });
  } catch (e: any) {
    console.warn('[suggester] gatherHandoff err:', e?.message);
    return [];
  }
}

/**
 * Source 3: Templates có hits cao nhưng NO conversions → content chưa đúng.
 * Hoặc templates chưa ai hit → trigger_conditions sai hoặc ko ai cần.
 */
export function gatherUnderperformingTemplates(): Array<{ id: string; hits: number; conversions: number; conv_rate: number; category: string }> {
  try {
    const rows = db.prepare(`
      SELECT id, category, hits, conversions,
        CASE WHEN hits > 10 THEN 1.0 * conversions / hits ELSE NULL END as conv_rate
      FROM agentic_templates
      WHERE active = 1 AND hits > 10
      ORDER BY conv_rate ASC
      LIMIT 10
    `).all() as any[];
    return rows.filter(r => r.conv_rate !== null && r.conv_rate < 0.3);
  } catch (e: any) {
    console.warn('[suggester] gatherUnderperforming err:', e?.message);
    return [];
  }
}

/**
 * Source 4: Common user messages (từ conversation_memory) không match template nào.
 * Dùng để thấy pattern lặp chưa có template cover.
 */
export function gatherUnmatchedPatterns(limit: number = 50): string[] {
  try {
    // Lấy user messages gần đây mà bot đã trả lời qua tier rag_ai/full_ai (không phải template)
    // Simpler: lấy top recent user messages
    const rows = db.prepare(`
      SELECT message FROM conversation_memory
      WHERE role = 'user' AND LENGTH(message) BETWEEN 10 AND 200
        AND created_at > ?
      ORDER BY id DESC LIMIT ?
    `).all(Date.now() - 14 * 24 * 3600 * 1000, limit) as any[];
    return rows.map(r => r.message);
  } catch (e: any) {
    console.warn('[suggester] gatherUnmatched err:', e?.message);
    return [];
  }
}

// ═══════════════════════════════════════════════════════════
// 2. GEMINI PROPOSE — call LLM với evidence → JSON suggestions
// ═══════════════════════════════════════════════════════════

/**
 * Gọi Gemini phân tích evidence → đề xuất templates.
 * Trả về array suggestions (có thể empty nếu LLM không tìm thấy pattern).
 */
export async function proposeTemplatesFromEvidence(
  stuck: ConversationSnippet[],
  handoff: ConversationSnippet[],
  underperf: Array<{ id: string; hits: number; conv_rate: number }>,
  unmatched: string[],
): Promise<TemplateSuggestion[]> {
  // Build evidence blob (trim nếu quá dài)
  const stuckSample = stuck.slice(0, 10).map(c => ({
    stuck_turns: c.stuck_turns,
    intent: c.intent,
    last_msgs: c.messages.slice(-6).map(m => `[${m.role}] ${m.message.substring(0, 120)}`),
  }));

  const handoffSample = handoff.slice(0, 10).map(c => ({
    reason: c.handoff_reason,
    last_msgs: c.messages.slice(-6).map(m => `[${m.role}] ${m.message.substring(0, 120)}`),
  }));

  const unmatchedSample = unmatched.slice(0, 30);

  // Fetch existing template IDs để AI biết đã có gì
  const existing = db.prepare(`SELECT id, category, description FROM agentic_templates WHERE active = 1 ORDER BY category, id`).all() as any[];
  const existingList = existing.map(e => `- [${e.category}] ${e.id}: ${e.description}`).join('\n');

  const system = `Bạn là chuyên gia CSKH phân tích hội thoại chatbot Sonder (nền tảng lưu trú TP.HCM). Nhiệm vụ: đề xuất TEMPLATE MỚI để bot xử lý tốt hơn các case hiện đang fail.

Templates CÓ SẴN (không đề xuất trùng):
${existingList}

Categories hợp lệ: discovery | gathering | info | objection | decision | handoff | misc

Format content (Mustache-like):
  - Biến: {{customerName}}, {{hotline}}, {{missingSlots}}, {{topic}}, {{hotelName}}, {{district}}, {{priceFrom}}
  - Section: {{#isVip}}...{{/isVip}}, {{^isVip}}...{{/isVip}}

Format trigger_conditions (JSON):
  - intent: 'booking' | 'info_question' | 'greeting' | 'complaint' | 'unclear' | ...
  - sub_category: 'price' | 'amenity' | 'location' | 'policy' | 'pet' | 'transport'
  - keywords_any: ['từ khóa 1', 'từ khóa 2']
  - turn_number: 1 (nếu specific turn)
  - stuck_turns_gte: 2 (nếu trigger khi stuck)
  - confidence_lt: 0.4 (nếu trigger khi low confidence)
  - slot_completeness_lt: 0.3 (ít slot)
  - rental_mode: 'short_term' | 'long_term'

QUY TẮC:
1. CHỈ đề xuất template cover GAP thực sự — pattern lặp trong evidence.
2. KHÔNG đề xuất template trùng với existing (check IDs + descriptions).
3. Content viết tiếng Việt, giọng "em", thân thiện, có emoji phù hợp.
4. Max 5 đề xuất/lần.
5. Mỗi đề xuất phải có reasoning ngắn gọn (pattern bạn thấy, bao nhiêu convos match).

Output JSON ARRAY:
[
  {
    "suggested_id": "refund_request_handling",
    "category": "objection",
    "description": "Khách yêu cầu refund sau khi đã cọc",
    "content": "Dạ em hiểu ạ...",
    "trigger_conditions": { "keywords_any": ["refund", "hoàn tiền", "trả lại cọc"] },
    "quick_replies": [{"title": "💬 Nhân viên", "payload": "intent_handoff"}],
    "confidence": 0.8,
    "reasoning": "Thấy 6/10 stuck convos về refund, chưa có template cover",
    "evidence_count": 6
  }
]

Nếu KHÔNG tìm thấy pattern mới → trả về [].`;

  const userPrompt = `=== EVIDENCE ===

STUCK CONVERSATIONS (bot lặp stage, ${stuck.length} total):
${JSON.stringify(stuckSample, null, 2)}

HANDOFF CONVERSATIONS (${handoff.length} total):
${JSON.stringify(handoffSample, null, 2)}

UNDERPERFORMING TEMPLATES (hits cao, conv_rate thấp):
${JSON.stringify(underperf, null, 2)}

UNMATCHED USER MESSAGES (${unmatched.length} recent, sample 30):
${JSON.stringify(unmatchedSample, null, 2)}

Phân tích → đề xuất tối đa 5 templates mới. Output JSON array.`;

  try {
    const { smartCascade } = require('../smart-cascade');
    const result = await smartCascade({
      system,
      user: userPrompt,
      json: true,
      temperature: 0.4,
      maxTokens: 3000,
      startFrom: 'gemini_flash',
    });

    if (!result?.text) return [];

    // Parse JSON array
    let parsed: any;
    try { parsed = JSON.parse(result.text); }
    catch {
      const m = result.text.match(/\[[\s\S]*\]/);
      if (!m) return [];
      try { parsed = JSON.parse(m[0]); } catch { return []; }
    }

    if (!Array.isArray(parsed)) return [];

    // Validate + sanitize
    const VALID_CATS = new Set(['discovery', 'gathering', 'info', 'objection', 'decision', 'handoff', 'misc']);
    return parsed
      .filter((s: any) => s && typeof s === 'object' && s.suggested_id && s.content && VALID_CATS.has(s.category))
      .map((s: any) => ({
        suggested_id: String(s.suggested_id).replace(/[^a-z0-9_]/gi, '_').toLowerCase().substring(0, 60),
        category: s.category,
        description: String(s.description || '').substring(0, 200),
        content: String(s.content).substring(0, 5000),
        trigger_conditions: s.trigger_conditions || {},
        quick_replies: Array.isArray(s.quick_replies) ? s.quick_replies.slice(0, 5) : undefined,
        confidence: typeof s.confidence === 'number' ? Math.max(0, Math.min(1, s.confidence)) : 0.7,
        reasoning: String(s.reasoning || '').substring(0, 500),
        evidence_count: Number(s.evidence_count) || 0,
      }))
      .slice(0, 5);
  } catch (e: any) {
    console.warn('[suggester] Gemini error:', e?.message);
    return [];
  }
}

// ═══════════════════════════════════════════════════════════
// 3. PERSIST — lưu suggestion vào table (status=pending)
// ═══════════════════════════════════════════════════════════

export function saveSuggestion(s: TemplateSuggestion, source: AnalysisSource['type'], evidence: any): number {
  // Skip nếu suggested_id đã exist trong templates OR pending suggestion
  const existingTemplate = db.prepare(`SELECT id FROM agentic_templates WHERE id = ?`).get(s.suggested_id);
  if (existingTemplate) {
    console.log(`[suggester] skip: template ${s.suggested_id} already exists`);
    return 0;
  }

  const existingPending = db.prepare(`
    SELECT id FROM agentic_template_suggestions
    WHERE suggested_id = ? AND status = 'pending'
  `).get(s.suggested_id);
  if (existingPending) {
    console.log(`[suggester] skip: pending suggestion ${s.suggested_id} already exists`);
    return 0;
  }

  const result = db.prepare(`
    INSERT INTO agentic_template_suggestions
      (suggested_id, category, description, content, trigger_conditions, quick_replies,
       confidence, evidence_json, analysis_source, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
  `).run(
    s.suggested_id,
    s.category,
    s.description + (s.reasoning ? ` | AI: ${s.reasoning}` : ''),
    s.content,
    JSON.stringify(s.trigger_conditions),
    s.quick_replies ? JSON.stringify(s.quick_replies) : null,
    s.confidence,
    JSON.stringify(evidence),
    source,
    Date.now(),
  );
  return result.lastInsertRowid as number;
}

// ═══════════════════════════════════════════════════════════
// 4. ORCHESTRATOR — main entry point
// ═══════════════════════════════════════════════════════════

export interface SuggestResult {
  suggestions_created: number;
  suggestions: TemplateSuggestion[];
  evidence_stats: {
    stuck: number;
    handoff: number;
    underperforming: number;
    unmatched: number;
  };
  error?: string;
}

/**
 * Full analysis run — gather + propose + save.
 */
export async function runTemplateSuggestionAnalysis(): Promise<SuggestResult> {
  console.log('[suggester] starting analysis run...');

  const stuck = gatherStuckConversations(30);
  const handoff = gatherHandoffConversations(30);
  const underperf = gatherUnderperformingTemplates();
  const unmatched = gatherUnmatchedPatterns(50);

  const stats = {
    stuck: stuck.length,
    handoff: handoff.length,
    underperforming: underperf.length,
    unmatched: unmatched.length,
  };

  console.log(`[suggester] evidence: stuck=${stats.stuck} handoff=${stats.handoff} underperf=${stats.underperforming} unmatched=${stats.unmatched}`);

  if (stats.stuck + stats.handoff + stats.underperforming + stats.unmatched < 3) {
    return { suggestions_created: 0, suggestions: [], evidence_stats: stats, error: 'Not enough evidence to analyze' };
  }

  const suggestions = await proposeTemplatesFromEvidence(stuck, handoff, underperf, unmatched);
  console.log(`[suggester] Gemini proposed ${suggestions.length} suggestions`);

  let created = 0;
  for (const s of suggestions) {
    // Determine primary source
    let source: AnalysisSource['type'] = 'pattern_repeat';
    if (stuck.length > handoff.length && stuck.length > unmatched.length) source = 'stuck_turns';
    else if (handoff.length > 0) source = 'handoff_log';
    else if (underperf.length > 0) source = 'low_hit_templates';

    const evidence = {
      source_stats: stats,
      sample_stuck: stuck.slice(0, 3).map(c => ({ sender: c.sender_id.substring(0, 20), intent: c.intent })),
      sample_handoff: handoff.slice(0, 3).map(c => ({ reason: c.handoff_reason })),
      reasoning: s.reasoning,
    };

    const id = saveSuggestion(s, source, evidence);
    if (id > 0) created++;
  }

  console.log(`[suggester] saved ${created} new suggestions (pending admin review)`);
  return { suggestions_created: created, suggestions, evidence_stats: stats };
}

// ═══════════════════════════════════════════════════════════
// 5. APPROVAL FLOW — admin duyệt suggestion → insert template
// ═══════════════════════════════════════════════════════════

export function approveSuggestion(
  suggestionId: number,
  reviewedBy: string,
  overrides?: { content?: string; trigger_conditions?: any; quick_replies?: any; description?: string; category?: string },
): { success: boolean; template_id?: string; error?: string } {
  try {
    const sug = db.prepare(`SELECT * FROM agentic_template_suggestions WHERE id = ?`).get(suggestionId) as any;
    if (!sug) return { success: false, error: 'Suggestion not found' };
    if (sug.status !== 'pending') return { success: false, error: `Already ${sug.status}` };

    // Build final template (allow admin overrides)
    const finalContent = overrides?.content ?? sug.content;
    const finalTrigger = overrides?.trigger_conditions ?? (sug.trigger_conditions ? JSON.parse(sug.trigger_conditions) : null);
    const finalQR = overrides?.quick_replies ?? (sug.quick_replies ? JSON.parse(sug.quick_replies) : null);
    const finalDesc = overrides?.description ?? sug.description;
    const finalCat = overrides?.category ?? sug.category;

    // Check if template already exists (race condition)
    const existing = db.prepare(`SELECT id FROM agentic_templates WHERE id = ?`).get(sug.suggested_id);
    if (existing) return { success: false, error: 'Template ID already exists — dùng /templates UI edit trực tiếp' };

    // Insert
    const now = Date.now();
    db.prepare(`
      INSERT INTO agentic_templates
        (id, category, description, trigger_conditions, content, quick_replies, confidence,
         active, hotel_id, version, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1, 0, 1, ?, ?)
    `).run(
      sug.suggested_id,
      finalCat,
      finalDesc,
      finalTrigger ? JSON.stringify(finalTrigger) : null,
      finalContent,
      finalQR ? JSON.stringify(finalQR) : null,
      Number(sug.confidence) || 0.8,
      now, now,
    );

    // Mark suggestion approved
    const newStatus = overrides ? 'edited' : 'approved';
    db.prepare(`
      UPDATE agentic_template_suggestions
      SET status = ?, reviewed_by = ?, reviewed_at = ?, approved_template_id = ?
      WHERE id = ?
    `).run(newStatus, reviewedBy, now, sug.suggested_id, suggestionId);

    // Invalidate template cache
    try {
      const { invalidateCache } = require('./template-engine');
      invalidateCache();
    } catch {}

    return { success: true, template_id: sug.suggested_id };
  } catch (e: any) {
    return { success: false, error: e?.message };
  }
}

export function rejectSuggestion(suggestionId: number, reviewedBy: string, note: string = ''): { success: boolean; error?: string } {
  try {
    const result = db.prepare(`
      UPDATE agentic_template_suggestions
      SET status = 'rejected', reviewed_by = ?, reviewed_at = ?, reviewed_note = ?
      WHERE id = ? AND status = 'pending'
    `).run(reviewedBy, Date.now(), note, suggestionId);
    if (result.changes === 0) return { success: false, error: 'Not found or already reviewed' };
    return { success: true };
  } catch (e: any) {
    return { success: false, error: e?.message };
  }
}

export function listPendingSuggestions(limit: number = 50): any[] {
  return db.prepare(`
    SELECT id, suggested_id, category, description, content, trigger_conditions, quick_replies,
      confidence, evidence_json, analysis_source, status, created_at
    FROM agentic_template_suggestions
    WHERE status = 'pending'
    ORDER BY created_at DESC LIMIT ?
  `).all(limit).map((r: any) => ({
    ...r,
    trigger_conditions: r.trigger_conditions ? JSON.parse(r.trigger_conditions) : null,
    quick_replies: r.quick_replies ? JSON.parse(r.quick_replies) : null,
    evidence: r.evidence_json ? JSON.parse(r.evidence_json) : null,
  }));
}

export function listAllSuggestions(status?: string, limit: number = 100): any[] {
  const rows = status
    ? db.prepare(`SELECT * FROM agentic_template_suggestions WHERE status = ? ORDER BY created_at DESC LIMIT ?`).all(status, limit)
    : db.prepare(`SELECT * FROM agentic_template_suggestions ORDER BY created_at DESC LIMIT ?`).all(limit);

  return rows.map((r: any) => ({
    ...r,
    trigger_conditions: r.trigger_conditions ? JSON.parse(r.trigger_conditions) : null,
    quick_replies: r.quick_replies ? JSON.parse(r.quick_replies) : null,
    evidence: r.evidence_json ? JSON.parse(r.evidence_json) : null,
  }));
}

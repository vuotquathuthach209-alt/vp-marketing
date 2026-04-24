/**
 * Template Engine — v27 Agentic
 *
 * Mustache-like renderer cho template content từ DB.
 *
 * Supported syntax:
 *   {{var}}              — simple substitution (escapes undefined → '')
 *   {{#var}}...{{/var}}  — section: render khối nếu var truthy
 *   {{^var}}...{{/var}}  — inverted section: render nếu var falsy
 *   {{var|fallback}}     — fallback value nếu undefined
 *
 * KHÔNG dùng thư viện ngoài — lightweight regex-based, đủ cho use case.
 *
 * Context vars thông dụng (em quy ước):
 *   customerName        — tên khách (nếu có)
 *   customerTier        — 'vip' | 'regular' | undefined
 *   isVip               — boolean
 *   hotline             — '0348 644 833'
 *   topic               — phát hiện được từ intent
 *   missingSlots        — "ngày check-in, số khách"
 *   hotelName, district, priceFrom, checkinDate, nights, guests
 *   answerPreview       — RAG answer short
 *   optionsComparison   — bảng so sánh options
 *   hasOptions          — boolean
 */

import { db } from '../../db';

export interface RenderContext {
  customerName?: string;
  customerTier?: string;
  isVip?: boolean;
  hotline?: string;
  topic?: string;
  missingSlots?: string;
  hotelName?: string;
  district?: string;
  priceFrom?: string;
  checkinDate?: string;
  nights?: number | string;
  guests?: string;
  answerPreview?: string;
  optionsComparison?: string;
  hasOptions?: boolean;
  [key: string]: any;
}

const HOTLINE_DEFAULT = '0348 644 833';

// ═══════════════════════════════════════════════════════════
// RENDER
// ═══════════════════════════════════════════════════════════

/**
 * Render template string với context.
 * Process sections first (so simple vars inside sections resolve correctly).
 */
export function renderString(template: string, ctx: RenderContext): string {
  const context: Record<string, any> = { hotline: HOTLINE_DEFAULT, ...ctx };

  let out = template;

  // 1. Inverted sections: {{^var}}...{{/var}} — render nếu var falsy
  out = out.replace(/\{\{\^(\w+)\}\}([\s\S]*?)\{\{\/\1\}\}/g, (_m: string, key: string, block: string) => {
    const v = context[key];
    return !v ? block : '';
  });

  // 2. Normal sections: {{#var}}...{{/var}} — render nếu var truthy
  out = out.replace(/\{\{#(\w+)\}\}([\s\S]*?)\{\{\/\1\}\}/g, (_m: string, key: string, block: string) => {
    const v = context[key];
    return v ? block : '';
  });

  // 3. Simple vars với fallback: {{var|default}}
  out = out.replace(/\{\{(\w+)\|([^}]*)\}\}/g, (_m: string, key: string, fallback: string) => {
    const v = context[key];
    return v !== undefined && v !== null && v !== '' ? String(v) : fallback;
  });

  // 4. Simple vars: {{var}}
  out = out.replace(/\{\{(\w+)\}\}/g, (_m: string, key: string) => {
    const v = context[key];
    return v !== undefined && v !== null ? String(v) : '';
  });

  // Collapse 3+ blank lines (cleanup sau khi section render xong)
  out = out.replace(/\n{3,}/g, '\n\n').trim();

  return out;
}

// ═══════════════════════════════════════════════════════════
// DB LOADING với memory cache
// ═══════════════════════════════════════════════════════════

export interface DbTemplate {
  id: string;
  category: string;
  description: string;
  trigger_conditions: any;       // parsed JSON
  content: string;                // raw Mustache string
  quick_replies: Array<{ title: string; payload: string }> | null;
  confidence: number;
  active: number;
  hotel_id: number;
  version: number;
}

interface CacheEntry {
  templates: DbTemplate[];
  ts: number;
}

const CACHE_TTL_MS = 5 * 60 * 1000;  // 5 phút
let cache: CacheEntry | null = null;
let indexById: Map<string, DbTemplate> | null = null;
let indexByCategory: Map<string, DbTemplate[]> | null = null;

/**
 * Load all active templates từ DB + cache 5 phút.
 */
export function loadTemplates(forceRefresh: boolean = false): DbTemplate[] {
  const now = Date.now();
  if (!forceRefresh && cache && now - cache.ts < CACHE_TTL_MS) {
    return cache.templates;
  }

  try {
    const rows = db.prepare(`
      SELECT id, category, description, trigger_conditions, content, quick_replies, confidence, active, hotel_id, version
      FROM agentic_templates
      WHERE active = 1
      ORDER BY hotel_id DESC, id ASC
    `).all() as any[];

    const templates: DbTemplate[] = rows.map(r => ({
      id: r.id,
      category: r.category,
      description: r.description || '',
      trigger_conditions: r.trigger_conditions ? safeParse(r.trigger_conditions) : null,
      content: r.content,
      quick_replies: r.quick_replies ? safeParse(r.quick_replies) : null,
      confidence: Number(r.confidence) || 0.9,
      active: r.active,
      hotel_id: r.hotel_id,
      version: r.version,
    }));

    // Rebuild indexes
    indexById = new Map();
    indexByCategory = new Map();
    for (const t of templates) {
      indexById.set(t.id, t);
      if (!indexByCategory.has(t.category)) indexByCategory.set(t.category, []);
      indexByCategory.get(t.category)!.push(t);
    }

    cache = { templates, ts: now };
    return templates;
  } catch (e: any) {
    console.warn('[template-engine] loadTemplates error:', e?.message);
    return cache?.templates || [];
  }
}

/**
 * Get template by ID (from cache).
 */
export function getTemplateById(id: string): DbTemplate | null {
  if (!indexById) loadTemplates();
  return indexById?.get(id) || null;
}

/**
 * Get templates by category (from cache).
 */
export function getTemplatesByCategory(category: string): DbTemplate[] {
  if (!indexByCategory) loadTemplates();
  return indexByCategory?.get(category) || [];
}

/**
 * Render template by ID với context.
 * Return null nếu không tìm thấy template.
 */
export function renderTemplateById(
  id: string,
  ctx: RenderContext = {},
): { content: string; quick_replies?: Array<{ title: string; payload: string }>; confidence: number; template_id: string } | null {
  const t = getTemplateById(id);
  if (!t) return null;

  // Track hit (fire-and-forget)
  try {
    db.prepare(`UPDATE agentic_templates SET hits = hits + 1, last_used_at = ? WHERE id = ?`).run(Date.now(), id);
  } catch {}

  return {
    content: renderString(t.content, ctx),
    quick_replies: t.quick_replies || undefined,
    confidence: t.confidence,
    template_id: t.id,
  };
}

/**
 * Refresh cache (gọi sau khi admin edit template).
 */
export function invalidateCache(): void {
  cache = null;
  indexById = null;
  indexByCategory = null;
  console.log('[template-engine] cache invalidated');
}

// ═══════════════════════════════════════════════════════════
// SMART SELECTION — match context → best template
// ═══════════════════════════════════════════════════════════

export interface SelectionContext {
  turn_number?: number;
  intent?: string;
  sub_category?: string;
  rental_mode?: 'short_term' | 'long_term';
  slot_completeness?: number;
  stuck_turns?: number;
  customer_is_new?: boolean;
  customer_is_returning?: boolean;
  message?: string;
  rag_match_score?: number;
  confidence_score?: number;
  in_booking_flow?: boolean;
  after_hours?: boolean;
  hotel_id?: number;
}

/**
 * Chọn template tốt nhất dựa vào context.
 * Logic: với mỗi active template, check trigger_conditions khớp không.
 * Trả về template có score match cao nhất.
 */
export function selectTemplate(ctx: SelectionContext): DbTemplate | null {
  const result = selectTemplateWithCandidates(ctx);
  return result.best;
}

/**
 * Version mở rộng: trả về best + top candidates để log debug.
 */
export function selectTemplateWithCandidates(ctx: SelectionContext): { best: DbTemplate | null; candidates: Array<{ id: string; score: number }> } {
  const templates = loadTemplates();
  const scored: Array<{ t: DbTemplate; score: number }> = [];

  for (const t of templates) {
    const cond = t.trigger_conditions;
    if (!cond) continue;

    // Multi-tenant: hotel_id=0 = global, hotel_id > 0 = specific
    if (ctx.hotel_id !== undefined && t.hotel_id !== 0 && t.hotel_id !== ctx.hotel_id) continue;

    const score = matchScore(cond, ctx);
    if (score === 0) continue;

    // Prefer hotel-specific over global nếu tie
    const finalScore = score + (t.hotel_id > 0 ? 0.01 : 0);
    scored.push({ t, score: finalScore });
  }

  // Sort descending
  scored.sort((a, b) => b.score - a.score);

  return {
    best: scored[0]?.t || null,
    candidates: scored.slice(0, 5).map(s => ({ id: s.t.id, score: Math.round(s.score * 100) / 100 })),
  };
}

/**
 * Match score: 1 nếu ALL conditions khớp, 0 nếu có điều kiện fail.
 * Càng nhiều điều kiện khớp → score càng cao (weighted by specificity).
 */
function matchScore(cond: any, ctx: SelectionContext): number {
  let matches = 0;
  let total = 0;

  // turn_number: exact
  if (cond.turn_number !== undefined) {
    total++;
    if (ctx.turn_number === cond.turn_number) matches++;
    else return 0;  // Exact required
  }

  // intent: exact match
  if (cond.intent !== undefined) {
    total++;
    if (ctx.intent === cond.intent) matches++;
    else return 0;
  }

  // sub_category
  if (cond.sub_category !== undefined) {
    total++;
    if (ctx.sub_category === cond.sub_category) matches++;
    else return 0;
  }

  // rental_mode
  if (cond.rental_mode !== undefined) {
    total++;
    if (ctx.rental_mode === cond.rental_mode) matches++;
    else return 0;
  }

  // slot_completeness_lt / _gte
  if (cond.slot_completeness_lt !== undefined) {
    total++;
    if ((ctx.slot_completeness ?? 0) < cond.slot_completeness_lt) matches++;
    else return 0;
  }
  if (cond.slot_completeness_gte !== undefined) {
    total++;
    if ((ctx.slot_completeness ?? 0) >= cond.slot_completeness_gte) matches++;
    else return 0;
  }

  // stuck_turns_gte
  if (cond.stuck_turns_gte !== undefined) {
    total++;
    if ((ctx.stuck_turns ?? 0) >= cond.stuck_turns_gte) matches++;
    else return 0;
  }

  // confidence_lt
  if (cond.confidence_lt !== undefined) {
    total++;
    if ((ctx.confidence_score ?? 1) < cond.confidence_lt) matches++;
    else return 0;
  }

  // rag_match_lt
  if (cond.rag_match_lt !== undefined) {
    total++;
    if ((ctx.rag_match_score ?? 1) < cond.rag_match_lt) matches++;
    else return 0;
  }

  // customer_is_new / customer_is_returning
  if (cond.customer_is_new !== undefined) {
    total++;
    if (ctx.customer_is_new === cond.customer_is_new) matches++;
    else return 0;
  }
  if (cond.customer_is_returning !== undefined) {
    total++;
    if (ctx.customer_is_returning === cond.customer_is_returning) matches++;
    else return 0;
  }

  // keywords_any: ANY match (accent-insensitive + normalized)
  if (Array.isArray(cond.keywords_any) && cond.keywords_any.length > 0) {
    total++;
    const m = normalizeForMatch(ctx.message || '');
    const hit = cond.keywords_any.some((kw: string) => m.includes(normalizeForMatch(kw)));
    if (hit) matches++;
    else return 0;
  }

  // in_booking_flow
  if (cond.in_booking_flow !== undefined) {
    total++;
    if (ctx.in_booking_flow === cond.in_booking_flow) matches++;
    else return 0;
  }

  // after_hours
  if (cond.after_hours !== undefined) {
    total++;
    if (ctx.after_hours === cond.after_hours) matches++;
    else return 0;
  }

  // message_length_lt
  if (cond.message_length_lt !== undefined) {
    total++;
    if ((ctx.message?.length ?? 0) < cond.message_length_lt) matches++;
    else return 0;
  }

  // Trả về `matches` (integer count) thay vì ratio — templates với NHIỀU conditions
  // thỏa mãn thắng tie-break tự nhiên. VD: first_vague (2 điều kiện: turn=1, len<10)
  // thắng first_contact_warm (1 điều kiện: turn=1) khi cả 2 đều match.
  return total === 0 ? 0 : matches;
}

// ═══════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════

function safeParse(s: string): any {
  try { return JSON.parse(s); } catch { return null; }
}

/**
 * Normalize Vietnamese text cho keyword matching:
 *   - Lowercase
 *   - Strip diacritics (NFD + remove combining marks)
 *   - "thú cưng" → "thu cung", "hoàn tiền" → "hoan tien"
 *
 * Giúp match khi user gõ không dấu hoặc typo nhẹ.
 */
export function normalizeForMatch(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')  // Remove diacritic marks
    .replace(/đ/gi, 'd')                // Handle Vietnamese 'đ' → 'd'
    .toLowerCase()
    .trim();
}

/**
 * Log template usage feedback (conversion tracking).
 */
export function markConversion(templateId: string): void {
  try {
    db.prepare(`UPDATE agentic_templates SET conversions = conversions + 1 WHERE id = ?`).run(templateId);
  } catch {}
}

/**
 * Track which template was sent to this sender (for later conversion attribution).
 */
export function trackTemplateUse(senderId: string, templateId: string, category: string): void {
  try {
    db.prepare(`
      INSERT INTO agentic_template_tracking (sender_id, last_template_id, last_template_category, last_sent_at, conversion_marked)
      VALUES (?, ?, ?, ?, 0)
      ON CONFLICT(sender_id) DO UPDATE SET
        last_template_id = excluded.last_template_id,
        last_template_category = excluded.last_template_category,
        last_sent_at = excluded.last_sent_at,
        conversion_marked = 0
    `).run(senderId, templateId, category, Date.now());
  } catch (e: any) { console.warn('[template-engine] trackTemplateUse err:', e?.message); }
}

/**
 * Check if user message is a positive signal → count conversion for last template.
 * Positive signals:
 *   - Contains phone number (10-11 digits)
 *   - Words: "ok", "đặt", "chốt", "đúng", "yes", "đồng ý", "xin SĐT"
 *   - Confirmation after booking_confirm_summary
 */
const POSITIVE_RE = /\b(ok|oke|okay|đặt|chốt|đúng|yes|ờ|vâng|ừ|đồng ý|xin sđt|gọi đi)\b/i;
const PHONE_RE = /(?:\+?84|0)[0-9]{9,10}/;

export function detectAndMarkConversion(senderId: string, userMsg: string): { converted: boolean; template_id?: string; category?: string } {
  try {
    const row = db.prepare(`
      SELECT last_template_id, last_template_category, last_sent_at, conversion_marked
      FROM agentic_template_tracking WHERE sender_id = ?
    `).get(senderId) as any;
    if (!row || row.conversion_marked) return { converted: false };

    // TTL: only count if last template was sent within 30 minutes
    const TTL_MS = 30 * 60 * 1000;
    if (Date.now() - row.last_sent_at > TTL_MS) return { converted: false };

    const msg = userMsg.toLowerCase();
    const hasPositive = POSITIVE_RE.test(msg) || PHONE_RE.test(userMsg);
    if (!hasPositive) return { converted: false };

    // Only count conversions for certain categories (not smalltalk / greeting)
    const CONVERSION_CATS = new Set(['gathering', 'decision', 'info', 'objection']);
    if (!CONVERSION_CATS.has(row.last_template_category)) return { converted: false };

    // Mark!
    markConversion(row.last_template_id);
    db.prepare(`UPDATE agentic_template_tracking SET conversion_marked = 1 WHERE sender_id = ?`).run(senderId);

    console.log(`[template-engine] conversion! sender=${senderId.substring(0, 20)} template=${row.last_template_id}`);
    return { converted: true, template_id: row.last_template_id, category: row.last_template_category };
  } catch (e: any) {
    console.warn('[template-engine] detectConversion err:', e?.message);
    return { converted: false };
  }
}

/**
 * Log decision: which template was picked, from which candidates.
 */
export function logSelection(
  senderId: string,
  hotelId: number,
  templateId: string,
  ctx: SelectionContext,
  candidates: Array<{ id: string; score: number }>,
  confidence: number,
): void {
  try {
    db.prepare(`
      INSERT INTO agentic_template_selections
        (sender_id, hotel_id, template_id, context_json, candidates_json, confidence_score, turn_number, intent, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      senderId,
      hotelId,
      templateId,
      JSON.stringify(ctx),
      JSON.stringify(candidates.slice(0, 3)),
      confidence,
      ctx.turn_number || 0,
      ctx.intent || 'unknown',
      Date.now(),
    );
  } catch (e: any) { console.warn('[template-engine] logSelection err:', e?.message); }
}

/**
 * Admin list (include inactive).
 */
export function listAllTemplates(includeInactive: boolean = false): DbTemplate[] {
  const rows = db.prepare(`
    SELECT id, category, description, trigger_conditions, content, quick_replies, confidence, active, hotel_id, version, hits, conversions, last_used_at, created_at, updated_at
    FROM agentic_templates
    ${includeInactive ? '' : 'WHERE active = 1'}
    ORDER BY category, id
  `).all() as any[];

  return rows.map(r => ({
    id: r.id,
    category: r.category,
    description: r.description || '',
    trigger_conditions: r.trigger_conditions ? safeParse(r.trigger_conditions) : null,
    content: r.content,
    quick_replies: r.quick_replies ? safeParse(r.quick_replies) : null,
    confidence: Number(r.confidence) || 0.9,
    active: r.active,
    hotel_id: r.hotel_id,
    version: r.version,
    ...(includeInactive && {
      hits: r.hits,
      conversions: r.conversions,
      last_used_at: r.last_used_at,
      created_at: r.created_at,
      updated_at: r.updated_at,
    }),
  }));
}

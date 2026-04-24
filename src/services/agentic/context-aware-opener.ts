/**
 * Context-Aware Opener (CAO) — v27 Phase 6
 *
 * Khi khách inbox lần ĐẦU trong session (turn 1 hoặc sau session gap > 30 phút),
 * LLM đọc 5 tin nhắn gần nhất + profile để quyết định:
 *
 *   action:
 *     - "greet_new"          → chào mới, dùng template returning_customer_greet
 *     - "resume_context"     → bám mạch câu chuyện cũ, CUSTOM opening từ LLM
 *     - "acknowledge_return" → khách đã booking rồi, gợi mở hỗ trợ thêm
 *
 * Mục tiêu: cá nhân hoá + bám mạch → tỷ lệ respond & conversion tăng.
 *
 * Safety:
 *   - JSON schema strict validation
 *   - Anti-hallucination: không cho LLM bịa giá/ngày/hotel
 *   - Timeout 3s, fallback template nếu fail
 *   - Cache 5 phút tránh double-call
 *
 * Cost: Gemini Flash ~$0.00007/call → $0.21/tháng cho 100 conversations/day
 */

import { db } from '../../db';

// ═══════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════

export type OpeningAction = 'greet_new' | 'resume_context' | 'acknowledge_return';

export interface OpeningPersonalization {
  mention_name?: boolean;
  mention_previous_inquiry?: boolean;
  mention_previous_booking?: boolean;
  use_vip_tone?: boolean;
  timeframe_ack?: 'just_now' | 'earlier_today' | 'yesterday' | 'after_week' | 'long_gap';
}

export interface OpeningDecision {
  action: OpeningAction;
  context_relevance: number;       // 0-1
  summary_previous?: string;       // Bối cảnh cũ (tối đa 200 chars)
  suggested_opening?: string;      // Custom text (chỉ khi resume_context)
  personalization?: OpeningPersonalization;
  fallback_template_id: string;    // Template ID dùng khi không custom
  confidence: number;              // 0-1
  llm_provider: string;
  from_cache?: boolean;
}

export interface CAOContext {
  senderId: string;
  hotelId: number;
  currentMessage: string;
  customerProfile: {
    name?: string;
    tier?: string;
    last_area?: string;
    last_property_type?: string;
    last_budget?: number;
    total_bookings?: number;
    days_since_last_visit?: number;
    favorite_district?: string;
  } | null;
  history: Array<{ role: string; message: string; ts?: number }>;
  sessionGapMinutes?: number;
}

// ═══════════════════════════════════════════════════════════
// Settings
// ═══════════════════════════════════════════════════════════

function getCAOSetting(key: string, def: any): any {
  try {
    const { getSetting } = require('../../db');
    const v = getSetting(`cao_${key}`);
    return v !== undefined && v !== null ? v : def;
  } catch { return def; }
}

export function isCAOEnabled(): boolean {
  const v = getCAOSetting('enabled', 'true');
  return v === 'true' || v === true || v === '1';
}

const DEFAULT_SESSION_GAP_MIN = 30;
const DEFAULT_MIN_HISTORY = 2;
const DEFAULT_CACHE_TTL_MIN = 5;
const DEFAULT_TIMEOUT_MS = 3000;

// ═══════════════════════════════════════════════════════════
// Trigger check
// ═══════════════════════════════════════════════════════════

/**
 * Check: CAO có nên fire cho request này không?
 */
export function shouldUseCAO(ctx: CAOContext): { use: boolean; reason: string } {
  if (!isCAOEnabled()) return { use: false, reason: 'cao_disabled' };

  // Bỏ qua khách hoàn toàn mới (không có profile + không có history)
  const hasProfile = ctx.customerProfile && ctx.customerProfile.name;
  const historyCount = ctx.history.filter(h => h.role === 'user').length;

  if (!hasProfile && historyCount < Number(getCAOSetting('min_history_msgs', DEFAULT_MIN_HISTORY))) {
    return { use: false, reason: 'new_customer_no_history' };
  }

  // Session gap: nếu tin nhắn user gần nhất trong history < threshold thì KHÔNG phải "opener"
  //              đơn giản là continue session → không cần CAO
  const gapMs = Number(getCAOSetting('session_gap_minutes', DEFAULT_SESSION_GAP_MIN)) * 60 * 1000;
  const lastMsg = ctx.history.length > 0 ? ctx.history[ctx.history.length - 1] : null;
  if (lastMsg && lastMsg.ts && Date.now() - lastMsg.ts < gapMs) {
    // Recent activity — đây không phải opener
    // Note: orchestrator đã gate bằng isFirstTurn rồi, nhưng double-check cho an toàn
    return { use: false, reason: 'session_active' };
  }

  return { use: true, reason: 'qualify' };
}

// ═══════════════════════════════════════════════════════════
// LLM call
// ═══════════════════════════════════════════════════════════

const SYSTEM_PROMPT = `Bạn là chuyên gia CSKH phân tích bối cảnh mở đầu hội thoại cho chatbot Sonder (nền tảng lưu trú TP.HCM).

NHIỆM VỤ: Phân tích 5 tin nhắn gần nhất + profile khách → quyết định cách mở đầu phù hợp.

3 ACTIONS:
1. **greet_new** — Khách cũ nhưng:
   - Đã quá lâu (>30 ngày không inbox)
   - Topic cũ không còn relevant (khách đã book xong rồi, giờ hỏi chuyện khác hoàn toàn)
   → Dùng template returning_customer_greet

2. **resume_context** — Khách inbox lại tiếp nối mạch cũ:
   - Lần trước đang hỏi/tư vấn chưa kết thúc
   - Khách đang continue conversation cũ
   - GENERATE custom opening text tự nhiên, bám sát nội dung cụ thể
   - KHÔNG bịa giá, ngày, tên chỗ → chỉ reference những gì thấy trong history
   - Tối đa 3 câu, giọng "em", có emoji phù hợp

3. **acknowledge_return** — Khách có booking trước đó, giờ quay lại:
   - Acknowledge khách quen
   - Hỏi mở gợi ý hỗ trợ
   → Dùng template returning_customer_greet + personalization

QUY TẮC NGHIÊM NGẶT:
1. KHÔNG bao giờ bịa số liệu (giá, ngày, tên phòng) không có trong profile/history
2. Tên khách chỉ dùng nếu profile.name có giá trị — KHÔNG đoán tên
3. summary_previous PHẢI chính xác từ history, không diễn giải thêm
4. Nếu không chắc action nào → default greet_new
5. suggested_opening chỉ trả về khi action=resume_context, phải ≤ 400 ký tự

OUTPUT JSON STRICT (không thêm text khác ngoài JSON):
{
  "action": "greet_new" | "resume_context" | "acknowledge_return",
  "context_relevance": 0.0-1.0,
  "summary_previous": "...",
  "suggested_opening": "...",      // CHỈ khi resume_context
  "personalization": {
    "mention_name": boolean,
    "mention_previous_inquiry": boolean,
    "mention_previous_booking": boolean,
    "use_vip_tone": boolean,
    "timeframe_ack": "just_now" | "earlier_today" | "yesterday" | "after_week" | "long_gap"
  },
  "fallback_template_id": "returning_customer_greet" | "first_contact_warm",
  "confidence": 0.0-1.0
}`;

function buildUserPrompt(ctx: CAOContext): string {
  const profile = ctx.customerProfile;
  const parts: string[] = [];

  parts.push('=== CUSTOMER PROFILE ===');
  if (profile) {
    parts.push(`Tên: ${profile.name || '(chưa biết)'}`);
    parts.push(`Tier: ${profile.tier || 'new'}`);
    parts.push(`Tổng bookings: ${profile.total_bookings || 0}`);
    if (profile.days_since_last_visit !== undefined) {
      parts.push(`Ngày từ lần ghé cuối: ${profile.days_since_last_visit}`);
    }
    if (profile.last_area) parts.push(`Khu vực quan tâm gần nhất: ${profile.last_area}`);
    if (profile.last_property_type) parts.push(`Loại phòng gần nhất: ${profile.last_property_type}`);
    if (profile.favorite_district) parts.push(`Khu vực yêu thích: ${profile.favorite_district}`);
  } else {
    parts.push('(Khách mới, không có profile)');
  }

  parts.push('\n=== 5 TIN NHẮN GẦN NHẤT ===');
  const recentMsgs = ctx.history.slice(-10);  // Take last 10, focus on last 5 actively
  if (recentMsgs.length === 0) {
    parts.push('(Chưa có history)');
  } else {
    for (const h of recentMsgs) {
      const roleLabel = h.role === 'user' ? '👤 Khách' : '🤖 Bot';
      const msg = (h.message || '').substring(0, 300);
      const ts = h.ts ? ` [${new Date(h.ts).toISOString().slice(0, 16)}]` : '';
      parts.push(`${roleLabel}${ts}: ${msg}`);
    }
  }

  parts.push('\n=== TIN NHẮN MỚI (cần mở đầu cho đúng) ===');
  parts.push(`👤 Khách: ${ctx.currentMessage}`);

  parts.push('\nPhân tích → output JSON:');
  return parts.join('\n');
}

/**
 * Call LLM → get OpeningDecision.
 */
export async function callOpeningLLM(ctx: CAOContext): Promise<OpeningDecision | null> {
  const provider = getCAOSetting('llm_provider', 'gemini_flash');
  const timeoutMs = Number(getCAOSetting('timeout_ms', DEFAULT_TIMEOUT_MS));

  const system = SYSTEM_PROMPT;
  const user = buildUserPrompt(ctx);

  try {
    const { smartCascade } = require('../smart-cascade');

    // Race với timeout
    const callPromise = smartCascade({
      system,
      user,
      json: true,
      temperature: 0.3,
      maxTokens: 600,
      startFrom: provider,
    });

    const timeoutPromise = new Promise<never>((_, rej) =>
      setTimeout(() => rej(new Error('CAO LLM timeout')), timeoutMs)
    );

    const result = await Promise.race([callPromise, timeoutPromise]);
    if (!result?.text) return null;

    // Parse JSON
    let parsed: any;
    try { parsed = JSON.parse(result.text); }
    catch {
      const m = result.text.match(/\{[\s\S]*\}/);
      if (!m) return null;
      try { parsed = JSON.parse(m[0]); } catch { return null; }
    }

    // Schema validate + sanitize
    const validated = validateOpeningOutput(parsed, ctx);
    if (!validated) return null;

    return {
      ...validated,
      llm_provider: result.provider || provider,
    };
  } catch (e: any) {
    console.warn('[cao] LLM call err:', e?.message);
    return null;
  }
}

// ═══════════════════════════════════════════════════════════
// Validation + anti-hallucination
// ═══════════════════════════════════════════════════════════

const VALID_ACTIONS: OpeningAction[] = ['greet_new', 'resume_context', 'acknowledge_return'];
const VALID_TIMEFRAMES = ['just_now', 'earlier_today', 'yesterday', 'after_week', 'long_gap'];
const VALID_TEMPLATES = ['returning_customer_greet', 'first_contact_warm', 'first_vague'];

// Suspicious patterns — LLM bịa số / hotel name
const HALLUCINATION_PATTERNS = [
  /\d+[k.]?\d*\s*(?:k|nghìn|ngàn|triệu|đồng|vnd)/i,          // prices like "500k", "1tr", "500 nghìn"
  /\d{1,2}\/\d{1,2}(?:\/\d{2,4})?/,                              // dates like "25/5" or "25/5/2025"
  /\d+\s*(?:đêm|ngày|tháng)/i,                                    // "2 đêm", "3 ngày"
];

function validateOpeningOutput(parsed: any, ctx: CAOContext): Omit<OpeningDecision, 'llm_provider'> | null {
  if (!parsed || typeof parsed !== 'object') return null;
  if (!VALID_ACTIONS.includes(parsed.action)) return null;

  const confidence = clamp(Number(parsed.confidence) || 0.7, 0, 1);
  const contextRelevance = clamp(Number(parsed.context_relevance) || 0.5, 0, 1);

  const summaryPrevious = typeof parsed.summary_previous === 'string'
    ? parsed.summary_previous.substring(0, 300)
    : undefined;

  let suggestedOpening: string | undefined;
  if (parsed.action === 'resume_context' && typeof parsed.suggested_opening === 'string') {
    const candidate: string = parsed.suggested_opening.substring(0, 500);

    // Anti-hallucination check
    if (!passesHallucinationCheck(candidate, ctx)) {
      console.warn('[cao] suggested_opening failed hallucination check — fallback to template');
      // Downgrade to greet_new
      parsed.action = 'greet_new';
    } else {
      suggestedOpening = candidate;
    }
  }

  // Build personalization (safe defaults)
  const p: OpeningPersonalization = {};
  if (parsed.personalization && typeof parsed.personalization === 'object') {
    p.mention_name = Boolean(parsed.personalization.mention_name) && !!ctx.customerProfile?.name;
    p.mention_previous_inquiry = Boolean(parsed.personalization.mention_previous_inquiry);
    p.mention_previous_booking = Boolean(parsed.personalization.mention_previous_booking) && (ctx.customerProfile?.total_bookings || 0) > 0;
    p.use_vip_tone = Boolean(parsed.personalization.use_vip_tone) && ctx.customerProfile?.tier === 'vip';
    if (VALID_TIMEFRAMES.includes(parsed.personalization.timeframe_ack)) {
      p.timeframe_ack = parsed.personalization.timeframe_ack;
    }
  }

  // Fallback template
  let fallbackId = typeof parsed.fallback_template_id === 'string' && VALID_TEMPLATES.includes(parsed.fallback_template_id)
    ? parsed.fallback_template_id
    : (ctx.customerProfile?.name ? 'returning_customer_greet' : 'first_contact_warm');

  return {
    action: parsed.action as OpeningAction,
    context_relevance: contextRelevance,
    summary_previous: summaryPrevious,
    suggested_opening: suggestedOpening,
    personalization: p,
    fallback_template_id: fallbackId,
    confidence,
  };
}

/**
 * Anti-hallucination: nếu LLM gen số liệu/tên chỗ không có trong history → reject.
 */
function passesHallucinationCheck(text: string, ctx: CAOContext): boolean {
  // Scan for suspicious number/date patterns
  for (const pattern of HALLUCINATION_PATTERNS) {
    if (pattern.test(text)) {
      // Check if the number/date exists in history (legitimate to repeat)
      const historyText = ctx.history.map(h => h.message).join(' ');
      const suspectMatches = text.match(pattern);
      if (suspectMatches) {
        for (const match of suspectMatches) {
          if (!historyText.includes(match) && !ctx.currentMessage.includes(match)) {
            console.warn(`[cao] suspicious token not in history: "${match}"`);
            return false;
          }
        }
      }
    }
  }

  // Name check: nếu LLM mention name, phải match profile.name
  if (ctx.customerProfile?.name) {
    const lowerText = text.toLowerCase();
    const nameLower = ctx.customerProfile.name.toLowerCase();
    // Split name into parts (e.g., "Anh Minh" → ["anh", "minh"])
    // If text contains "Anh/Chị X" where X not in profile name parts → hallucination
    const customNameMatch = lowerText.match(/(?:anh|chị|em|bạn)\s+([a-zàáâãèéêìíòóôõùúăđĩũơưạảấầẩẫậắằẳẵặẹẻẽềềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹ]+)/i);
    if (customNameMatch) {
      const usedName = customNameMatch[1].toLowerCase();
      if (!nameLower.includes(usedName) && usedName !== 'chị') {
        console.warn(`[cao] name mismatch: LLM used "${usedName}", profile has "${nameLower}"`);
        return false;
      }
    }
  }

  return true;
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

// ═══════════════════════════════════════════════════════════
// Cache
// ═══════════════════════════════════════════════════════════

function getCacheTTLMs(): number {
  return Number(getCAOSetting('cache_ttl_minutes', DEFAULT_CACHE_TTL_MIN)) * 60 * 1000;
}

export function getCachedDecision(senderId: string): OpeningDecision | null {
  try {
    const row = db.prepare(`SELECT * FROM agentic_opening_cache WHERE sender_id = ?`).get(senderId) as any;
    if (!row) return null;
    if (Date.now() - row.cached_at > getCacheTTLMs()) return null;

    return {
      action: row.action as OpeningAction,
      context_relevance: row.context_relevance,
      summary_previous: row.summary_previous,
      suggested_opening: row.suggested_opening,
      personalization: row.personalization_json ? safeParse(row.personalization_json) : {},
      fallback_template_id: row.fallback_template_id,
      confidence: row.confidence,
      llm_provider: row.llm_provider,
      from_cache: true,
    };
  } catch { return null; }
}

export function saveCachedDecision(senderId: string, decision: OpeningDecision): void {
  try {
    db.prepare(`
      INSERT INTO agentic_opening_cache
        (sender_id, action, context_relevance, summary_previous, suggested_opening,
         personalization_json, fallback_template_id, confidence, llm_provider, cached_at, used_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(sender_id) DO UPDATE SET
        action = excluded.action,
        context_relevance = excluded.context_relevance,
        summary_previous = excluded.summary_previous,
        suggested_opening = excluded.suggested_opening,
        personalization_json = excluded.personalization_json,
        fallback_template_id = excluded.fallback_template_id,
        confidence = excluded.confidence,
        llm_provider = excluded.llm_provider,
        cached_at = excluded.cached_at,
        used_at = excluded.used_at,
        was_effective = NULL
    `).run(
      senderId,
      decision.action,
      decision.context_relevance,
      decision.summary_previous || null,
      decision.suggested_opening || null,
      decision.personalization ? JSON.stringify(decision.personalization) : null,
      decision.fallback_template_id,
      decision.confidence,
      decision.llm_provider,
      Date.now(),
      Date.now(),
    );
  } catch (e: any) { console.warn('[cao] cache save err:', e?.message); }
}

/**
 * Mark was_effective sau khi khách respond.
 */
export function markCAOEffectiveness(senderId: string, effective: boolean): void {
  try {
    db.prepare(`UPDATE agentic_opening_cache SET was_effective = ? WHERE sender_id = ?`)
      .run(effective ? 1 : 0, senderId);
  } catch {}
}

// ═══════════════════════════════════════════════════════════
// Main entry
// ═══════════════════════════════════════════════════════════

export interface CAORenderResult {
  reply: string;
  decision: OpeningDecision;
  template_id?: string;    // Nếu dùng template (greet_new / acknowledge_return)
  custom_generated: boolean;  // true nếu resume_context với custom text
}

/**
 * Main: decide + render opening.
 * Return null nếu CAO không apply (new customer, active session, etc).
 */
export async function runCAO(ctx: CAOContext): Promise<CAORenderResult | null> {
  const check = shouldUseCAO(ctx);
  if (!check.use) {
    console.log(`[cao] skip: ${check.reason}`);
    return null;
  }

  // Check cache
  let decision = getCachedDecision(ctx.senderId);

  if (!decision) {
    // Fresh LLM call
    decision = await callOpeningLLM(ctx);
    if (!decision) {
      console.warn('[cao] LLM fail, return null → caller fallback to template');
      return null;
    }
    saveCachedDecision(ctx.senderId, decision);
  }

  // Build reply
  if (decision.action === 'resume_context' && decision.suggested_opening) {
    // Use custom LLM opening
    return {
      reply: decision.suggested_opening,
      decision,
      custom_generated: true,
    };
  }

  // Use fallback template (greet_new / acknowledge_return)
  // Caller will render it — we just return decision + template_id
  return {
    reply: '',  // Empty — caller will renderTemplate
    decision,
    template_id: decision.fallback_template_id,
    custom_generated: false,
  };
}

// ═══════════════════════════════════════════════════════════
// Stats (admin UI)
// ═══════════════════════════════════════════════════════════

export function getCAOStats(daysAgo: number = 7): any {
  const since = Date.now() - daysAgo * 24 * 3600 * 1000;
  try {
    const byAction = db.prepare(`
      SELECT action, COUNT(*) as n,
        AVG(confidence) as avg_conf,
        AVG(context_relevance) as avg_rel,
        SUM(CASE WHEN was_effective = 1 THEN 1 ELSE 0 END) as effective
      FROM agentic_opening_cache WHERE cached_at > ?
      GROUP BY action
    `).all(since);

    const byProvider = db.prepare(`
      SELECT llm_provider, COUNT(*) as n
      FROM agentic_opening_cache WHERE cached_at > ?
      GROUP BY llm_provider
    `).all(since);

    const totals = db.prepare(`
      SELECT COUNT(*) as total,
        SUM(CASE WHEN was_effective = 1 THEN 1 ELSE 0 END) as effective_total,
        SUM(CASE WHEN was_effective = 0 THEN 1 ELSE 0 END) as drop_total
      FROM agentic_opening_cache WHERE cached_at > ?
    `).get(since);

    return { byAction, byProvider, totals, since };
  } catch (e: any) {
    return { error: e?.message };
  }
}

function safeParse(s: string): any {
  try { return JSON.parse(s); } catch { return null; }
}

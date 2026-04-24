/**
 * Safety Guard — v27 Agentic Bot
 *
 * Kiểm tra PRE-REPLY: có nên dùng AI hay không?
 *
 * 3 checks:
 *   1. DATA AVAILABILITY — intent cần data gì, có trong DB không?
 *   2. CONFIDENCE THRESHOLD — score từ confidence-scorer
 *   3. STUCK DETECTION — đã loop mấy turns
 *
 * Nếu trigger safety:
 *   - Render safety_unknown template
 *   - Execute handoff
 *   - Return { should_skip_ai: true, reply: template_text }
 */

import { db } from '../../db';
import { computeConfidence, ConfidenceInputs, ConfidenceResult } from './confidence-scorer';
import { renderTemplate } from './template-library';
import { executeHandoff, HandoffContext } from './human-handoff';

export interface SafetyCheckInput {
  sender_id: string;
  hotel_id?: number;
  user_message: string;
  intent: string;
  sub_category?: string;
  intent_confidence: number;
  rag_match_score: number;
  slot_completeness: number;
  template_match: { id: string; score: number } | null;
  stuck_turns: number;
  turn_number: number;
  slots?: any;
  history?: Array<{ role: string; message: string }>;
  customer_name?: string;
}

export interface SafetyCheckResult {
  confidence: ConfidenceResult;
  action: 'proceed_template' | 'proceed_rag_ai' | 'proceed_full_ai' | 'trigger_safety' | 'trigger_handoff';
  reply?: string;
  quick_replies?: Array<{ title: string; payload: string }>;
  handoff_log_id?: number;
  recommended_template?: string;
  cost_estimate: 'free' | 'low' | 'medium' | 'high';   // token cost hint
}

/**
 * Check if intent requires data that exists in DB.
 */
function checkDataAvailability(intent: string, sub_category: string | undefined): boolean {
  try {
    // Basic: có ít nhất 1 active hotel trong network?
    const hotelCount = (db.prepare(
      `SELECT COUNT(*) as n FROM mkt_hotels WHERE status = 'active'`
    ).get() as any)?.n || 0;

    if (hotelCount === 0) return false;

    // Intent-specific checks
    if (intent === 'info_question') {
      if (sub_category === 'price') {
        // Cần có price data trong hotel_room_catalog
        const priceCount = (db.prepare(
          `SELECT COUNT(*) as n FROM hotel_room_catalog WHERE price_weekday > 0`
        ).get() as any)?.n || 0;
        return priceCount > 0;
      }
      if (sub_category === 'amenity' || sub_category === 'wifi') {
        const amenityCount = (db.prepare(
          `SELECT COUNT(*) as n FROM hotel_amenities`
        ).get() as any)?.n || 0;
        return amenityCount > 0;
      }
      if (sub_category === 'location') return true;   // always available
    }

    if (intent === 'booking') return hotelCount > 0;
    return true;
  } catch { return true; }
}

/**
 * Main safety check — called trước khi decide reply strategy.
 */
export async function safetyCheck(input: SafetyCheckInput): Promise<SafetyCheckResult> {
  const hasData = checkDataAvailability(input.intent, input.sub_category);

  // Compute confidence
  const confidence = computeConfidence({
    intent_confidence: input.intent_confidence,
    intent_type: input.intent,
    sub_category: input.sub_category,
    rag_match_score: input.rag_match_score,
    has_structured_data: hasData,
    slot_completeness: input.slot_completeness,
    template_match: input.template_match,
    stuck_turns: input.stuck_turns,
    turn_number: input.turn_number,
  });

  // ══════════════════════════════════════════════════════
  // HANDOFF TRIGGERS (must handoff, no AI)
  // ══════════════════════════════════════════════════════

  // Trigger 1: User explicitly asks for human
  const m = input.user_message.toLowerCase();
  if (/\b(gặp nhân viên|cskh|hotline|gọi điện|tư vấn viên|nhân viên|staff|call|speak to human)\b/.test(m)) {
    const handoff = await executeHandoff({
      sender_id: input.sender_id,
      hotel_id: input.hotel_id,
      customer_name: input.customer_name,
      trigger_reason: 'user_request',
      confidence_score: confidence.score,
      last_message: input.user_message,
      slots: input.slots,
      history: input.history,
    });
    const t = renderTemplate('handoff_execute', { customerName: input.customer_name });
    return {
      confidence,
      action: 'trigger_handoff',
      reply: t?.content,
      quick_replies: t?.quick_replies,
      handoff_log_id: handoff.log_id,
      cost_estimate: 'free',
    };
  }

  // Trigger 2: Stuck 3+ turns → force handoff
  if (input.stuck_turns >= 3) {
    const handoff = await executeHandoff({
      sender_id: input.sender_id,
      hotel_id: input.hotel_id,
      customer_name: input.customer_name,
      trigger_reason: 'stuck_turns',
      confidence_score: confidence.score,
      last_message: input.user_message,
      slots: input.slots,
      history: input.history,
    });
    const t = renderTemplate('handoff_execute', { customerName: input.customer_name });
    return {
      confidence,
      action: 'trigger_handoff',
      reply: t?.content,
      quick_replies: t?.quick_replies,
      handoff_log_id: handoff.log_id,
      cost_estimate: 'free',
    };
  }

  // Trigger 3: Turn >= 6 AND không tiến triển (slot completeness < 0.4)
  if (input.turn_number >= 6 && input.slot_completeness < 0.4) {
    // Offer handoff (không force)
    const t = renderTemplate('handoff_offer', {});
    return {
      confidence,
      action: 'trigger_safety',
      reply: t?.content,
      quick_replies: t?.quick_replies,
      cost_estimate: 'free',
    };
  }

  // ══════════════════════════════════════════════════════
  // SAFETY MODE: confidence < 0.3
  // ══════════════════════════════════════════════════════

  if (confidence.tier === 'safety') {
    // Data thật sự không có → render safety_unknown + handoff
    const handoff = await executeHandoff({
      sender_id: input.sender_id,
      hotel_id: input.hotel_id,
      customer_name: input.customer_name,
      trigger_reason: hasData ? 'safety_low_conf' : 'data_not_found',
      confidence_score: confidence.score,
      last_message: input.user_message,
      slots: input.slots,
      history: input.history,
    });
    const t = renderTemplate('safety_unknown', {});
    return {
      confidence,
      action: 'trigger_safety',
      reply: t?.content,
      quick_replies: t?.quick_replies,
      handoff_log_id: handoff.log_id,
      cost_estimate: 'free',
    };
  }

  // ══════════════════════════════════════════════════════
  // TEMPLATE TIER: high confidence + good match
  // ══════════════════════════════════════════════════════

  if (confidence.tier === 'template' && confidence.recommended_template) {
    return {
      confidence,
      action: 'proceed_template',
      recommended_template: confidence.recommended_template,
      cost_estimate: 'free',
    };
  }

  // ══════════════════════════════════════════════════════
  // RAG-AUGMENTED AI: moderate confidence
  // ══════════════════════════════════════════════════════

  if (confidence.tier === 'rag_ai') {
    return { confidence, action: 'proceed_rag_ai', cost_estimate: 'low' };
  }

  // Full AI (last resort, expensive)
  return { confidence, action: 'proceed_full_ai', cost_estimate: 'medium' };
}

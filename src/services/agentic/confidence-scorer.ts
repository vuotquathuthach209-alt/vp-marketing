/**
 * Confidence Scorer — v27 Agentic Bot
 *
 * Compute composite confidence (0-1) để decide reply tier:
 *   >= 0.80 → TEMPLATE (high accuracy, no AI)
 *   >= 0.50 → RAG_AI (moderate, augmented)
 *   <  0.50 → SAFETY (handoff to human)
 *
 * Formula:
 *   confidence =
 *     0.35 × intent_confidence     (Gemini classify certainty)
 *   + 0.30 × rag_match_score        (top RAG cosine similarity)
 *   + 0.20 × data_completeness      (required slots present ratio)
 *   + 0.15 × template_match_score   (pattern match known templates)
 *
 * Anti-hallucination checks:
 *   - If intent=info_question AND rag_match < 0.4 → score capped 0.4 (force SAFETY)
 *   - If intent=booking AND no hotel data available → cap 0.3
 *   - If 2+ same-stage turns → penalty -0.2 (force escalation)
 */

import { db } from '../../db';

export interface ConfidenceInputs {
  intent_confidence: number;       // 0-1, from Gemini classifier
  intent_type: string;              // 'booking'|'info_question'|'greeting'|...
  sub_category?: string;            // 'price'|'amenity'|...
  rag_match_score: number;          // 0-1, max cosine của top RAG chunk
  has_structured_data: boolean;     // Có structured data để trả lời?
  slot_completeness: number;        // 0-1, % slots filled vs required
  template_match: { id: string; score: number } | null;
  stuck_turns: number;              // same_stage_count (escape hatch)
  turn_number: number;              // current turn in conversation
}

export interface ConfidenceResult {
  score: number;                    // 0-1 final
  tier: 'template' | 'rag_ai' | 'full_ai' | 'safety';
  breakdown: Record<string, number>;
  reasons: string[];                // Debug: why this tier
  recommended_template?: string;    // Nếu tier=template
}

/**
 * Main scorer — return tier + reasons.
 */
export function computeConfidence(inputs: ConfidenceInputs): ConfidenceResult {
  const breakdown: Record<string, number> = {};
  const reasons: string[] = [];

  // 1. Intent certainty (35%)
  breakdown.intent = (inputs.intent_confidence || 0) * 0.35;

  // 2. RAG match (30%)
  breakdown.rag = (inputs.rag_match_score || 0) * 0.30;

  // 3. Data completeness (20%)
  breakdown.data = (inputs.slot_completeness || 0) * 0.20;

  // 4. Template match (15%)
  breakdown.template = (inputs.template_match?.score || 0) * 0.15;

  let score = Object.values(breakdown).reduce((a, b) => a + b, 0);

  // ══════════════════════════════════════════════════════
  // HALLUCINATION GUARDS — cap score if risky situations
  // ══════════════════════════════════════════════════════

  // Guard 1: info_question but no RAG match + no structured data
  if (inputs.intent_type === 'info_question' && inputs.rag_match_score < 0.4 && !inputs.has_structured_data) {
    score = Math.min(score, 0.4);
    reasons.push('guard_info_no_data: cap 0.4');
  }

  // Guard 2: booking but no hotel data available
  if (inputs.intent_type === 'booking' && !inputs.has_structured_data) {
    score = Math.min(score, 0.3);
    reasons.push('guard_booking_no_hotels: cap 0.3');
  }

  // Guard 3: stuck 2+ turns → penalty + force escalation
  if (inputs.stuck_turns >= 2) {
    score -= 0.2;
    reasons.push(`guard_stuck_${inputs.stuck_turns}: penalty -0.2`);
  }

  // Guard 4: turn >= 5 without resolution → offer handoff (but don't force)
  if (inputs.turn_number >= 5 && inputs.slot_completeness < 0.5) {
    score -= 0.1;
    reasons.push(`guard_slow_progress: penalty -0.1`);
  }

  // Clamp 0-1
  score = Math.max(0, Math.min(1, score));

  // ══════════════════════════════════════════════════════
  // TIER DECISION
  // ══════════════════════════════════════════════════════

  let tier: ConfidenceResult['tier'];
  if (score >= 0.80 && inputs.template_match && inputs.template_match.score >= 0.7) {
    tier = 'template';
    reasons.push(`template_match: ${inputs.template_match.id}`);
  } else if (score >= 0.50) {
    tier = 'rag_ai';
    reasons.push('moderate_confidence: RAG-augmented AI');
  } else if (score >= 0.30) {
    tier = 'full_ai';
    reasons.push('low_confidence: full AI with disclaimer');
  } else {
    tier = 'safety';
    reasons.push('below_threshold: safety handoff');
  }

  return {
    score: Math.round(score * 100) / 100,
    tier,
    breakdown: Object.fromEntries(
      Object.entries(breakdown).map(([k, v]) => [k, Math.round(v * 100) / 100])
    ),
    reasons,
    recommended_template: tier === 'template' ? inputs.template_match?.id : undefined,
  };
}

/**
 * Helper: compute slot_completeness from FSM slots + intent.
 */
export function computeSlotCompleteness(
  slots: any,
  intent: string,
  isLongTerm: boolean = false,
): number {
  if (intent !== 'booking') return 1.0;   // N/A for non-booking

  const required = isLongTerm
    ? ['property_type', 'checkin_date', 'months', 'guests_adults', 'area_normalized']
    : ['property_type', 'checkin_date', 'nights', 'guests_adults', 'area_normalized'];

  const filled = required.filter(k => {
    const v = slots[k];
    return v !== undefined && v !== null && v !== '';
  }).length;

  return filled / required.length;
}

/**
 * Match message to known template patterns.
 * Return best-match template ID + score.
 */
export function matchTemplate(
  msg: string,
  intent: string,
  sub_category: string | undefined,
  turn: number,
): { id: string; score: number } | null {
  const m = msg.toLowerCase().trim();

  // Turn 0/1 greeting (first-ever msg)
  if (turn <= 1) {
    if (/^(chào|hello|hi|hey|alo|xin chào|dạ|hi em|chào em)/.test(m)) {
      return { id: 'greeting_opening', score: 0.95 };
    }
    return { id: 'greeting_opening', score: 0.85 };
  }

  // Explicit intent markers
  if (/\b(gặp nhân viên|cskh|hotline|gọi điện|tư vấn viên|nhân viên|staff)\b/.test(m)) {
    return { id: 'handoff_offer', score: 0.92 };
  }
  if (/\b(tạm biệt|bye|goodbye|cảm ơn|thanks|ok không đặt)\b/.test(m)) {
    return { id: 'bye_friendly', score: 0.9 };
  }

  // Info intent matching
  if (intent === 'info_question') {
    if (sub_category === 'price' || /\b(giá|bao nhiêu|tiền|cost)\b/.test(m)) {
      return { id: 'info_price_range', score: 0.85 };
    }
    if (sub_category === 'location' || /\b(ở đâu|địa chỉ|vị trí|location)\b/.test(m)) {
      return { id: 'info_location_overview', score: 0.85 };
    }
  }

  // Booking intent turn 2-3 → discovery template
  if (intent === 'booking' && turn >= 2 && turn <= 3) {
    if (/\b(chdv|căn hộ|thuê tháng|apartment|monthly)\b/.test(m)) {
      return { id: 'discover_long_stay', score: 0.88 };
    }
    return { id: 'discover_short_stay', score: 0.80 };
  }

  // Unclear
  if (intent === 'unclear' && turn >= 2) {
    return { id: 'discover_clarify_intent', score: 0.75 };
  }

  return null;
}

/**
 * Get recent stuck count for sender (cho guard 3).
 */
export function getStuckTurns(senderId: string): number {
  try {
    const row = db.prepare(
      `SELECT same_stage_count FROM bot_conversation_state WHERE sender_id = ?`
    ).get(senderId) as any;
    return row?.same_stage_count || 0;
  } catch {
    return 0;
  }
}

/**
 * Get turn number for current session.
 */
export function getTurnNumber(senderId: string): number {
  try {
    const row = db.prepare(
      `SELECT COUNT(*) as n FROM conversation_memory
       WHERE sender_id = ? AND role = 'user'
         AND created_at > (SELECT COALESCE(updated_at, 0) FROM bot_conversation_state WHERE sender_id = ?) - 1800000`
    ).get(senderId, senderId) as any;
    return row?.n || 1;
  } catch {
    return 1;
  }
}

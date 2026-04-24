/**
 * Agentic Orchestrator — v27 main loop.
 *
 * OBSERVE → PLAN → REASON → ACT pattern.
 *
 * Entry point: processMessageAgentic(senderId, hotelId, msg, opts)
 *
 * Flow:
 *   1. OBSERVE: gather full context (history, state, customer profile)
 *   2. PLAN:    turn_number drives strategy
 *                 turn 1  → GREETING template (no AI)
 *                 turn 2-3 → DISCOVERY template (smart batch question)
 *                 turn 4+ → ACTION (book/info/handoff)
 *   3. REASON:  compute confidence → safety guard
 *   4. ACT:     render reply via appropriate tier
 *
 * Feature flag: USE_AGENTIC_FLOW=true trong .env hoặc settings.
 * Default: disabled — em tests trước khi enable production.
 */

import { db } from '../../db';
import { safetyCheck } from './safety-guard';
import { renderTemplate } from './template-library';
import { matchTemplate, getStuckTurns, getTurnNumber, computeSlotCompleteness } from './confidence-scorer';

export interface AgenticResult {
  reply: string;
  quick_replies?: Array<{ title: string; payload: string }>;
  intent: string;
  confidence_score: number;
  tier_used: 'template' | 'rag_ai' | 'full_ai' | 'safety' | 'handoff';
  handoff_triggered: boolean;
  cost_estimate: 'free' | 'low' | 'medium' | 'high';
  meta?: any;
}

/**
 * Main entry — process 1 user message via agentic pipeline.
 */
export async function processMessageAgentic(
  senderId: string,
  hotelId: number,
  msg: string,
  opts: { language?: string; imageUrl?: string } = {},
): Promise<AgenticResult | null> {
  try {
    // ═══════════════════════════════════════════
    // 1. OBSERVE — gather context
    // ═══════════════════════════════════════════
    const turnNumber = getTurnNumber(senderId);
    const stuckTurns = getStuckTurns(senderId);

    // Customer profile (returning check)
    let customerName: string | undefined;
    let customerTier: string | undefined;
    try {
      const { getCustomerProfile } = require('../customer-memory');
      const profile = getCustomerProfile(senderId);
      if (profile) {
        customerName = profile.name;
        customerTier = profile.customer_tier;
      }
    } catch {}

    // FSM state + slots
    let slots: any = {};
    try {
      const { getState } = require('../conversation-fsm');
      const state = getState(senderId);
      if (state) slots = state.slots || {};
    } catch {}

    // Recent history (5 messages)
    const historyRows = db.prepare(
      `SELECT role, message FROM conversation_memory
       WHERE sender_id = ? ORDER BY id DESC LIMIT 10`
    ).all(senderId) as any[];
    const history = historyRows.reverse().map((r: any) => ({ role: r.role, message: r.message }));

    // ═══════════════════════════════════════════
    // TURN 1 FAST-PATH: pure greeting (template)
    // turnNumber = số user msg ĐÃ CÓ trong DB. 0 = msg này là msg đầu.
    // ═══════════════════════════════════════════
    const isFirstTurn = turnNumber === 0 || history.filter(h => h.role === 'user').length === 0;
    if (isFirstTurn) {
      const templateId = customerName ? 'greeting_returning' : 'greeting_opening';
      const t = renderTemplate(templateId, { customerName, customerTier });
      if (t) {
        console.log(`[agentic] turn 1 (first-ever) → template ${templateId} (no AI)`);
        return {
          reply: t.content,
          quick_replies: t.quick_replies,
          intent: 'greeting',
          confidence_score: 1.0,
          tier_used: 'template',
          handoff_triggered: false,
          cost_estimate: 'free',
          meta: { template_id: templateId, turn_number: 1 },
        };
      }
    }

    // ═══════════════════════════════════════════
    // 2. PLAN — intent classification (Gemini)
    // ═══════════════════════════════════════════
    let intentResult: any = null;
    try {
      const { analyzeIntent } = require('../gemini-intent-classifier');
      intentResult = await analyzeIntent(msg, { senderId, hasPrevContext: history.length > 0 });
    } catch (e: any) {
      console.warn('[agentic] intent classify fail:', e?.message);
    }

    const intent = intentResult?.primary_intent || 'unclear';
    const subCategory = intentResult?.sub_category;
    const intentConfidence = intentResult?.confidence || 0.5;

    // ═══════════════════════════════════════════
    // 3. REASON — RAG match + template match + safety
    // ═══════════════════════════════════════════

    // RAG match score (if info_question)
    let ragMatchScore = 0;
    if (intent === 'info_question' || (intent === 'booking' && turnNumber >= 3)) {
      try {
        const { unifiedQuery } = require('../knowledge-sync');
        const qr = await unifiedQuery(msg);
        ragMatchScore = qr?.confidence || 0;
      } catch {}
    }

    // Slot completeness
    const isLongTerm = slots.rental_mode === 'long_term';
    const slotCompleteness = computeSlotCompleteness(slots, intent, isLongTerm);

    // Template match
    const templateMatch = matchTemplate(msg, intent, subCategory, turnNumber);

    // Safety check → returns action
    const safety = await safetyCheck({
      sender_id: senderId,
      hotel_id: hotelId,
      user_message: msg,
      intent,
      sub_category: subCategory,
      intent_confidence: intentConfidence,
      rag_match_score: ragMatchScore,
      slot_completeness: slotCompleteness,
      template_match: templateMatch,
      stuck_turns: stuckTurns,
      turn_number: turnNumber,
      slots,
      history,
      customer_name: customerName,
    });

    console.log(`[agentic] turn=${turnNumber} intent=${intent} conf=${safety.confidence.score} tier=${safety.confidence.tier} action=${safety.action}`);

    // ═══════════════════════════════════════════
    // 4. ACT — render reply by tier
    // ═══════════════════════════════════════════

    if (safety.action === 'trigger_handoff' || safety.action === 'trigger_safety') {
      return {
        reply: safety.reply || 'Em xin lỗi, em kết nối anh/chị với nhân viên ạ.',
        quick_replies: safety.quick_replies,
        intent: 'handoff',
        confidence_score: safety.confidence.score,
        tier_used: safety.action === 'trigger_handoff' ? 'handoff' : 'safety',
        handoff_triggered: true,
        cost_estimate: 'free',
        meta: {
          reasons: safety.confidence.reasons,
          handoff_log_id: safety.handoff_log_id,
        },
      };
    }

    if (safety.action === 'proceed_template' && safety.recommended_template) {
      const t = renderTemplate(safety.recommended_template, { customerName, customerTier });
      if (t) {
        return {
          reply: t.content,
          quick_replies: t.quick_replies,
          intent,
          confidence_score: safety.confidence.score,
          tier_used: 'template',
          handoff_triggered: false,
          cost_estimate: 'free',
          meta: {
            template_id: safety.recommended_template,
            reasons: safety.confidence.reasons,
          },
        };
      }
    }

    // RAG_AI or FULL_AI: fall through to existing FSM/funnel-dispatcher
    // Em KHÔNG re-implement AI generation ở đây — delegate.
    // Orchestrator chỉ decide strategy, existing code handle actual generation.
    return null;    // Signal caller to use legacy flow
  } catch (e: any) {
    console.error('[agentic] orchestrator error:', e?.message);
    return null;    // Fallback to legacy
  }
}

/**
 * Admin helper: check if agentic flow is enabled.
 */
export function isAgenticEnabled(): boolean {
  if (process.env.USE_AGENTIC_FLOW === 'true' || process.env.USE_AGENTIC_FLOW === '1') {
    return true;
  }
  try {
    const { getSetting } = require('../../db');
    const override = getSetting('agentic_flow_enabled');
    return override === 'true';
  } catch {
    return false;
  }
}

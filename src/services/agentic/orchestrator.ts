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
import {
  selectTemplate,
  selectTemplateWithCandidates,
  renderTemplateById,
  trackTemplateUse,
  detectAndMarkConversion,
  detectAndTrackClick,
  logSelection,
  getTemplateById,
} from './template-engine';
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
    // 0a. QR CLICK CHECK — nếu msg khớp title của quick_reply → count click
    //     (phải chạy TRƯỚC conversion check vì click cũng có thể kèm positive signal)
    // ═══════════════════════════════════════════
    try {
      const click = detectAndTrackClick(senderId, msg);
      if (click.clicked) {
        console.log(`[agentic] QR click tracked: ${click.template_id}${click.variant_key ? ':' + click.variant_key : ''} button="${click.button}"`);
      }
    } catch {}

    // ═══════════════════════════════════════════
    // 0b. CONVERSION CHECK — nếu msg là positive signal sau template gần đây
    //     → mark conversion cho template đó (và variant nếu có A/B)
    // ═══════════════════════════════════════════
    try {
      const conv = detectAndMarkConversion(senderId, msg);
      if (conv.converted) {
        console.log(`[agentic] conversion tracked: ${conv.template_id}${conv.variant_key ? ':' + conv.variant_key : ''} (${conv.category})`);
      }
    } catch {}

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

    // Recent history (10 messages, newest last). Include timestamps for session gap detection.
    const historyRows = db.prepare(
      `SELECT role, message, created_at FROM conversation_memory
       WHERE sender_id = ? ORDER BY id DESC LIMIT 10`
    ).all(senderId) as any[];
    const history = historyRows.reverse().map((r: any) => ({
      role: r.role,
      message: r.message,
      ts: r.created_at,
    }));

    // ═══════════════════════════════════════════
    // TURN 1 / SESSION RESUME: Context-Aware Opener
    //
    // Nếu là:
    //   - First turn (chưa có user msg nào), OR
    //   - Session gap > 30 min (inbox lại sau khi im lặng lâu)
    //
    // VÀ khách có profile hoặc có history ≥ 2 msgs:
    //   → Gọi LLM (Gemini Flash) đọc 5 tin nhắn cuối + profile → quyết định mở đầu
    //
    // Khách mới hoàn toàn (no profile, no history) → dùng template fast-path luôn (tiết kiệm cost)
    // ═══════════════════════════════════════════
    const userMsgCount = history.filter(h => h.role === 'user').length;
    const isFirstTurn = turnNumber === 0 || userMsgCount === 0;

    // Session gap: tin nhắn gần nhất cách đây bao lâu?
    const lastMsgTs = history.length > 0 ? history[history.length - 1].ts : 0;
    const sessionGapMs = lastMsgTs ? Date.now() - lastMsgTs : Number.POSITIVE_INFINITY;
    const SESSION_GAP_THRESHOLD_MS = 30 * 60 * 1000;
    const isSessionResume = !isFirstTurn && sessionGapMs > SESSION_GAP_THRESHOLD_MS;

    const shouldTryOpener = isFirstTurn || isSessionResume;

    if (shouldTryOpener) {
      const isVip = customerTier === 'vip';

      // ── Thử CAO (chỉ cho returning customer hoặc có history) ──
      let caoResult: any = null;
      try {
        const { runCAO } = require('./context-aware-opener');
        const profile = {
          name: customerName,
          tier: customerTier,
          total_bookings: 0,   // Will fill below if available
          days_since_last_visit: undefined,
          last_area: undefined,
          last_property_type: undefined,
          favorite_district: undefined,
          last_budget: undefined,
        };
        // Enrich profile với info sâu hơn
        try {
          const { getCustomerProfile } = require('../customer-memory');
          const full = getCustomerProfile(senderId);
          if (full) Object.assign(profile, full);
        } catch {}

        caoResult = await runCAO({
          senderId,
          hotelId,
          currentMessage: msg,
          customerProfile: profile.name ? profile : null,
          history,
          sessionGapMinutes: Math.floor(sessionGapMs / 60000),
        });
      } catch (e: any) {
        console.warn('[agentic] CAO error:', e?.message);
      }

      // ── CAO returned custom opening (resume_context) ──
      if (caoResult && caoResult.custom_generated && caoResult.reply) {
        console.log(`[agentic] CAO ${caoResult.decision.action} (${caoResult.decision.llm_provider}) conf=${caoResult.decision.confidence} rel=${caoResult.decision.context_relevance}`);

        // Track opening usage (use special template_id "cao_custom")
        trackTemplateUse(senderId, 'cao_custom', 'discovery');
        logSelection(senderId, hotelId, 'cao_custom', {
          turn_number: turnNumber + 1,
          message: msg,
          customer_is_returning: !!customerName,
        }, [], caoResult.decision.confidence);

        return {
          reply: caoResult.reply,
          intent: 'greeting',
          confidence_score: caoResult.decision.confidence,
          tier_used: 'template',   // Still template tier for metrics (cost=low)
          handoff_triggered: false,
          cost_estimate: 'low',
          meta: {
            template_id: 'cao_custom',
            cao_action: caoResult.decision.action,
            cao_summary: caoResult.decision.summary_previous,
            cao_provider: caoResult.decision.llm_provider,
            cao_from_cache: caoResult.decision.from_cache,
            turn_number: turnNumber + 1,
          },
        };
      }

      // ── CAO decided greet_new / acknowledge_return → use template với personalization ──
      const ctx: any = {
        turn_number: 1,
        customer_is_new: !customerName,
        customer_is_returning: !!customerName,
        message: msg,
      };

      let templateId: string;
      let smartCandidates: any[] = [];

      if (caoResult && caoResult.template_id) {
        // CAO chỉ định template
        templateId = caoResult.template_id;
        console.log(`[agentic] CAO ${caoResult.decision.action} → template ${templateId}`);
      } else {
        // CAO không apply (khách mới) → smart selection như cũ
        const selResult = selectTemplateWithCandidates(ctx);
        const selected = selResult.best;
        templateId = selected?.id || (customerName ? 'returning_customer_greet' : 'first_contact_warm');
        smartCandidates = selResult.candidates;
      }

      const vars: any = { customerName, customerTier, isVip };
      // Thêm personalization vars từ CAO (nếu có)
      if (caoResult?.decision?.summary_previous) {
        vars.previousInquirySummary = caoResult.decision.summary_previous;
      }

      const r2 = renderTemplateById(templateId, vars);
      const t = r2 ? { content: r2.content, quick_replies: r2.quick_replies, confidence: r2.confidence } : renderTemplate(templateId, vars);
      const variantKey = r2?.variant_key;
      if (t) {
        console.log(`[agentic] turn 1${isSessionResume ? ' (resume)' : ''} → template ${templateId}${variantKey ? ':' + variantKey : ''}`);

        const tplInfo = getTemplateById(templateId);
        trackTemplateUse(senderId, templateId, tplInfo?.category || 'discovery', variantKey);
        logSelection(senderId, hotelId, templateId, ctx, smartCandidates, t.confidence);

        return {
          reply: t.content,
          quick_replies: t.quick_replies,
          intent: 'greeting',
          confidence_score: caoResult?.decision.confidence || 1.0,
          tier_used: 'template',
          handoff_triggered: false,
          cost_estimate: caoResult ? 'low' : 'free',
          meta: {
            template_id: templateId,
            variant_key: variantKey,
            turn_number: 1,
            session_resume: isSessionResume,
            cao_action: caoResult?.decision?.action,
            cao_provider: caoResult?.decision?.llm_provider,
            candidates: smartCandidates,
          },
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
      // Smart selection fallback: nếu có template khớp context hơn trong DB → ưu tiên.
      const smartCtx: any = {
        turn_number: turnNumber,
        intent,
        sub_category: subCategory,
        rental_mode: isLongTerm ? 'long_term' : 'short_term',
        slot_completeness: slotCompleteness,
        stuck_turns: stuckTurns,
        customer_is_new: !customerName,
        customer_is_returning: !!customerName,
        message: msg,
        rag_match_score: ragMatchScore,
        confidence_score: safety.confidence.score,
        hotel_id: hotelId,
      };
      const selResult = selectTemplateWithCandidates(smartCtx);
      const smart = selResult.best;
      const finalId = smart?.id || safety.recommended_template;
      const vars: any = {
        customerName,
        customerTier,
        isVip: customerTier === 'vip',
        topic: subCategory,
      };
      // Use renderTemplateById for variant attribution; fallback to renderTemplate if not found
      const r2 = renderTemplateById(finalId, vars);
      const t = r2 ? { content: r2.content, quick_replies: r2.quick_replies, confidence: r2.confidence } : renderTemplate(finalId, vars);
      const variantKey = r2?.variant_key;
      if (t) {
        // Track + log
        const tplInfo = getTemplateById(finalId);
        trackTemplateUse(senderId, finalId, tplInfo?.category || 'misc', variantKey);
        logSelection(senderId, hotelId, finalId, smartCtx, selResult.candidates, t.confidence);

        return {
          reply: t.content,
          quick_replies: t.quick_replies,
          intent,
          confidence_score: safety.confidence.score,
          tier_used: 'template',
          handoff_triggered: false,
          cost_estimate: 'free',
          meta: {
            template_id: finalId,
            variant_key: variantKey,
            smart_selected: !!smart,
            reasons: safety.confidence.reasons,
            candidates: selResult.candidates,
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

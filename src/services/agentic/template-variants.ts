/**
 * Template Variants (A/B Testing) — v27 Phase 5
 *
 * Mỗi template có thể có nhiều variants (A, B, C...). Khi render:
 *   1. Check có active variants không
 *   2. Weighted random pick theo `weight` column
 *   3. Track impression vào variant đó (không vào parent)
 *
 * Conversion attribution:
 *   - `detectAndMarkConversion` nhận biết variant từ tracking table
 *   - Update conversion count cho đúng variant
 *
 * Winner detection:
 *   - Sau N impressions (default 100), tính conv_rate của từng variant
 *   - Nếu variant X có conv_rate > winner_threshold × variant_Y → X wins
 *   - Admin có thể "promote" winner → copy content về parent, archive variants
 */

import { db } from '../../db';

export interface Variant {
  id: number;
  template_id: string;
  variant_key: string;
  content: string;
  quick_replies: Array<{ title: string; payload: string }> | null;
  weight: number;
  active: number;
  impressions: number;
  clicks: number;
  conversions: number;
}

const MIN_IMPRESSIONS_FOR_WINNER = 50;
const WINNER_RATE_MULTIPLIER = 1.5;   // winner must have ≥ 1.5× conv_rate of others

/**
 * Load all active variants for a template.
 */
export function getVariants(templateId: string): Variant[] {
  try {
    const rows = db.prepare(`
      SELECT id, template_id, variant_key, content, quick_replies, weight, active,
        impressions, clicks, conversions
      FROM agentic_template_variants
      WHERE template_id = ? AND active = 1
      ORDER BY variant_key ASC
    `).all(templateId) as any[];

    return rows.map(r => ({
      ...r,
      quick_replies: r.quick_replies ? safeParse(r.quick_replies) : null,
    }));
  } catch (e: any) {
    console.warn('[variants] getVariants err:', e?.message);
    return [];
  }
}

/**
 * Weighted random pick from active variants.
 * Trả về null nếu không có variants → caller dùng parent template.
 */
export function pickVariant(templateId: string): Variant | null {
  const variants = getVariants(templateId);
  if (variants.length === 0) return null;
  if (variants.length === 1) return variants[0];

  const totalWeight = variants.reduce((s, v) => s + (v.weight || 0.5), 0);
  if (totalWeight <= 0) return variants[0];

  let r = Math.random() * totalWeight;
  for (const v of variants) {
    r -= (v.weight || 0.5);
    if (r <= 0) return v;
  }
  return variants[variants.length - 1];
}

/**
 * Record impression for variant (called when variant content được render).
 */
export function trackImpression(variantId: number): void {
  try {
    db.prepare(`UPDATE agentic_template_variants SET impressions = impressions + 1 WHERE id = ?`).run(variantId);
  } catch {}
}

/**
 * Record click for variant (user bấm QR thuộc variant).
 */
export function trackClickForVariant(templateId: string, variantKey: string): void {
  try {
    db.prepare(`UPDATE agentic_template_variants SET clicks = clicks + 1 WHERE template_id = ? AND variant_key = ?`)
      .run(templateId, variantKey);
  } catch {}
}

/**
 * Record conversion for variant.
 */
export function trackConversionForVariant(templateId: string, variantKey: string): void {
  try {
    db.prepare(`UPDATE agentic_template_variants SET conversions = conversions + 1 WHERE template_id = ? AND variant_key = ?`)
      .run(templateId, variantKey);
  } catch {}
}

/**
 * Compute winner for a template — needs enough impressions + statistical margin.
 */
export interface WinnerAnalysis {
  template_id: string;
  has_variants: boolean;
  enough_data: boolean;
  winner?: string;                   // variant_key
  winner_conv_rate?: number;
  runner_up?: string;
  runner_up_conv_rate?: number;
  confidence?: 'high' | 'medium' | 'low';
  variants: Array<{
    variant_key: string;
    impressions: number;
    clicks: number;
    conversions: number;
    ctr: number;
    conv_rate: number;
  }>;
}

export function analyzeWinner(templateId: string): WinnerAnalysis {
  const variants = db.prepare(`
    SELECT variant_key, impressions, clicks, conversions
    FROM agentic_template_variants
    WHERE template_id = ? AND active = 1
    ORDER BY conversions DESC, impressions DESC
  `).all(templateId) as any[];

  const withRates = variants.map(v => ({
    variant_key: v.variant_key,
    impressions: v.impressions || 0,
    clicks: v.clicks || 0,
    conversions: v.conversions || 0,
    ctr: v.impressions > 0 ? v.clicks / v.impressions : 0,
    conv_rate: v.impressions > 0 ? v.conversions / v.impressions : 0,
  }));

  const result: WinnerAnalysis = {
    template_id: templateId,
    has_variants: withRates.length > 0,
    enough_data: false,
    variants: withRates,
  };

  if (withRates.length < 2) return result;

  const totalImpressions = withRates.reduce((s, v) => s + v.impressions, 0);
  result.enough_data = totalImpressions >= MIN_IMPRESSIONS_FOR_WINNER;

  // Sort by conversion rate descending
  const sorted = [...withRates].sort((a, b) => b.conv_rate - a.conv_rate);
  result.winner = sorted[0].variant_key;
  result.winner_conv_rate = sorted[0].conv_rate;
  result.runner_up = sorted[1]?.variant_key;
  result.runner_up_conv_rate = sorted[1]?.conv_rate;

  if (result.enough_data && sorted[0].conv_rate > 0 && sorted[1].conv_rate > 0) {
    const ratio = sorted[0].conv_rate / sorted[1].conv_rate;
    if (ratio >= WINNER_RATE_MULTIPLIER * 1.5) result.confidence = 'high';
    else if (ratio >= WINNER_RATE_MULTIPLIER) result.confidence = 'medium';
    else result.confidence = 'low';
  }

  return result;
}

/**
 * Promote winner: copy winner content → parent template, archive other variants.
 */
export function promoteWinner(templateId: string, winnerKey: string, adminId: string): { success: boolean; error?: string } {
  try {
    const winner = db.prepare(`SELECT * FROM agentic_template_variants WHERE template_id = ? AND variant_key = ? AND active = 1`)
      .get(templateId, winnerKey) as any;
    if (!winner) return { success: false, error: 'Winner variant not found' };

    const parent = db.prepare(`SELECT * FROM agentic_templates WHERE id = ?`).get(templateId) as any;
    if (!parent) return { success: false, error: 'Parent template not found' };

    const now = Date.now();

    // Save parent snapshot to history
    db.prepare(`
      INSERT INTO agentic_templates_history (template_id, version, content, trigger_conditions, quick_replies, changed_by, changed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(templateId, parent.version, parent.content, parent.trigger_conditions, parent.quick_replies, `${adminId} (A/B promote ${winnerKey})`, now);

    // Promote winner to parent
    db.prepare(`
      UPDATE agentic_templates
      SET content = ?, quick_replies = ?, version = version + 1, updated_at = ?
      WHERE id = ?
    `).run(winner.content, winner.quick_replies, now, templateId);

    // Deactivate all variants
    db.prepare(`UPDATE agentic_template_variants SET active = 0, updated_at = ? WHERE template_id = ?`).run(now, templateId);

    // Cache invalidate
    try {
      const { invalidateCache } = require('./template-engine');
      invalidateCache();
    } catch {}

    return { success: true };
  } catch (e: any) {
    return { success: false, error: e?.message };
  }
}

function safeParse(s: string): any {
  try { return JSON.parse(s); } catch { return null; }
}

// ═══════════════════════════════════════════════════════════
// AUTO-PROMOTE (Phase 6) — daily cron tự động promote A/B winner
// ═══════════════════════════════════════════════════════════

const REQUIRED_STREAK_DAYS = 7;           // phải high confidence liên tục 7 ngày
const MIN_IMPRESSIONS_AUTO = 100;          // min impressions total trước khi auto-promote
const MIN_WINNER_RATE_MARGIN = 1.5;        // winner phải conv_rate ≥ 1.5× runner_up
const MAX_PROMOTES_PER_WEEK = 1;           // max 1 auto-promote per template per 7 ngày

function isAutoPromoteEnabled(): boolean {
  try {
    const { getSetting } = require('../../db');
    const v = getSetting('auto_promote_variants');
    return v === 'true' || v === true || v === '1';
  } catch { return false; }
}

/**
 * Log daily winner analysis for a template.
 */
export function logDailyWinnerAnalysis(templateId: string): { logged: boolean; reason?: string } {
  const analysis = analyzeWinner(templateId);
  if (!analysis.has_variants) return { logged: false, reason: 'no_variants' };

  const totalImpressions = analysis.variants.reduce((s, v) => s + v.impressions, 0);

  try {
    db.prepare(`
      INSERT INTO agentic_variant_winner_log
        (template_id, winner_key, winner_conv_rate, runner_up_key, runner_up_conv_rate,
         confidence, total_impressions, logged_at, auto_promoted)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)
    `).run(
      templateId,
      analysis.winner || null,
      analysis.winner_conv_rate || 0,
      analysis.runner_up || null,
      analysis.runner_up_conv_rate || 0,
      analysis.confidence || 'low',
      totalImpressions,
      Date.now(),
    );
    return { logged: true };
  } catch (e: any) {
    return { logged: false, reason: e?.message };
  }
}

/**
 * Check if template has N consecutive days of high confidence.
 * Return { streak: number, winnerKey: string | null, reason: string }
 */
export interface StreakResult {
  templateId: string;
  streak: number;               // consecutive days of high confidence
  consistentWinner: string | null;  // winner_key if same across all streak days
  latestAnalysis?: WinnerAnalysis;
  reason: string;
  eligible: boolean;
}

export function checkStreak(templateId: string, requiredDays: number = REQUIRED_STREAK_DAYS): StreakResult {
  try {
    // Get last N days of winner logs (1 per day)
    const sinceMs = Date.now() - requiredDays * 24 * 3600 * 1000;
    const logs = db.prepare(`
      SELECT winner_key, confidence, winner_conv_rate, runner_up_conv_rate, total_impressions, logged_at
      FROM agentic_variant_winner_log
      WHERE template_id = ? AND logged_at > ?
      ORDER BY logged_at DESC
    `).all(templateId, sinceMs) as any[];

    if (logs.length < requiredDays) {
      return {
        templateId,
        streak: logs.filter(l => l.confidence === 'high').length,
        consistentWinner: null,
        reason: `not_enough_days (need ${requiredDays}, have ${logs.length})`,
        eligible: false,
      };
    }

    // Check all N days are 'high' and same winner
    let streak = 0;
    let consistentWinner: string | null = logs[0].winner_key;
    for (const log of logs) {
      if (log.confidence === 'high' && log.winner_key === consistentWinner) {
        streak++;
      } else {
        break;
      }
    }

    if (streak < requiredDays) {
      return {
        templateId,
        streak,
        consistentWinner: null,
        reason: `streak_too_short (${streak}/${requiredDays})`,
        eligible: false,
      };
    }

    // Additional check: impressions minimum
    const avgImpressions = logs.slice(0, requiredDays).reduce((s, l) => s + l.total_impressions, 0) / requiredDays;
    if (avgImpressions < MIN_IMPRESSIONS_AUTO) {
      return {
        templateId,
        streak,
        consistentWinner,
        reason: `low_impressions (avg ${avgImpressions.toFixed(0)} < ${MIN_IMPRESSIONS_AUTO})`,
        eligible: false,
      };
    }

    // Check: rate margin
    const latest = analyzeWinner(templateId);
    if (latest.winner_conv_rate && latest.runner_up_conv_rate) {
      const margin = latest.winner_conv_rate / Math.max(latest.runner_up_conv_rate, 0.001);
      if (margin < MIN_WINNER_RATE_MARGIN) {
        return {
          templateId,
          streak,
          consistentWinner,
          latestAnalysis: latest,
          reason: `margin_too_small (${margin.toFixed(2)}× < ${MIN_WINNER_RATE_MARGIN}×)`,
          eligible: false,
        };
      }
    }

    // Check: no recent auto-promote (max 1/week per template)
    const recentPromote = db.prepare(`
      SELECT logged_at FROM agentic_variant_winner_log
      WHERE template_id = ? AND auto_promoted = 1 AND logged_at > ?
      LIMIT 1
    `).get(templateId, Date.now() - 7 * 24 * 3600 * 1000);
    if (recentPromote) {
      return {
        templateId,
        streak,
        consistentWinner,
        latestAnalysis: latest,
        reason: 'already_promoted_this_week',
        eligible: false,
      };
    }

    return {
      templateId,
      streak,
      consistentWinner,
      latestAnalysis: latest,
      reason: 'eligible',
      eligible: true,
    };
  } catch (e: any) {
    return {
      templateId,
      streak: 0,
      consistentWinner: null,
      reason: `error: ${e?.message}`,
      eligible: false,
    };
  }
}

/**
 * Run daily auto-promote cron.
 * For each template with variants:
 *   1. Log today's winner analysis
 *   2. Check 7-day streak
 *   3. If eligible + setting enabled → promote automatically
 *   4. Send Telegram notification to admin
 */
export interface AutoPromoteRunResult {
  checked: number;
  logged: number;
  eligible: Array<StreakResult & { promoted: boolean; error?: string }>;
  enabled: boolean;
  ts: number;
}

export async function runDailyAutoPromote(): Promise<AutoPromoteRunResult> {
  const enabled = isAutoPromoteEnabled();
  console.log(`[auto-promote] daily run (enabled=${enabled})`);

  // Get all templates that HAVE variants
  const templates = db.prepare(`
    SELECT DISTINCT template_id
    FROM agentic_template_variants
    WHERE active = 1
  `).all() as any[];

  let logged = 0;
  const eligible: Array<StreakResult & { promoted: boolean; error?: string }> = [];

  for (const t of templates) {
    const templateId = t.template_id;

    // 1. Log today's analysis
    const logResult = logDailyWinnerAnalysis(templateId);
    if (logResult.logged) logged++;

    // 2. Check streak
    const streakCheck = checkStreak(templateId);

    if (streakCheck.eligible) {
      const entry = { ...streakCheck, promoted: false, error: undefined as string | undefined };

      if (enabled && streakCheck.consistentWinner) {
        // 3. Auto-promote
        const promoteResult = promoteWinner(templateId, streakCheck.consistentWinner, 'auto-cron');
        if (promoteResult.success) {
          entry.promoted = true;

          // Mark today's log as auto_promoted=1
          try {
            db.prepare(`
              UPDATE agentic_variant_winner_log
              SET auto_promoted = 1
              WHERE id = (SELECT id FROM agentic_variant_winner_log WHERE template_id = ? ORDER BY logged_at DESC LIMIT 1)
            `).run(templateId);
          } catch {}

          // 4. Telegram notification
          try {
            await sendAutoPromoteNotification(templateId, streakCheck);
          } catch (e: any) {
            console.warn('[auto-promote] telegram notify fail:', e?.message);
          }
        } else {
          entry.error = promoteResult.error;
        }
      }

      eligible.push(entry);
    }
  }

  console.log(`[auto-promote] checked=${templates.length} logged=${logged} eligible=${eligible.length} promoted=${eligible.filter(e => e.promoted).length}`);

  return {
    checked: templates.length,
    logged,
    eligible,
    enabled,
    ts: Date.now(),
  };
}

/**
 * Telegram alert admin khi auto-promote.
 */
async function sendAutoPromoteNotification(templateId: string, streak: StreakResult): Promise<void> {
  try {
    const { notifyAll } = require('../telegram');
    const a = streak.latestAnalysis;

    const parts = [
      `🏆 *Auto-promoted winner*`,
      ``,
      `Template: \`${templateId}\``,
      `Winner: *${streak.consistentWinner}* (${((a?.winner_conv_rate || 0) * 100).toFixed(1)}% conv rate)`,
      `vs ${a?.runner_up}: ${((a?.runner_up_conv_rate || 0) * 100).toFixed(1)}%`,
      `Streak: ${streak.streak} ngày confidence=high liên tục`,
      ``,
      `Winner content đã copy vào parent template. Các variants khác archived.`,
      `Rollback: admin panel → Templates → ${templateId} → Lịch sử`,
    ];

    await notifyAll(parts.join('\n'));
  } catch (e: any) {
    // notifyAll might not exist or Telegram not configured — silent fail
    console.warn('[auto-promote] notify err:', e?.message);
  }
}

/**
 * Admin API: list recent auto-promote log entries.
 */
export function listAutoPromoteHistory(limit: number = 30): any[] {
  return db.prepare(`
    SELECT id, template_id, winner_key, winner_conv_rate, runner_up_key, runner_up_conv_rate,
      confidence, total_impressions, logged_at, auto_promoted
    FROM agentic_variant_winner_log
    ORDER BY logged_at DESC
    LIMIT ?
  `).all(limit);
}

/**
 * Admin API: preview — eligible templates (dry-run, không promote).
 */
export async function previewAutoPromote(): Promise<AutoPromoteRunResult> {
  const templates = db.prepare(`
    SELECT DISTINCT template_id
    FROM agentic_template_variants
    WHERE active = 1
  `).all() as any[];

  const eligible: Array<StreakResult & { promoted: boolean; error?: string }> = [];
  for (const t of templates) {
    const streakCheck = checkStreak(t.template_id);
    if (streakCheck.eligible) {
      eligible.push({ ...streakCheck, promoted: false });
    }
  }

  return {
    checked: templates.length,
    logged: 0,
    eligible,
    enabled: isAutoPromoteEnabled(),
    ts: Date.now(),
  };
}

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

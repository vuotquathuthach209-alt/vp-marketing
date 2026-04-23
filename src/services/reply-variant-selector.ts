/**
 * Reply Variant Selector — A/B test variants cho reply templates.
 *
 * Flow:
 *   1. Bot muốn gửi reply cho touchpoint X (e.g. 'greeting_new')
 *   2. pickVariant(senderId, template_key) → return 1 variant text
 *   3. Assignment is DETERMINISTIC (hash-based) → same sender always gets same variant
 *   4. Record impression immediately, record conversion when bot_reply_outcomes updates
 *
 * Fallback: nếu template_key không có variants → return null (caller uses hardcoded default)
 */

import crypto from 'crypto';
import { db } from '../db';

export interface TemplateVariant {
  id: number;
  template_key: string;
  variant_name: string;
  content: string;
  weight: number;
  is_winner: boolean;
  impressions: number;
  conversions: number;
}

/** Hash-based deterministic assignment: [0, 100) */
function hashBucket(senderId: string, experimentId: number): number {
  const h = crypto.createHash('sha256').update(`${senderId}:${experimentId}`).digest();
  return h.readUInt32BE(0) % 100;
}

/** Get active variants for a template_key. Respect weights (winner gets 100% if is_winner=1). */
export function getActiveVariants(hotelId: number, templateKey: string): TemplateVariant[] {
  return db.prepare(
    `SELECT id, template_key, variant_name, content, weight, is_winner, impressions, conversions
     FROM reply_templates
     WHERE (hotel_id = ? OR hotel_id = 0) AND template_key = ? AND active = 1
     ORDER BY is_winner DESC, id ASC`
  ).all(hotelId, templateKey) as any[];
}

/** Select 1 variant for sender based on deterministic hash.
 *  Returns null nếu template_key không có active variants. */
export function pickVariant(senderId: string, hotelId: number, templateKey: string): TemplateVariant | null {
  const variants = getActiveVariants(hotelId, templateKey);
  if (variants.length === 0) return null;

  // Winner mode: 100% traffic → winner
  const winner = variants.find(v => v.is_winner);
  if (winner) return winner;

  // Find or create experiment for this (hotel, template)
  let experiment = db.prepare(
    `SELECT id FROM reply_experiments WHERE (hotel_id = ? OR hotel_id = 0) AND template_key = ? AND status = 'running' LIMIT 1`
  ).get(hotelId, templateKey) as any;

  if (!experiment) {
    // Auto-create experiment if we have 2+ variants
    if (variants.length >= 2) {
      const r = db.prepare(
        `INSERT INTO reply_experiments (hotel_id, experiment_name, template_key, status, started_at)
         VALUES (?, ?, ?, 'running', ?)`
      ).run(0, `auto_${templateKey}_${Date.now()}`, templateKey, Date.now());
      experiment = { id: r.lastInsertRowid };
    } else {
      return variants[0] || null;
    }
  }

  // Check existing assignment
  const existing = db.prepare(
    `SELECT variant_id FROM reply_assignments WHERE sender_id = ? AND experiment_id = ?`
  ).get(senderId, experiment.id) as any;

  if (existing) {
    const variant = variants.find(v => v.id === existing.variant_id);
    if (variant) return variant;
  }

  // New assignment: weighted random via hash bucket
  const totalWeight = variants.reduce((s, v) => s + v.weight, 0);
  const bucket = hashBucket(senderId, experiment.id);
  const threshold = (bucket / 100) * totalWeight;

  let cumWeight = 0;
  let selected = variants[0];
  for (const v of variants) {
    cumWeight += v.weight;
    if (threshold < cumWeight) {
      selected = v;
      break;
    }
  }

  if (!selected) return variants[0] || null;

  // Persist assignment
  try {
    db.prepare(
      `INSERT OR IGNORE INTO reply_assignments (sender_id, experiment_id, variant_id, assigned_at)
       VALUES (?, ?, ?, ?)`
    ).run(senderId, experiment.id, selected.id, Date.now());
  } catch {}

  return selected;
}

/** Fill template placeholders with actual values. */
export function fillTemplate(template: string, vars: Record<string, string | number | undefined>): string {
  let out = template;
  for (const [key, val] of Object.entries(vars)) {
    const re = new RegExp(`\\{\\{\\s*${key}\\s*\\}\\}`, 'g');
    out = out.replace(re, val === undefined || val === null ? '' : String(val));
  }
  return out;
}

/** Record that a variant was shown to user (impression). Call when bot sends. */
export function recordImpression(variantId: number): void {
  try {
    db.prepare(`UPDATE reply_templates SET impressions = impressions + 1, updated_at = ? WHERE id = ?`)
      .run(Date.now(), variantId);
  } catch {}
}

/** Record outcome for a variant. Call khi outcome-classifier quyết định. */
export function recordVariantOutcome(variantId: number, outcome: string): void {
  const field = {
    'converted_to_lead': 'converted_to_lead',
    'booked': 'booked',
    'misunderstood': 'misunderstood',
    'ghosted': 'ghosted',
  }[outcome];
  if (!field) return;
  try {
    db.prepare(`UPDATE reply_templates SET ${field} = ${field} + 1, conversions = CASE WHEN ? IN ('converted_to_lead','booked') THEN conversions + 1 ELSE conversions END, updated_at = ? WHERE id = ?`)
      .run(outcome, Date.now(), variantId);
  } catch {}
}

/** Lookup variant by assignment (cho outcome classifier post-facto). */
export function getVariantForSenderReply(senderId: string, templateKey: string, hotelId: number): TemplateVariant | null {
  const row = db.prepare(
    `SELECT rt.* FROM reply_assignments ra
     JOIN reply_templates rt ON rt.id = ra.variant_id
     JOIN reply_experiments re ON re.id = ra.experiment_id
     WHERE ra.sender_id = ? AND re.template_key = ? AND (re.hotel_id = ? OR re.hotel_id = 0)
     ORDER BY ra.assigned_at DESC LIMIT 1`
  ).get(senderId, templateKey, hotelId) as any;
  return row || null;
}

/**
 * Sync Conflict Resolver — merge rules khi 2 bên cùng update.
 *
 * Philosophy:
 *   - Inventory/pricing: OTA luôn wins (OTA thấy all channels, có full picture)
 *   - Customer context (phone, preferences): MKT wins (bot có rich chat context)
 *   - Booking status: Last-write-wins by timestamp (both sides tolerant)
 *   - Cancellation: First-cancel-wins (cancel là terminal state)
 *
 * All conflicts logged to sync_conflicts table for audit + manual review.
 */

import { db } from '../db';

export type EntityType = 'booking' | 'availability' | 'customer' | 'pricing';
export type Winner = 'mkt' | 'ota' | 'merged' | 'manual';

export interface ResolutionResult {
  winner: Winner;
  value: any;
  rule: string;
  auto: boolean;
}

interface RuleContext {
  entity_type: EntityType;
  field_name: string;
  mkt_value: any;
  ota_value: any;
  mkt_updated_at?: number;
  ota_updated_at?: number;
}

// ═══════════════════════════════════════════
// Rule definitions
// ═══════════════════════════════════════════

const OTA_AUTHORITATIVE_FIELDS = new Set([
  'available_rooms',
  'total_rooms',
  'stop_sell',
  'base_price',
  'monthly_price_from',
  'room_count',
  'hourly_price',
  'pms_booking_id',
]);

const MKT_AUTHORITATIVE_FIELDS = new Set([
  'sender_id',
  'customer_preferences',
  'chat_summary',
  'bot_intent',
  'assigned_staff',
  'notes',
  'persona_tier',
]);

// First-cancel-wins fields
const TERMINAL_FIELDS = new Set(['cancelled_at']);

/**
 * Resolve a single-field conflict.
 */
export function resolveConflict(
  entityType: EntityType,
  entityId: string,
  fieldName: string,
  mktValue: any,
  otaValue: any,
  opts: { mkt_ts?: number; ota_ts?: number; auto_log?: boolean } = {},
): ResolutionResult {
  const autoLog = opts.auto_log !== false;

  let result: ResolutionResult;

  // Rule 1: Same value → no conflict
  if (deepEqual(mktValue, otaValue)) {
    return { winner: 'merged', value: mktValue, rule: 'identical', auto: true };
  }

  // Rule 2: OTA authoritative fields → OTA wins
  if (OTA_AUTHORITATIVE_FIELDS.has(fieldName)) {
    result = { winner: 'ota', value: otaValue, rule: 'ota_authoritative', auto: true };
  }
  // Rule 3: MKT authoritative fields → MKT wins
  else if (MKT_AUTHORITATIVE_FIELDS.has(fieldName)) {
    result = { winner: 'mkt', value: mktValue, rule: 'mkt_authoritative', auto: true };
  }
  // Rule 4: Terminal fields (cancellation) → first-wins (lower timestamp)
  else if (TERMINAL_FIELDS.has(fieldName)) {
    const mktTs = opts.mkt_ts || Infinity;
    const otaTs = opts.ota_ts || Infinity;
    if (mktValue && !otaValue) result = { winner: 'mkt', value: mktValue, rule: 'first_cancel_mkt', auto: true };
    else if (otaValue && !mktValue) result = { winner: 'ota', value: otaValue, rule: 'first_cancel_ota', auto: true };
    else result = mktTs < otaTs
      ? { winner: 'mkt', value: mktValue, rule: 'first_cancel_mkt_ts', auto: true }
      : { winner: 'ota', value: otaValue, rule: 'first_cancel_ota_ts', auto: true };
  }
  // Rule 5: One side null → other side wins
  else if (mktValue == null && otaValue != null) {
    result = { winner: 'ota', value: otaValue, rule: 'fill_null_from_ota', auto: true };
  }
  else if (otaValue == null && mktValue != null) {
    result = { winner: 'mkt', value: mktValue, rule: 'fill_null_from_mkt', auto: true };
  }
  // Rule 6: Customer contact fields → merge (union)
  else if (entityType === 'customer' && (fieldName === 'phone' || fieldName === 'email' || fieldName === 'name')) {
    // Keep longer/richer value
    const pick = String(mktValue).length >= String(otaValue).length ? 'mkt' : 'ota';
    result = { winner: pick, value: pick === 'mkt' ? mktValue : otaValue, rule: 'richer_wins', auto: true };
  }
  // Rule 7: Default — last-write-wins by timestamp
  else {
    const mktTs = opts.mkt_ts || 0;
    const otaTs = opts.ota_ts || 0;
    if (mktTs === otaTs) {
      // Timestamp tie → need manual resolution
      result = { winner: 'manual', value: null, rule: 'timestamp_tie', auto: false };
    } else {
      result = mktTs > otaTs
        ? { winner: 'mkt', value: mktValue, rule: 'last_write_wins_mkt', auto: true }
        : { winner: 'ota', value: otaValue, rule: 'last_write_wins_ota', auto: true };
    }
  }

  // Log to sync_conflicts
  if (autoLog) {
    try {
      db.prepare(
        `INSERT INTO sync_conflicts
         (entity_type, entity_id, field_name, mkt_value, ota_value,
          resolution, resolved_by, auto_resolved, created_at, resolved_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        entityType,
        entityId,
        fieldName,
        safeStringify(mktValue),
        safeStringify(otaValue),
        result.winner === 'manual' ? 'manual_pending' : `${result.winner}_wins`,
        result.rule,
        result.auto ? 1 : 0,
        Date.now(),
        result.auto ? Date.now() : null,
      );
    } catch (e: any) {
      console.warn('[conflict] log fail:', e?.message);
    }
  }

  return result;
}

/**
 * Bulk resolve an object — useful when merging two records.
 * Returns the winning values per field.
 */
export function resolveObjectConflicts(
  entityType: EntityType,
  entityId: string,
  mktObj: Record<string, any>,
  otaObj: Record<string, any>,
  opts: { mkt_ts?: number; ota_ts?: number } = {},
): { merged: Record<string, any>; manual_needed: string[] } {
  const merged: Record<string, any> = {};
  const manualNeeded: string[] = [];

  const allKeys = new Set([...Object.keys(mktObj || {}), ...Object.keys(otaObj || {})]);

  for (const key of allKeys) {
    const resolution = resolveConflict(
      entityType,
      entityId,
      key,
      mktObj?.[key],
      otaObj?.[key],
      { mkt_ts: opts.mkt_ts, ota_ts: opts.ota_ts, auto_log: true },
    );
    if (resolution.winner === 'manual') {
      manualNeeded.push(key);
    } else {
      merged[key] = resolution.value;
    }
  }

  return { merged, manual_needed: manualNeeded };
}

/**
 * List unresolved conflicts cho admin review.
 */
export function listManualConflicts(limit: number = 50): any[] {
  return db.prepare(
    `SELECT * FROM sync_conflicts WHERE resolution = 'manual_pending' ORDER BY created_at DESC LIMIT ?`
  ).all(limit) as any[];
}

export function resolveManually(
  conflictId: number,
  winner: 'mkt' | 'ota',
  resolvedBy: string,
): boolean {
  const r = db.prepare(
    `UPDATE sync_conflicts
     SET resolution = ?, resolved_by = ?, auto_resolved = 0, resolved_at = ?
     WHERE id = ? AND resolution = 'manual_pending'`
  ).run(`${winner}_wins`, resolvedBy, Date.now(), conflictId);
  return r.changes > 0;
}

// ═══════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════

function deepEqual(a: any, b: any): boolean {
  if (a === b) return true;
  if (a == null || b == null) return a == null && b == null;
  if (typeof a !== typeof b) return false;
  if (typeof a !== 'object') return false;
  try { return JSON.stringify(a) === JSON.stringify(b); } catch { return false; }
}

function safeStringify(v: any): string {
  if (v == null) return '';
  if (typeof v === 'string') return v.slice(0, 500);
  try { return JSON.stringify(v).slice(0, 500); } catch { return String(v).slice(0, 500); }
}

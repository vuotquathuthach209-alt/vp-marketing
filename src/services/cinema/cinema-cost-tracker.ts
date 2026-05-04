/**
 * Cinema Cost Tracker — budget cap + per-shot cost logging.
 *
 * 3 layer protection:
 *   1. Pre-flight estimator: before generation, estimate from storyboard.
 *      Abort if > per-episode cap.
 *   2. Monthly cap check: cumulative actual cost in current month + estimate.
 *      Abort if > monthly budget.
 *   3. Per-shot logging: every API call writes 1 row to cinema_costs_log.
 *
 * Settings:
 *   cinema_max_cost_per_episode_usd  (default '80')
 *   cinema_max_monthly_budget_usd    (default '400')
 *
 * Reference skill: sonder-cinema
 */

import { db, getSetting } from '../../db';

// ═══════════════════════════════════════════════════════════
// Provider pricing (locked tại thời điểm build, sync vs FAL.ai 2026)
// ═══════════════════════════════════════════════════════════

export type Provider = 'veo' | 'hailuo' | 'seedance' | 'hedra' | 'elevenlabs' | 'claude' | 'kling_fallback';

interface PricingTable {
  perSecondCents?: number;                  // video gen
  perVideoCents?: number;                   // fixed price per video
  perCharCents?: number;                    // text-based (voice, claude)
  fixedMonthlyCents?: number;               // subscription
}

/**
 * Pricing reference (April-May 2026). Cents per unit.
 * Update khi provider raise pricing.
 */
const PRICING: Record<Provider, PricingTable> = {
  // Veo 3.1 Premium — 1080p với audio
  veo: { perSecondCents: 40 },              // $0.40/s = 40 cents/s
  // Hailuo 2.3 Pro
  hailuo: { perVideoCents: 49 },            // $0.49/video
  // Seedance 2.0 Fast (cheap for b-roll)
  seedance: { perSecondCents: 2.2 },        // $0.022/s = 2.2 cents/s
  // Hedra Character-3 (talking head)
  hedra: { perSecondCents: 8.3 },           // $0.05/min ≈ $0.083/s? ~$5/min ≈ 8.3 cents/s
  // ElevenLabs Multilingual v2
  elevenlabs: { perCharCents: 0.03 },       // $0.30/1k chars
  // Claude Sonnet 4.6 (rough)
  claude: { perCharCents: 0.0003 },         // ~$3/1M chars input
  // Kling 3.0 Standard fallback nếu Veo quota hết
  kling_fallback: { perSecondCents: 10 },   // $0.10/s
};

// ═══════════════════════════════════════════════════════════
// Estimate cost cho 1 storyboard (pre-flight)
// ═══════════════════════════════════════════════════════════

export interface ShotEstimate {
  shot_no: number;
  provider: Provider;
  duration_sec: number;
  estimated_cost_cents: number;
}

export interface EpisodeCostEstimate {
  total_cents: number;
  total_usd: number;
  by_provider_cents: Record<string, number>;
  shot_count: number;
  shots: ShotEstimate[];
}

export function estimateShotCost(provider: Provider, durationSec: number = 8): number {
  const p = PRICING[provider];
  if (!p) return 0;
  if (p.perVideoCents) return p.perVideoCents;
  if (p.perSecondCents) return Math.ceil(p.perSecondCents * durationSec);
  return 0;
}

export function estimateVoiceCost(charCount: number): number {
  return Math.ceil(PRICING.elevenlabs.perCharCents! * charCount);
}

export function estimateScriptCost(promptChars: number): number {
  return Math.ceil(PRICING.claude.perCharCents! * promptChars);
}

export function estimateEpisodeCost(opts: {
  shots: Array<{ shot_no: number; provider: Provider; duration_sec: number }>;
  total_words_vn?: number;          // for voiceover estimate
  script_input_chars?: number;      // for Claude estimate
}): EpisodeCostEstimate {
  const shotEstimates: ShotEstimate[] = opts.shots.map((s) => ({
    shot_no: s.shot_no,
    provider: s.provider,
    duration_sec: s.duration_sec,
    estimated_cost_cents: estimateShotCost(s.provider, s.duration_sec),
  }));

  const byProviderCents: Record<string, number> = {};
  for (const s of shotEstimates) {
    byProviderCents[s.provider] = (byProviderCents[s.provider] || 0) + s.estimated_cost_cents;
  }

  // Voiceover ≈ 5 chars/word VN (rough)
  const voiceCost = opts.total_words_vn ? estimateVoiceCost(opts.total_words_vn * 5) : 0;
  if (voiceCost > 0) byProviderCents.elevenlabs = voiceCost;

  // Script gen ≈ 4000 chars input prompt + 2000 chars output (Claude)
  const scriptCost = estimateScriptCost(opts.script_input_chars || 6000);
  if (scriptCost > 0) byProviderCents.claude = scriptCost;

  const totalCents = Object.values(byProviderCents).reduce((a, b) => a + b, 0);

  return {
    total_cents: totalCents,
    total_usd: Math.round(totalCents) / 100,
    by_provider_cents: byProviderCents,
    shot_count: shotEstimates.length,
    shots: shotEstimates,
  };
}

// ═══════════════════════════════════════════════════════════
// Budget cap checks
// ═══════════════════════════════════════════════════════════

export function getPerEpisodeCapCents(): number {
  const usd = parseFloat(getSetting('cinema_max_cost_per_episode_usd') || '80');
  return Math.round(usd * 100);
}

export function getMonthlyBudgetCapCents(): number {
  const usd = parseFloat(getSetting('cinema_max_monthly_budget_usd') || '400');
  return Math.round(usd * 100);
}

export function getCurrentMonthSpendCents(): number {
  const startOfMonth = new Date();
  startOfMonth.setUTCDate(1);
  startOfMonth.setUTCHours(0, 0, 0, 0);
  const monthStartMs = startOfMonth.getTime();

  const row = db.prepare(`
    SELECT COALESCE(SUM(cost_cents), 0) as total
    FROM cinema_costs_log
    WHERE created_at >= ?
  `).get(monthStartMs) as any;

  return row?.total || 0;
}

export interface BudgetCheckResult {
  ok: boolean;
  reason?: string;
  estimate_cents: number;
  per_ep_cap_cents: number;
  monthly_cap_cents: number;
  monthly_spent_cents: number;
  monthly_remaining_cents: number;
}

/**
 * Pre-flight budget check. Call BEFORE running pipeline.
 * Returns ok=false with reason nếu vượt cap.
 */
export function checkBudget(estimate: EpisodeCostEstimate): BudgetCheckResult {
  const perEpCap = getPerEpisodeCapCents();
  const monthlyCap = getMonthlyBudgetCapCents();
  const monthlySpent = getCurrentMonthSpendCents();

  const result: BudgetCheckResult = {
    ok: true,
    estimate_cents: estimate.total_cents,
    per_ep_cap_cents: perEpCap,
    monthly_cap_cents: monthlyCap,
    monthly_spent_cents: monthlySpent,
    monthly_remaining_cents: monthlyCap - monthlySpent,
  };

  if (estimate.total_cents > perEpCap) {
    result.ok = false;
    result.reason = `episode_estimate_exceeds_cap: $${(estimate.total_cents / 100).toFixed(2)} > $${(perEpCap / 100).toFixed(2)}`;
    return result;
  }

  if (monthlySpent + estimate.total_cents > monthlyCap) {
    result.ok = false;
    result.reason = `monthly_budget_exceeded: spent $${(monthlySpent / 100).toFixed(2)} + estimate $${(estimate.total_cents / 100).toFixed(2)} > cap $${(monthlyCap / 100).toFixed(2)}`;
    return result;
  }

  return result;
}

// ═══════════════════════════════════════════════════════════
// Logging actual costs (each API call)
// ═══════════════════════════════════════════════════════════

export interface CostLogInput {
  episode_id?: number | null;
  shot_id?: number | null;
  provider: Provider;
  operation: 'video_gen' | 'voice_synth' | 'script_gen' | 'storyboard_gen';
  duration_sec?: number;
  units?: number;                   // chars cho voice, seconds cho video
  cost_cents: number;
  request_id?: string;
  notes?: string;
}

export function logCost(input: CostLogInput): number {
  try {
    const r = db.prepare(`
      INSERT INTO cinema_costs_log
        (episode_id, shot_id, provider, operation, duration_sec, units, cost_cents, request_id, notes, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.episode_id || null,
      input.shot_id || null,
      input.provider,
      input.operation,
      input.duration_sec || null,
      input.units || null,
      input.cost_cents,
      input.request_id || null,
      input.notes || null,
      Date.now(),
    );
    return r.lastInsertRowid as number;
  } catch (e: any) {
    console.warn(`[cinema-cost] logCost fail: ${e?.message}`);
    return 0;
  }
}

/**
 * Compute total actual cost cho 1 episode (sau khi chạy xong).
 * Update cinema_episodes.cost_cents_actual + cost_breakdown_json.
 */
export function reconcileEpisodeCost(episodeId: number): { total_cents: number; by_provider: Record<string, number> } {
  const rows = db.prepare(`
    SELECT provider, SUM(cost_cents) as total
    FROM cinema_costs_log
    WHERE episode_id = ?
    GROUP BY provider
  `).all(episodeId) as any[];

  const byProvider: Record<string, number> = {};
  let total = 0;
  for (const r of rows) {
    byProvider[r.provider] = r.total;
    total += r.total;
  }

  db.prepare(`
    UPDATE cinema_episodes
    SET cost_cents_actual = ?, cost_breakdown_json = ?, updated_at = ?
    WHERE id = ?
  `).run(total, JSON.stringify(byProvider), Date.now(), episodeId);

  return { total_cents: total, by_provider: byProvider };
}

// ═══════════════════════════════════════════════════════════
// Reporting helpers (admin UI)
// ═══════════════════════════════════════════════════════════

export interface MonthlyBudgetReport {
  month: string;                    // "2026-05"
  spent_cents: number;
  spent_usd: number;
  cap_cents: number;
  cap_usd: number;
  remaining_cents: number;
  remaining_usd: number;
  episodes_count: number;
  by_provider: Record<string, { cost_cents: number; cost_usd: number; calls: number }>;
}

export function getMonthlyBudgetReport(): MonthlyBudgetReport {
  const startOfMonth = new Date();
  startOfMonth.setUTCDate(1);
  startOfMonth.setUTCHours(0, 0, 0, 0);
  const monthStartMs = startOfMonth.getTime();
  const monthLabel = startOfMonth.toISOString().slice(0, 7);

  const spent = getCurrentMonthSpendCents();
  const cap = getMonthlyBudgetCapCents();

  const epCount = (db.prepare(`
    SELECT COUNT(DISTINCT episode_id) as n
    FROM cinema_costs_log WHERE created_at >= ? AND episode_id IS NOT NULL
  `).get(monthStartMs) as any).n || 0;

  const byProviderRows = db.prepare(`
    SELECT provider, SUM(cost_cents) as cost, COUNT(*) as calls
    FROM cinema_costs_log WHERE created_at >= ? GROUP BY provider
  `).all(monthStartMs) as any[];

  const byProvider: Record<string, { cost_cents: number; cost_usd: number; calls: number }> = {};
  for (const r of byProviderRows) {
    byProvider[r.provider] = {
      cost_cents: r.cost,
      cost_usd: r.cost / 100,
      calls: r.calls,
    };
  }

  return {
    month: monthLabel,
    spent_cents: spent,
    spent_usd: spent / 100,
    cap_cents: cap,
    cap_usd: cap / 100,
    remaining_cents: cap - spent,
    remaining_usd: (cap - spent) / 100,
    episodes_count: epCount,
    by_provider: byProvider,
  };
}

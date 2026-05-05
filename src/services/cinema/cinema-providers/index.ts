/**
 * Cinema Provider Router — Hybrid 5-tier cascade for cost optimization.
 *
 * TIER 0 (FREE):     Pexels stock video    — for shots without character
 * TIER 0.5 (FREE):   LumaLabs Dream Machine — 30 free gens/month fallback
 * TIER 1 (CHEAP):    Wan 2.6 / Seedance     — cheap paid AI gen
 * TIER 2 (MID):      Veo Fast               — w/ audio when needed
 * TIER 3 (PREMIUM):  Hailuo Pro / Hedra     — money shots only
 * TIER 4 (CINEMA):   Veo Premium / Kling    — MID/FULL mode only
 *
 * Reference skill: sonder-cinema (Plan B hybrid)
 */

import { generateVeoShot, estimateVeoCost, type VeoOpts } from './veo-client';
import { generateHailuoShot, estimateHailuoCost, type HailuoOpts } from './hailuo-client';
import { generateSeedanceShot, estimateSeedanceCost, type SeedanceOpts } from './seedance-client';
import { generateHedraShot, estimateHedraCost, type HedraOpts } from './hedra-client';
import { generateWanShot, estimateWanCost, type WanOpts } from './wan-client';
import { generateLumaShot, estimateLumaCost, getLumaQuotaStatus, type LumaOpts } from './luma-client';
import { generateStockShot, estimateStockCost, resetStockUsedIds, type StockShotOpts } from './stock-client';
import type { VideoGenResult } from './fal-base';

export {
  generateVeoShot, estimateVeoCost,
  generateHailuoShot, estimateHailuoCost,
  generateSeedanceShot, estimateSeedanceCost,
  generateHedraShot, estimateHedraCost,
  generateWanShot, estimateWanCost,
  generateLumaShot, estimateLumaCost, getLumaQuotaStatus,
  generateStockShot, estimateStockCost, resetStockUsedIds,
};

export type {
  VeoOpts, HailuoOpts, SeedanceOpts, HedraOpts,
  WanOpts, LumaOpts, StockShotOpts,
  VideoGenResult,
};

// ═══════════════════════════════════════════════════════════
// Shot type system
// ═══════════════════════════════════════════════════════════

export type ShotType = 'HERO_ESTABLISHING' | 'CHARACTER_SCENE' | 'ATMOSPHERIC_BROLL' | 'TALKING_HEAD';

/**
 * Provider routing logic — picks BEST tool given shot context.
 *
 * Cascade strategy (Plan B):
 *   - has_character=false, non-talking → try stock first, then Luma free, then Wan cheap
 *   - has_character=true + money_shot=true → Hailuo Pro (locked, premium)
 *   - has_character=true + money_shot=false → Wan cheap (face fine at distance)
 *   - talking_head → Hedra (lip-sync required)
 *   - atmospheric → stock first, then Seedance Fast
 */
export type ProviderId = 'stock' | 'luma' | 'wan' | 'seedance' | 'hailuo' | 'hedra' | 'veo';

export interface ShotContext {
  shot_type: ShotType;
  has_character: boolean;
  money_shot?: boolean;            // critical face shot, no compromise
  duration_sec: number;
}

/**
 * Pick PRIMARY provider + fallback cascade for shot context.
 * Returns ordered list — try in sequence until one succeeds.
 */
export function pickProvidersForShot(ctx: ShotContext): ProviderId[] {
  // TALKING_HEAD: only Hedra has lip-sync. No fallback.
  if (ctx.shot_type === 'TALKING_HEAD') return ['hedra', 'hailuo'];

  // CHARACTER_SCENE money shot: Hailuo locked (face quality)
  if (ctx.shot_type === 'CHARACTER_SCENE' && ctx.money_shot) {
    return ['hailuo'];
  }

  // CHARACTER_SCENE non-money: Wan acceptable (face less critical wide)
  if (ctx.shot_type === 'CHARACTER_SCENE') {
    return ['wan', 'hailuo'];
  }

  // HERO_ESTABLISHING + has_character: probably wants face, Wan first
  if (ctx.shot_type === 'HERO_ESTABLISHING' && ctx.has_character) {
    return ['wan', 'luma', 'veo', 'hailuo'];
  }

  // HERO_ESTABLISHING no character: stock preferred (FREE!)
  if (ctx.shot_type === 'HERO_ESTABLISHING') {
    return ['stock', 'luma', 'wan', 'veo'];
  }

  // ATMOSPHERIC_BROLL: stock preferred (FREE!), Seedance fallback
  if (ctx.shot_type === 'ATMOSPHERIC_BROLL') {
    return ['stock', 'luma', 'seedance', 'wan'];
  }

  // Default fallback
  return ['stock', 'wan', 'seedance'];
}

// ═══════════════════════════════════════════════════════════
// Estimate cost cho shot context (use FIRST provider in cascade)
// ═══════════════════════════════════════════════════════════

export function estimateShotCostByContext(ctx: ShotContext): number {
  const providers = pickProvidersForShot(ctx);
  const primary = providers[0];
  return estimateProviderCost(primary, ctx.duration_sec);
}

export function estimateProviderCost(provider: ProviderId, durationSec: number): number {
  switch (provider) {
    case 'stock': return 0;
    case 'luma': return 0;                                     // free tier (when available)
    case 'wan': return estimateWanCost(durationSec);
    case 'seedance': return estimateSeedanceCost(durationSec, false);
    case 'hailuo': return estimateHailuoCost();
    case 'hedra': return estimateHedraCost(durationSec);
    case 'veo': return estimateVeoCost(durationSec, true, false);   // fast no audio default
    default: return 0;
  }
}

// ═══════════════════════════════════════════════════════════
// LEGACY routing (kept for backward compat with existing storyboard)
// ═══════════════════════════════════════════════════════════

export const SHOT_TYPE_TO_PROVIDER: Record<ShotType, ProviderId> = {
  HERO_ESTABLISHING: 'wan',         // changed default veo → wan (cheaper)
  CHARACTER_SCENE:   'hailuo',
  ATMOSPHERIC_BROLL: 'stock',       // changed default seedance → stock (free)
  TALKING_HEAD:      'hedra',
};

export function pickProviderForShot(shotType: ShotType): ProviderId {
  return SHOT_TYPE_TO_PROVIDER[shotType] || 'stock';
}

export function estimateShotCostByType(shotType: ShotType, durationSec: number): number {
  return estimateProviderCost(SHOT_TYPE_TO_PROVIDER[shotType] || 'stock', durationSec);
}

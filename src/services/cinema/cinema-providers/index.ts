/**
 * Cinema Provider Router — auto-route shot type → tool.
 *
 * Reference skill: sonder-cinema (LOCKED routing rules)
 */

import { generateVeoShot, estimateVeoCost, type VeoOpts } from './veo-client';
import { generateHailuoShot, estimateHailuoCost, type HailuoOpts } from './hailuo-client';
import { generateSeedanceShot, estimateSeedanceCost, type SeedanceOpts } from './seedance-client';
import { generateHedraShot, estimateHedraCost, type HedraOpts } from './hedra-client';
import type { VideoGenResult } from './fal-base';

export {
  generateVeoShot, estimateVeoCost,
  generateHailuoShot, estimateHailuoCost,
  generateSeedanceShot, estimateSeedanceCost,
  generateHedraShot, estimateHedraCost,
};

export type { VeoOpts, HailuoOpts, SeedanceOpts, HedraOpts, VideoGenResult };

// ═══════════════════════════════════════════════════════════
// Shot type → provider routing (LOCKED by skill)
// ═══════════════════════════════════════════════════════════

export type ShotType = 'HERO_ESTABLISHING' | 'CHARACTER_SCENE' | 'ATMOSPHERIC_BROLL' | 'TALKING_HEAD';

export const SHOT_TYPE_TO_PROVIDER: Record<ShotType, 'veo' | 'hailuo' | 'seedance' | 'hedra'> = {
  HERO_ESTABLISHING: 'veo',          // cinematic wide + audio-native
  CHARACTER_SCENE:   'hailuo',       // best face/micro-expression
  ATMOSPHERIC_BROLL: 'seedance',     // cheap b-roll texture ($0.022/s)
  TALKING_HEAD:      'hedra',        // photoreal lip-sync from image+audio
};

export function pickProviderForShot(shotType: ShotType): 'veo' | 'hailuo' | 'seedance' | 'hedra' {
  return SHOT_TYPE_TO_PROVIDER[shotType] || 'seedance';
}

// ═══════════════════════════════════════════════════════════
// Estimate cost cho shot type + duration
// ═══════════════════════════════════════════════════════════

export function estimateShotCostByType(shotType: ShotType, durationSec: number): number {
  switch (shotType) {
    case 'HERO_ESTABLISHING':
      return estimateVeoCost(durationSec, false, true);  // premium with audio
    case 'CHARACTER_SCENE':
      return estimateHailuoCost();                       // flat $0.49
    case 'ATMOSPHERIC_BROLL':
      return estimateSeedanceCost(durationSec, false);   // fast tier
    case 'TALKING_HEAD':
      return estimateHedraCost(durationSec);
    default:
      return 0;
  }
}

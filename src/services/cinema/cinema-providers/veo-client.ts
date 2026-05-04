/**
 * Veo 3.1 client (via FAL.ai) — HERO_ESTABLISHING shots.
 *
 * Veo 3.1: 1080p với audio-native, $0.40/giây.
 * Best cho cinematic establishing shots với ambient sound (Sài Gòn 5h sáng,
 * golden hour drone view, đêm mưa Bến Thành).
 *
 * Model ID FAL: fal-ai/veo3 (premium) hoặc fal-ai/veo3/fast (cheap $0.15/s)
 *
 * Reference skill: sonder-cinema
 */

import { runFalVideoJob, type VideoGenInput, type VideoGenResult } from './fal-base';
import { estimateShotCost, logCost } from '../cinema-cost-tracker';
import { getSetting } from '../../../db';

const MODEL_ID_PREMIUM = 'fal-ai/veo3';
const MODEL_ID_FAST = 'fal-ai/veo3/fast';

export interface VeoOpts extends VideoGenInput {
  episode_id?: number;
  shot_id?: number;
  use_fast?: boolean;                   // Veo 3 Fast ($0.15/s vs $0.40/s)
}

/**
 * Generate cinematic shot via Veo 3.1.
 * Default: premium with audio. Use `use_fast=true` cho budget mode.
 */
export async function generateVeoShot(opts: VeoOpts): Promise<VideoGenResult> {
  const useFast = opts.use_fast ?? (getSetting('cinema_veo_use_fast') === 'true');
  const modelId = useFast ? MODEL_ID_FAST : MODEL_ID_PREMIUM;

  const duration = opts.duration_sec || 8;          // Veo default 8s
  const aspectRatio = opts.aspect_ratio || '9:16';   // vertical for Sonder
  const resolution = opts.resolution || '1080p';

  // Construct FAL input (Veo schema)
  const input: any = {
    prompt: opts.prompt,
    aspect_ratio: aspectRatio,
    duration: `${duration}s`,
    enhance_prompt: true,
    auto_fix: true,
  };

  if (!useFast) {
    // Premium options
    input.resolution = resolution;
    input.generate_audio = opts.audio !== false;     // default true cho premium
  } else {
    input.generate_audio = opts.audio === true;      // default false cho fast (cheap)
  }

  if (opts.negative_prompt) input.negative_prompt = opts.negative_prompt;
  if (opts.seed) input.seed = opts.seed;

  console.log(`[veo] generating (${useFast ? 'fast' : 'premium'}) duration=${duration}s audio=${input.generate_audio}: "${opts.prompt.slice(0, 80)}..."`);

  const r = await runFalVideoJob({
    modelId,
    input,
    localFilenamePrefix: `veo-ep${opts.episode_id || 'X'}-shot${opts.shot_id || 'X'}`,
    videoUrlExtractor: (data) => data?.video?.url || data?.url || data?.output?.video?.url,
    pollTimeoutMs: 480_000,                          // 8 min for Veo (slowest)
  });

  // Calculate cost based on actual model used + audio
  let costPerSec: number;
  if (useFast) {
    costPerSec = input.generate_audio ? 15 : 10;     // 15c with audio, 10c without
  } else {
    costPerSec = input.generate_audio ? 40 : 20;     // 40c with audio, 20c without (1080p)
  }
  const costCents = Math.ceil(costPerSec * duration);

  if (r.ok) {
    logCost({
      episode_id: opts.episode_id || null,
      shot_id: opts.shot_id || null,
      provider: 'veo',
      operation: 'video_gen',
      duration_sec: duration,
      units: duration,
      cost_cents: costCents,
      request_id: r.request_id,
      notes: `${useFast ? 'fast' : 'premium'} ${resolution} audio=${input.generate_audio}`,
    });
  }

  return {
    ok: r.ok,
    video_url: r.video_url,
    local_path: r.local_path,
    duration_sec: duration,
    cost_cents: r.ok ? costCents : 0,
    request_id: r.request_id,
    error: r.error,
  };
}

export function estimateVeoCost(durationSec: number, useFast = false, withAudio = true): number {
  let perSec: number;
  if (useFast) perSec = withAudio ? 15 : 10;
  else perSec = withAudio ? 40 : 20;
  return Math.ceil(perSec * durationSec);
}

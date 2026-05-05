/**
 * Wan 2.6 client (Alibaba via FAL.ai) — TIER 1 cheap text-to-video.
 *
 * $0.05/s for 720p — cheapest paid option for hero/establishing shots
 * without character close-up requirements.
 *
 * Use cases (PILOT 60s):
 *   - Hero establishing wide (no character face)
 *   - Character action wide (face less critical at distance)
 *   - Atmospheric outro
 *
 * NOT for: character close-up (use Hailuo Pro instead — better face).
 *
 * Model ID FAL: fal-ai/wan/v2.6/text-to-video
 *               fal-ai/wan/v2.6/image-to-video
 *
 * Quality: "best for social media TikTok/Reels/Shorts" per benchmarks.
 * Resolution: 720p only (no 1080p) — fine for FB Reels + YT Shorts.
 *
 * Reference skill: sonder-cinema (TIER 1 hybrid stack)
 */

import { runFalVideoJob, type VideoGenInput, type VideoGenResult } from './fal-base';
import { logCost } from '../cinema-cost-tracker';

const MODEL_T2V = 'fal-ai/wan/v2.6/text-to-video';
const MODEL_I2V = 'fal-ai/wan/v2.6/image-to-video';

export interface WanOpts extends VideoGenInput {
  episode_id?: number;
  shot_id?: number;
}

export async function generateWanShot(opts: WanOpts): Promise<VideoGenResult> {
  const useImage = !!opts.reference_image_url;
  const modelId = useImage ? MODEL_I2V : MODEL_T2V;

  const duration = Math.min(10, Math.max(4, opts.duration_sec || 6));
  const aspectRatio = opts.aspect_ratio || '9:16';

  const input: any = {
    prompt: opts.prompt,
    duration,
    aspect_ratio: aspectRatio,
    resolution: '720p',                      // Wan max 720p
  };

  if (useImage) input.image_url = opts.reference_image_url;
  if (opts.negative_prompt) input.negative_prompt = opts.negative_prompt;
  if (opts.seed) input.seed = opts.seed;

  console.log(`[wan] generating (${useImage ? 'i2v' : 't2v'}) duration=${duration}s: "${opts.prompt.slice(0, 80)}..."`);

  const r = await runFalVideoJob({
    modelId,
    input,
    localFilenamePrefix: `wan-ep${opts.episode_id || 'X'}-shot${opts.shot_id || 'X'}`,
    videoUrlExtractor: (data) => data?.video?.url || data?.url || data?.output?.video?.url,
    pollTimeoutMs: 240_000,
  });

  // Wan 2.6: $0.05/s
  const costPerSec = 5;                      // 5 cents/s = $0.05/s
  const costCents = Math.ceil(costPerSec * duration);

  if (r.ok) {
    logCost({
      episode_id: opts.episode_id || null,
      shot_id: opts.shot_id || null,
      provider: 'kling_fallback',            // closest enum match in tracker
      operation: 'video_gen',
      duration_sec: duration,
      units: duration,
      cost_cents: costCents,
      request_id: r.request_id,
      notes: `wan-2.6 ${useImage ? 'i2v' : 't2v'} 720p`,
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

export function estimateWanCost(durationSec: number): number {
  return Math.ceil(5 * Math.min(10, Math.max(4, durationSec)));
}

/**
 * Hailuo 2.3 Pro client (MiniMax via FAL.ai) — CHARACTER_SCENE shots.
 *
 * Best face/micro-expression consistency. $0.49/video Pro tier.
 * Use cho cảnh có nhân vật close-up: Linh đi bộ, Tuấn pha trà, Vy nhìn ra cửa sổ.
 *
 * Model ID FAL: fal-ai/minimax/hailuo-02/pro/image-to-video
 *
 * Mode:
 *   - text-to-video: từ prompt
 *   - image-to-video: từ reference image (preferred cho character consistency)
 *
 * Reference skill: sonder-cinema
 */

import { runFalVideoJob, type VideoGenInput, type VideoGenResult } from './fal-base';
import { logCost } from '../cinema-cost-tracker';

const MODEL_ID_T2V = 'fal-ai/minimax/hailuo-02/pro/text-to-video';
const MODEL_ID_I2V = 'fal-ai/minimax/hailuo-02/pro/image-to-video';

export interface HailuoOpts extends VideoGenInput {
  episode_id?: number;
  shot_id?: number;
}

export async function generateHailuoShot(opts: HailuoOpts): Promise<VideoGenResult> {
  const useImage = !!opts.reference_image_url;
  const modelId = useImage ? MODEL_ID_I2V : MODEL_ID_T2V;

  const duration = opts.duration_sec || 6;          // Hailuo default 6s
  const aspectRatio = opts.aspect_ratio || '9:16';

  const input: any = {
    prompt: opts.prompt,
    duration: duration.toString(),
    aspect_ratio: aspectRatio,
  };

  if (useImage) input.image_url = opts.reference_image_url;
  if (opts.negative_prompt) input.negative_prompt = opts.negative_prompt;
  if (opts.seed) input.seed = opts.seed;

  console.log(`[hailuo] generating (${useImage ? 'i2v' : 't2v'}) duration=${duration}s: "${opts.prompt.slice(0, 80)}..."`);

  const r = await runFalVideoJob({
    modelId,
    input,
    localFilenamePrefix: `hailuo-ep${opts.episode_id || 'X'}-shot${opts.shot_id || 'X'}`,
    videoUrlExtractor: (data) => data?.video?.url || data?.url || data?.output?.video?.url,
    pollTimeoutMs: 360_000,                          // 6 min for Hailuo
  });

  // Hailuo Pro: $0.49/video (fixed price regardless of duration)
  const costCents = 49;

  if (r.ok) {
    logCost({
      episode_id: opts.episode_id || null,
      shot_id: opts.shot_id || null,
      provider: 'hailuo',
      operation: 'video_gen',
      duration_sec: duration,
      units: 1,                                     // 1 video
      cost_cents: costCents,
      request_id: r.request_id,
      notes: `${useImage ? 'i2v' : 't2v'} pro`,
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

export function estimateHailuoCost(): number {
  return 49;  // $0.49/video flat
}

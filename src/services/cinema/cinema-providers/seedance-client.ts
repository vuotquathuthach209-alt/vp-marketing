/**
 * Seedance 2.0 Fast client (ByteDance via FAL.ai) — ATMOSPHERIC_BROLL shots.
 *
 * Cheapest per-second: $0.022/giây Fast tier. Use cho b-roll texture cảnh:
 * ly trà nóng bốc khói, ánh đèn vàng, ga giường nhăn, tay viết nhật ký.
 *
 * Multimodal: 8+ ngôn ngữ lip-sync (có thể test VN sau), max 12 reference files.
 * Limit 4-15 giây/clip — phù hợp B-roll ngắn.
 *
 * Model ID FAL: fal-ai/bytedance/seedance/v2/text-to-video (Fast tier)
 *
 * Reference skill: sonder-cinema
 */

import { runFalVideoJob, type VideoGenInput, type VideoGenResult } from './fal-base';
import { logCost } from '../cinema-cost-tracker';

const MODEL_ID_FAST = 'fal-ai/bytedance/seedance/v2/text-to-video';
const MODEL_ID_PRO = 'fal-ai/bytedance/seedance/v2/pro/text-to-video';
const MODEL_ID_I2V = 'fal-ai/bytedance/seedance/v2/image-to-video';

export interface SeedanceOpts extends VideoGenInput {
  episode_id?: number;
  shot_id?: number;
  use_pro?: boolean;                    // Pro tier ($0.10/s) vs Fast ($0.022/s)
}

export async function generateSeedanceShot(opts: SeedanceOpts): Promise<VideoGenResult> {
  const usePro = opts.use_pro || false;
  const useImage = !!opts.reference_image_url;

  let modelId: string;
  if (useImage) modelId = MODEL_ID_I2V;
  else if (usePro) modelId = MODEL_ID_PRO;
  else modelId = MODEL_ID_FAST;

  const duration = Math.min(15, Math.max(4, opts.duration_sec || 6));   // Seedance limit 4-15s
  const aspectRatio = opts.aspect_ratio || '9:16';
  const resolution = opts.resolution || '720p';                          // default 720p (Fast tier không support 4K)

  const input: any = {
    prompt: opts.prompt,
    duration,
    aspect_ratio: aspectRatio,
    resolution,
  };

  if (useImage) input.image_url = opts.reference_image_url;
  if (opts.negative_prompt) input.negative_prompt = opts.negative_prompt;
  if (opts.seed) input.seed = opts.seed;

  console.log(`[seedance] generating (${usePro ? 'pro' : 'fast'}, ${useImage ? 'i2v' : 't2v'}) duration=${duration}s: "${opts.prompt.slice(0, 80)}..."`);

  const r = await runFalVideoJob({
    modelId,
    input,
    localFilenamePrefix: `seedance-ep${opts.episode_id || 'X'}-shot${opts.shot_id || 'X'}`,
    videoUrlExtractor: (data) => data?.video?.url || data?.url || data?.output?.video?.url,
    pollTimeoutMs: 240_000,                                              // 4 min — Seedance Fast khá nhanh
  });

  // Cost: Fast $0.022/s, Pro $0.10/s
  const costPerSec = usePro ? 10 : 2.2;
  const costCents = Math.ceil(costPerSec * duration);

  if (r.ok) {
    logCost({
      episode_id: opts.episode_id || null,
      shot_id: opts.shot_id || null,
      provider: 'seedance',
      operation: 'video_gen',
      duration_sec: duration,
      units: duration,
      cost_cents: costCents,
      request_id: r.request_id,
      notes: `${usePro ? 'pro' : 'fast'} ${resolution} ${useImage ? 'i2v' : 't2v'}`,
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

export function estimateSeedanceCost(durationSec: number, usePro = false): number {
  const perSec = usePro ? 10 : 2.2;
  return Math.ceil(perSec * Math.min(15, Math.max(4, durationSec)));
}

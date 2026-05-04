/**
 * Hedra Character-3 client — TALKING_HEAD shots.
 *
 * Best lip-sync photoreal: omnimodal (image + text + audio simultaneously).
 * Pricing: $16/tháng rolling subscription + $0.05/min cho live avatars.
 * Per-shot cost approx = subscription amortized + per-minute compute.
 *
 * Use cho dialogue close-ups: Tuấn POV monologue, Linh viết nhật ký nói,
 * Vy kể chuyện trong cafe.
 *
 * API: https://api.hedra.com (REST). Cần HEDRA_API_KEY trong settings.
 *
 * Reference skill: sonder-cinema
 */

import axios, { AxiosError } from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import { db, getSetting } from '../../../db';
import { logCost } from '../cinema-cost-tracker';

const HEDRA_API_BASE = 'https://api.hedra.com/web-app/public';
const MEDIA_DIR = '/opt/vp-marketing/data/media';
const CINEMA_VIDEOS_DIR = path.join(MEDIA_DIR, 'cinema-shots');

if (!fs.existsSync(CINEMA_VIDEOS_DIR)) fs.mkdirSync(CINEMA_VIDEOS_DIR, { recursive: true });

// ═══════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════

export interface HedraOpts {
  episode_id?: number;
  shot_id?: number;
  reference_image_path: string;          // local path or URL to character image
  audio_path: string;                    // local mp3/wav of voiceover
  text_prompt?: string;                  // optional director note for facial expression
  resolution?: '720p' | '1080p';
  duration_sec?: number;                 // expected duration (limited by audio)
  ar?: '9:16' | '16:9' | '1:1';
}

export interface HedraResult {
  ok: boolean;
  video_url?: string;
  local_path?: string;
  duration_sec?: number;
  cost_cents: number;
  request_id?: string;
  error?: string;
}

// ═══════════════════════════════════════════════════════════
// Auth
// ═══════════════════════════════════════════════════════════

function getHedraApiKey(): string {
  const key = getSetting('hedra_api_key') || process.env.HEDRA_API_KEY || '';
  if (!key) throw new Error('hedra_api_key not configured');
  return key;
}

function authHeaders(): Record<string, string> {
  return {
    'X-API-Key': getHedraApiKey(),
    'Content-Type': 'application/json',
  };
}

// ═══════════════════════════════════════════════════════════
// Asset upload (Hedra requires upload first, then generate)
// ═══════════════════════════════════════════════════════════

async function uploadAsset(localPath: string, type: 'image' | 'audio'): Promise<string> {
  const apiKey = getHedraApiKey();

  // 1. Create asset record
  const createR = await axios.post(
    `${HEDRA_API_BASE}/assets`,
    {
      name: path.basename(localPath),
      type,
    },
    { headers: { 'X-API-Key': apiKey, 'Content-Type': 'application/json' }, timeout: 30_000 },
  );

  const assetId: string = createR.data?.id;
  if (!assetId) throw new Error('hedra_no_asset_id');

  // 2. Upload binary
  const buf = fs.readFileSync(localPath);
  const contentType = type === 'image' ? 'image/jpeg' : 'audio/mpeg';

  await axios.post(
    `${HEDRA_API_BASE}/assets/${assetId}/upload`,
    buf,
    {
      headers: { 'X-API-Key': apiKey, 'Content-Type': contentType },
      timeout: 120_000,
      maxBodyLength: Infinity,
    },
  );

  return assetId;
}

// ═══════════════════════════════════════════════════════════
// Generate talking head video
// ═══════════════════════════════════════════════════════════

export async function generateHedraShot(opts: HedraOpts): Promise<HedraResult> {
  if (!fs.existsSync(opts.reference_image_path)) {
    return { ok: false, cost_cents: 0, error: 'image_not_found: ' + opts.reference_image_path };
  }
  if (!fs.existsSync(opts.audio_path)) {
    return { ok: false, cost_cents: 0, error: 'audio_not_found: ' + opts.audio_path };
  }

  console.log(`[hedra] generating talking head: img=${path.basename(opts.reference_image_path)} audio=${path.basename(opts.audio_path)}`);

  let imageAssetId: string;
  let audioAssetId: string;
  try {
    [imageAssetId, audioAssetId] = await Promise.all([
      uploadAsset(opts.reference_image_path, 'image'),
      uploadAsset(opts.audio_path, 'audio'),
    ]);
  } catch (e: any) {
    return { ok: false, cost_cents: 0, error: 'hedra_asset_upload_fail: ' + e?.message };
  }

  // Submit generation
  let generationId: string;
  try {
    const submitR = await axios.post(
      `${HEDRA_API_BASE}/generations`,
      {
        type: 'video',
        ai_model_id: 'character-3',
        start_keyframe_id: imageAssetId,
        audio_id: audioAssetId,
        generated_video_inputs: {
          text_prompt: opts.text_prompt || '',
          resolution: opts.resolution || '720p',
          aspect_ratio: opts.ar || '9:16',
          duration_ms: opts.duration_sec ? Math.round(opts.duration_sec * 1000) : undefined,
        },
      },
      { headers: authHeaders(), timeout: 60_000 },
    );

    generationId = submitR.data?.id;
    if (!generationId) {
      return { ok: false, cost_cents: 0, error: 'hedra_no_generation_id' };
    }
  } catch (e: any) {
    const ax = e as AxiosError<any>;
    return { ok: false, cost_cents: 0, error: 'hedra_submit_fail: ' + (ax?.response?.data?.error || ax?.message) };
  }

  // Poll until ready (max 6 min)
  const start = Date.now();
  const timeoutMs = 360_000;
  let videoUrl: string | undefined;

  while (Date.now() - start < timeoutMs) {
    try {
      const statusR = await axios.get(
        `${HEDRA_API_BASE}/generations/${generationId}/status`,
        { headers: authHeaders(), timeout: 30_000 },
      );
      const status: string = statusR.data?.status;
      if (status === 'complete' || status === 'completed') {
        videoUrl = statusR.data?.url || statusR.data?.video_url;
        break;
      }
      if (status === 'error' || status === 'failed') {
        return {
          ok: false,
          cost_cents: 0,
          request_id: generationId,
          error: 'hedra_failed: ' + (statusR.data?.error_message || 'unknown'),
        };
      }
    } catch (e: any) {
      // transient
    }
    await new Promise((r) => setTimeout(r, 5000));
  }

  if (!videoUrl) {
    return {
      ok: false,
      cost_cents: 0,
      request_id: generationId,
      error: 'hedra_timeout',
    };
  }

  // Download to local
  let localPath: string | undefined;
  try {
    const ts = Date.now();
    const filename = `hedra-ep${opts.episode_id || 'X'}-shot${opts.shot_id || 'X'}-${ts}.mp4`;
    localPath = path.join(CINEMA_VIDEOS_DIR, filename);
    const resp = await axios.get(videoUrl, { responseType: 'arraybuffer', timeout: 120_000, maxContentLength: 100 * 1024 * 1024 });
    fs.writeFileSync(localPath, Buffer.from(resp.data));
  } catch (e: any) {
    console.warn(`[hedra] download fail: ${e?.message}`);
  }

  // Cost: ~$0.05/min Hedra Live; with character-3 generations approx $0.10/min generation
  // Plus subscription $16/mo amortized — we just track per-video compute
  const durationSec = opts.duration_sec || 10;
  const costCents = Math.ceil((durationSec / 60) * 10);    // ~10 cents/min compute

  logCost({
    episode_id: opts.episode_id || null,
    shot_id: opts.shot_id || null,
    provider: 'hedra',
    operation: 'video_gen',
    duration_sec: durationSec,
    units: 1,
    cost_cents: costCents,
    request_id: generationId,
    notes: `character-3 ${opts.resolution || '720p'}`,
  });

  return {
    ok: true,
    video_url: videoUrl,
    local_path: localPath,
    duration_sec: durationSec,
    cost_cents: costCents,
    request_id: generationId,
  };
}

export function estimateHedraCost(durationSec: number): number {
  // Per-shot compute cost approx 10 cents/min
  return Math.ceil((durationSec / 60) * 10);
}

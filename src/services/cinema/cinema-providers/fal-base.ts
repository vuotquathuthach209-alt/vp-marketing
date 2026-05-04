/**
 * FAL.ai shared client — base HTTP layer for video generation providers.
 *
 * Pattern:
 *   1. POST https://queue.fal.run/{model_id} với input → trả về request_id
 *   2. Poll status https://queue.fal.run/{model_id}/requests/{request_id}/status
 *   3. Fetch result https://queue.fal.run/{model_id}/requests/{request_id}
 *   4. Download video URL → save to local + log cost
 *
 * Reused by veo-client, hailuo-client, seedance-client.
 *
 * Reference skill: sonder-cinema
 */

import axios, { AxiosError } from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import { getSetting } from '../../../db';

const QUEUE_BASE = 'https://queue.fal.run';
const MEDIA_DIR = '/opt/vp-marketing/data/media';
const CINEMA_VIDEOS_DIR = path.join(MEDIA_DIR, 'cinema-shots');

if (!fs.existsSync(CINEMA_VIDEOS_DIR)) fs.mkdirSync(CINEMA_VIDEOS_DIR, { recursive: true });

// ═══════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════

export interface FalSubmitResult {
  request_id: string;
  status_url?: string;
  response_url?: string;
}

export interface FalStatusResult {
  status: 'IN_QUEUE' | 'IN_PROGRESS' | 'COMPLETED' | 'FAILED' | string;
  queue_position?: number;
  logs?: any[];
}

export interface FalResult<T = any> {
  status: 'COMPLETED' | 'FAILED';
  data?: T;
  error?: string;
}

export interface VideoGenInput {
  prompt: string;                       // ENG prompt
  duration_sec?: number;                // target duration (some providers fixed)
  aspect_ratio?: '16:9' | '9:16' | '1:1';
  resolution?: '720p' | '1080p' | '4k';
  audio?: boolean;                      // Veo 3.1 supports
  reference_image_url?: string;         // image-to-video providers
  negative_prompt?: string;
  seed?: number;
}

export interface VideoGenResult {
  ok: boolean;
  video_url?: string;                   // remote URL
  local_path?: string;                  // downloaded to local
  duration_sec?: number;                // actual
  cost_cents: number;                   // from cost tracker
  request_id?: string;
  error?: string;
}

// ═══════════════════════════════════════════════════════════
// Auth
// ═══════════════════════════════════════════════════════════

export function getFalApiKey(): string {
  const key = getSetting('fal_api_key') || process.env.FAL_API_KEY || '';
  if (!key) throw new Error('fal_api_key not configured (settings or FAL_API_KEY env)');
  return key;
}

function authHeaders(): Record<string, string> {
  return {
    Authorization: `Key ${getFalApiKey()}`,
    'Content-Type': 'application/json',
  };
}

// ═══════════════════════════════════════════════════════════
// Submit + poll workflow
// ═══════════════════════════════════════════════════════════

/**
 * Submit job to FAL queue. Returns request_id + URLs FAL gave us back.
 *
 * IMPORTANT: For multi-slash model IDs (e.g. fal-ai/bytedance/seedance/v2/text-to-video),
 * the polling URL is /fal-ai/requests/{id}/status (just owner part), NOT the full path.
 * Always use the status_url + response_url returned by FAL in the submit response.
 */
export async function falSubmit(modelId: string, input: any): Promise<FalSubmitResult> {
  const url = `${QUEUE_BASE}/${modelId}`;
  try {
    const r = await axios.post(url, input, {
      headers: authHeaders(),
      timeout: 60_000,
    });
    if (!r.data?.request_id) {
      throw new Error('no request_id in submit response: ' + JSON.stringify(r.data).slice(0, 300));
    }
    return {
      request_id: r.data.request_id,
      status_url: r.data.status_url,
      response_url: r.data.response_url,
    };
  } catch (e: any) {
    const ax = e as AxiosError<any>;
    const msg = ax?.response?.data?.detail || ax?.response?.data?.error || ax?.message;
    throw new Error(`fal_submit_fail (${modelId}): ${typeof msg === 'string' ? msg : JSON.stringify(msg).slice(0, 200)}`);
  }
}

/**
 * Build owner-only base for polling (FAL returns URLs but we may need fallback).
 * fal-ai/veo3 → fal-ai
 * fal-ai/bytedance/seedance/v2/text-to-video → fal-ai
 */
function ownerOnly(modelId: string): string {
  const parts = modelId.split('/');
  return parts[0];                                // first segment = owner
}

/**
 * Poll status. Prefer status_url returned by FAL (correct URL for any model),
 * fallback to constructed URL using owner-only path.
 */
export async function falPoll(submitResult: FalSubmitResult, modelId: string, opts: { intervalMs?: number; timeoutMs?: number } = {}): Promise<FalStatusResult> {
  const intervalMs = opts.intervalMs || 5000;
  const timeoutMs = opts.timeoutMs || 600_000;
  const start = Date.now();
  let lastStatus: FalStatusResult | null = null;

  // Prefer FAL-returned status_url; fallback to owner-only construction
  const statusUrl = submitResult.status_url
    || `${QUEUE_BASE}/${ownerOnly(modelId)}/requests/${submitResult.request_id}/status`;

  while (Date.now() - start < timeoutMs) {
    try {
      const r = await axios.get(statusUrl, {
        headers: authHeaders(),
        timeout: 30_000,
      });
      lastStatus = r.data as FalStatusResult;
      if (lastStatus.status === 'COMPLETED' || lastStatus.status === 'FAILED') {
        return lastStatus;
      }
    } catch (e: any) {
      console.warn(`[fal-poll] ${modelId} ${submitResult.request_id} transient err:`, e?.message);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }

  return lastStatus || { status: 'FAILED', logs: [{ message: `polling_timeout_after_${timeoutMs}ms` }] };
}

/**
 * Fetch final result. Prefer response_url returned by FAL; fallback owner-only.
 */
export async function falFetchResult<T = any>(submitResult: FalSubmitResult, modelId: string): Promise<T> {
  const responseUrl = submitResult.response_url
    || `${QUEUE_BASE}/${ownerOnly(modelId)}/requests/${submitResult.request_id}`;

  try {
    const r = await axios.get(responseUrl, {
      headers: authHeaders(),
      timeout: 30_000,
    });
    return r.data as T;
  } catch (e: any) {
    const ax = e as AxiosError<any>;
    throw new Error(`fal_fetch_result_fail: ${ax?.response?.data?.detail || ax?.message}`);
  }
}

// ═══════════════════════════════════════════════════════════
// Download video to local
// ═══════════════════════════════════════════════════════════

export async function downloadVideo(remoteUrl: string, localFilename: string): Promise<string> {
  const localPath = path.join(CINEMA_VIDEOS_DIR, localFilename);
  try {
    const resp = await axios.get(remoteUrl, {
      responseType: 'arraybuffer',
      timeout: 180_000,
      maxContentLength: 200 * 1024 * 1024,    // 200MB cap
    });
    fs.writeFileSync(localPath, Buffer.from(resp.data));
    return localPath;
  } catch (e: any) {
    throw new Error(`download_fail: ${e?.message}`);
  }
}

// ═══════════════════════════════════════════════════════════
// High-level: submit + poll + fetch + download
// ═══════════════════════════════════════════════════════════

export interface RunFalOpts {
  modelId: string;
  input: any;
  localFilenamePrefix: string;
  videoUrlExtractor: (data: any) => string | undefined;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
}

export async function runFalVideoJob(opts: RunFalOpts): Promise<{ ok: boolean; video_url?: string; local_path?: string; request_id?: string; error?: string }> {
  let submitR: FalSubmitResult;
  try {
    submitR = await falSubmit(opts.modelId, opts.input);
  } catch (e: any) {
    return { ok: false, error: e.message };
  }

  console.log(`[fal] ${opts.modelId} submitted req=${submitR.request_id} status_url=${submitR.status_url || '(constructed)'}`);

  const status = await falPoll(submitR, opts.modelId, {
    intervalMs: opts.pollIntervalMs,
    timeoutMs: opts.pollTimeoutMs,
  });

  if (status.status !== 'COMPLETED') {
    const errLog = (status.logs || []).map((l: any) => l.message || JSON.stringify(l)).join(' | ').slice(0, 300);
    return { ok: false, request_id: submitR.request_id, error: `fal_status=${status.status}: ${errLog}` };
  }

  let result: any;
  try {
    result = await falFetchResult(submitR, opts.modelId);
  } catch (e: any) {
    return { ok: false, request_id: submitR.request_id, error: e.message };
  }

  const videoUrl = opts.videoUrlExtractor(result);
  if (!videoUrl) {
    return { ok: false, request_id: submitR.request_id, error: 'no_video_url_in_result: ' + JSON.stringify(result).slice(0, 300) };
  }

  // Download to local for FFmpeg compose later
  const ts = Date.now();
  const filename = `${opts.localFilenamePrefix}-${ts}.mp4`;
  let localPath: string | undefined;
  try {
    localPath = await downloadVideo(videoUrl, filename);
  } catch (e: any) {
    console.warn(`[fal] ${opts.modelId} download fail (will use remote URL): ${e?.message}`);
  }

  return {
    ok: true,
    video_url: videoUrl,
    local_path: localPath,
    request_id: submitR.request_id,
  };
}

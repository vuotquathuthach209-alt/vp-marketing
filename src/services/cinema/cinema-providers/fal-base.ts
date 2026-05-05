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
/**
 * Custom error class for FAL balance exhaustion.
 * Detected via HTTP 403 with "Exhausted balance" message.
 * Orchestrator catches this and aborts pipeline gracefully (no retry).
 */
export class FalBalanceExhaustedError extends Error {
  isBalanceExhausted = true;
  constructor(public modelId: string, public detail?: string) {
    super(`FAL balance exhausted (${modelId}): ${detail || 'top up at fal.ai/dashboard/billing'}`);
    this.name = 'FalBalanceExhaustedError';
  }
}

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
    const status = ax?.response?.status;
    const msg = ax?.response?.data?.detail || ax?.response?.data?.error || ax?.message;
    const msgStr = typeof msg === 'string' ? msg : JSON.stringify(msg).slice(0, 200);

    // 403 + "Exhausted balance" or "User is locked" → balance issue, not transient
    if (status === 403 && /exhaust|locked|balance|insufficient/i.test(msgStr)) {
      throw new FalBalanceExhaustedError(modelId, msgStr);
    }

    throw new Error(`fal_submit_fail (${modelId}): ${msgStr}`);
  }
}

/**
 * Quick FAL account health check. Returns { healthy, balance, message }.
 * Calls a cheap endpoint to detect 403 lock state.
 */
export async function checkFalHealth(): Promise<{ healthy: boolean; locked: boolean; balance_usd?: number; message: string }> {
  try {
    // Try the user/me-style endpoint. FAL's billing API isn't documented publicly,
    // so fall back to a probe submit (just checking if 403 fires immediately).
    // We use a tiny dry-run probe via Seedance Fast (cheapest), checking only the auth/balance gate.
    // IMPORTANT: this DOES create a queued job at $0.022 worst-case if balance is healthy.
    // Cancel immediately after.
    const r = await axios.post(
      `${QUEUE_BASE}/fal-ai/bytedance/seedance/v2/text-to-video`,
      { prompt: 'health check', duration: 4, aspect_ratio: '9:16', resolution: '720p' },
      { headers: authHeaders(), timeout: 30_000, validateStatus: () => true },
    );

    if (r.status === 403) {
      const detail = r.data?.detail || JSON.stringify(r.data).slice(0, 200);
      return { healthy: false, locked: true, message: `403 — ${detail}` };
    }
    if (r.status === 200 && r.data?.request_id) {
      // Submitted successfully — cancel to avoid charge
      try {
        await axios.put(
          `${QUEUE_BASE}/fal-ai/bytedance/requests/${r.data.request_id}/cancel`,
          {},
          { headers: authHeaders(), timeout: 15_000, validateStatus: () => true },
        );
      } catch { /* best-effort cancel */ }
      return { healthy: true, locked: false, message: 'OK — balance available' };
    }
    return { healthy: false, locked: false, message: `unexpected status ${r.status}` };
  } catch (e: any) {
    return { healthy: false, locked: false, message: e?.message || 'unknown error' };
  }
}

/**
 * FAL URL discovery — empirical mapping from extensive testing 2026-05-05:
 *
 *   STATUS poll URL: use FAL's status_url verbatim (owner-only path)
 *     ✅ https://queue.fal.run/fal-ai/minimax/requests/{id}/status
 *     ❌ https://queue.fal.run/fal-ai/minimax/hailuo-02/pro/text-to-video/requests/{id}/status (405)
 *
 *   FETCH result URL: requires FULL model path (per FAL docs)
 *     ❌ https://queue.fal.run/fal-ai/bytedance/requests/{id} (404 "Path not found")
 *     ✅ https://queue.fal.run/fal-ai/bytedance/seedance/v2/text-to-video/requests/{id}
 *
 * FAL inconsistency: their submit response returns owner-only URLs for both
 * status_url and response_url. status_url works as-is, response_url DOES NOT
 * — must construct full path for fetch.
 */
function buildResponseUrl(modelId: string, requestId: string): string {
  return `${QUEUE_BASE}/${modelId}/requests/${requestId}`;
}

/**
 * Poll status using FAL-returned status_url (owner-only path works for status).
 */
export async function falPoll(submitResult: FalSubmitResult, modelId: string, opts: { intervalMs?: number; timeoutMs?: number } = {}): Promise<FalStatusResult> {
  const intervalMs = opts.intervalMs || 5000;
  const timeoutMs = opts.timeoutMs || 600_000;
  const start = Date.now();
  let lastStatus: FalStatusResult | null = null;

  // Trust FAL's status_url (owner-only works for status); fallback construct
  const ownerOnly = modelId.split('/')[0];
  const statusUrl = submitResult.status_url
    || `${QUEUE_BASE}/${ownerOnly}/requests/${submitResult.request_id}/status`;

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
 * Fetch result — FAL inconsistent: some models need full path, others owner-only.
 *
 * Empirical 2026-05-05 testing:
 *   • Seedance: full path works  (/fal-ai/bytedance/seedance/v2/.../requests/{id})
 *   • Hailuo:   owner-only works (/fal-ai/minimax/requests/{id})
 *   • Veo:      single-segment   (/fal-ai/veo3/requests/{id})
 *
 * Strategy: try BOTH URLs (FAL-returned response_url + full path construct),
 * return first that succeeds with 200.
 */
export async function falFetchResult<T = any>(submitResult: FalSubmitResult, modelId: string): Promise<T> {
  // Build candidate URLs in priority order
  const candidates: string[] = [];

  // 1st priority: FAL-returned response_url (works for Hailuo, Veo)
  if (submitResult.response_url) candidates.push(submitResult.response_url);

  // 2nd priority: constructed full path (works for Seedance multi-slash)
  const fullPath = buildResponseUrl(modelId, submitResult.request_id);
  if (!candidates.includes(fullPath)) candidates.push(fullPath);

  // 3rd priority: owner-only fallback (in case FAL didn't return response_url)
  const ownerOnlyUrl = `${QUEUE_BASE}/${modelId.split('/')[0]}/requests/${submitResult.request_id}`;
  if (!candidates.includes(ownerOnlyUrl)) candidates.push(ownerOnlyUrl);

  let lastErr: any;
  for (const url of candidates) {
    try {
      const r = await axios.get(url, {
        headers: authHeaders(),
        timeout: 30_000,
        validateStatus: () => true,
      });
      if (r.status === 200) {
        return r.data as T;
      }
      lastErr = `${r.status} ${JSON.stringify(r.data).slice(0, 150)}`;
    } catch (e: any) {
      lastErr = e?.message || 'unknown';
    }
  }

  throw new Error(`fal_fetch_result_fail (tried ${candidates.length} URLs): ${lastErr}`);
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

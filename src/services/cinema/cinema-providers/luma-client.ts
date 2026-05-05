/**
 * LumaLabs Dream Machine client — TIER 0.5 (FREE 30 gens/month).
 *
 * Free tier: 30 generations/tháng, no watermark, commercial use OK
 * (per Luma 2026 free plan terms).
 *
 * For Sonder Cinema PILOT cron T7 (4 clips × ~6 shots = 24 shots/tháng),
 * Luma free tier gần đủ cover toàn bộ video gen needs.
 *
 * Strategy: track usage in DB, fallback to Wan 2.6 paid when quota hết.
 *
 * API: https://api.lumalabs.ai/dream-machine/v1
 * Setting required: luma_api_key
 */

import axios, { AxiosError } from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import { db, getSetting } from '../../../db';
import { logCost } from '../cinema-cost-tracker';
import type { VideoGenInput, VideoGenResult } from './fal-base';

const API_BASE = 'https://api.lumalabs.ai/dream-machine/v1';
const MEDIA_DIR = '/opt/vp-marketing/data/media';
const CINEMA_VIDEOS_DIR = path.join(MEDIA_DIR, 'cinema-shots');

if (!fs.existsSync(CINEMA_VIDEOS_DIR)) fs.mkdirSync(CINEMA_VIDEOS_DIR, { recursive: true });

// Free tier quota: 30 generations / month
const FREE_TIER_QUOTA = 30;

// ═══════════════════════════════════════════════════════════
// Quota tracking — count Luma generations this calendar month
// ═══════════════════════════════════════════════════════════

function getThisMonthLumaUsage(): number {
  try {
    const startOfMonth = new Date();
    startOfMonth.setUTCDate(1);
    startOfMonth.setUTCHours(0, 0, 0, 0);

    const r = db.prepare(`
      SELECT COUNT(*) as n FROM cinema_costs_log
      WHERE provider = 'kling_fallback'
        AND notes LIKE '%luma%'
        AND created_at >= ?
    `).get(startOfMonth.getTime()) as any;

    return r?.n || 0;
  } catch {
    return 0;
  }
}

export function getLumaQuotaStatus(): { used: number; quota: number; remaining: number; available: boolean } {
  const used = getThisMonthLumaUsage();
  return {
    used,
    quota: FREE_TIER_QUOTA,
    remaining: Math.max(0, FREE_TIER_QUOTA - used),
    available: used < FREE_TIER_QUOTA,
  };
}

// ═══════════════════════════════════════════════════════════
// Auth
// ═══════════════════════════════════════════════════════════

function getLumaApiKey(): string {
  const key = getSetting('luma_api_key') || process.env.LUMA_API_KEY || '';
  if (!key) throw new Error('luma_api_key not configured (free tier yêu cầu signup tại lumalabs.ai/dashboard)');
  return key;
}

function authHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${getLumaApiKey()}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
}

// ═══════════════════════════════════════════════════════════
// Generate
// ═══════════════════════════════════════════════════════════

export interface LumaOpts extends VideoGenInput {
  episode_id?: number;
  shot_id?: number;
}

export async function generateLumaShot(opts: LumaOpts): Promise<VideoGenResult | null> {
  // Pre-flight: check quota
  const quota = getLumaQuotaStatus();
  if (!quota.available) {
    console.log(`[luma] quota exhausted (${quota.used}/${quota.quota}) — fallback to next tier`);
    return null;
  }

  const aspectRatio = opts.aspect_ratio || '9:16';
  const duration = opts.duration_sec || 5;        // Luma default 5s

  const input: any = {
    prompt: opts.prompt,
    aspect_ratio: aspectRatio,
    duration: `${duration}s`,
    model: 'ray-2-flash',                          // Free tier model
  };
  if (opts.reference_image_url) {
    input.keyframes = { frame0: { type: 'image', url: opts.reference_image_url } };
  }

  console.log(`[luma] generating (free tier, ${quota.remaining}/${quota.quota} remaining): "${opts.prompt.slice(0, 80)}..."`);

  let generationId: string;
  try {
    const r = await axios.post(`${API_BASE}/generations`, input, {
      headers: authHeaders(),
      timeout: 60_000,
    });
    generationId = r.data?.id;
    if (!generationId) {
      console.warn(`[luma] no generation_id: ${JSON.stringify(r.data).slice(0, 200)}`);
      return null;
    }
  } catch (e: any) {
    const ax = e as AxiosError<any>;
    const status = ax?.response?.status;
    const msg = ax?.response?.data?.detail || ax?.response?.data?.error || ax?.message;
    if (status === 402 || status === 429 || /quota|limit|exceeded/i.test(String(msg))) {
      console.log(`[luma] quota/rate limit hit (${status}) — fallback`);
      return null;
    }
    console.warn(`[luma] submit fail: ${msg}`);
    return null;
  }

  // Poll until ready (max 4 min — Luma usually 30-90s)
  const start = Date.now();
  const timeoutMs = 240_000;
  let videoUrl: string | undefined;

  while (Date.now() - start < timeoutMs) {
    try {
      const sr = await axios.get(`${API_BASE}/generations/${generationId}`, {
        headers: authHeaders(),
        timeout: 30_000,
      });
      const state = sr.data?.state;
      if (state === 'completed') {
        videoUrl = sr.data?.assets?.video || sr.data?.video?.url;
        break;
      }
      if (state === 'failed') {
        console.warn(`[luma] generation failed: ${sr.data?.failure_reason || 'unknown'}`);
        return null;
      }
    } catch (e: any) {
      console.warn(`[luma] poll err: ${e?.message}`);
    }
    await new Promise((r) => setTimeout(r, 5000));
  }

  if (!videoUrl) {
    console.warn(`[luma] poll timeout after ${timeoutMs}ms`);
    return null;
  }

  // Download to local
  const ts = Date.now();
  const filename = `luma-ep${opts.episode_id || 'X'}-shot${opts.shot_id || 'X'}-${ts}.mp4`;
  const localPath = path.join(CINEMA_VIDEOS_DIR, filename);
  try {
    const dl = await axios.get(videoUrl, {
      responseType: 'arraybuffer',
      timeout: 120_000,
      maxContentLength: 100 * 1024 * 1024,
    });
    fs.writeFileSync(localPath, Buffer.from(dl.data));
  } catch (e: any) {
    console.warn(`[luma] download fail: ${e?.message}`);
    return null;
  }

  console.log(`[luma] ✅ generated free tier (${quota.used + 1}/${quota.quota}) → ${path.basename(localPath)}`);

  // Log $0 cost — but mark notes as "luma" so quota tracker counts
  logCost({
    episode_id: opts.episode_id || null,
    shot_id: opts.shot_id || null,
    provider: 'kling_fallback',                  // tracker enum — repurposed for luma free
    operation: 'video_gen',
    duration_sec: duration,
    units: 1,
    cost_cents: 0,
    request_id: generationId,
    notes: `luma-free-tier-${duration}s (${quota.used + 1}/${quota.quota})`,
  });

  return {
    ok: true,
    video_url: videoUrl,
    local_path: localPath,
    duration_sec: duration,
    cost_cents: 0,
    request_id: generationId,
  };
}

export function estimateLumaCost(): number {
  return 0;       // free tier (when available)
}

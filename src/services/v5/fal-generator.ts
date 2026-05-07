/**
 * V5 FAL.ai generators — image (Flux) + video (Wan 2.2).
 *
 * Reference: skill sonder-content-v5
 *
 * Models:
 *   Image: fal-ai/flux/dev      ~$0.025/image
 *   Video: fal-ai/wan/v2.2/text-to-video  ~$0.10-0.20/clip 5s
 *
 * Reuses existing FAL base layer (cinema-providers/fal-base.ts).
 *
 * Budget cap: $30/month — alert via Telegram if exceeded.
 */

import * as fs from 'fs';
import * as path from 'path';
import axios from 'axios';
import { db } from '../../db';
import {
  falSubmit,
  falPoll,
  falFetchResult,
  getFalApiKey,
} from './fal-base';

const V5_GEN_DIR = '/opt/vp-marketing/data/media/v5-gen';
if (!fs.existsSync(V5_GEN_DIR)) fs.mkdirSync(V5_GEN_DIR, { recursive: true });

const MONTHLY_BUDGET_USD = parseFloat(process.env.V5_FAL_BUDGET_MONTHLY_USD || '30');

export interface V5GenResult {
  ok: boolean;
  local_path?: string;
  remote_url?: string;
  duration_sec?: number;
  cost_usd: number;
  error?: string;
}

/* ───────── Budget tracking ───────── */

function getMonthlySpend(): number {
  const startOfMonth = new Date();
  startOfMonth.setDate(1);
  startOfMonth.setHours(0, 0, 0, 0);
  const r = db.prepare(
    `SELECT COALESCE(SUM(cost_usd), 0) as total
     FROM v5_rendered_clips
     WHERE rendered_at >= ?`,
  ).get(startOfMonth.getTime()) as { total: number };
  return r.total || 0;
}

function checkBudget(estimatedCost: number): { ok: boolean; spent: number; remaining: number } {
  const spent = getMonthlySpend();
  const remaining = MONTHLY_BUDGET_USD - spent;
  return {
    ok: remaining >= estimatedCost,
    spent,
    remaining,
  };
}

/* ───────── Image generation (Flux) ───────── */

export async function generateAIImage(opts: {
  prompt: string;
  aspect_ratio?: '9:16' | '1:1' | '16:9';
  filename_prefix?: string;
}): Promise<V5GenResult> {
  const estimatedCost = 0.025;
  const budget = checkBudget(estimatedCost);
  if (!budget.ok) {
    return {
      ok: false,
      cost_usd: 0,
      error: `Budget exceeded — spent $${budget.spent.toFixed(2)} of $${MONTHLY_BUDGET_USD}`,
    };
  }

  try {
    const ar = opts.aspect_ratio || '9:16';
    const submitResult = await falSubmit('fal-ai/flux/dev', {
      prompt: opts.prompt,
      aspect_ratio: ar,
      num_inference_steps: 28,
      guidance_scale: 3.5,
      num_images: 1,
      output_format: 'jpeg',
    });

    const status = await falPoll(submitResult, 'fal-ai/flux/dev', {
      intervalMs: 3000,
      timeoutMs: 120000,
    });
    if (status.status !== 'COMPLETED') {
      return { ok: false, cost_usd: 0, error: `Flux status: ${status.status}` };
    }

    const result = await falFetchResult<any>(submitResult, 'fal-ai/flux/dev');
    const imageUrl = result.images?.[0]?.url;
    if (!imageUrl) {
      return { ok: false, cost_usd: 0, error: 'no image URL in result' };
    }

    // Download
    const filename = `${opts.filename_prefix || 'v5-img'}-${Date.now()}.jpg`;
    const localPath = path.join(V5_GEN_DIR, filename);
    const dl = await axios.get(imageUrl, { responseType: 'arraybuffer', timeout: 30000 });
    fs.writeFileSync(localPath, Buffer.from(dl.data));

    return {
      ok: true,
      remote_url: imageUrl,
      local_path: localPath,
      cost_usd: estimatedCost,
    };
  } catch (e: any) {
    console.warn('[v5-fal] image gen fail:', e?.response?.data || e.message);
    return { ok: false, cost_usd: 0, error: e?.message || String(e) };
  }
}

/* ───────── Video generation (Wan 2.2) ───────── */

export async function generateAIVideo(opts: {
  prompt: string;
  duration_sec?: 5 | 10;             // Wan supports 5s or 10s
  aspect_ratio?: '9:16' | '16:9' | '1:1';
  filename_prefix?: string;
}): Promise<V5GenResult> {
  const duration = opts.duration_sec || 5;
  const estimatedCost = duration === 10 ? 0.20 : 0.10;
  const budget = checkBudget(estimatedCost);
  if (!budget.ok) {
    return {
      ok: false,
      cost_usd: 0,
      error: `Budget exceeded — spent $${budget.spent.toFixed(2)} of $${MONTHLY_BUDGET_USD}`,
    };
  }

  try {
    // Use Wan 2.6 (proven stable in Cinema pipeline since Apr 2026)
    const MODEL = 'fal-ai/wan/v2.6/text-to-video';
    const submitResult = await falSubmit(MODEL, {
      prompt: opts.prompt,
      duration: duration,
      aspect_ratio: opts.aspect_ratio || '9:16',
      resolution: '720p',
    });

    const status = await falPoll(submitResult, MODEL, {
      intervalMs: 5000,
      timeoutMs: 300000, // 5 min for video
    });
    if (status.status !== 'COMPLETED') {
      return { ok: false, cost_usd: 0, error: `Wan status: ${status.status}` };
    }

    const result = await falFetchResult<any>(submitResult, MODEL);
    const videoUrl = result.video?.url || result.videos?.[0]?.url;
    if (!videoUrl) {
      return { ok: false, cost_usd: 0, error: 'no video URL in result' };
    }

    const filename = `${opts.filename_prefix || 'v5-vid'}-${Date.now()}.mp4`;
    const localPath = path.join(V5_GEN_DIR, filename);
    const dl = await axios.get(videoUrl, { responseType: 'arraybuffer', timeout: 60000 });
    fs.writeFileSync(localPath, Buffer.from(dl.data));

    return {
      ok: true,
      remote_url: videoUrl,
      local_path: localPath,
      duration_sec: duration,
      cost_usd: estimatedCost,
    };
  } catch (e: any) {
    console.warn('[v5-fal] video gen fail:', e?.response?.data || e.message);
    return { ok: false, cost_usd: 0, error: e?.message || String(e) };
  }
}

/* ───────── Public: get monthly budget status ───────── */

export function getBudgetStatus(): { spent: number; budget: number; remaining: number; pct: number } {
  const spent = getMonthlySpend();
  return {
    spent,
    budget: MONTHLY_BUDGET_USD,
    remaining: MONTHLY_BUDGET_USD - spent,
    pct: (spent / MONTHLY_BUDGET_USD) * 100,
  };
}

/** Telegram alert when budget > 80% */
export async function alertIfBudgetCritical(): Promise<void> {
  const b = getBudgetStatus();
  if (b.pct < 80) return;
  try {
    const { notifyAll } = require('../telegram');
    await notifyAll(
      `🚨 V5 FAL budget alert: spent $${b.spent.toFixed(2)} of $${b.budget} (${b.pct.toFixed(0)}%). ` +
      `Remaining $${b.remaining.toFixed(2)}.`,
    );
  } catch {}
}

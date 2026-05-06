/**
 * V5 Orchestrator — full pipeline: generate → render → (admin review) → publish.
 *
 * Reference: skill sonder-content-v5
 *
 * Cron schedule:
 *   17:00 VN — Generate script (3 hooks) + render 3 variants → status='approved' (auto)
 *              hoặc status='rendered' chờ admin review (Phase 1-3)
 *   19:00 VN — Pick best variant (or any approved) → publish FB Reels
 *
 * Auto vs admin review:
 *   - Phase 1-3 (60d đầu): admin review BẮT BUỘC trước publish
 *   - Phase 4+ (sau Gate 3 pass): auto-publish nếu confidence > 80%
 */

import { db, getSetting } from '../../db';
import { generateV5Script } from './script-writer';
import { renderV5Script } from './composer';
import { publishV5Variant } from './publisher';
import type { V5Theme } from './types';

export interface V5PipelineResult {
  ok: boolean;
  step_failed?: string;
  script_id?: number;
  rendered_count?: number;
  total_cost_usd?: number;
  published_post_ids?: string[];
  error?: string;
}

/** Stage A — Generate script + render 3 variants */
export async function runV5GeneratePhase(opts?: {
  theme?: V5Theme;
  generated_by?: string;
}): Promise<V5PipelineResult> {
  console.log('\n══════════════════════════════════════════════════════════════════════');
  console.log('[v5-orch] STAGE A: Generate + Render');
  console.log('══════════════════════════════════════════════════════════════════════');

  const enabled = getSetting('v5_cron_enabled') !== 'false';
  if (!enabled) {
    return { ok: false, step_failed: 'cron_disabled' };
  }

  // 1. Generate script
  const script = await generateV5Script({ theme: opts?.theme, generated_by: opts?.generated_by || 'cron-17h' });
  if (!script) {
    return { ok: false, step_failed: 'script_gen' };
  }

  // 2. Render 3 variants
  const renderResult = await renderV5Script(script.id);
  if (!renderResult.ok) {
    return {
      ok: false,
      step_failed: 'render',
      script_id: script.id,
      error: renderResult.error,
    };
  }

  // 3. Set status — admin review or auto-approve
  const autoPublish = getSetting('v5_auto_publish_enabled') === 'true';
  if (autoPublish) {
    db.prepare(`UPDATE v5_scripts SET status = 'approved' WHERE id = ?`).run(script.id);
  }
  // Else: status stays 'rendered' → admin review needed

  console.log(`[v5-orch] ✅ Stage A complete: script #${script.id}, ${renderResult.variants.length} variants, $${renderResult.total_cost_usd.toFixed(3)}`);
  return {
    ok: true,
    script_id: script.id,
    rendered_count: renderResult.variants.length,
    total_cost_usd: renderResult.total_cost_usd,
  };
}

/** Stage B — Publish next approved variant */
export async function runV5PublishPhase(): Promise<V5PipelineResult> {
  console.log('\n══════════════════════════════════════════════════════════════════════');
  console.log('[v5-orch] STAGE B: Publish');
  console.log('══════════════════════════════════════════════════════════════════════');

  const enabled = getSetting('v5_cron_enabled') !== 'false';
  if (!enabled) {
    return { ok: false, step_failed: 'cron_disabled' };
  }

  // Find next approved script
  const script = db.prepare(
    `SELECT * FROM v5_scripts
     WHERE status = 'approved'
     ORDER BY created_at ASC
     LIMIT 1`,
  ).get() as any;

  if (!script) {
    console.log('[v5-orch] no approved script — skip publish');
    return { ok: false, step_failed: 'no_approved' };
  }

  // Get all 3 variants
  const variants = db.prepare(
    `SELECT * FROM v5_rendered_clips WHERE script_id = ? ORDER BY variant`,
  ).all(script.id) as any[];

  if (variants.length === 0) {
    return { ok: false, step_failed: 'no_variants', script_id: script.id };
  }

  // Phase 1-2: Post all 3 variants to FB (A/B test)
  // Phase 4+: Pick winning variant only
  const platforms = (getSetting('v5_publish_platforms') || 'fb').split(',') as Array<'fb' | 'ig' | 'tiktok' | 'youtube'>;

  const publishedIds: string[] = [];
  for (const variant of variants) {
    const results = await publishV5Variant({
      rendered_clip_id: variant.id,
      platforms,
    });
    for (const r of results) {
      if (r.ok && r.platform_post_id) publishedIds.push(`${r.platform}:${r.platform_post_id}`);
    }

    // Throttle 30s between variants to avoid spam signal
    if (variants.indexOf(variant) < variants.length - 1) {
      await new Promise(r => setTimeout(r, 30000));
    }
  }

  // Mark script as posted
  db.prepare(`UPDATE v5_scripts SET status = 'posted' WHERE id = ?`).run(script.id);

  console.log(`[v5-orch] ✅ Stage B complete: published ${publishedIds.length} posts`);
  return {
    ok: true,
    script_id: script.id,
    published_post_ids: publishedIds,
  };
}

/** Combined pipeline (cron entry) */
export async function runV5Pipeline(): Promise<V5PipelineResult> {
  return runV5GeneratePhase();
}

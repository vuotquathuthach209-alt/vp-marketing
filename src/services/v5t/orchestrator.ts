/**
 * V5T Orchestrator — generate → render → (review) → publish.
 *
 * Reference: skill sonder-content-v5t
 *
 * Cron schedule (DISABLED by default):
 *   T3 (Tue) 10:00 — Carousel
 *   T5 (Thu) 10:00 — Single image story
 *   CN (Sun) 10:00 — Poll/question (community)
 */

import { db, getSetting } from '../../db';
import { generateV5TPost } from './post-writer';
import { composeV5TPost } from './composer';
import { publishV5TPost } from './publisher';
import type { V5TPostType } from './types';

export interface V5TPipelineResult {
  ok: boolean;
  step_failed?: string;
  post_id?: number;
  images_count?: number;
  total_cost_usd?: number;
  fb_post_id?: string;
  error?: string;
}

/** Stage A — Generate post + render images */
export async function runV5TGeneratePhase(opts?: {
  type?: V5TPostType;
  generated_by?: string;
}): Promise<V5TPipelineResult> {
  console.log('\n══════════════════════════════════════════════════════════════════════');
  console.log('[v5t-orch] STAGE A: Generate + Render');
  console.log('══════════════════════════════════════════════════════════════════════');

  if (getSetting('v5t_cron_enabled') === 'false') {
    return { ok: false, step_failed: 'cron_disabled' };
  }

  // 1. Generate post (caption + 3 hooks + hashtags)
  const post = await generateV5TPost({
    type: opts?.type,
    generated_by: opts?.generated_by || 'cron',
  });
  if (!post) return { ok: false, step_failed: 'post_gen' };

  // 2. Compose images
  const composeResult = await composeV5TPost(post.id);
  if (!composeResult.ok) {
    return {
      ok: false,
      step_failed: 'compose',
      post_id: post.id,
      error: composeResult.error,
    };
  }

  // 3. Auto-approve if flag enabled
  if (getSetting('v5t_auto_publish_enabled') === 'true') {
    db.prepare(`UPDATE v5t_posts SET status = 'approved' WHERE id = ?`).run(post.id);
  }

  console.log(`[v5t-orch] ✅ Stage A: post #${post.id} type=${post.type} | ${composeResult.images.length} images | $${composeResult.total_cost_usd.toFixed(3)}`);
  return {
    ok: true,
    post_id: post.id,
    images_count: composeResult.images.length,
    total_cost_usd: composeResult.total_cost_usd,
  };
}

/** Stage B — Publish next approved post */
export async function runV5TPublishPhase(): Promise<V5TPipelineResult> {
  console.log('\n══════════════════════════════════════════════════════════════════════');
  console.log('[v5t-orch] STAGE B: Publish');
  console.log('══════════════════════════════════════════════════════════════════════');

  if (getSetting('v5t_cron_enabled') === 'false') {
    return { ok: false, step_failed: 'cron_disabled' };
  }

  // IDEMPOTENT-PER-DAY: nếu hôm nay (giờ VN) đã post 1 bài rồi → skip (tránh spam).
  // Nhờ vậy cron chạy nhiều mốc (11h/14h/17h) + startup catch-up đều an toàn:
  // mốc nào chạy được trước thì post, các mốc sau no-op. App restart bất kỳ lúc
  // nào trong khung giờ vẫn đảm bảo đăng đúng 1 bài/ngày.
  const nowVN = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Ho_Chi_Minh' }));
  const startOfDayVN = new Date(nowVN.getFullYear(), nowVN.getMonth(), nowVN.getDate(), 0, 0, 0).getTime();
  // startOfDayVN tính theo local-of-server; bù lệch về epoch thật bằng cách so posted_at trực tiếp.
  const postedToday = db.prepare(
    `SELECT COUNT(*) AS n FROM v5t_posts WHERE status = 'posted' AND posted_at >= ?`,
  ).get(startOfDayVN) as { n: number };
  if (postedToday.n > 0) {
    console.log('[v5t-orch] Stage B skip — đã post 1 bài hôm nay (idempotent)');
    return { ok: false, step_failed: 'already_posted_today' };
  }

  const post = db.prepare(
    `SELECT id FROM v5t_posts WHERE status = 'approved' ORDER BY created_at ASC LIMIT 1`,
  ).get() as { id: number } | undefined;

  if (!post) return { ok: false, step_failed: 'no_approved' };

  // Pick variant A by default for first publish (Phase 1)
  // Phase 4+: pick winning variant from past A/B data
  const result = await publishV5TPost({ post_id: post.id, variant: 'a' });

  if (result.ok) {
    console.log(`[v5t-orch] ✅ Stage B: post #${post.id} → fb_post_id=${result.fb_post_id}`);
    return {
      ok: true,
      post_id: post.id,
      fb_post_id: result.fb_post_id,
    };
  } else {
    return {
      ok: false,
      step_failed: 'publish',
      post_id: post.id,
      error: result.error,
    };
  }
}

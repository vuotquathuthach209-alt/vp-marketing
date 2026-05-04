/**
 * Tips Orchestrator — main pipeline cho Daily Tips video.
 *
 * State machine:
 *   draft → generating → script_review → visuals → voice →
 *   composing → qc_review → approved → scheduled → published
 *
 * Flow E2E:
 *   1. createTipsProject(category) — pick idea từ pool
 *   2. generateScriptStep — Claude script + A/B hook variants
 *   3. fetchVisualsStep — Pexels per tip
 *   4. synthesizeVoiceStep — ElevenLabs energetic voice
 *   5. composeStep — FFmpeg với number overlay + BGM
 *   6. publishStep — FB + YouTube Shorts (+ IG TBD)
 *
 * Auto mode (cron T2/T4/T6 19:00): toàn bộ steps tự động.
 * Manual mode (admin UI): có gate review giữa các step.
 */

import * as fs from 'fs';
import * as path from 'path';
import { db } from '../../db';
import {
  TipsCategory,
  HookPattern,
  pickNextIdea,
  markIdeaUsed,
  replenishIdeasIfLow,
  getTodayCategory,
} from './tips-engine';
import { generateTipsScript } from './tips-script-writer';
import { fetchAllTipsVisuals } from './tips-visuals';
import { synthesizeTipsVoice, composeTipsVideo, pickBgmForTips } from './tips-composer';

const MEDIA_DIR = '/opt/vp-marketing/data/media';
const PUBLIC_BASE = 'https://app.sondervn.com';

// ═══════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════

export type TipsStatus =
  | 'draft'
  | 'generating'
  | 'script_review'
  | 'visuals'
  | 'voice'
  | 'composing'
  | 'qc_review'
  | 'approved'
  | 'scheduled'
  | 'published'
  | 'failed';

export interface TipsVideoRow {
  id: number;
  category: TipsCategory;
  topic: string;
  status: TipsStatus;
  hook_text?: string;
  hook_variants_json?: string;
  tips_json?: string;
  cta_text?: string;
  caption_text?: string;
  hashtags_json?: string;
  duration_sec?: number;
  voice_audio_path?: string;
  voice_segments_json?: string;
  bgm_path?: string;
  draft_video_url?: string;
  final_video_url?: string;
  cost_cents: number;
  created_at: number;
  updated_at: number;
}

// ═══════════════════════════════════════════════════════════
// Step 1: Create project (pick idea or use manual topic)
// ═══════════════════════════════════════════════════════════

export interface CreateTipsInput {
  category?: TipsCategory;
  topic?: string;
  hook_pattern?: HookPattern;
  generated_by?: string;
}

export function createTipsProject(input: CreateTipsInput): { id: number; topic: string } | { error: string } {
  let category = input.category;
  let topic = input.topic;
  let hookPattern: HookPattern = input.hook_pattern || 'number';
  let ideaId: number | undefined;

  // Auto mode: get today's category from rotation
  if (!category) {
    const today = getTodayCategory();
    if (!today) return { error: 'Today is not a tips day (cron only T2/T4/T6)' };
    category = today;
  }

  // Auto mode: pick idea from pool
  if (!topic) {
    const idea = pickNextIdea(category);
    if (!idea) return { error: `No unused idea for category ${category}. Run replenishIdeasIfLow() first.` };
    topic = idea.topic;
    hookPattern = idea.hook_pattern || 'number';
    ideaId = idea.id;
  }

  const now = Date.now();
  const result = db.prepare(`
    INSERT INTO tips_videos
      (category, topic, hook_pattern, hook_text, tips_json, status, generated_by, cost_cents, created_at, updated_at)
    VALUES (?, ?, ?, '', '[]', 'draft', ?, 0, ?, ?)
  `).run(category, topic, hookPattern, input.generated_by || 'system', now, now);

  const id = result.lastInsertRowid as number;
  if (ideaId) markIdeaUsed(ideaId, id);

  console.log(`[tips-orch] project #${id} created: [${category}] "${topic.substring(0, 60)}"`);
  return { id, topic };
}

// ═══════════════════════════════════════════════════════════
// Step 2: Generate script (Claude)
// ═══════════════════════════════════════════════════════════

export async function generateScriptStep(projectId: number): Promise<{ ok: boolean; error?: string }> {
  const proj = db.prepare(`SELECT * FROM tips_videos WHERE id = ?`).get(projectId) as TipsVideoRow;
  if (!proj) return { ok: false, error: 'project not found' };
  if (!['draft', 'generating'].includes(proj.status)) {
    return { ok: false, error: `cannot gen script from status=${proj.status}` };
  }

  setStatus(projectId, 'generating');

  try {
    const script = await generateTipsScript({
      topic: proj.topic,
      category: proj.category,
      hook_pattern: (proj as any).hook_pattern || 'number',
    });

    // Persist script
    const now = Date.now();
    db.prepare(`
      UPDATE tips_videos
      SET hook_text = ?, hook_variants_json = ?, tips_json = ?, cta_text = ?,
          caption_text = ?, hashtags_json = ?, duration_sec = ?,
          status = 'script_review', updated_at = ?
      WHERE id = ?
    `).run(
      script.hook_text,
      JSON.stringify(script.hook_variants),
      JSON.stringify(script.tips),
      script.cta_text,
      script.caption_text,
      JSON.stringify(script.hashtags),
      script.total_duration_sec,
      now,
      projectId,
    );

    // Save A/B variants to experiments table
    db.prepare(`DELETE FROM tips_hook_experiments WHERE video_id = ?`).run(projectId);
    db.prepare(`
      INSERT INTO tips_hook_experiments (video_id, variant_key, hook_text, hook_pattern, created_at)
      VALUES (?, 'A', ?, ?, ?), (?, 'B', ?, ?, ?)
    `).run(
      projectId, script.hook_variants.A, script.hook_pattern, now,
      projectId, script.hook_variants.B, 'mixed', now,
    );

    // Cost estimate (Claude tokens)
    const costEstimate = 5;   // ~500 input + ~1500 output @ Claude pricing → ~$0.05 → 5 cents
    db.prepare(`UPDATE tips_videos SET cost_cents = cost_cents + ? WHERE id = ?`).run(costEstimate, projectId);

    console.log(`[tips-orch] project #${projectId} script ready: hook="${script.hook_text.substring(0, 50)}..." 5 tips`);
    return { ok: true };
  } catch (e: any) {
    setStatus(projectId, 'failed', e?.message);
    return { ok: false, error: e?.message };
  }
}

// ═══════════════════════════════════════════════════════════
// Step 3: Fetch visuals
// ═══════════════════════════════════════════════════════════

export async function fetchVisualsStep(projectId: number): Promise<{ ok: boolean; fetched: number; failed: number; error?: string }> {
  const proj = db.prepare(`SELECT * FROM tips_videos WHERE id = ?`).get(projectId) as TipsVideoRow;
  if (!proj) return { ok: false, fetched: 0, failed: 0, error: 'project not found' };
  if (!['script_review', 'visuals'].includes(proj.status)) {
    return { ok: false, fetched: 0, failed: 0, error: `cannot fetch visuals from status=${proj.status}` };
  }

  setStatus(projectId, 'visuals');

  try {
    const tips = JSON.parse(proj.tips_json || '[]');
    if (tips.length !== 5) return { ok: false, fetched: 0, failed: 0, error: `expected 5 tips, got ${tips.length}` };

    const visuals = await fetchAllTipsVisuals(tips);
    const fetched = visuals.filter(v => v).length;
    const failed = visuals.filter(v => !v).length;

    // Update tips_json với visual paths
    for (let i = 0; i < tips.length; i++) {
      if (visuals[i]) {
        tips[i].visual_url = `/media/tips-visuals/${path.basename(visuals[i]!.local_path)}`;
        tips[i].visual_local_path = visuals[i]!.local_path;
      }
    }

    db.prepare(`UPDATE tips_videos SET tips_json = ?, updated_at = ? WHERE id = ?`)
      .run(JSON.stringify(tips), Date.now(), projectId);

    if (failed === 0) {
      // Move to voice gen
      setStatus(projectId, 'voice');
    } else {
      console.warn(`[tips-orch] project #${projectId} ${failed}/5 visuals failed — staying in 'visuals' for retry`);
    }

    console.log(`[tips-orch] project #${projectId} visuals: ${fetched}/5 fetched`);
    return { ok: failed === 0, fetched, failed };
  } catch (e: any) {
    setStatus(projectId, 'failed', e?.message);
    return { ok: false, fetched: 0, failed: 0, error: e?.message };
  }
}

// ═══════════════════════════════════════════════════════════
// Step 4: Synthesize voice
// ═══════════════════════════════════════════════════════════

export async function synthesizeVoiceStep(projectId: number): Promise<{ ok: boolean; error?: string }> {
  const proj = db.prepare(`SELECT * FROM tips_videos WHERE id = ?`).get(projectId) as TipsVideoRow;
  if (!proj) return { ok: false, error: 'project not found' };
  if (!['voice', 'visuals'].includes(proj.status)) {
    return { ok: false, error: `cannot synth voice from status=${proj.status}` };
  }

  setStatus(projectId, 'voice');

  try {
    const tips = JSON.parse(proj.tips_json || '[]');
    const hookVariants = JSON.parse(proj.hook_variants_json || '{}');
    const hashtags = JSON.parse(proj.hashtags_json || '[]');

    // Build TipsScript shape
    const script = {
      category: proj.category,
      topic: proj.topic,
      hook_pattern: (proj as any).hook_pattern || 'number',
      hook_text: proj.hook_text || '',
      hook_variants: hookVariants,
      tips,
      cta_text: proj.cta_text || '',
      caption_text: proj.caption_text || '',
      hashtags,
      total_duration_sec: proj.duration_sec || 75,
    };

    const segments = await synthesizeTipsVoice(script as any, projectId);

    // Persist voice info
    db.prepare(`
      UPDATE tips_videos
      SET voice_segments_json = ?, status = 'composing', updated_at = ?
      WHERE id = ?
    `).run(JSON.stringify(segments.map(s => ({
      audio_path: s.audio_path,
      duration_sec: s.duration_sec,
    }))), Date.now(), projectId);

    // Cost estimate (ElevenLabs)
    const totalChars = segments.reduce((s, x) => s + x.text.length, 0);
    const costCents = Math.ceil((totalChars / 1000) * 30);
    db.prepare(`UPDATE tips_videos SET cost_cents = cost_cents + ? WHERE id = ?`).run(costCents, projectId);

    console.log(`[tips-orch] project #${projectId} voice ready: ${segments.length} segments, ${totalChars} chars, $${(costCents / 100).toFixed(2)}`);
    return { ok: true };
  } catch (e: any) {
    setStatus(projectId, 'failed', e?.message);
    return { ok: false, error: e?.message };
  }
}

// ═══════════════════════════════════════════════════════════
// Step 5: Compose video
// ═══════════════════════════════════════════════════════════

export async function composeStep(projectId: number): Promise<{ ok: boolean; video_url?: string; duration?: number; error?: string }> {
  const proj = db.prepare(`SELECT * FROM tips_videos WHERE id = ?`).get(projectId) as TipsVideoRow;
  if (!proj) return { ok: false, error: 'project not found' };
  if (!['composing', 'voice'].includes(proj.status)) {
    return { ok: false, error: `cannot compose from status=${proj.status}` };
  }

  setStatus(projectId, 'composing');

  try {
    const tips = JSON.parse(proj.tips_json || '[]');
    const hookVariants = JSON.parse(proj.hook_variants_json || '{}');
    const hashtags = JSON.parse(proj.hashtags_json || '[]');
    const voiceSegmentsRaw = JSON.parse(proj.voice_segments_json || '[]');

    // Re-build voice segments với text từ DB
    const voiceSegments = [
      { text: proj.hook_text || '', audio_path: voiceSegmentsRaw[0]?.audio_path, duration_sec: voiceSegmentsRaw[0]?.duration_sec || 5 },
      ...tips.map((t: any, i: number) => ({
        text: t.text,
        audio_path: voiceSegmentsRaw[i + 1]?.audio_path,
        duration_sec: voiceSegmentsRaw[i + 1]?.duration_sec || 12,
      })),
      { text: proj.cta_text || '', audio_path: voiceSegmentsRaw[6]?.audio_path, duration_sec: voiceSegmentsRaw[6]?.duration_sec || 10 },
    ];

    // Re-build visuals from local paths in tips_json
    const visuals = tips.map((t: any, i: number) => {
      if (!t.visual_local_path) return null;
      return {
        tip_index: i,
        type: 'video' as const,
        local_path: t.visual_local_path,
        duration_sec: 0,
        source_id: '',
      };
    });

    if (visuals.some((v: any) => !v)) {
      return { ok: false, error: 'missing visual for some tips' };
    }

    const bgmPath = pickBgmForTips();
    const filename = `tips-${proj.category}-${projectId}-${Date.now()}.mp4`;
    const outputPath = path.join(MEDIA_DIR, filename);

    const composeR = await composeTipsVideo({
      script: {
        category: proj.category,
        topic: proj.topic,
        hook_pattern: (proj as any).hook_pattern || 'number',
        hook_text: proj.hook_text || '',
        hook_variants: hookVariants,
        tips,
        cta_text: proj.cta_text || '',
        caption_text: proj.caption_text || '',
        hashtags,
        total_duration_sec: proj.duration_sec || 75,
      } as any,
      voiceSegments: voiceSegments as any,
      visuals: visuals as any,
      bgmPath,
      outputPath,
    });

    const videoUrl = `/media/${filename}`;

    db.prepare(`
      UPDATE tips_videos
      SET draft_video_url = ?, bgm_path = ?, status = 'qc_review', updated_at = ?
      WHERE id = ?
    `).run(videoUrl, bgmPath || null, Date.now(), projectId);

    console.log(`[tips-orch] project #${projectId} composed: ${(composeR.size_bytes / 1024 / 1024).toFixed(1)}MB ${composeR.duration.toFixed(1)}s → ${videoUrl}`);
    return { ok: true, video_url: videoUrl, duration: composeR.duration };
  } catch (e: any) {
    setStatus(projectId, 'failed', e?.message);
    return { ok: false, error: e?.message };
  }
}

// ═══════════════════════════════════════════════════════════
// Step 6: Publish (reuse story-to-video publishers)
// ═══════════════════════════════════════════════════════════

export async function publishStep(projectId: number, opts: { skipFB?: boolean; skipYT?: boolean } = {}): Promise<{ ok: boolean; published_to: any; error?: string }> {
  const proj = db.prepare(`SELECT * FROM tips_videos WHERE id = ?`).get(projectId) as TipsVideoRow;
  if (!proj) return { ok: false, published_to: {}, error: 'project not found' };
  if (!['approved', 'qc_review'].includes(proj.status)) {
    return { ok: false, published_to: {}, error: `cannot publish from status=${proj.status}` };
  }

  const videoUrl = proj.final_video_url || proj.draft_video_url;
  if (!videoUrl) return { ok: false, published_to: {}, error: 'no video file' };

  // Use absolute path
  const localPath = path.join(MEDIA_DIR, path.basename(videoUrl));
  const publicUrl = `${PUBLIC_BASE}${videoUrl}`;

  if (!fs.existsSync(localPath)) {
    return { ok: false, published_to: {}, error: `video file not found: ${localPath}` };
  }

  const caption = (proj.caption_text || '') + '\n\n' + (JSON.parse(proj.hashtags_json || '[]') as string[]).join(' ');
  const publishedTo: any = { facebook: [], youtube: null, instagram: null };

  // ─── A. Publish FB (multi-page) — reuse story-to-video publish pattern ───
  if (!opts.skipFB) {
    try {
      const axios = require('axios');
      const pages = db.prepare(`SELECT id, fb_page_id, access_token, name, hotel_id FROM pages`).all() as any[];

      for (let i = 0; i < pages.length; i++) {
        const p = pages[i];
        try {
          const resp = await axios.post(
            `https://graph.facebook.com/v18.0/${p.fb_page_id}/videos`,
            null,
            {
              params: { file_url: publicUrl, description: caption, access_token: p.access_token },
              timeout: 240_000,
            }
          );
          publishedTo.facebook.push({
            page_id: p.id,
            page_name: p.name,
            post_id: resp.data?.id,
            published_at: Date.now(),
          });
          console.log(`[tips-orch] ✓ FB ${p.name}: ${resp.data?.id}`);
        } catch (e: any) {
          const err = e?.response?.data?.error?.message || e?.message;
          publishedTo.facebook.push({ page_id: p.id, error: err });
          console.warn(`[tips-orch] ✗ FB ${p.name}: ${err}`);
        }
        if (i < pages.length - 1) await new Promise(r => setTimeout(r, 30_000));
      }
    } catch (e: any) {
      console.warn('[tips-orch] FB publish fatal:', e?.message);
    }
  }

  // ─── B. Publish YouTube Shorts ───
  if (!opts.skipYT) {
    try {
      const { getSetting } = require('../../db');
      if (getSetting('enable_publish_youtube') === '1') {
        const { publishYoutubeShort } = await import('../youtube-publisher');
        const ytTitle = `${proj.topic}`.slice(0, 95);
        const tagsArr = ['tips', 'travel', 'vietnam', 'sonder', proj.category];
        const ytR = await publishYoutubeShort({
          videoPath: localPath,
          title: ytTitle,
          description: caption,
          tags: tagsArr,
          privacyStatus: 'public',
        });
        if (ytR.ok) {
          publishedTo.youtube = { video_id: ytR.video_id, url: ytR.url, published_at: Date.now() };
          console.log(`[tips-orch] ✓ YouTube: ${ytR.url}`);
        } else {
          publishedTo.youtube = { error: ytR.error };
        }
      }
    } catch (e: any) {
      publishedTo.youtube = { error: e?.message };
    }
  }

  // Update DB
  const fbPostIds = publishedTo.facebook.map((f: any) => f.post_id).filter(Boolean);
  db.prepare(`
    UPDATE tips_videos
    SET final_video_url = ?, fb_post_ids = ?, yt_video_id = ?, yt_video_url = ?,
        status = 'published', published_at = ?, updated_at = ?
    WHERE id = ?
  `).run(
    videoUrl,
    JSON.stringify(fbPostIds),
    publishedTo.youtube?.video_id || null,
    publishedTo.youtube?.url || null,
    Date.now(),
    Date.now(),
    projectId,
  );

  return { ok: true, published_to: publishedTo };
}

// ═══════════════════════════════════════════════════════════
// FULL AUTO MODE — run entire pipeline (cron)
// ═══════════════════════════════════════════════════════════

export interface AutoRunResult {
  ok: boolean;
  project_id?: number;
  category?: TipsCategory;
  topic?: string;
  steps_completed: string[];
  duration_sec?: number;
  published_to?: any;
  error?: string;
}

export async function runDailyTipsAuto(opts: { skipPublish?: boolean } = {}): Promise<AutoRunResult> {
  const steps: string[] = [];

  console.log('[tips-orch] auto run starting...');

  // 0. Check today is a tips day
  const category = getTodayCategory();
  if (!category) {
    return { ok: false, steps_completed: steps, error: 'today_not_tips_day' };
  }

  // 0b. Replenish ideas if needed
  await replenishIdeasIfLow();
  steps.push('ideas_replenished');

  // 1. Create project
  const created = createTipsProject({ category, generated_by: 'cron' });
  if ('error' in created) {
    return { ok: false, steps_completed: steps, error: created.error };
  }
  steps.push(`project_created:${created.id}`);
  const pid = created.id;

  // 2. Generate script
  const scriptR = await generateScriptStep(pid);
  if (!scriptR.ok) {
    return { ok: false, project_id: pid, category, steps_completed: steps, error: 'script: ' + scriptR.error };
  }
  steps.push('script_generated');

  // 3. Fetch visuals
  const visualsR = await fetchVisualsStep(pid);
  if (!visualsR.ok) {
    return { ok: false, project_id: pid, category, steps_completed: steps, error: 'visuals: ' + visualsR.error };
  }
  steps.push(`visuals:${visualsR.fetched}/5`);

  // 4. Voice
  const voiceR = await synthesizeVoiceStep(pid);
  if (!voiceR.ok) {
    return { ok: false, project_id: pid, category, steps_completed: steps, error: 'voice: ' + voiceR.error };
  }
  steps.push('voice_synthesized');

  // 5. Compose
  const composeR = await composeStep(pid);
  if (!composeR.ok) {
    return { ok: false, project_id: pid, category, steps_completed: steps, error: 'compose: ' + composeR.error };
  }
  steps.push(`composed:${composeR.duration?.toFixed(1)}s`);

  // 6. Auto-approve (skip review for cron mode) + Publish
  if (opts.skipPublish) {
    setStatus(pid, 'approved');
    return {
      ok: true,
      project_id: pid,
      category,
      topic: created.topic,
      steps_completed: steps,
      duration_sec: composeR.duration,
    };
  }

  setStatus(pid, 'approved');
  const publishR = await publishStep(pid);
  steps.push('published');

  return {
    ok: publishR.ok,
    project_id: pid,
    category,
    topic: created.topic,
    steps_completed: steps,
    duration_sec: composeR.duration,
    published_to: publishR.published_to,
  };
}

// ═══════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════

function setStatus(projectId: number, status: TipsStatus, errorMsg?: string): void {
  try {
    if (errorMsg) {
      db.prepare(`UPDATE tips_videos SET status = ?, error_log = ?, updated_at = ? WHERE id = ?`)
        .run(status, errorMsg, Date.now(), projectId);
    } else {
      db.prepare(`UPDATE tips_videos SET status = ?, updated_at = ? WHERE id = ?`)
        .run(status, Date.now(), projectId);
    }
  } catch {}
}

export function getProject(id: number): TipsVideoRow | null {
  try {
    return db.prepare(`SELECT * FROM tips_videos WHERE id = ?`).get(id) as TipsVideoRow;
  } catch { return null; }
}

export function listProjects(opts: { status?: TipsStatus; limit?: number } = {}): TipsVideoRow[] {
  try {
    if (opts.status) {
      return db.prepare(`SELECT * FROM tips_videos WHERE status = ? ORDER BY created_at DESC LIMIT ?`)
        .all(opts.status, opts.limit || 50) as TipsVideoRow[];
    }
    return db.prepare(`SELECT * FROM tips_videos ORDER BY created_at DESC LIMIT ?`)
      .all(opts.limit || 50) as TipsVideoRow[];
  } catch { return []; }
}

export function approveStep(projectId: number, gate: 'gate1' | 'gate3'): { ok: boolean; error?: string } {
  try {
    const col = gate === 'gate1' ? 'reviewed_at_gate1' : 'reviewed_at_gate3';
    const nextStatus = gate === 'gate1' ? 'visuals' : 'approved';
    db.prepare(`UPDATE tips_videos SET status = ?, ${col} = ?, updated_at = ? WHERE id = ?`)
      .run(nextStatus, Date.now(), Date.now(), projectId);
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e?.message };
  }
}

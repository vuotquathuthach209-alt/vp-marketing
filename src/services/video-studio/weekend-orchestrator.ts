/**
 * Weekend Orchestrator — main pipeline cho Weekend Special.
 *
 * State machine: same với tips-orchestrator
 *   draft → generating → script_review → visuals → voice → composing → qc_review → approved → scheduled → published
 *
 * Auto cron Sun 19:00 VN.
 */

import * as fs from 'fs';
import * as path from 'path';
import { db } from '../../db';
import {
  WeekendThemeType,
  getThemeForToday,
  pickSubjectForTheme,
  getISOWeek,
  getSundayOfMonth,
  logThemeRun,
  getThisWeekLog,
  THEME_METADATA,
} from './weekend-engine';
import { generateWeekendScript } from './weekend-script-writer';
import { fetchAllWeekendVisuals, generateThumbnail } from './weekend-visuals';
import { synthesizeWeekendVoice, composeWeekendVideo, pickBgmForTheme } from './weekend-composer';

const MEDIA_DIR = '/opt/vp-marketing/data/media';
const PUBLIC_BASE = 'https://app.sondervn.com';

// ═══════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════

export type WeekendStatus =
  | 'draft' | 'generating' | 'script_review' | 'visuals' | 'voice'
  | 'composing' | 'qc_review' | 'approved' | 'scheduled' | 'published' | 'failed';

export interface WeekendVideoRow {
  id: number;
  theme_type: WeekendThemeType;
  theme_subject: string;
  topic: string;
  status: WeekendStatus;
  hook_text?: string;
  cta_text?: string;
  caption_text?: string;
  hashtags_json?: string;
  script_json?: string;
  scenes_count?: number;
  duration_sec?: number;
  voice_segments_json?: string;
  visuals_json?: string;
  bgm_path?: string;
  draft_video_url?: string;
  final_video_url?: string;
  thumbnail_url?: string;
  cost_cents: number;
  generated_by?: string;
  created_at: number;
  updated_at: number;
}

// ═══════════════════════════════════════════════════════════
// Step 1: Create project
// ═══════════════════════════════════════════════════════════

export interface CreateWeekendInput {
  theme_type?: WeekendThemeType;
  theme_subject?: string;
  generated_by?: string;
}

export function createWeekendProject(input: CreateWeekendInput): { id: number; theme_type: WeekendThemeType; theme_subject: string } | { error: string } {
  // Auto mode: pick today's theme
  let theme = input.theme_type;
  if (!theme) {
    const todayTheme = getThemeForToday();
    if (!todayTheme) return { error: 'Today is not Sunday — weekend video runs CN only' };
    theme = todayTheme.theme;
  }

  const subject = input.theme_subject || pickSubjectForTheme(theme);
  const meta = THEME_METADATA[theme];

  const now = Date.now();
  const result = db.prepare(`
    INSERT INTO weekend_videos
      (theme_type, theme_subject, topic, status, script_json, scenes_count, duration_sec, generated_by, cost_cents, created_at, updated_at)
    VALUES (?, ?, ?, 'draft', '{}', ?, ?, ?, 0, ?, ?)
  `).run(
    theme,
    subject,
    `${meta.label}: ${subject}`,
    meta.scenes_target,
    meta.duration_target_sec,
    input.generated_by || 'system',
    now, now,
  );

  const id = result.lastInsertRowid as number;
  console.log(`[weekend-orch] project #${id} created: theme=${theme} subject="${subject}"`);
  return { id, theme_type: theme, theme_subject: subject };
}

// ═══════════════════════════════════════════════════════════
// Step 2: Generate script
// ═══════════════════════════════════════════════════════════

export async function generateScriptStep(projectId: number): Promise<{ ok: boolean; error?: string }> {
  const proj = db.prepare(`SELECT * FROM weekend_videos WHERE id = ?`).get(projectId) as WeekendVideoRow;
  if (!proj) return { ok: false, error: 'project not found' };
  if (!['draft', 'generating'].includes(proj.status)) {
    return { ok: false, error: `cannot gen script from status=${proj.status}` };
  }

  setStatus(projectId, 'generating');

  try {
    const script = await generateWeekendScript({
      theme: proj.theme_type,
      subject: proj.theme_subject,
    });

    const now = Date.now();
    db.prepare(`
      UPDATE weekend_videos
      SET hook_text = ?, cta_text = ?, caption_text = ?, hashtags_json = ?,
          script_json = ?, scenes_count = ?, duration_sec = ?,
          status = 'script_review', updated_at = ?
      WHERE id = ?
    `).run(
      script.hook_text,
      script.cta_text,
      script.caption_text,
      JSON.stringify(script.hashtags),
      JSON.stringify({
        scenes: script.scenes,
        thumbnail_prompt: script.thumbnail_prompt,
      }),
      script.scenes.length,
      script.total_duration_sec,
      now,
      projectId,
    );

    // Cost: ~$0.08 (4000 tokens × Claude Sonnet pricing)
    db.prepare(`UPDATE weekend_videos SET cost_cents = cost_cents + 8 WHERE id = ?`).run(projectId);

    console.log(`[weekend-orch] project #${projectId} script ready: ${script.scenes.length} scenes, ${script.total_duration_sec}s`);
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
  const proj = db.prepare(`SELECT * FROM weekend_videos WHERE id = ?`).get(projectId) as WeekendVideoRow;
  if (!proj) return { ok: false, fetched: 0, failed: 0, error: 'project not found' };
  if (!['script_review', 'visuals'].includes(proj.status)) {
    return { ok: false, fetched: 0, failed: 0, error: `cannot fetch visuals from status=${proj.status}` };
  }

  setStatus(projectId, 'visuals');

  try {
    const scriptObj = JSON.parse(proj.script_json || '{}');
    const scenes = scriptObj.scenes || [];
    if (scenes.length === 0) return { ok: false, fetched: 0, failed: 0, error: 'no scenes' };

    const visuals = await fetchAllWeekendVisuals(scenes);
    const fetched = visuals.filter(v => v).length;
    const failed = visuals.filter(v => !v).length;

    // Save visuals_json
    const visualsForDb = visuals.map((v, i) => v ? {
      scene_idx: i,
      type: v.type,
      local_path: v.local_path,
      natural_duration_sec: v.natural_duration_sec,
      relative_url: `/media/weekend-visuals/${path.basename(v.local_path)}`,
    } : null);

    db.prepare(`UPDATE weekend_videos SET visuals_json = ?, updated_at = ? WHERE id = ?`)
      .run(JSON.stringify(visualsForDb), Date.now(), projectId);

    if (failed === 0) {
      setStatus(projectId, 'voice');
    } else {
      console.warn(`[weekend-orch] project #${projectId} ${failed}/${visuals.length} visuals failed`);
    }

    console.log(`[weekend-orch] project #${projectId} visuals: ${fetched}/${visuals.length} fetched (AI=${visuals.filter(v => v?.type === 'ai').length}, stock=${visuals.filter(v => v?.type === 'stock').length})`);

    // Generate thumbnail (parallel, non-blocking)
    if (scriptObj.thumbnail_prompt) {
      generateThumbnail(scriptObj.thumbnail_prompt).then(thumbPath => {
        if (thumbPath) {
          db.prepare(`UPDATE weekend_videos SET thumbnail_url = ? WHERE id = ?`)
            .run(`/media/${path.basename(thumbPath)}`, projectId);
        }
      }).catch(() => {});
    }

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
  const proj = db.prepare(`SELECT * FROM weekend_videos WHERE id = ?`).get(projectId) as WeekendVideoRow;
  if (!proj) return { ok: false, error: 'project not found' };
  if (!['voice', 'visuals'].includes(proj.status)) {
    return { ok: false, error: `cannot synth voice from status=${proj.status}` };
  }

  setStatus(projectId, 'voice');

  try {
    const scriptObj = JSON.parse(proj.script_json || '{}');
    const scenes = scriptObj.scenes || [];

    const segments = await synthesizeWeekendVoice(scenes, proj.theme_type, projectId);

    db.prepare(`
      UPDATE weekend_videos
      SET voice_segments_json = ?, status = 'composing', updated_at = ?
      WHERE id = ?
    `).run(
      JSON.stringify(segments),
      Date.now(),
      projectId,
    );

    // Cost ElevenLabs
    const totalChars = scenes.reduce((s: number, sc: any) => s + (sc.text?.length || 0), 0);
    const costCents = Math.ceil((totalChars / 1000) * 30);
    db.prepare(`UPDATE weekend_videos SET cost_cents = cost_cents + ? WHERE id = ?`).run(costCents, projectId);

    console.log(`[weekend-orch] project #${projectId} voice ready: ${segments.length} segments, ${totalChars} chars`);
    return { ok: true };
  } catch (e: any) {
    setStatus(projectId, 'failed', e?.message);
    return { ok: false, error: e?.message };
  }
}

// ═══════════════════════════════════════════════════════════
// Step 5: Compose
// ═══════════════════════════════════════════════════════════

export async function composeStep(projectId: number): Promise<{ ok: boolean; video_url?: string; duration?: number; error?: string }> {
  const proj = db.prepare(`SELECT * FROM weekend_videos WHERE id = ?`).get(projectId) as WeekendVideoRow;
  if (!proj) return { ok: false, error: 'project not found' };
  if (!['composing', 'voice'].includes(proj.status)) {
    return { ok: false, error: `cannot compose from status=${proj.status}` };
  }

  setStatus(projectId, 'composing');

  try {
    const scriptObj = JSON.parse(proj.script_json || '{}');
    const scenes = scriptObj.scenes || [];
    const visuals = JSON.parse(proj.visuals_json || '[]');
    const voiceSegments = JSON.parse(proj.voice_segments_json || '[]');

    if (scenes.length === 0) throw new Error('no scenes');
    if (visuals.length !== scenes.length) throw new Error(`visuals count mismatch: ${visuals.length} vs ${scenes.length}`);
    if (voiceSegments.length !== scenes.length) throw new Error(`voice count mismatch: ${voiceSegments.length} vs ${scenes.length}`);

    const bgmPath = pickBgmForTheme(proj.theme_type);
    const filename = `weekend-${proj.theme_type}-${projectId}-${Date.now()}.mp4`;
    const outputPath = path.join(MEDIA_DIR, filename);

    const composeR = await composeWeekendVideo({
      scenes,
      visuals: visuals.map((v: any) => ({ ...v, scene_idx: v.scene_idx, local_path: v.local_path, type: v.type, natural_duration_sec: v.natural_duration_sec })),
      voiceSegments,
      bgmPath,
      outputPath,
    });

    const videoUrl = `/media/${filename}`;
    db.prepare(`
      UPDATE weekend_videos
      SET draft_video_url = ?, bgm_path = ?, status = 'qc_review', updated_at = ?
      WHERE id = ?
    `).run(videoUrl, bgmPath || null, Date.now(), projectId);

    console.log(`[weekend-orch] project #${projectId} composed: ${(composeR.size_bytes / 1024 / 1024).toFixed(1)}MB ${composeR.duration_sec.toFixed(1)}s → ${videoUrl}`);
    return { ok: true, video_url: videoUrl, duration: composeR.duration_sec };
  } catch (e: any) {
    setStatus(projectId, 'failed', e?.message);
    return { ok: false, error: e?.message };
  }
}

// ═══════════════════════════════════════════════════════════
// Step 6: Publish (reuse story-to-video FB + YouTube)
// ═══════════════════════════════════════════════════════════

export async function publishStep(projectId: number, opts: { skipFB?: boolean; skipYT?: boolean } = {}): Promise<{ ok: boolean; published_to: any; error?: string }> {
  const proj = db.prepare(`SELECT * FROM weekend_videos WHERE id = ?`).get(projectId) as WeekendVideoRow;
  if (!proj) return { ok: false, published_to: {}, error: 'project not found' };
  if (!['approved', 'qc_review'].includes(proj.status)) {
    return { ok: false, published_to: {}, error: `cannot publish from status=${proj.status}` };
  }

  const videoUrl = proj.final_video_url || proj.draft_video_url;
  if (!videoUrl) return { ok: false, published_to: {}, error: 'no video' };

  const localPath = path.join(MEDIA_DIR, path.basename(videoUrl));
  const publicUrl = `${PUBLIC_BASE}${videoUrl}`;
  if (!fs.existsSync(localPath)) return { ok: false, published_to: {}, error: 'video file not found' };

  const hashtags = JSON.parse(proj.hashtags_json || '[]') as string[];
  const caption = (proj.caption_text || '') + '\n\n' + hashtags.join(' ');
  const publishedTo: any = { facebook: [], youtube: null };

  // FB multi-page
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
          console.log(`[weekend-orch] ✓ FB ${p.name}: ${resp.data?.id}`);
        } catch (e: any) {
          publishedTo.facebook.push({ page_id: p.id, error: e?.response?.data?.error?.message || e?.message });
        }
        if (i < pages.length - 1) await new Promise(r => setTimeout(r, 30_000));
      }
    } catch (e: any) {
      console.warn('[weekend-orch] FB fatal:', e?.message);
    }
  }

  // YouTube Shorts
  if (!opts.skipYT) {
    try {
      const { getSetting } = require('../../db');
      if (getSetting('enable_publish_youtube') === '1') {
        const { publishYoutubeShort } = await import('../youtube-publisher');
        const ytTitle = `${proj.theme_subject}`.slice(0, 95);
        const ytR = await publishYoutubeShort({
          videoPath: localPath,
          title: ytTitle,
          description: caption,
          tags: ['weekend', 'sonder', 'travel', 'vietnam', proj.theme_type],
          privacyStatus: 'public',
        });
        if (ytR.ok) {
          publishedTo.youtube = { video_id: ytR.video_id, url: ytR.url };
          console.log(`[weekend-orch] ✓ YouTube: ${ytR.url}`);
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
    UPDATE weekend_videos
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
// FULL AUTO MODE — Sun cron
// ═══════════════════════════════════════════════════════════

export interface WeekendAutoResult {
  ok: boolean;
  project_id?: number;
  theme_type?: WeekendThemeType;
  theme_subject?: string;
  steps_completed: string[];
  duration_sec?: number;
  published_to?: any;
  error?: string;
  skipped?: string;
}

export async function runWeekendAuto(opts: { skipPublish?: boolean } = {}): Promise<WeekendAutoResult> {
  const steps: string[] = [];
  console.log('[weekend-orch] auto run starting...');

  // 0. Check today is Sunday
  const todayTheme = getThemeForToday();
  if (!todayTheme) {
    return { ok: false, steps_completed: steps, skipped: 'not_sunday', error: 'today is not Sunday' };
  }

  // 0b. Already done this week?
  const thisWeek = getThisWeekLog();
  if (thisWeek?.video_id && thisWeek?.status === 'published') {
    return { ok: true, steps_completed: steps, skipped: 'already_published_this_week', error: undefined };
  }

  // 1. Pick subject + create
  const subject = pickSubjectForTheme(todayTheme.theme);
  const created = createWeekendProject({ theme_type: todayTheme.theme, theme_subject: subject, generated_by: 'cron' });
  if ('error' in created) return { ok: false, steps_completed: steps, error: created.error };
  steps.push(`project_created:${created.id}`);
  const pid = created.id;

  // Log theme run
  const sundayInfo = getSundayOfMonth();
  logThemeRun({
    isoWeek: getISOWeek(),
    sundayDate: sundayInfo.sundayDate.getTime(),
    sundayNum: todayTheme.sundayNum,
    themeType: todayTheme.theme,
    themeSubject: subject,
    videoId: pid,
    status: 'planned',
  });

  // 2. Script
  const scriptR = await generateScriptStep(pid);
  if (!scriptR.ok) return { ok: false, project_id: pid, theme_type: todayTheme.theme, theme_subject: subject, steps_completed: steps, error: 'script: ' + scriptR.error };
  steps.push('script_generated');

  // 3. Visuals
  const visualsR = await fetchVisualsStep(pid);
  if (!visualsR.ok) return { ok: false, project_id: pid, theme_type: todayTheme.theme, theme_subject: subject, steps_completed: steps, error: `visuals: ${visualsR.error || `${visualsR.failed}/${visualsR.fetched + visualsR.failed} failed`}` };
  steps.push(`visuals:${visualsR.fetched}`);

  // 4. Voice
  const voiceR = await synthesizeVoiceStep(pid);
  if (!voiceR.ok) return { ok: false, project_id: pid, theme_type: todayTheme.theme, theme_subject: subject, steps_completed: steps, error: 'voice: ' + voiceR.error };
  steps.push('voice_synthesized');

  // 5. Compose
  const composeR = await composeStep(pid);
  if (!composeR.ok) return { ok: false, project_id: pid, theme_type: todayTheme.theme, theme_subject: subject, steps_completed: steps, error: 'compose: ' + composeR.error };
  steps.push(`composed:${composeR.duration?.toFixed(1)}s`);

  if (opts.skipPublish) {
    setStatus(pid, 'approved');
    return {
      ok: true,
      project_id: pid,
      theme_type: todayTheme.theme,
      theme_subject: subject,
      steps_completed: steps,
      duration_sec: composeR.duration,
    };
  }

  // 6. Auto-approve + Publish
  setStatus(pid, 'approved');
  const publishR = await publishStep(pid);
  steps.push('published');

  // Update theme log
  logThemeRun({
    isoWeek: getISOWeek(),
    sundayDate: sundayInfo.sundayDate.getTime(),
    sundayNum: todayTheme.sundayNum,
    themeType: todayTheme.theme,
    themeSubject: subject,
    videoId: pid,
    status: publishR.ok ? 'published' : 'failed',
  });

  return {
    ok: publishR.ok,
    project_id: pid,
    theme_type: todayTheme.theme,
    theme_subject: subject,
    steps_completed: steps,
    duration_sec: composeR.duration,
    published_to: publishR.published_to,
  };
}

// ═══════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════

function setStatus(projectId: number, status: WeekendStatus, errorMsg?: string): void {
  try {
    if (errorMsg) {
      db.prepare(`UPDATE weekend_videos SET status = ?, error_log = ?, updated_at = ? WHERE id = ?`)
        .run(status, errorMsg, Date.now(), projectId);
    } else {
      db.prepare(`UPDATE weekend_videos SET status = ?, updated_at = ? WHERE id = ?`)
        .run(status, Date.now(), projectId);
    }
  } catch {}
}

export function getProject(id: number): WeekendVideoRow | null {
  try {
    return db.prepare(`SELECT * FROM weekend_videos WHERE id = ?`).get(id) as WeekendVideoRow;
  } catch { return null; }
}

export function listProjects(opts: { status?: WeekendStatus; theme?: WeekendThemeType; limit?: number } = {}): WeekendVideoRow[] {
  try {
    if (opts.status && opts.theme) {
      return db.prepare(`SELECT * FROM weekend_videos WHERE status = ? AND theme_type = ? ORDER BY created_at DESC LIMIT ?`)
        .all(opts.status, opts.theme, opts.limit || 50) as WeekendVideoRow[];
    }
    if (opts.status) {
      return db.prepare(`SELECT * FROM weekend_videos WHERE status = ? ORDER BY created_at DESC LIMIT ?`)
        .all(opts.status, opts.limit || 50) as WeekendVideoRow[];
    }
    if (opts.theme) {
      return db.prepare(`SELECT * FROM weekend_videos WHERE theme_type = ? ORDER BY created_at DESC LIMIT ?`)
        .all(opts.theme, opts.limit || 50) as WeekendVideoRow[];
    }
    return db.prepare(`SELECT * FROM weekend_videos ORDER BY created_at DESC LIMIT ?`)
      .all(opts.limit || 50) as WeekendVideoRow[];
  } catch { return []; }
}

export function approveStep(projectId: number, gate: 'gate1' | 'gate3'): { ok: boolean; error?: string } {
  try {
    const col = gate === 'gate1' ? 'reviewed_at_gate1' : 'reviewed_at_gate3';
    const nextStatus = gate === 'gate1' ? 'visuals' : 'approved';
    db.prepare(`UPDATE weekend_videos SET status = ?, ${col} = ?, updated_at = ? WHERE id = ?`)
      .run(nextStatus, Date.now(), Date.now(), projectId);
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e?.message };
  }
}

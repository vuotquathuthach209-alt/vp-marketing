/**
 * Cinema Orchestrator — full pipeline cho Sonder Cinema 5-7 phút.
 *
 * Pipeline (1 episode):
 *   1. createCinemaEpisode (insert row, status='draft')
 *   2. generateScriptStep (Claude, 18-23 shots)
 *   3. buildAndPersistStoryboard (route shots → providers, cost estimate, budget check)
 *   4. ABORT if budget cap exceeded
 *   5. synthesizeVoiceStep (ElevenLabs Ngân clone per shot)
 *   6. generateShotsStep (Veo/Hailuo/Seedance/Hedra in parallel batches of 4)
 *   7. composeStep (FFmpeg stitch + grade + watermark + BGM + teaser cut)
 *   8. reconcileEpisodeCost (sum actual)
 *   9. status='qc_review' (default — admin review) hoặc 'approved' (autoApprove cron mode)
 *
 * Reference skill: sonder-cinema
 */

import * as fs from 'fs';
import * as path from 'path';
import { db } from '../../db';
import {
  generateCinemaScript,
  type CinemaScript,
  type GenerateScriptOpts,
} from './cinema-script-writer';
import {
  buildStoryboard,
  persistStoryboard,
  persistStoryboardToEpisode,
  type Storyboard,
  type StoryboardShot,
} from './cinema-storyboard';
import {
  synthesizeCinemaVoice,
  getVoiceForShot,
  type CinemaVoiceSegment,
} from './cinema-voice';
import {
  composeCinemaVideo,
  pickBgmForCinema,
  buildCinemaOutputPath,
  type CinemaShotMaterial,
  type ComposeResult,
} from './cinema-composer';
import {
  generateVeoShot,
  generateHailuoShot,
  generateSeedanceShot,
  generateHedraShot,
  type VideoGenResult,
} from './cinema-providers';
import {
  reconcileEpisodeCost,
  logCost,
} from './cinema-cost-tracker';

const PUBLIC_BASE = 'https://app.sondervn.com';

// ═══════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════

export type CinemaStatus =
  | 'draft' | 'generating_script' | 'storyboard'
  | 'budget_exceeded'
  | 'synthesizing_voice' | 'generating_video'
  | 'composing' | 'qc_review' | 'approved'
  | 'published' | 'failed';

// ═══════════════════════════════════════════════════════════
// Cinema series bucket — 1 master "Sonder Cinema" series
// ═══════════════════════════════════════════════════════════

const CINEMA_SERIES_SLUG = 'sonder-cinema-master';

function ensureCinemaSeries(): number {
  const existing = db.prepare(`SELECT id FROM cinema_series WHERE series_slug = ?`).get(CINEMA_SERIES_SLUG) as any;
  if (existing) return existing.id;

  const r = db.prepare(`
    INSERT INTO cinema_series (series_slug, title, description, status, created_at)
    VALUES (?, ?, ?, 'active', ?)
  `).run(
    CINEMA_SERIES_SLUG,
    'Sonder Cinema',
    'Long-form 5-7 phút premium. 1 tập/tuần T7 20:30 VN. Multi-act cinematic storytelling.',
    Date.now(),
  );
  console.log(`[cinema-orch] master series created id=${r.lastInsertRowid}`);
  return r.lastInsertRowid as number;
}

function getNextEpisodeNo(seriesId: number): number {
  const row = db.prepare(`SELECT MAX(episode_no) as max_no FROM cinema_episodes WHERE series_id = ?`).get(seriesId) as any;
  return (row?.max_no || 0) + 1;
}

// ═══════════════════════════════════════════════════════════
// Status helpers
// ═══════════════════════════════════════════════════════════

function setStatus(episodeId: number, status: CinemaStatus, error?: string) {
  db.prepare(`UPDATE cinema_episodes SET status = ?, error = ?, updated_at = ? WHERE id = ?`)
    .run(status, error || null, Date.now(), episodeId);
}

function setError(episodeId: number, error: string) {
  setStatus(episodeId, 'failed', error);
}

// ═══════════════════════════════════════════════════════════
// Step 1: Create episode
// ═══════════════════════════════════════════════════════════

export interface CreateCinemaInput {
  primary_character: string;
  secondary_characters?: string[];
  episode_idea: string;
  generatedBy?: string;
  scheduledAt?: number;
}

export function createCinemaEpisode(input: CreateCinemaInput): { ok: true; episode_id: number; episode_no: number; series_id: number } | { ok: false; error: string } {
  try {
    const seriesId = ensureCinemaSeries();
    const episodeNo = getNextEpisodeNo(seriesId);

    const r = db.prepare(`
      INSERT INTO cinema_episodes
        (series_id, episode_no, primary_character_slug, secondary_chars_json,
         premise, status, scheduled_at, generated_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?)
    `).run(
      seriesId,
      episodeNo,
      input.primary_character,
      JSON.stringify(input.secondary_characters || []),
      input.episode_idea.slice(0, 1000),
      input.scheduledAt || null,
      input.generatedBy || 'manual',
      Date.now(),
      Date.now(),
    );

    return {
      ok: true,
      episode_id: r.lastInsertRowid as number,
      episode_no: episodeNo,
      series_id: seriesId,
    };
  } catch (e: any) {
    return { ok: false, error: e?.message };
  }
}

// ═══════════════════════════════════════════════════════════
// Step 2: Script
// ═══════════════════════════════════════════════════════════

export async function generateScriptStep(episodeId: number, opts: GenerateScriptOpts): Promise<{ ok: boolean; script?: CinemaScript; error?: string }> {
  setStatus(episodeId, 'generating_script');
  try {
    const r = await generateCinemaScript(opts);
    return { ok: true, script: r.script };
  } catch (e: any) {
    setError(episodeId, `script gen fail: ${e?.message}`);
    return { ok: false, error: e?.message };
  }
}

// ═══════════════════════════════════════════════════════════
// Step 3: Storyboard + Budget Check (CRITICAL ABORT POINT)
// ═══════════════════════════════════════════════════════════

export function buildStoryboardStep(episodeId: number, episodeNo: number, script: CinemaScript): { ok: boolean; storyboard?: Storyboard; error?: string; budget_exceeded?: boolean } {
  setStatus(episodeId, 'storyboard');
  try {
    const storyboard = buildStoryboard(script, episodeId, episodeNo);

    if (!storyboard.budget_check.ok) {
      setStatus(episodeId, 'budget_exceeded', storyboard.budget_check.reason);
      console.warn(`[cinema-orch] ep#${episodeId} BUDGET EXCEEDED: ${storyboard.budget_check.reason}`);
      return { ok: false, budget_exceeded: true, error: storyboard.budget_check.reason };
    }

    persistStoryboardToEpisode(storyboard, script);
    persistStoryboard(storyboard);

    console.log(`[cinema-orch] ep#${episodeId} storyboard: ${storyboard.shots.length} shots | est=$${(storyboard.total_estimated_cents / 100).toFixed(2)} | breakdown=${JSON.stringify(storyboard.cost_breakdown_cents)}`);

    return { ok: true, storyboard };
  } catch (e: any) {
    setError(episodeId, `storyboard fail: ${e?.message}`);
    return { ok: false, error: e?.message };
  }
}

// ═══════════════════════════════════════════════════════════
// Step 4: Voice synthesis (per shot)
// ═══════════════════════════════════════════════════════════

export async function synthesizeVoiceStep(episodeId: number, shots: StoryboardShot[]): Promise<{ ok: boolean; segments?: CinemaVoiceSegment[]; error?: string }> {
  setStatus(episodeId, 'synthesizing_voice');
  try {
    const segments = await synthesizeCinemaVoice(shots, episodeId);
    return { ok: true, segments };
  } catch (e: any) {
    setError(episodeId, `voice synth fail: ${e?.message}`);
    return { ok: false, error: e?.message };
  }
}

// ═══════════════════════════════════════════════════════════
// Step 5: Generate shots (Veo/Hailuo/Seedance/Hedra in parallel batches)
// ═══════════════════════════════════════════════════════════

interface ShotResult {
  shot_no: number;
  ok: boolean;
  video_url?: string;
  local_path?: string;
  has_embedded_audio: boolean;
  cost_cents: number;
  error?: string;
}

async function generateOneShot(
  shot: StoryboardShot,
  voice: CinemaVoiceSegment | null,
  episodeId: number,
  shotDbId: number,
): Promise<ShotResult> {
  // Update DB row to generating
  db.prepare(`UPDATE cinema_shots SET status = 'generating', updated_at = ? WHERE id = ?`).run(Date.now(), shotDbId);

  try {
    let r: VideoGenResult;
    let hasEmbeddedAudio = false;

    switch (shot.provider) {
      case 'veo': {
        r = await generateVeoShot({
          prompt: shot.visual_prompt,
          duration_sec: shot.duration_target_sec,
          aspect_ratio: '9:16',
          audio: true,                      // Veo audio-native mode
          episode_id: episodeId,
          shot_id: shotDbId,
        });
        hasEmbeddedAudio = r.ok;            // Veo with audio
        break;
      }
      case 'hailuo': {
        r = await generateHailuoShot({
          prompt: shot.visual_prompt,
          duration_sec: shot.duration_target_sec,
          aspect_ratio: '9:16',
          episode_id: episodeId,
          shot_id: shotDbId,
        });
        break;
      }
      case 'seedance': {
        r = await generateSeedanceShot({
          prompt: shot.visual_prompt,
          duration_sec: shot.duration_target_sec,
          aspect_ratio: '9:16',
          resolution: '720p',
          episode_id: episodeId,
          shot_id: shotDbId,
        });
        break;
      }
      case 'hedra': {
        // Hedra needs reference image + audio
        // For POC: use generated character profile image OR fallback to image gen
        // TODO Phase 2: train FLUX LoRA → use that. For now use Hailuo first frame.
        if (!voice || !voice.audio_path) {
          r = { ok: false, cost_cents: 0, error: 'hedra_needs_voice_but_none_synthesized' };
          break;
        }
        // For POC: generate character image first via Hailuo single frame, save, pass to Hedra
        // Simplified: skip Hedra in POC if no reference image, fallback to Hailuo
        console.warn(`[cinema-orch] shot ${shot.shot_no} TALKING_HEAD requested but Hedra needs reference image — fallback to Hailuo for POC`);
        r = await generateHailuoShot({
          prompt: shot.visual_prompt + ', close-up portrait, talking expression',
          duration_sec: shot.duration_target_sec,
          aspect_ratio: '9:16',
          episode_id: episodeId,
          shot_id: shotDbId,
        });
        break;
      }
      default:
        r = { ok: false, cost_cents: 0, error: `unknown_provider: ${shot.provider}` };
    }

    if (r.ok) {
      db.prepare(`
        UPDATE cinema_shots
        SET status = 'done', generated_video_url = ?, generated_video_path = ?,
            duration_actual_sec = ?, cost_cents = ?, updated_at = ?
        WHERE id = ?
      `).run(
        r.video_url || null,
        r.local_path || null,
        r.duration_sec || null,
        r.cost_cents || 0,
        Date.now(),
        shotDbId,
      );
    } else {
      const retryCount = (db.prepare(`SELECT retry_count FROM cinema_shots WHERE id = ?`).get(shotDbId) as any)?.retry_count || 0;
      db.prepare(`
        UPDATE cinema_shots
        SET status = 'failed', error = ?, retry_count = ?, updated_at = ?
        WHERE id = ?
      `).run(r.error || 'unknown', retryCount + 1, Date.now(), shotDbId);
    }

    return {
      shot_no: shot.shot_no,
      ok: r.ok,
      video_url: r.video_url,
      local_path: r.local_path,
      has_embedded_audio: hasEmbeddedAudio,
      cost_cents: r.cost_cents,
      error: r.error,
    };
  } catch (e: any) {
    db.prepare(`UPDATE cinema_shots SET status = 'failed', error = ?, updated_at = ? WHERE id = ?`)
      .run(e?.message || 'unknown', Date.now(), shotDbId);
    return {
      shot_no: shot.shot_no,
      ok: false,
      has_embedded_audio: false,
      cost_cents: 0,
      error: e?.message,
    };
  }
}

export async function generateShotsStep(
  episodeId: number,
  storyboard: Storyboard,
  voiceSegments: CinemaVoiceSegment[],
  opts: { batchSize?: number } = {},
): Promise<{ ok: boolean; results?: ShotResult[]; error?: string }> {
  setStatus(episodeId, 'generating_video');
  const batchSize = opts.batchSize || 4;     // 4 concurrent calls — respect FAL rate limits

  // Resolve shot DB ids
  const shotDbRows = db.prepare(`SELECT id, shot_no FROM cinema_shots WHERE episode_id = ?`).all(episodeId) as any[];
  const shotIdMap = new Map<number, number>(shotDbRows.map((r: any) => [r.shot_no, r.id]));

  const results: ShotResult[] = [];
  const shots = storyboard.shots;

  console.log(`[cinema-orch] generating ${shots.length} shots in batches of ${batchSize}`);

  // Process in batches
  for (let i = 0; i < shots.length; i += batchSize) {
    const batch = shots.slice(i, i + batchSize);
    const batchPromises = batch.map((shot) => {
      const shotDbId = shotIdMap.get(shot.shot_no);
      if (!shotDbId) return Promise.resolve<ShotResult>({ shot_no: shot.shot_no, ok: false, has_embedded_audio: false, cost_cents: 0, error: 'shot_db_id_not_found' });
      const voice = getVoiceForShot(voiceSegments, shot.shot_no) || null;
      return generateOneShot(shot, voice, episodeId, shotDbId);
    });

    const batchResults = await Promise.all(batchPromises);
    results.push(...batchResults);

    const okCount = batchResults.filter((r) => r.ok).length;
    console.log(`[cinema-orch] batch ${i / batchSize + 1}: ${okCount}/${batch.length} ok`);
  }

  const totalOk = results.filter((r) => r.ok).length;
  const minRequired = Math.ceil(shots.length * 0.85);  // 85% threshold

  if (totalOk < minRequired) {
    const errSummary = results.filter((r) => !r.ok).map((r) => `shot${r.shot_no}: ${r.error}`).slice(0, 5).join(' | ');
    setError(episodeId, `only ${totalOk}/${shots.length} shots ok (need ≥${minRequired}): ${errSummary}`);
    return { ok: false, results, error: `low_shot_success_rate` };
  }

  console.log(`[cinema-orch] ✅ shots: ${totalOk}/${shots.length} succeeded`);
  return { ok: true, results };
}

// ═══════════════════════════════════════════════════════════
// Step 6: Compose
// ═══════════════════════════════════════════════════════════

export async function composeStep(
  episodeId: number,
  episodeNo: number,
  script: CinemaScript,
  storyboard: Storyboard,
  shotResults: ShotResult[],
  voiceSegments: CinemaVoiceSegment[],
): Promise<{ ok: boolean; result?: ComposeResult; error?: string }> {
  setStatus(episodeId, 'composing');

  try {
    // Build materials
    const materials: CinemaShotMaterial[] = [];
    for (const shot of storyboard.shots) {
      const result = shotResults.find((r) => r.shot_no === shot.shot_no);
      if (!result || !result.ok || !result.local_path) {
        console.warn(`[cinema-orch] shot ${shot.shot_no} skipped (no local video)`);
        continue;
      }
      const voice = getVoiceForShot(voiceSegments, shot.shot_no) || null;
      materials.push({
        shot_no: shot.shot_no,
        shot,
        generated_video_path: result.local_path,
        voice: voice && voice.mode !== 'silent' ? voice : null,
        has_embedded_audio: result.has_embedded_audio,
      });
    }

    if (materials.length < storyboard.shots.length * 0.7) {
      setError(episodeId, `not enough materials: ${materials.length}/${storyboard.shots.length}`);
      return { ok: false, error: 'insufficient_materials' };
    }

    const outputPath = buildCinemaOutputPath(episodeNo, script.primary_character);
    const bgmPath = pickBgmForCinema(script.bgm_mood);

    const r = await composeCinemaVideo({
      script,
      episodeId,
      episodeNo,
      materials,
      bgmPath,
      outputPath,
    });

    // Build URLs
    const filename = path.basename(r.output_path);
    const finalUrl = `${PUBLIC_BASE}/media/cinema-out/${filename}`;
    const teaserUrl = r.teaser_path ? `${PUBLIC_BASE}/media/cinema-out/${path.basename(r.teaser_path)}` : null;

    db.prepare(`
      UPDATE cinema_episodes
      SET final_video_url = ?, teaser_video_url = ?,
          total_duration_actual_sec = ?, generated_at = ?, updated_at = ?
      WHERE id = ?
    `).run(finalUrl, teaserUrl, Math.round(r.duration_sec), Date.now(), Date.now(), episodeId);

    return { ok: true, result: r };
  } catch (e: any) {
    setError(episodeId, `compose fail: ${e?.message}`);
    return { ok: false, error: e?.message };
  }
}

// ═══════════════════════════════════════════════════════════
// FULL PIPELINE
// ═══════════════════════════════════════════════════════════

export interface RunCinemaInput {
  primary_character: string;
  secondary_characters?: string[];
  episode_idea: string;
  generatedBy?: string;
  scheduledAt?: number;
  autoApprove?: boolean;            // cron mode → status='approved' instead of 'qc_review'
}

export interface RunCinemaResult {
  ok: boolean;
  episode_id?: number;
  episode_no?: number;
  output_path?: string;
  final_video_url?: string;
  teaser_path?: string;
  duration_sec?: number;
  cost_cents?: number;
  script?: CinemaScript;
  error?: string;
  step_failed?: string;
  budget_exceeded?: boolean;
}

export async function runFullCinemaPipeline(input: RunCinemaInput): Promise<RunCinemaResult> {
  // Step 1: Create
  const created = createCinemaEpisode(input);
  if (!created.ok) {
    return { ok: false, error: 'create_fail: ' + created.error, step_failed: 'create' };
  }
  const { episode_id, episode_no } = created;

  console.log(`\n${'═'.repeat(70)}\n[cinema-orch] PIPELINE START ep#${episode_id} no=${episode_no} | ${input.primary_character} | "${input.episode_idea.slice(0, 80)}"\n${'═'.repeat(70)}`);

  // Step 2: Script
  const scriptR = await generateScriptStep(episode_id, {
    primary_character: input.primary_character,
    secondary_characters: input.secondary_characters,
    episode_idea: input.episode_idea,
    episode_no,
  });
  if (!scriptR.ok || !scriptR.script) {
    return { ok: false, episode_id, error: scriptR.error, step_failed: 'script' };
  }
  console.log(`[cinema-orch] ✅ script: "${scriptR.script.title}" shots=${scriptR.script.shots.length} dur=${scriptR.script.total_duration_target_sec}s`);

  // Step 3: Storyboard + Budget Check (ABORT POINT)
  const sbR = buildStoryboardStep(episode_id, episode_no, scriptR.script);
  if (!sbR.ok || !sbR.storyboard) {
    return {
      ok: false,
      episode_id,
      error: sbR.error,
      step_failed: 'storyboard',
      budget_exceeded: sbR.budget_exceeded,
    };
  }
  console.log(`[cinema-orch] ✅ storyboard: ${sbR.storyboard.shots.length} shots | est=$${(sbR.storyboard.total_estimated_cents / 100).toFixed(2)} | budget OK`);

  // Step 4: Voice synth
  const voiceR = await synthesizeVoiceStep(episode_id, sbR.storyboard.shots);
  if (!voiceR.ok || !voiceR.segments) {
    return { ok: false, episode_id, error: voiceR.error, step_failed: 'voice' };
  }
  console.log(`[cinema-orch] ✅ voice: ${voiceR.segments.filter((s) => s.mode !== 'silent').length}/${voiceR.segments.length} non-silent segments`);

  // Step 5: Generate shots
  const shotsR = await generateShotsStep(episode_id, sbR.storyboard, voiceR.segments);
  if (!shotsR.ok || !shotsR.results) {
    return { ok: false, episode_id, error: shotsR.error, step_failed: 'video_gen' };
  }

  // Step 6: Compose
  const composeR = await composeStep(
    episode_id, episode_no, scriptR.script,
    sbR.storyboard, shotsR.results, voiceR.segments,
  );
  if (!composeR.ok || !composeR.result) {
    return { ok: false, episode_id, error: composeR.error, step_failed: 'compose' };
  }

  // Step 7: Reconcile cost
  const cost = reconcileEpisodeCost(episode_id);

  // Step 8: Set final status
  const finalStatus: CinemaStatus = input.autoApprove ? 'approved' : 'qc_review';
  setStatus(episode_id, finalStatus);

  console.log(`[cinema-orch] PIPELINE COMPLETE ep#${episode_id} → ${finalStatus} | actual cost=$${(cost.total_cents / 100).toFixed(2)}\n${'═'.repeat(70)}\n`);

  // Reload final URL
  const finalRow = db.prepare(`SELECT final_video_url, teaser_video_url FROM cinema_episodes WHERE id = ?`).get(episode_id) as any;

  return {
    ok: true,
    episode_id,
    episode_no,
    output_path: composeR.result.output_path,
    final_video_url: finalRow?.final_video_url,
    teaser_path: composeR.result.teaser_path,
    duration_sec: composeR.result.duration_sec,
    cost_cents: cost.total_cents,
    script: scriptR.script,
  };
}

// ═══════════════════════════════════════════════════════════
// Query helpers (admin UI)
// ═══════════════════════════════════════════════════════════

export function listCinemaEpisodes(opts: { limit?: number; status?: string } = {}): any[] {
  const seriesId = ensureCinemaSeries();
  const limit = opts.limit || 30;

  const where = opts.status ? 'AND status = ?' : '';
  const sql = `
    SELECT id, episode_no, title, status, primary_character_slug,
           shot_count, total_duration_target_sec, total_duration_actual_sec,
           cost_cents_estimate, cost_cents_actual, final_video_url,
           teaser_video_url, yt_video_id, fb_video_id,
           scheduled_at, generated_at, published_at, error
    FROM cinema_episodes
    WHERE series_id = ? ${where}
    ORDER BY episode_no DESC LIMIT ?
  `;
  return opts.status
    ? db.prepare(sql).all(seriesId, opts.status, limit) as any[]
    : db.prepare(sql).all(seriesId, limit) as any[];
}

export function getCinemaEpisodeDetail(episodeId: number): any {
  const ep = db.prepare(`SELECT * FROM cinema_episodes WHERE id = ?`).get(episodeId) as any;
  if (!ep) return null;

  const shots = db.prepare(`SELECT * FROM cinema_shots WHERE episode_id = ? ORDER BY shot_no ASC`).all(episodeId) as any[];
  const costLogs = db.prepare(`SELECT provider, SUM(cost_cents) as cost, COUNT(*) as calls FROM cinema_costs_log WHERE episode_id = ? GROUP BY provider`).all(episodeId) as any[];

  let script: CinemaScript | null = null;
  try {
    if (ep.script_json) script = JSON.parse(ep.script_json);
  } catch {}

  return { ...ep, shots, cost_logs: costLogs, script };
}

export function approveCinemaEpisode(episodeId: number): { ok: boolean; error?: string } {
  const ep = db.prepare(`SELECT status FROM cinema_episodes WHERE id = ?`).get(episodeId) as any;
  if (!ep) return { ok: false, error: 'not_found' };
  if (!['qc_review', 'failed'].includes(ep.status)) {
    return { ok: false, error: `cannot approve from status=${ep.status}` };
  }
  setStatus(episodeId, 'approved');
  return { ok: true };
}

/**
 * Anthology Orchestrator — main pipeline cho Sonder Stories.
 *
 * Daily flow (1 tập 19:00 VN):
 *   1. pickTodayCharacter (rotation từ engine)
 *   2. createAnthologyEpisode (insert story_episodes row, status='generating')
 *   3. generateScript (Claude với continuity injection)
 *   4. fetchVisuals (AI image + Pexels fallback)
 *   5. synthesizeVoice (Edge-TTS HoaiMy → ElevenLabs STS Ngân)
 *   6. composeVideo (FFmpeg cinematic 6-layer)
 *   7. persistFacts + advanceArc + bump counters
 *   8. status='approved' (admin có thể publish manual hoặc auto-cron)
 *
 * Reference skill: sonder-storytelling
 */

import * as fs from 'fs';
import * as path from 'path';
import { db } from '../../db';
import {
  type CharacterSlug,
  type TodayPick,
  pickTodayCharacter,
  pickLocationForCharacter,
  getCharacter,
  incrementAppearance,
  incrementLocationAppearance,
  incrementValueAppearances,
  advanceArc,
} from './anthology-engine';
import {
  type AnthologyScript,
  type GenerateOpts,
  generateAnthologyScript,
  persistNewFacts,
} from './anthology-script-writer';
import {
  fetchAllAnthologyVisuals,
} from './anthology-visuals';
import {
  type AnthologyVisual,
  type AnthologyVoiceSegment,
  synthesizeAnthologyVoice,
  composeAnthologyVideo,
  pickBgmForAnthology,
  buildAnthologyOutputPath,
} from './anthology-composer';

const PUBLIC_BASE = 'https://app.sondervn.com';

// ═══════════════════════════════════════════════════════════
// Anthology bucket series — single container for all anthology eps
// ═══════════════════════════════════════════════════════════

const ANTHOLOGY_SERIES_SLUG = 'sonder-anthology-master';

/** Ensure 1 master series exists for anthology bucket. Idempotent. */
function ensureAnthologySeries(): number {
  const existing = db.prepare(`SELECT id FROM story_series WHERE month_slug = ?`).get(ANTHOLOGY_SERIES_SLUG) as any;
  if (existing) return existing.id;

  const now = Date.now();
  const r = db.prepare(`
    INSERT INTO story_series (month_slug, title, subtitle, concept, start_date, status, created_at)
    VALUES (?, ?, ?, ?, ?, 'active', ?)
  `).run(
    ANTHOLOGY_SERIES_SLUG,
    'Sonder Stories — Anthology',
    'Multi-arc serialized storytelling | 1 tập/ngày 19:00 VN',
    'Universe khách Sonder. Mỗi vị khách = 1 dòng story dài tập. Ý tự thành. Câu chuyện vô tận.',
    now,
    now,
  );
  console.log(`[anth-orch] anthology master series created id=${r.lastInsertRowid}`);
  return r.lastInsertRowid as number;
}

function getNextAnthologyEpisodeNo(seriesId: number): number {
  const row = db.prepare(`SELECT MAX(episode_no) as max_no FROM story_episodes WHERE series_id = ?`).get(seriesId) as any;
  return (row?.max_no || 0) + 1;
}

// ═══════════════════════════════════════════════════════════
// Schedule: next 19:00 VN
// ═══════════════════════════════════════════════════════════

const TZ_OFFSET_MS = 7 * 3600 * 1000;

function nextNineteenVN(now: number = Date.now()): number {
  // 19:00 VN today → epoch ms. Nếu đã quá 19:00 → 19:00 ngày mai.
  const d = new Date(now + TZ_OFFSET_MS);
  d.setUTCHours(12, 0, 0, 0);  // 19:00 VN = 12:00 UTC
  const targetEpoch = d.getTime() - TZ_OFFSET_MS;
  if (targetEpoch <= now) {
    return targetEpoch + 24 * 3600 * 1000;
  }
  return targetEpoch;
}

// ═══════════════════════════════════════════════════════════
// Status helper
// ═══════════════════════════════════════════════════════════

export type AnthologyStatus =
  | 'draft'
  | 'generating_script'
  | 'fetching_visuals'
  | 'synthesizing_voice'
  | 'composing_video'
  | 'qc_review'
  | 'approved'
  | 'scheduled'
  | 'published'
  | 'failed';

function setStatus(episodeId: number, status: AnthologyStatus, error?: string) {
  db.prepare(`UPDATE story_episodes SET status = ?, error = ?, updated_at = ? WHERE id = ?`)
    .run(status, error || null, Date.now(), episodeId);
}

function setError(episodeId: number, error: string) {
  setStatus(episodeId, 'failed', error);
}

// ═══════════════════════════════════════════════════════════
// Step 1: Create anthology episode row
// ═══════════════════════════════════════════════════════════

export interface CreateAnthologyEpisodeInput {
  pick?: TodayPick;
  episodeIdeaSeed?: string;
  generatedBy?: string;
  scheduledAt?: number;  // override (default: next 19:00 VN)
}

export interface CreateResult {
  ok: true;
  episode_id: number;
  episode_no: number;
  series_id: number;
  pick: TodayPick;
  scheduled_at: number;
}

export function createAnthologyEpisode(input: CreateAnthologyEpisodeInput = {}): CreateResult | { ok: false; error: string } {
  try {
    const seriesId = ensureAnthologySeries();
    const pick = input.pick || pickTodayCharacter();
    const episodeNo = getNextAnthologyEpisodeNo(seriesId);
    const scheduledAt = input.scheduledAt || nextNineteenVN();

    const dow = new Date(Date.now() + TZ_OFFSET_MS).getUTCDay();
    const slotName = ['cn', 't2', 't3', 't4', 't5', 't6', 't7'][dow];

    // Resolve arc_id from pick.arc_slug (if any)
    let arcId: number | null = null;
    if (pick.arc_slug) {
      const a = db.prepare(`SELECT id FROM story_arcs WHERE arc_slug = ?`).get(pick.arc_slug) as any;
      if (a) arcId = a.id;
    }

    const characterIds = JSON.stringify([pick.primary, ...(pick.secondary || [])]);

    const now = Date.now();
    const r = db.prepare(`
      INSERT INTO story_episodes (
        series_id, episode_no, beat, title, caption, scheduled_at,
        status, character_ids, arc_id, slot, updated_at, cost_cents
      ) VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, 0)
    `).run(
      seriesId,
      episodeNo,
      'inciting',  // placeholder, script writer sẽ override
      `Tập ${episodeNo} — ${pick.primary}`,
      '',  // caption filled after script gen
      scheduledAt,
      characterIds,
      arcId,
      slotName,
      now,
    );

    const episodeId = r.lastInsertRowid as number;
    console.log(`[anth-orch] episode #${episodeId} (no=${episodeNo}) created | char=${pick.primary} arc=${pick.arc_slug || 'none'} slot=${slotName} sched=${new Date(scheduledAt).toISOString()}`);

    return {
      ok: true,
      episode_id: episodeId,
      episode_no: episodeNo,
      series_id: seriesId,
      pick,
      scheduled_at: scheduledAt,
    };
  } catch (e: any) {
    console.error('[anth-orch] createAnthologyEpisode fail:', e?.message);
    return { ok: false, error: e?.message || 'unknown' };
  }
}

// ═══════════════════════════════════════════════════════════
// Step 2: Generate script
// ═══════════════════════════════════════════════════════════

export async function generateScriptStep(
  episodeId: number,
  pick: TodayPick,
  opts?: { episodeIdeaSeed?: string },
): Promise<{ ok: boolean; script?: AnthologyScript; error?: string }> {
  const ep = db.prepare(`SELECT * FROM story_episodes WHERE id = ?`).get(episodeId) as any;
  if (!ep) return { ok: false, error: 'episode not found' };

  setStatus(episodeId, 'generating_script');

  try {
    const r = await generateAnthologyScript({
      pick,
      episodeIdeaSeed: opts?.episodeIdeaSeed,
      retryOnValidationFail: true,
    });

    const script = r.script;

    // Resolve location_id
    const locRow = db.prepare(`SELECT id FROM story_locations WHERE slug = ?`).get(script.location_slug) as any;
    const locId = locRow?.id || null;

    // Update episode row with script-derived fields
    db.prepare(`
      UPDATE story_episodes
      SET title = ?, caption = ?, beat = ?,
          location_id = ?, brand_values_json = ?, logo_placements_json = ?,
          hook_surface = ?, hook_arc = ?, anthology_script_json = ?,
          updated_at = ?
      WHERE id = ?
    `).run(
      script.title,
      script.caption_text,
      script.arc_beat || 'inciting',
      locId,
      JSON.stringify(script.brand_values_used),
      JSON.stringify(script.logo_placements_used),
      script.hook_surface,
      script.hook_arc,
      JSON.stringify(script),
      Date.now(),
      episodeId,
    );

    if (r.validation.errors.length > 0) {
      console.warn(`[anth-orch] script validation errors (proceeding anyway): ${r.validation.errors.join(' | ')}`);
    }

    return { ok: true, script };
  } catch (e: any) {
    setError(episodeId, `script gen fail: ${e?.message}`);
    return { ok: false, error: e?.message };
  }
}

// ═══════════════════════════════════════════════════════════
// Step 3: Fetch visuals (6 layers)
// ═══════════════════════════════════════════════════════════

export async function fetchVisualsStep(
  episodeId: number,
  script: AnthologyScript,
): Promise<{ ok: boolean; visuals?: AnthologyVisual[]; error?: string }> {
  setStatus(episodeId, 'fetching_visuals');

  try {
    const visualsResults = await fetchAllAnthologyVisuals(script.layers);
    const visuals = visualsResults.filter((v): v is AnthologyVisual => v !== null);

    if (visuals.length !== 6) {
      setError(episodeId, `only ${visuals.length}/6 visuals fetched`);
      return { ok: false, error: `only ${visuals.length}/6 visuals fetched` };
    }

    db.prepare(`UPDATE story_episodes SET anthology_visuals_json = ?, updated_at = ? WHERE id = ?`)
      .run(JSON.stringify(visuals.map((v) => ({
        layer_no: v.layer_no, layer_name: v.layer_name, type: v.type, local_path: v.local_path,
      }))), Date.now(), episodeId);

    return { ok: true, visuals };
  } catch (e: any) {
    setError(episodeId, `visuals fetch fail: ${e?.message}`);
    return { ok: false, error: e?.message };
  }
}

// ═══════════════════════════════════════════════════════════
// Step 4: Synthesize voice
// ═══════════════════════════════════════════════════════════

export async function synthesizeVoiceStep(
  episodeId: number,
  script: AnthologyScript,
): Promise<{ ok: boolean; segments?: AnthologyVoiceSegment[]; error?: string }> {
  setStatus(episodeId, 'synthesizing_voice');

  try {
    const segments = await synthesizeAnthologyVoice(script, episodeId);

    db.prepare(`UPDATE story_episodes SET anthology_voice_json = ?, updated_at = ? WHERE id = ?`)
      .run(JSON.stringify(segments.map((s) => ({
        layer_no: s.layer_no, layer_name: s.layer_name,
        audio_path: s.audio_path, duration_sec: s.duration_sec,
      }))), Date.now(), episodeId);

    return { ok: true, segments };
  } catch (e: any) {
    setError(episodeId, `voice synth fail: ${e?.message}`);
    return { ok: false, error: e?.message };
  }
}

// ═══════════════════════════════════════════════════════════
// Step 5: Compose video
// ═══════════════════════════════════════════════════════════

export async function composeVideoStep(
  episodeId: number,
  episodeNo: number,
  script: AnthologyScript,
  visuals: AnthologyVisual[],
  voiceSegments: AnthologyVoiceSegment[],
): Promise<{ ok: boolean; output_path?: string; duration_sec?: number; error?: string }> {
  setStatus(episodeId, 'composing_video');

  try {
    const outputPath = buildAnthologyOutputPath(episodeNo, script.primary_character);
    const bgmPath = pickBgmForAnthology(script.bgm_mood);

    const result = await composeAnthologyVideo({
      script,
      visuals,
      voiceSegments,
      bgmPath,
      outputPath,
      episodeNo,
    });

    // Build public URL relative to media dir
    const filename = path.basename(result.output_path);
    const finalUrl = `${PUBLIC_BASE}/media/anth-out/${filename}`;

    db.prepare(`
      UPDATE story_episodes
      SET final_video_url = ?, video_duration_sec = ?, bgm_path = ?, updated_at = ?
      WHERE id = ?
    `).run(finalUrl, Math.round(result.duration_sec), bgmPath || null, Date.now(), episodeId);

    return {
      ok: true,
      output_path: result.output_path,
      duration_sec: result.duration_sec,
    };
  } catch (e: any) {
    setError(episodeId, `compose fail: ${e?.message}`);
    return { ok: false, error: e?.message };
  }
}

// ═══════════════════════════════════════════════════════════
// Step 6: Post-publish bookkeeping
// ═══════════════════════════════════════════════════════════

export function postPublishBookkeeping(episodeId: number, script: AnthologyScript): void {
  try {
    // 1. Persist new facts → story_continuity
    const factsCount = persistNewFacts(script, episodeId);

    // 2. Bump character appearance counters
    incrementAppearance(script.primary_character);
    if (script.secondary_characters) {
      for (const sec of script.secondary_characters) incrementAppearance(sec);
    }

    // 3. Bump location count
    const loc = db.prepare(`SELECT id FROM story_locations WHERE slug = ?`).get(script.location_slug) as any;
    if (loc?.id) incrementLocationAppearance(loc.id);

    // 4. Bump brand values appearances
    if (script.brand_values_used.length > 0) {
      incrementValueAppearances(script.brand_values_used);
    }

    // 5. Bump logo placements
    for (const placement of script.logo_placements_used) {
      try {
        db.prepare(`UPDATE story_logo_placements SET appearance_count = appearance_count + 1 WHERE placement_key = ?`)
          .run(placement);
      } catch {}
    }

    // 6. Advance arc + auto-activate next
    if (script.arc_slug) {
      const arc = db.prepare(`SELECT id FROM story_arcs WHERE arc_slug = ?`).get(script.arc_slug) as any;
      if (arc?.id) {
        advanceArc(arc.id);

        // Link to story_arc_episodes
        try {
          db.prepare(`
            INSERT OR IGNORE INTO story_arc_episodes (arc_id, episode_id, arc_episode_no, beat)
            VALUES (?, ?, ?, ?)
          `).run(arc.id, episodeId, script.arc_episode_no || 0, script.arc_beat || 'standalone');
        } catch (e: any) {
          console.warn('[anth-orch] arc_episodes link fail:', e?.message);
        }
      }
    }

    console.log(`[anth-orch] bookkeeping ep#${episodeId}: ${factsCount} facts saved, counters bumped`);
  } catch (e: any) {
    console.warn(`[anth-orch] bookkeeping fail ep#${episodeId}: ${e?.message}`);
  }
}

// ═══════════════════════════════════════════════════════════
// FULL PIPELINE — end-to-end (đến approved status)
// ═══════════════════════════════════════════════════════════

export interface RunFullPipelineInput {
  pick?: TodayPick;
  episodeIdeaSeed?: string;
  generatedBy?: string;
  scheduledAt?: number;
  /** If true, skip qc_review and set status='approved' (cron auto-mode). Default false (admin manual = qc_review). */
  autoApprove?: boolean;
}

export interface RunFullPipelineResult {
  ok: boolean;
  episode_id?: number;
  episode_no?: number;
  output_path?: string;
  final_video_url?: string;
  duration_sec?: number;
  script?: AnthologyScript;
  error?: string;
  step_failed?: string;
}

/**
 * Run full pipeline từ pick → composed video, status='qc_review'.
 * Admin sẽ review → approve → schedule publish.
 */
export async function runFullAnthologyPipeline(input: RunFullPipelineInput = {}): Promise<RunFullPipelineResult> {
  // Step 1: Create
  const created = createAnthologyEpisode(input);
  if (!('ok' in created) || created.ok !== true) {
    return { ok: false, error: 'createAnthologyEpisode fail', step_failed: 'create' };
  }
  const { episode_id, episode_no, pick } = created;

  console.log(`\n${'═'.repeat(60)}\n[anth-orch] PIPELINE START ep#${episode_id} no=${episode_no} | ${pick.reason}\n${'═'.repeat(60)}`);

  // Step 2: Script
  const scriptR = await generateScriptStep(episode_id, pick, { episodeIdeaSeed: input.episodeIdeaSeed });
  if (!scriptR.ok || !scriptR.script) {
    return { ok: false, episode_id, error: scriptR.error, step_failed: 'script' };
  }
  console.log(`[anth-orch] ✅ script: "${scriptR.script.title}" duration=${scriptR.script.total_duration_target_sec}s`);

  // Step 3: Visuals
  const visualsR = await fetchVisualsStep(episode_id, scriptR.script);
  if (!visualsR.ok || !visualsR.visuals) {
    return { ok: false, episode_id, error: visualsR.error, step_failed: 'visuals' };
  }
  console.log(`[anth-orch] ✅ visuals: ${visualsR.visuals.length}/6 fetched`);

  // Step 4: Voice
  const voiceR = await synthesizeVoiceStep(episode_id, scriptR.script);
  if (!voiceR.ok || !voiceR.segments) {
    return { ok: false, episode_id, error: voiceR.error, step_failed: 'voice' };
  }
  console.log(`[anth-orch] ✅ voice: ${voiceR.segments.length}/6 synthesized`);

  // Step 5: Compose
  const composeR = await composeVideoStep(
    episode_id,
    episode_no,
    scriptR.script,
    visualsR.visuals,
    voiceR.segments,
  );
  if (!composeR.ok || !composeR.output_path) {
    return { ok: false, episode_id, error: composeR.error, step_failed: 'compose' };
  }
  console.log(`[anth-orch] ✅ video: ${composeR.output_path} (${composeR.duration_sec?.toFixed(1)}s)`);

  // Step 6: Set status — autoApprove (cron) → 'approved' (publish cron sẽ pick up)
  //                    manual UI generate → 'qc_review' (admin manual approve)
  const finalStatus: AnthologyStatus = input.autoApprove ? 'approved' : 'qc_review';
  setStatus(episode_id, finalStatus);

  console.log(`[anth-orch] PIPELINE COMPLETE ep#${episode_id} → ${finalStatus}\n${'═'.repeat(60)}\n`);

  // Reload final URL
  const finalRow = db.prepare(`SELECT final_video_url FROM story_episodes WHERE id = ?`).get(episode_id) as any;

  return {
    ok: true,
    episode_id,
    episode_no,
    output_path: composeR.output_path,
    final_video_url: finalRow?.final_video_url,
    duration_sec: composeR.duration_sec,
    script: scriptR.script,
  };
}

// ═══════════════════════════════════════════════════════════
// Approve + publish helpers
// ═══════════════════════════════════════════════════════════

export function approveEpisode(episodeId: number, approvedBy: string = 'admin'): { ok: boolean; error?: string } {
  const ep = db.prepare(`SELECT * FROM story_episodes WHERE id = ?`).get(episodeId) as any;
  if (!ep) return { ok: false, error: 'not found' };
  if (!['qc_review', 'failed'].includes(ep.status)) {
    return { ok: false, error: `cannot approve from status=${ep.status}` };
  }

  setStatus(episodeId, 'approved');
  console.log(`[anth-orch] ep#${episodeId} approved by ${approvedBy}`);
  return { ok: true };
}

/**
 * Mark published — call after FB upload succeeded.
 * Trigger bookkeeping (facts + counters + arc advance).
 */
export function markPublished(episodeId: number, fbPostIds?: string[]): { ok: boolean; error?: string } {
  const ep = db.prepare(`SELECT * FROM story_episodes WHERE id = ?`).get(episodeId) as any;
  if (!ep) return { ok: false, error: 'not found' };

  // Parse stored script for bookkeeping
  let script: AnthologyScript | null = null;
  try {
    if (ep.anthology_script_json) script = JSON.parse(ep.anthology_script_json);
  } catch {}

  db.prepare(`
    UPDATE story_episodes
    SET status = 'published', published_at = ?, fb_post_ids = ?, updated_at = ?
    WHERE id = ?
  `).run(Date.now(), fbPostIds ? JSON.stringify(fbPostIds) : null, Date.now(), episodeId);

  if (script) postPublishBookkeeping(episodeId, script);

  console.log(`[anth-orch] ep#${episodeId} marked published${fbPostIds ? ` fb_posts=${fbPostIds.join(',')}` : ''}`);
  return { ok: true };
}

// ═══════════════════════════════════════════════════════════
// Query helpers (for admin UI)
// ═══════════════════════════════════════════════════════════

export function listAnthologyEpisodes(opts: { limit?: number; status?: string } = {}): any[] {
  const seriesId = ensureAnthologySeries();
  const limit = opts.limit || 30;

  if (opts.status) {
    return db.prepare(`
      SELECT id, episode_no, title, caption, status, character_ids, arc_id, slot,
             scheduled_at, published_at, final_video_url, video_duration_sec, hook_surface,
             updated_at, error
      FROM story_episodes
      WHERE series_id = ? AND status = ?
      ORDER BY episode_no DESC LIMIT ?
    `).all(seriesId, opts.status, limit);
  }

  return db.prepare(`
    SELECT id, episode_no, title, caption, status, character_ids, arc_id, slot,
           scheduled_at, published_at, final_video_url, video_duration_sec, hook_surface,
           updated_at, error
    FROM story_episodes
    WHERE series_id = ?
    ORDER BY episode_no DESC LIMIT ?
  `).all(seriesId, limit);
}

export function getAnthologyEpisodeDetail(episodeId: number): any {
  const ep = db.prepare(`SELECT * FROM story_episodes WHERE id = ?`).get(episodeId) as any;
  if (!ep) return null;

  // Resolve linked entities
  const characters = ep.character_ids ? JSON.parse(ep.character_ids) : [];
  const charProfiles = characters.map((slug: string) => getCharacter(slug)).filter(Boolean);

  const location = ep.location_id
    ? db.prepare(`SELECT * FROM story_locations WHERE id = ?`).get(ep.location_id)
    : null;

  const arc = ep.arc_id
    ? db.prepare(`SELECT * FROM story_arcs WHERE id = ?`).get(ep.arc_id)
    : null;

  let script: AnthologyScript | null = null;
  try {
    if (ep.anthology_script_json) script = JSON.parse(ep.anthology_script_json);
  } catch {}

  return {
    ...ep,
    characters: charProfiles,
    location,
    arc,
    script,
    brand_values: ep.brand_values_json ? JSON.parse(ep.brand_values_json) : [],
    logo_placements: ep.logo_placements_json ? JSON.parse(ep.logo_placements_json) : [],
  };
}

export function getAnthologyStats(): {
  total_episodes: number;
  by_status: Record<string, number>;
  by_character: Record<string, number>;
  active_arcs: any[];
  recent_facts: any[];
} {
  const seriesId = ensureAnthologySeries();

  const total = (db.prepare(`SELECT COUNT(*) as n FROM story_episodes WHERE series_id = ?`).get(seriesId) as any).n;

  const byStatus = db.prepare(`
    SELECT status, COUNT(*) as n FROM story_episodes WHERE series_id = ? GROUP BY status
  `).all(seriesId) as any[];

  const byChar = db.prepare(`SELECT slug, name, appearance_count FROM story_characters ORDER BY appearance_count DESC`).all() as any[];

  const activeArcs = db.prepare(`
    SELECT id, arc_slug, character_slug, arc_title, episodes_planned, episodes_published, status
    FROM story_arcs WHERE status = 'active' ORDER BY started_at ASC
  `).all() as any[];

  const recentFacts = db.prepare(`
    SELECT fact_key, fact_value, established_episode_id, established_at
    FROM story_continuity WHERE superseded_at IS NULL
    ORDER BY established_at DESC LIMIT 20
  `).all() as any[];

  return {
    total_episodes: total,
    by_status: Object.fromEntries(byStatus.map((r: any) => [r.status, r.n])),
    by_character: Object.fromEntries(byChar.map((c: any) => [c.slug, c.appearance_count])),
    active_arcs: activeArcs,
    recent_facts: recentFacts,
  };
}

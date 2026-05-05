/**
 * Cinema Storyboard — convert script.shots → executable shot list with provider routing.
 *
 * Input: CinemaScript từ script-writer
 * Output: storyboard với mỗi shot mapped đến provider + estimated cost
 *
 * Pre-flight estimator: tính tổng cost trước khi gen → abort nếu vượt cap.
 *
 * Reference skill: sonder-cinema (LOCKED routing)
 */

import { db } from '../../db';
import type { CinemaScript, CinemaShot } from './cinema-script-writer';
import {
  pickProvidersForShot,
  estimateProviderCost,
  type ShotType,
  type ProviderId,
  type ShotContext,
} from './cinema-providers';
import {
  estimateEpisodeCost,
  checkBudget,
  type EpisodeCostEstimate,
  type BudgetCheckResult,
  type Provider,
} from './cinema-cost-tracker';

// ═══════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════

export interface StoryboardShot extends CinemaShot {
  provider: Provider;                   // legacy (primary tier)
  provider_cascade: ProviderId[];       // Plan B cascade list (try in order)
  estimated_cost_cents: number;
  // Image-to-video shots cần reference image generated trước
  needs_reference_image: boolean;
  // Talking head shots cần audio-first → image+audio → Hedra
  needs_talking_head_pipeline: boolean;
}

export interface Storyboard {
  episode_id: number;
  episode_no: number;
  primary_character: string;
  shots: StoryboardShot[];
  total_estimated_cents: number;
  cost_breakdown_cents: Record<string, number>;
  budget_check: BudgetCheckResult;
}

// ═══════════════════════════════════════════════════════════
// Build storyboard from script
// ═══════════════════════════════════════════════════════════

// Map cascade ProviderId → cost-tracker Provider enum (some are aliases for tracking)
function providerIdToTrackerEnum(id: ProviderId): Provider {
  switch (id) {
    case 'stock': return 'seedance';                // free, logged as 0-cost line in tracker
    case 'luma': return 'kling_fallback';            // free tier, repurpose enum
    case 'wan': return 'kling_fallback';             // cheap paid, repurpose enum
    case 'seedance': return 'seedance';
    case 'hailuo': return 'hailuo';
    case 'hedra': return 'hedra';
    case 'veo': return 'veo';
  }
}

export function buildStoryboard(script: CinemaScript, episodeId: number, episodeNo: number): Storyboard {
  const shots: StoryboardShot[] = script.shots.map((s) => {
    // Build shot context for cascade routing (Plan B)
    const ctx: ShotContext = {
      shot_type: s.shot_type as ShotType,
      has_character: s.has_character ?? (s.shot_type === 'CHARACTER_SCENE' || s.shot_type === 'TALKING_HEAD'),
      money_shot: s.money_shot ?? false,
      duration_sec: s.duration_target_sec,
    };
    const cascade = pickProvidersForShot(ctx);
    const primaryId = cascade[0];
    const provider = providerIdToTrackerEnum(primaryId);
    const estimated_cost_cents = estimateProviderCost(primaryId, s.duration_target_sec);

    return {
      ...s,
      provider,
      provider_cascade: cascade,
      estimated_cost_cents,
      needs_reference_image: primaryId === 'hailuo' || primaryId === 'hedra',
      needs_talking_head_pipeline: primaryId === 'hedra',
    };
  });

  // Cost estimate via tracker
  const estimate = estimateEpisodeCost({
    shots: shots.map((s) => ({
      shot_no: s.shot_no,
      provider: s.provider,
      duration_sec: s.duration_target_sec,
    })),
    total_words_vn: script.total_words_vn,
    script_input_chars: 8000,           // ~ system + user prompt size
  });

  const budgetCheck = checkBudget(estimate);

  return {
    episode_id: episodeId,
    episode_no: episodeNo,
    primary_character: script.primary_character,
    shots,
    total_estimated_cents: estimate.total_cents,
    cost_breakdown_cents: estimate.by_provider_cents,
    budget_check: budgetCheck,
  };
}

// ═══════════════════════════════════════════════════════════
// Persist storyboard to DB (cinema_shots)
// ═══════════════════════════════════════════════════════════

export function persistStoryboard(storyboard: Storyboard): { inserted: number } {
  const stmt = db.prepare(`
    INSERT INTO cinema_shots
      (episode_id, shot_no, act, shot_type, provider, prompt, voiceover_text,
       duration_target_sec, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
    ON CONFLICT (episode_id, shot_no) DO UPDATE SET
      act = excluded.act,
      shot_type = excluded.shot_type,
      provider = excluded.provider,
      prompt = excluded.prompt,
      voiceover_text = excluded.voiceover_text,
      duration_target_sec = excluded.duration_target_sec,
      status = 'pending',
      updated_at = ?
  `);

  let inserted = 0;
  const now = Date.now();
  for (const s of storyboard.shots) {
    try {
      stmt.run(
        storyboard.episode_id,
        s.shot_no,
        s.act,
        s.shot_type,
        s.provider,
        s.visual_prompt,
        s.voiceover_text || '',
        s.duration_target_sec,
        now,
        now,
      );
      inserted++;
    } catch (e: any) {
      console.warn(`[storyboard] persist shot ${s.shot_no} fail: ${e?.message}`);
    }
  }
  return { inserted };
}

// ═══════════════════════════════════════════════════════════
// Update episode row with storyboard summary
// ═══════════════════════════════════════════════════════════

export function persistStoryboardToEpisode(storyboard: Storyboard, script: CinemaScript): void {
  db.prepare(`
    UPDATE cinema_episodes
    SET shot_count = ?,
        total_duration_target_sec = ?,
        total_words_vn = ?,
        cost_cents_estimate = ?,
        cost_breakdown_json = ?,
        storyboard_json = ?,
        bgm_mood = ?,
        brand_values_used_json = ?,
        cold_open_text = ?,
        title_card_text = ?,
        closing_line = ?,
        caption_yt = ?,
        caption_fb_teaser = ?,
        hashtags_json = ?,
        title = ?,
        primary_character_slug = ?,
        secondary_chars_json = ?,
        premise = ?,
        script_json = ?,
        updated_at = ?
    WHERE id = ?
  `).run(
    storyboard.shots.length,
    script.total_duration_target_sec,
    script.total_words_vn,
    storyboard.total_estimated_cents,
    JSON.stringify(storyboard.cost_breakdown_cents),
    JSON.stringify(storyboard.shots.map((s) => ({
      shot_no: s.shot_no, act: s.act, shot_type: s.shot_type,
      provider: s.provider, duration: s.duration_target_sec,
      cost_cents: s.estimated_cost_cents,
    }))),
    script.bgm_mood,
    JSON.stringify(script.brand_values_used),
    script.cold_open_text || null,
    script.title_card_text,
    script.closing_line,
    script.caption_yt,
    script.caption_fb_teaser,
    JSON.stringify(script.hashtags),
    script.title,
    script.primary_character,
    JSON.stringify(script.secondary_characters || []),
    script.premise,
    JSON.stringify(script),
    Date.now(),
    storyboard.episode_id,
  );
}

/**
 * Studio Orchestrator — main state machine cho video project.
 *
 * States:
 *   draft → scripting → script_review → visuals → voice_review →
 *   composing → qc_review → approved → scheduled → published
 *
 * V1 MVP focus: draft → scripting → script_review → visuals
 * (voice + compose + publish sẽ hoàn tất ở V1.5)
 *
 * Flow:
 *   1. createProject(topic, opts) → status=draft
 *   2. generateScriptStep(id) → status=scripting → script_review
 *   3. [Admin reviews script via UI]
 *   4. approveScriptStep(id) → status=visuals
 *   5. generateVisualsStep(id) → status=voice_review (after visuals fetched)
 *   6. [TODO V1.5: voice synthesis + composition]
 */

import { db } from '../../db';
import { generateScript, ScriptOutput, ScriptOptions } from './script-writer';
import { fetchVisualsForScenes } from './visual-generator';
import { getDefaultBrandKit } from './brand-kit';
import { markIdeaUsed } from './content-discovery';

export type ProjectStatus =
  | 'draft'
  | 'scripting'
  | 'script_review'
  | 'visuals'
  | 'voice_review'
  | 'composing'
  | 'qc_review'
  | 'approved'
  | 'scheduled'
  | 'published'
  | 'failed';

export interface CreateProjectInput {
  topic: string;
  title?: string;
  target_duration_sec?: number;       // Default 90
  tier?: 'stock' | 'hybrid' | 'premium';  // Default 'stock'
  series_id?: number;
  brand_kit_id?: number;               // Default: default brand kit
  idea_id?: number;                    // If from content_ideas library
  generated_by?: string;               // Admin email
  style?: 'informative' | 'energetic' | 'warm' | 'professional';
  audience?: string;
}

export interface VideoProject {
  id: number;
  title: string;
  topic: string;
  target_duration_sec: number;
  tier: string;
  status: ProjectStatus;
  script_json?: string;
  draft_video_url?: string;
  final_video_url?: string;
  caption_text?: string;
  cost_cents: number;
  error_log?: string;
  created_at: number;
  updated_at: number;
}

// ═══════════════════════════════════════════════════════════
// Create project
// ═══════════════════════════════════════════════════════════

export function createProject(input: CreateProjectInput): { id: number; project: VideoProject } | { error: string } {
  try {
    const brandKit = input.brand_kit_id
      ? db.prepare(`SELECT id FROM video_brand_kits WHERE id = ? AND active = 1`).get(input.brand_kit_id)
      : getDefaultBrandKit();

    if (!brandKit) return { error: 'No active brand kit — please create one first' };

    const now = Date.now();
    const result = db.prepare(`
      INSERT INTO video_projects
        (title, topic, target_duration_sec, tier, status,
         series_id, brand_kit_id, generated_by,
         cost_cents, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'draft', ?, ?, ?, 0, ?, ?)
    `).run(
      input.title || input.topic.substring(0, 100),
      input.topic,
      input.target_duration_sec || 90,
      input.tier || 'stock',
      input.series_id || null,
      (brandKit as any).id,
      input.generated_by || 'system',
      now, now,
    );

    const id = result.lastInsertRowid as number;

    // Mark idea as used if provided
    if (input.idea_id) markIdeaUsed(input.idea_id, id);

    const project = db.prepare(`SELECT * FROM video_projects WHERE id = ?`).get(id) as VideoProject;
    console.log(`[vs-orch] project created id=${id} topic="${input.topic.substring(0, 60)}"`);

    return { id, project };
  } catch (e: any) {
    return { error: e?.message };
  }
}

// ═══════════════════════════════════════════════════════════
// Step: Generate script
// ═══════════════════════════════════════════════════════════

export async function generateScriptStep(projectId: number, opts?: Partial<ScriptOptions>): Promise<{ success: boolean; error?: string }> {
  try {
    const proj = db.prepare(`SELECT * FROM video_projects WHERE id = ?`).get(projectId) as any;
    if (!proj) return { success: false, error: 'Project not found' };
    if (!['draft', 'scripting'].includes(proj.status)) {
      return { success: false, error: `Cannot generate script from status=${proj.status}` };
    }

    updateStatus(projectId, 'scripting');

    const script = await generateScript({
      topic: proj.topic,
      target_duration_sec: proj.target_duration_sec,
      style: opts?.style,
      audience: opts?.audience,
      language: 'vi',
      brand_name: 'Sonder',
    });

    if (!script) {
      updateStatus(projectId, 'draft', 'Script generation failed');
      return { success: false, error: 'LLM returned null' };
    }

    // Save script JSON
    const now = Date.now();
    db.prepare(`
      UPDATE video_projects
      SET script_json = ?, title = COALESCE(NULLIF(title, topic), ?), hook_question = ?,
          caption_text = ?, status = 'script_review', updated_at = ?
      WHERE id = ?
    `).run(
      JSON.stringify(script),
      script.title,
      script.hook_question,
      script.caption_social + '\n\n' + (script.hashtags || []).join(' '),
      now,
      projectId,
    );

    // Clear old scenes if retry
    db.prepare(`DELETE FROM video_scenes WHERE project_id = ?`).run(projectId);

    // Persist scenes
    for (const s of script.scenes) {
      db.prepare(`
        INSERT INTO video_scenes
          (project_id, scene_index, kind, text, duration_sec, visual_prompt, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)
      `).run(projectId, s.index, s.kind, s.text, s.duration_sec, s.visual_prompt, now);
    }

    // Log cost estimate (approx LLM tokens)
    const costCents = Math.ceil(((script.tokens_used?.input || 500) + (script.tokens_used?.output || 1000)) * 0.0001);
    db.prepare(`
      INSERT INTO video_cost_ledger (project_id, provider, operation, units_used, cost_cents, metadata_json, created_at)
      VALUES (?, ?, 'script_gen', ?, ?, ?, ?)
    `).run(
      projectId,
      script.provider,
      (script.tokens_used?.input || 0) + (script.tokens_used?.output || 0),
      costCents,
      JSON.stringify({ scenes: script.scenes.length, chars: script.scenes.reduce((s, sc) => s + sc.text.length, 0) }),
      now,
    );

    db.prepare(`UPDATE video_projects SET cost_cents = cost_cents + ? WHERE id = ?`).run(costCents, projectId);

    console.log(`[vs-orch] project ${projectId} script generated: ${script.scenes.length} scenes, ${script.total_duration_sec}s`);
    return { success: true };
  } catch (e: any) {
    updateStatus(projectId, 'draft', e?.message);
    return { success: false, error: e?.message };
  }
}

// ═══════════════════════════════════════════════════════════
// Step: Approve script (gate 1)
// ═══════════════════════════════════════════════════════════

export function approveScriptStep(projectId: number, editedScenes?: Array<{ index: number; text?: string; visual_prompt?: string }>): { success: boolean; error?: string } {
  try {
    const proj = db.prepare(`SELECT status FROM video_projects WHERE id = ?`).get(projectId) as any;
    if (!proj) return { success: false, error: 'Not found' };
    if (proj.status !== 'script_review') {
      return { success: false, error: `Status must be script_review, got ${proj.status}` };
    }

    // Apply admin edits to scenes
    if (editedScenes?.length) {
      for (const edit of editedScenes) {
        const sets: string[] = [];
        const vals: any[] = [];
        if (edit.text !== undefined) { sets.push('text = ?'); vals.push(edit.text); }
        if (edit.visual_prompt !== undefined) { sets.push('visual_prompt = ?'); vals.push(edit.visual_prompt); }
        if (sets.length === 0) continue;
        vals.push(projectId, edit.index);
        db.prepare(`UPDATE video_scenes SET ${sets.join(', ')} WHERE project_id = ? AND scene_index = ?`).run(...vals);
      }
    }

    db.prepare(`
      UPDATE video_projects
      SET status = 'visuals', reviewed_at_gate1 = ?, updated_at = ?
      WHERE id = ?
    `).run(Date.now(), Date.now(), projectId);

    console.log(`[vs-orch] project ${projectId} script approved → visuals`);
    return { success: true };
  } catch (e: any) {
    return { success: false, error: e?.message };
  }
}

// ═══════════════════════════════════════════════════════════
// Step: Fetch visuals (stock clips)
// ═══════════════════════════════════════════════════════════

export async function generateVisualsStep(projectId: number): Promise<{ success: boolean; fetched: number; failed: number; error?: string }> {
  try {
    const proj = db.prepare(`SELECT * FROM video_projects WHERE id = ?`).get(projectId) as any;
    if (!proj) return { success: false, fetched: 0, failed: 0, error: 'Not found' };
    if (proj.status !== 'visuals') {
      return { success: false, fetched: 0, failed: 0, error: `Status must be visuals, got ${proj.status}` };
    }

    const brandKit = db.prepare(`SELECT * FROM video_brand_kits WHERE id = ?`).get(proj.brand_kit_id) as any;
    const aspectRatio = brandKit?.aspect_ratio || '9:16';

    const scenes = db.prepare(`
      SELECT id, scene_index, text, duration_sec, visual_prompt
      FROM video_scenes WHERE project_id = ? ORDER BY scene_index ASC
    `).all(projectId) as any[];

    // Extract stock keywords from visual_prompt (fallback if not stored separately)
    // For V1: regenerate keywords from prompt if needed
    const sceneInputs = scenes.map(s => ({
      stock_keywords: extractKeywords(s.visual_prompt),
      visual_prompt: s.visual_prompt,
      duration_sec: s.duration_sec,
    }));

    const results = await fetchVisualsForScenes(sceneInputs, aspectRatio);

    let fetched = 0, failed = 0;
    for (let i = 0; i < scenes.length; i++) {
      const s = scenes[i];
      const r = results[i];

      if (r) {
        db.prepare(`
          UPDATE video_scenes
          SET visual_url = ?, visual_provider = ?, status = 'ready'
          WHERE id = ?
        `).run(r.clip_url, r.provider, s.id);
        fetched++;
      } else {
        db.prepare(`UPDATE video_scenes SET status = 'failed', retry_count = retry_count + 1 WHERE id = ?`).run(s.id);
        failed++;
      }
    }

    // Next status: voice_review (sau khi admin preview visuals)
    if (failed === 0) {
      db.prepare(`UPDATE video_projects SET status = 'voice_review', updated_at = ? WHERE id = ?`).run(Date.now(), projectId);
    } else {
      // Partial success → stay in 'visuals' để admin retry failed scenes
      db.prepare(`UPDATE video_projects SET error_log = ?, updated_at = ? WHERE id = ?`)
        .run(`${failed}/${scenes.length} scenes failed to fetch visuals`, Date.now(), projectId);
    }

    console.log(`[vs-orch] project ${projectId} visuals: fetched=${fetched} failed=${failed}`);
    return { success: failed === 0, fetched, failed };
  } catch (e: any) {
    return { success: false, fetched: 0, failed: 0, error: e?.message };
  }
}

// ═══════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════

function updateStatus(projectId: number, status: ProjectStatus, errorMsg?: string): void {
  try {
    const sets = ['status = ?', 'updated_at = ?'];
    const vals: any[] = [status, Date.now()];
    if (errorMsg) { sets.push('error_log = ?'); vals.push(errorMsg); }
    vals.push(projectId);
    db.prepare(`UPDATE video_projects SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  } catch {}
}

/**
 * Extract English keywords từ visual_prompt cho stock search.
 * Simple heuristic: lấy 2-4 noun phrases đầu tiên.
 */
function extractKeywords(prompt: string): string[] {
  // Remove common style modifiers
  const cleaned = prompt
    .replace(/cinematic|golden hour|shallow depth of field|warm|vibrant|consistent|lighting|colors|style|grading|aesthetic/gi, '')
    .replace(/\s+/g, ' ')
    .trim();

  // Split by comma, take first few phrases, filter short
  const phrases = cleaned.split(',')
    .map(p => p.trim())
    .filter(p => p.length >= 3 && p.length <= 50)
    .slice(0, 4);

  if (phrases.length === 0) {
    // Fallback: first 3 words
    return [cleaned.split(' ').slice(0, 4).join(' ')];
  }

  return phrases;
}

// ═══════════════════════════════════════════════════════════
// Query / list
// ═══════════════════════════════════════════════════════════

export function getProject(id: number): VideoProject | null {
  try {
    return db.prepare(`SELECT * FROM video_projects WHERE id = ?`).get(id) as VideoProject;
  } catch { return null; }
}

export function listProjects(opts: { status?: string; limit?: number } = {}): VideoProject[] {
  try {
    if (opts.status) {
      return db.prepare(`SELECT * FROM video_projects WHERE status = ? ORDER BY created_at DESC LIMIT ?`)
        .all(opts.status, opts.limit || 50) as VideoProject[];
    }
    return db.prepare(`SELECT * FROM video_projects ORDER BY created_at DESC LIMIT ?`)
      .all(opts.limit || 50) as VideoProject[];
  } catch { return []; }
}

export function getProjectScenes(projectId: number): any[] {
  return db.prepare(`SELECT * FROM video_scenes WHERE project_id = ? ORDER BY scene_index ASC`).all(projectId) as any[];
}

export function deleteProject(id: number): { success: boolean } {
  try {
    db.prepare(`DELETE FROM video_scenes WHERE project_id = ?`).run(id);
    db.prepare(`DELETE FROM video_publish_log WHERE project_id = ?`).run(id);
    db.prepare(`DELETE FROM video_cost_ledger WHERE project_id = ?`).run(id);
    db.prepare(`DELETE FROM video_projects WHERE id = ?`).run(id);
    return { success: true };
  } catch { return { success: false }; }
}

/**
 * V5 Hybrid Composer — combine real footage + AI assets → 3 variant MP4s.
 *
 * Reference: skill sonder-content-v5
 *
 * Pipeline:
 *   1. Read script + visual_plan from v5_scripts
 *   2. For each shot: real_footage (use file) | ai_image (gen via Flux) | ai_video (gen via Wan)
 *   3. Synthesize VO via Edge-TTS → ElevenLabs STS Ngân
 *   4. Compose 3 variants A/B/C (different hooks, same body)
 *   5. FFmpeg concat + BGM + watermark + output 1080p 9:16
 *   6. Save v5_rendered_clips rows
 */

import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { db } from '../../db';
import { generateAIImage, generateAIVideo } from './fal-generator';
import type { V5Script, V5Shot, V5RenderedClip } from './types';

// sonder-voice deleted in pivot 2026-05-11 — V5 reels paused, V5T uses static images (no TTS).
// Stub kept for any legacy code that calls it.
async function synthesizeSonderVoice(_text: string, _outPath?: string): Promise<{ ok: boolean; path?: string; mode?: string; error?: string }> {
  return { ok: false, error: 'sonder-voice module removed in 2026-05-11 pivot' };
}

const V5_OUT_DIR = '/opt/vp-marketing/data/media/v5-out';
const BGM_DIR = '/opt/vp-marketing/data/bgm';
const FOOTAGE_DIR = process.env.V5_FOOTAGE_DIR || '/var/sonder-real-footage';

if (!fs.existsSync(V5_OUT_DIR)) fs.mkdirSync(V5_OUT_DIR, { recursive: true });

/* ───────── FFmpeg helpers ───────── */

function runFfmpeg(args: string[], timeoutMs = 180000): { ok: boolean; stderr: string } {
  const r = spawnSync('ffmpeg', args, {
    encoding: 'utf8',
    maxBuffer: 200 * 1024 * 1024,
    timeout: timeoutMs,
  });
  return { ok: r.status === 0, stderr: r.stderr || '' };
}

function ffprobeDuration(file: string): number {
  const r = spawnSync('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1', file,
  ], { encoding: 'utf8' });
  return parseFloat(r.stdout?.trim() || '0') || 0;
}

/** Resolve shot to local file path — gen if needed */
async function resolveShotToFile(shot: V5Shot, scriptId: number): Promise<{ path: string; cost: number } | null> {
  if (shot.source === 'real_footage' && shot.footage_id) {
    const footage = db.prepare(`SELECT path FROM v5_footage WHERE id = ?`).get(shot.footage_id) as any;
    if (footage?.path && fs.existsSync(footage.path)) {
      // Increment used_count
      db.prepare(`UPDATE v5_footage SET used_count = used_count + 1 WHERE id = ?`).run(shot.footage_id);
      return { path: footage.path, cost: 0 };
    }
    return null;
  }

  if (shot.source === 'ai_image' && shot.ai_prompt) {
    const r = await generateAIImage({
      prompt: shot.ai_prompt,
      aspect_ratio: '9:16',
      filename_prefix: `v5-${scriptId}-shot${shot.shot_no}`,
    });
    if (r.ok && r.local_path) return { path: r.local_path, cost: r.cost_usd };
    return null;
  }

  if (shot.source === 'ai_video' && shot.ai_prompt) {
    const r = await generateAIVideo({
      prompt: shot.ai_prompt,
      duration_sec: 5,
      aspect_ratio: '9:16',
      filename_prefix: `v5-${scriptId}-shot${shot.shot_no}`,
    });
    if (r.ok && r.local_path) return { path: r.local_path, cost: r.cost_usd };
    return null;
  }

  return null;
}

/** Convert image to short video clip (for ai_image shots) */
function imageToClip(imagePath: string, durationSec: number, outPath: string): boolean {
  const args = [
    '-y',
    '-loop', '1',
    '-i', imagePath,
    '-t', String(durationSec),
    '-vf', 'scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,format=yuv420p',
    '-r', '30',
    '-c:v', 'libx264',
    '-preset', 'fast',
    outPath,
  ];
  const r = runFfmpeg(args);
  return r.ok && fs.existsSync(outPath);
}

/** Trim video clip to duration */
function trimClip(inPath: string, durationSec: number, outPath: string): boolean {
  const args = [
    '-y',
    '-i', inPath,
    '-t', String(durationSec),
    '-vf', 'scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,format=yuv420p',
    '-r', '30',
    '-c:v', 'libx264',
    '-preset', 'fast',
    '-an',                              // strip audio (we add VO+BGM later)
    outPath,
  ];
  const r = runFfmpeg(args);
  return r.ok && fs.existsSync(outPath);
}

/** Compose 1 variant: hook clip + body clips → MP4 with VO + BGM */
async function composeVariant(opts: {
  variant: 'a' | 'b' | 'c';
  scriptId: number;
  hookClipPath: string;             // 0-3s
  bodyClipPaths: string[];          // shot files for context/encounter/sensory/reflection/closing
  voAudioPath: string | null;       // synthesized VO (optional — silent if null)
  bgmPath: string;
  outPath: string;
}): Promise<{ ok: boolean; durationSec: number; sizeMb: number; error?: string }> {
  const tmpDir = path.dirname(opts.outPath);
  const concatList = path.join(tmpDir, `concat-${opts.variant}-${Date.now()}.txt`);

  try {
    const lines = [opts.hookClipPath, ...opts.bodyClipPaths].map(
      p => `file '${p.replace(/'/g, "'\\''")}'`,
    );
    fs.writeFileSync(concatList, lines.join('\n'));

    // Build complex filter: video concat + (optional) VO mix + BGM
    const args: string[] = ['-y', '-f', 'concat', '-safe', '0', '-i', concatList];
    if (opts.voAudioPath && fs.existsSync(opts.voAudioPath)) {
      args.push('-i', opts.voAudioPath);
    }
    if (fs.existsSync(opts.bgmPath)) {
      args.push('-i', opts.bgmPath);
    }

    // Filter complex: VO over BGM (BGM ducked when VO present)
    const hasVo = opts.voAudioPath && fs.existsSync(opts.voAudioPath);
    const hasBgm = fs.existsSync(opts.bgmPath);
    let filter = '';
    if (hasVo && hasBgm) {
      filter = '[1:a]volume=1.0[vo];[2:a]volume=0.15[bgm];[vo][bgm]amix=inputs=2:duration=first[a]';
      args.push('-filter_complex', filter);
      args.push('-map', '0:v', '-map', '[a]');
    } else if (hasVo) {
      args.push('-map', '0:v', '-map', '1:a');
    } else if (hasBgm) {
      args.push('-filter_complex', '[1:a]volume=0.5[a]');
      args.push('-map', '0:v', '-map', '[a]');
    } else {
      args.push('-map', '0:v', '-an');
    }

    args.push(
      '-c:v', 'libx264',
      '-preset', 'medium',
      '-crf', '20',
      '-c:a', 'aac',
      '-b:a', '128k',
      '-shortest',
      opts.outPath,
    );

    const r = runFfmpeg(args, 180000);
    if (!r.ok) {
      return { ok: false, durationSec: 0, sizeMb: 0, error: r.stderr.slice(-500) };
    }

    const stat = fs.statSync(opts.outPath);
    const dur = ffprobeDuration(opts.outPath);
    return { ok: true, durationSec: dur, sizeMb: stat.size / (1024 * 1024) };
  } catch (e: any) {
    return { ok: false, durationSec: 0, sizeMb: 0, error: e.message };
  } finally {
    try { fs.unlinkSync(concatList); } catch {}
  }
}

/* ───────── Main entry ───────── */

export async function renderV5Script(scriptId: number): Promise<{
  ok: boolean;
  variants: V5RenderedClip[];
  total_cost_usd: number;
  error?: string;
}> {
  const scriptRow = db.prepare(`SELECT * FROM v5_scripts WHERE id = ?`).get(scriptId) as any;
  if (!scriptRow) return { ok: false, variants: [], total_cost_usd: 0, error: 'script not found' };

  const visualPlan = JSON.parse(scriptRow.visual_plan_json) as { shots: V5Shot[] };
  const hooks = {
    a: JSON.parse(scriptRow.hook_a_json),
    b: JSON.parse(scriptRow.hook_b_json),
    c: JSON.parse(scriptRow.hook_c_json),
  };

  // Mark script as rendering
  db.prepare(`UPDATE v5_scripts SET status = 'rendering' WHERE id = ?`).run(scriptId);

  let totalCost = 0;
  const tmpDir = path.join(V5_OUT_DIR, `script-${scriptId}-tmp`);
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

  // 1. Resolve all body shots (skip first which is hook — variant-specific)
  const bodyShots = visualPlan.shots.slice(1);
  const bodyClipPaths: string[] = [];

  console.log(`[v5-composer] rendering ${bodyShots.length} body shots for script ${scriptId}`);
  for (const shot of bodyShots) {
    const file = await resolveShotToFile(shot, scriptId);
    if (!file) {
      console.warn(`[v5-composer] shot ${shot.shot_no} unresolved — skipping`);
      continue;
    }
    totalCost += file.cost;

    const shotDuration = shot.end_sec - shot.start_sec;
    const tmpClip = path.join(tmpDir, `body-shot-${shot.shot_no}.mp4`);

    // If image, convert to video; if video, trim
    const ext = path.extname(file.path).toLowerCase();
    const isImage = ['.jpg', '.jpeg', '.png', '.webp'].includes(ext);
    const success = isImage
      ? imageToClip(file.path, shotDuration, tmpClip)
      : trimClip(file.path, shotDuration, tmpClip);

    if (success) bodyClipPaths.push(tmpClip);
  }

  if (bodyClipPaths.length === 0) {
    db.prepare(`UPDATE v5_scripts SET status = 'failed' WHERE id = ?`).run(scriptId);
    return { ok: false, variants: [], total_cost_usd: totalCost, error: 'no body shots resolved' };
  }

  // 2. Synthesize VO body (shared across all 3 variants — body identical)
  const body = JSON.parse(scriptRow.body_json) as {
    context_vo: string;
    encounter_vo: string;
    reflection_vo: string;
    closing_vo: string;
  };
  const bodyVoText = [body.context_vo, body.encounter_vo, body.reflection_vo, body.closing_vo]
    .filter(Boolean)
    .join('. ');
  const voBodyPath = path.join(tmpDir, 'vo-body.mp3');
  let voBodyOk = false;
  if (bodyVoText.trim()) {
    console.log(`[v5-composer] synthesizing VO body (${bodyVoText.length} chars)`);
    try {
      const synthR = await synthesizeSonderVoice(bodyVoText, voBodyPath);
      voBodyOk = synthR.ok;
      console.log(`[v5-composer] VO body: ${synthR.ok ? 'OK ' + synthR.mode : 'FAIL ' + synthR.error}`);
    } catch (e: any) {
      console.warn('[v5-composer] VO synth fail:', e.message);
    }
  }

  // 3. For each variant — generate hook clip + VO hook + compose
  const variants: V5RenderedClip[] = [];
  const bgmPath = path.join(BGM_DIR, `mood_${scriptRow.bgm_mood || 'warm'}.mp3`);

  for (const v of ['a', 'b', 'c'] as const) {
    const hook = hooks[v];
    console.log(`[v5-composer] rendering variant ${v} (pattern: ${hook.pattern})`);

    // Hook image (3s)
    let hookClip = path.join(tmpDir, `hook-${v}.mp4`);
    if (hook.visual_prompt) {
      const r = await generateAIImage({
        prompt: hook.visual_prompt,
        aspect_ratio: '9:16',
        filename_prefix: `v5-${scriptId}-hook${v}`,
      });
      if (r.ok && r.local_path) {
        totalCost += r.cost_usd;
        imageToClip(r.local_path, 3, hookClip);
      }
    }
    if (!fs.existsSync(hookClip) && bodyClipPaths[0]) {
      // Fallback: reuse first body clip as hook
      hookClip = bodyClipPaths[0];
    }

    // Hook VO (skip nếu textural_asmr — silent design)
    let voHookPath: string | null = null;
    if (hook.vo_text && hook.pattern !== 'textural_asmr') {
      const tmpVo = path.join(tmpDir, `vo-hook-${v}.mp3`);
      const r = await synthesizeSonderVoice(hook.vo_text, tmpVo);
      if (r.ok) voHookPath = tmpVo;
    }

    // Concat hook VO + body VO into single track (always re-encode MP3 to keep size small)
    const finalVoPath = path.join(tmpDir, `vo-final-${v}.mp3`);
    const mp3Codec = ['-c:a', 'libmp3lame', '-b:a', '96k', '-ar', '24000'];
    if (voHookPath && voBodyOk) {
      const concatList = path.join(tmpDir, `vo-concat-${v}.txt`);
      fs.writeFileSync(concatList, `file '${voHookPath}'\nfile '${voBodyPath}'`);
      runFfmpeg(['-y', '-f', 'concat', '-safe', '0', '-i', concatList, ...mp3Codec, finalVoPath]);
    } else if (voBodyOk) {
      // Only body VO — pad 3s silence at start (where hook would be)
      runFfmpeg([
        '-y', '-f', 'lavfi', '-i', 'anullsrc=r=24000:cl=mono', '-t', '3',
        '-i', voBodyPath,
        '-filter_complex', '[0:a][1:a]concat=n=2:v=0:a=1[a]',
        '-map', '[a]', ...mp3Codec, finalVoPath,
      ]);
    } else if (voHookPath) {
      fs.copyFileSync(voHookPath, finalVoPath);
    }

    const outPath = path.join(V5_OUT_DIR, `script-${scriptId}-variant-${v}.mp4`);

    const result = await composeVariant({
      variant: v,
      scriptId,
      hookClipPath: hookClip,
      bodyClipPaths,
      voAudioPath: fs.existsSync(finalVoPath) ? finalVoPath : null,
      bgmPath,
      outPath,
    });

    if (result.ok) {
      const r = db.prepare(
        `INSERT INTO v5_rendered_clips
         (script_id, variant, hook_pattern, output_path, duration_sec, size_mb, cost_usd, rendered_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(scriptId, v, hook.pattern, outPath, result.durationSec, result.sizeMb, totalCost / 3, Date.now());

      variants.push({
        id: r.lastInsertRowid as number,
        script_id: scriptId,
        variant: v,
        hook_pattern: hook.pattern,
        output_path: outPath,
        duration_sec: result.durationSec,
        size_mb: result.sizeMb,
        cost_usd: totalCost / 3,
        rendered_at: Date.now(),
      });
      console.log(`[v5-composer] ✅ variant ${v} rendered: ${outPath} (${result.durationSec.toFixed(1)}s, ${result.sizeMb.toFixed(1)}MB)`);
    } else {
      console.warn(`[v5-composer] ❌ variant ${v} fail:`, result.error);
    }
  }

  // Cleanup tmp
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}

  // Update script status
  if (variants.length > 0) {
    db.prepare(`UPDATE v5_scripts SET status = 'rendered' WHERE id = ?`).run(scriptId);
    return { ok: true, variants, total_cost_usd: totalCost };
  } else {
    db.prepare(`UPDATE v5_scripts SET status = 'failed' WHERE id = ?`).run(scriptId);
    return { ok: false, variants: [], total_cost_usd: totalCost, error: 'no variants rendered' };
  }
}

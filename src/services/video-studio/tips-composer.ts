/**
 * Tips Composer — FFmpeg compose video tips với:
 *   - Number overlay BIG (1, 2, 3, 4, 5) prominent ở góc
 *   - Tip title text overlay (bold, contrast)
 *   - Visual stock clip (Pexels)
 *   - Voiceover ElevenLabs energetic
 *   - BGM energetic mood (uplifting fallback)
 *   - Quick cuts (12s/tip)
 *   - Hook 5s + 5 tips × 12s + CTA 10s = 75s total
 *
 * Output: 1080x1920 portrait MP4 cho FB Reels / IG Reels / YT Shorts.
 */

import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { db, getSetting } from '../../db';
import type { TipScene, TipsScript } from './tips-engine';
import type { TipVisual } from './tips-visuals';
// ⚡ Sonder brand voice — shared utility (skill: sonder-brand-voice)
// Edge-TTS HoaiMy → ElevenLabs STS với voice Ngân (a3AkyqGG4v8Pg7SWQ0Y3)
import { synthesizeSonderVoice, audioFileDuration } from '../sonder-voice';

const MEDIA_DIR = '/opt/vp-marketing/data/media';
const TIPS_OUT_DIR = path.join(MEDIA_DIR, 'tips-out');
const VOICE_DIR = path.join(MEDIA_DIR, 'tips-voices');

if (!fs.existsSync(TIPS_OUT_DIR)) fs.mkdirSync(TIPS_OUT_DIR, { recursive: true });
if (!fs.existsSync(VOICE_DIR)) fs.mkdirSync(VOICE_DIR, { recursive: true });

const FPS = 30;
const W = 1080;
const H = 1920;

// ═══════════════════════════════════════════════════════════
// Voice synthesis — DELEGATED to ../sonder-voice (brand voice skill)
// All TTS goes through Edge-TTS HoaiMy → ElevenLabs STS với voice Ngân
// ═══════════════════════════════════════════════════════════

interface VoiceSegment {
  text: string;
  audio_path: string;
  duration_sec: number;
}

/**
 * Synthesize all segments for tips video (hook + 5 tips + cta = 7 segments).
 *
 * Delegates to shared sonder-voice utility (skill: sonder-brand-voice).
 * Per-Tips override allowed via setting `vs_elevenlabs_voice_id_energetic`.
 */
export async function synthesizeTipsVoice(script: TipsScript, projectId: number): Promise<VoiceSegment[]> {
  // Tips can use specific energetic voice if admin sets it; otherwise default Ngân
  const tipsVoiceOverride = getSetting('vs_elevenlabs_voice_id_energetic') || undefined;

  const segments: VoiceSegment[] = [];
  const ts = Date.now();
  const modes: string[] = [];

  const buildPath = (suffix: string) => path.join(VOICE_DIR, `tips-${projectId}-${ts}-${suffix}.mp3`);

  // 1. Hook
  const hookPath = buildPath('hook');
  const hookR = await synthesizeSonderVoice(script.hook_text, hookPath, tipsVoiceOverride);
  if (!hookR.ok) throw new Error('hook synth fail: ' + hookR.error);
  modes.push(hookR.mode);
  segments.push({ text: script.hook_text, audio_path: hookPath, duration_sec: audioFileDuration(hookPath) });

  // 2. Tips × 5
  for (let i = 0; i < script.tips.length; i++) {
    const tip = script.tips[i];
    const tipPath = buildPath(`tip${i + 1}`);
    const r = await synthesizeSonderVoice(tip.text, tipPath, tipsVoiceOverride);
    if (!r.ok) throw new Error(`tip ${i + 1} synth fail: ` + r.error);
    modes.push(r.mode);
    segments.push({ text: tip.text, audio_path: tipPath, duration_sec: audioFileDuration(tipPath) });
  }

  // 3. CTA
  const ctaPath = buildPath('cta');
  const ctaR = await synthesizeSonderVoice(script.cta_text, ctaPath, tipsVoiceOverride);
  if (!ctaR.ok) throw new Error('cta synth fail: ' + ctaR.error);
  modes.push(ctaR.mode);
  segments.push({ text: script.cta_text, audio_path: ctaPath, duration_sec: audioFileDuration(ctaPath) });

  const stsCount = modes.filter(m => m === 'sts').length;
  console.log(`[tips-composer] voice synth: ${segments.length} segments (${stsCount} STS, ${modes.length - stsCount} edge-only) for project #${projectId}`);

  return segments;
}

// ═══════════════════════════════════════════════════════════
// FFmpeg compose
// ═══════════════════════════════════════════════════════════

interface ComposeOpts {
  script: TipsScript;
  voiceSegments: VoiceSegment[];     // [hook, tip1..5, cta] = 7 segments
  visuals: Array<TipVisual | null>;  // 5 (per tip), hook + cta dùng visual của tip 1 và tip 5
  bgmPath?: string;
  outputPath: string;
}

export async function composeTipsVideo(opts: ComposeOpts): Promise<{ output_path: string; duration: number; size_bytes: number }> {
  const { script, voiceSegments, visuals, bgmPath, outputPath } = opts;

  if (voiceSegments.length !== 7) {
    throw new Error(`expected 7 voice segments (hook + 5 tips + cta), got ${voiceSegments.length}`);
  }
  if (visuals.length !== 5) {
    throw new Error(`expected 5 visuals, got ${visuals.length}`);
  }

  // Check ffmpeg
  const ffCheck = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' });
  if (ffCheck.status !== 0) throw new Error('ffmpeg not available');

  const tempDir = path.dirname(outputPath);
  if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

  // Build scene segments (visual + audio + overlay text)
  // Scene 1: HOOK (5s) — use visual[0], hook voice, big hook text overlay
  // Scenes 2-6: TIPS 1-5 (12s each) — visual[i-1], tip voice, NUMBER + TITLE overlay
  // Scene 7: CTA (10s) — use visual[4] last frame, cta voice, CTA text overlay

  // To avoid FFmpeg multi-input bugs, render each segment to its own MP4 then concat
  const ts = Date.now();
  const segmentsDir = path.join(tempDir, `tips-segs-${ts}`);
  if (!fs.existsSync(segmentsDir)) fs.mkdirSync(segmentsDir, { recursive: true });

  const segmentPaths: string[] = [];

  try {
    // ─── 1. HOOK segment (5s) ───
    const hookVisual = visuals[0];
    if (!hookVisual) throw new Error('no visual for hook');
    const hookOut = path.join(segmentsDir, '01-hook.mp4');
    await renderSegment({
      visualPath: hookVisual.local_path,
      voicePath: voiceSegments[0].audio_path,
      duration: Math.max(4, voiceSegments[0].duration_sec + 0.5),    // hook ~5s
      outputPath: hookOut,
      overlayType: 'hook',
      overlayText: script.hook_text,
    });
    segmentPaths.push(hookOut);

    // ─── 2-6. TIP segments (5 tips × 12s) ───
    for (let i = 0; i < 5; i++) {
      const tipVisual = visuals[i];
      if (!tipVisual) {
        // Fallback: use previous visual or first
        const fb = visuals.find(v => v) || visuals[0];
        if (!fb) throw new Error(`no visual fallback for tip ${i + 1}`);
        console.warn(`[tips-composer] tip ${i + 1} missing visual, fallback`);
      }
      const useVisual = tipVisual || visuals.find(v => v)!;
      const tipOut = path.join(segmentsDir, `${String(i + 2).padStart(2, '0')}-tip${i + 1}.mp4`);

      const tip = script.tips[i];
      const voiceSeg = voiceSegments[i + 1];   // hook=0, tips start at 1
      const segDur = Math.max(8, Math.min(14, voiceSeg.duration_sec + 1.5));

      await renderSegment({
        visualPath: useVisual.local_path,
        voicePath: voiceSeg.audio_path,
        duration: segDur,
        outputPath: tipOut,
        overlayType: 'tip',
        tipNumber: tip.number,
        tipTitle: tip.title,
      });
      segmentPaths.push(tipOut);
    }

    // ─── 7. CTA segment (10s) ───
    const ctaVisual = visuals[4] || visuals.find(v => v);
    if (!ctaVisual) throw new Error('no visual for cta');
    const ctaOut = path.join(segmentsDir, '07-cta.mp4');
    await renderSegment({
      visualPath: ctaVisual.local_path,
      voicePath: voiceSegments[6].audio_path,
      duration: Math.max(8, voiceSegments[6].duration_sec + 1),
      outputPath: ctaOut,
      overlayType: 'cta',
      overlayText: script.cta_text,
    });
    segmentPaths.push(ctaOut);

    // ─── Concat all segments + BGM ───
    const concatList = path.join(segmentsDir, 'concat.txt');
    fs.writeFileSync(concatList, segmentPaths.map(p => `file '${p}'`).join('\n'));

    const finalArgs: string[] = [
      '-f', 'concat', '-safe', '0', '-i', concatList,
    ];

    let filterComplex = '';
    let mapVideo = '0:v';
    let mapAudio = '0:a';

    if (bgmPath && fs.existsSync(bgmPath)) {
      finalArgs.push('-stream_loop', '-1', '-i', bgmPath);
      // BGM ducking: voice prominent, BGM low
      filterComplex = [
        `[0:a]volume=1.0,asplit=2[voice_main][voice_sc]`,
        `[1:a]volume=0.20,afade=t=in:st=0:d=1[bgm_pre]`,
        `[bgm_pre][voice_sc]sidechaincompress=threshold=0.05:ratio=8:attack=5:release=200:level_sc=1[bgm_ducked]`,
        `[voice_main][bgm_ducked]amix=inputs=2:duration=first:dropout_transition=0:weights=1.0 0.6[outa]`,
      ].join(';');
      mapAudio = '[outa]';
    }

    finalArgs.push(
      ...(filterComplex ? ['-filter_complex', filterComplex] : []),
      '-map', mapVideo,
      '-map', mapAudio,
      '-c:v', 'libx264', '-profile:v', 'high', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p',
      '-r', String(FPS), '-g', String(FPS * 2),
      '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2',
      '-movflags', '+faststart',
      '-y', outputPath,
    );

    const r = spawnSync('ffmpeg', finalArgs, { encoding: 'utf8', maxBuffer: 200 * 1024 * 1024 });
    if (r.status !== 0) {
      const errTail = (r.stderr || '').split('\n').slice(-30).join('\n');
      throw new Error('ffmpeg final concat fail: ' + errTail);
    }

    const duration = audioFileDuration(outputPath);
    const size = fs.statSync(outputPath).size;

    // Cleanup intermediate segments
    for (const p of segmentPaths) try { fs.unlinkSync(p); } catch {}
    try { fs.unlinkSync(concatList); } catch {}
    try { fs.rmdirSync(segmentsDir); } catch {}

    return { output_path: outputPath, duration, size_bytes: size };
  } catch (e) {
    // Cleanup on error
    for (const p of segmentPaths) try { fs.unlinkSync(p); } catch {}
    try { fs.rmSync(segmentsDir, { recursive: true, force: true }); } catch {}
    throw e;
  }
}

// ═══════════════════════════════════════════════════════════
// Per-segment render (visual + voice + overlay)
// ═══════════════════════════════════════════════════════════

async function renderSegment(opts: {
  visualPath: string;
  voicePath: string;
  duration: number;
  outputPath: string;
  overlayType: 'hook' | 'tip' | 'cta';
  overlayText?: string;
  tipNumber?: number;
  tipTitle?: string;
}): Promise<void> {
  const { visualPath, voicePath, duration, outputPath, overlayType } = opts;
  const FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';

  // Visual: scale + crop to 1080x1920, loop video to duration, normalize fps
  const baseVf = `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setpts=PTS-STARTPTS,fps=${FPS}`;

  // Cinematic grade (mild)
  const grade = `eq=saturation=1.08:contrast=1.05:brightness=0.02`;

  // Vignette
  const vignette = `vignette=PI/4`;

  // Build overlay filter based on type
  let overlayFilter = '';

  if (overlayType === 'hook') {
    // Big hook text — top center, large, white with black outline + gradient bg behind
    const txt = escapeForFFmpeg(opts.overlayText || '');
    // Wrap to 2-3 lines for readability
    const wrapped = wrapText(txt, 22);
    const lines = wrapped.split('\n');

    // Box behind text
    overlayFilter += `,drawbox=x=40:y=300:w=${W - 80}:h=${100 + lines.length * 100}:color=black@0.55:t=fill`;

    // Each line drawn separately
    lines.forEach((line, idx) => {
      overlayFilter += `,drawtext=fontfile=${FONT}:text='${line}':fontsize=64:fontcolor=white:borderw=4:bordercolor=black:x=(w-text_w)/2:y=320+${idx * 90}`;
    });
  }

  if (overlayType === 'tip') {
    const num = opts.tipNumber || 1;
    const title = escapeForFFmpeg(opts.tipTitle || '');

    // BIG circle number bottom-left + tip title bottom-center
    // Number in colored circle (orange #FF8C42)
    overlayFilter += `,drawbox=x=60:y=${H - 280}:w=180:h=180:color=0xFF8C42:t=fill`;
    overlayFilter += `,drawtext=fontfile=${FONT}:text='${num}':fontsize=140:fontcolor=white:borderw=4:bordercolor=black:x=85+${num >= 10 ? 0 : 30}:y=${H - 280}`;

    // Title text (right of number bubble) — large bold
    const titleLines = wrapText(title, 16).split('\n').slice(0, 2);
    titleLines.forEach((line, idx) => {
      overlayFilter += `,drawbox=x=270:y=${H - 280 + idx * 90}:w=${W - 320}:h=80:color=black@0.65:t=fill`;
      overlayFilter += `,drawtext=fontfile=${FONT}:text='${escapeForFFmpeg(line)}':fontsize=58:fontcolor=white:borderw=2:bordercolor=black:x=290:y=${H - 270 + idx * 90}`;
    });
  }

  if (overlayType === 'cta') {
    const txt = escapeForFFmpeg(opts.overlayText || '');
    const wrapped = wrapText(txt, 20);
    const lines = wrapped.split('\n').slice(0, 3);

    overlayFilter += `,drawbox=x=40:y=${H / 2 - 200}:w=${W - 80}:h=${100 + lines.length * 100}:color=0xFF8C42@0.85:t=fill`;
    lines.forEach((line, idx) => {
      overlayFilter += `,drawtext=fontfile=${FONT}:text='${line}':fontsize=60:fontcolor=white:borderw=3:bordercolor=black:x=(w-text_w)/2:y=${H / 2 - 180 + idx * 90}`;
    });
  }

  const fadeIn = 0.3;
  const fadeOut = 0.3;
  const fadeFilter = `,fade=t=in:st=0:d=${fadeIn}:alpha=0,fade=t=out:st=${(duration - fadeOut).toFixed(2)}:d=${fadeOut}:alpha=0`;

  // Audio: pad/trim to exact duration
  const audioFilter = `[1:a]aresample=48000,apad=whole_dur=${duration.toFixed(3)},atrim=duration=${duration.toFixed(3)},asetpts=PTS-STARTPTS[outa]`;

  const args = [
    '-stream_loop', '-1', '-t', duration.toFixed(3), '-i', visualPath,
    '-i', voicePath,
    '-filter_complex', `[0:v]${baseVf},${grade},${vignette}${overlayFilter}${fadeFilter}[outv];${audioFilter}`,
    '-map', '[outv]',
    '-map', '[outa]',
    '-c:v', 'libx264', '-profile:v', 'high', '-preset', 'medium', '-crf', '21', '-pix_fmt', 'yuv420p',
    '-r', String(FPS), '-g', String(FPS * 2),
    '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2',
    '-t', duration.toFixed(3),
    '-movflags', '+faststart',
    '-y', outputPath,
  ];

  const r = spawnSync('ffmpeg', args, { encoding: 'utf8', maxBuffer: 100 * 1024 * 1024 });
  if (r.status !== 0) {
    const errTail = (r.stderr || '').split('\n').slice(-30).join('\n');
    throw new Error(`renderSegment fail (${overlayType}): ${errTail}`);
  }
}

// ═══════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════

function escapeForFFmpeg(s: string): string {
  // Escape special chars cho drawtext: : ' \ %
  return s
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "")
    .replace(/:/g, '\\:')
    .replace(/%/g, '\\%')
    .replace(/,/g, '\\,');
}

function wrapText(text: string, maxLen: number): string {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    if ((cur + ' ' + w).trim().length > maxLen) {
      if (cur) lines.push(cur.trim());
      cur = w;
    } else {
      cur = cur ? cur + ' ' + w : w;
    }
  }
  if (cur) lines.push(cur.trim());
  return lines.slice(0, 4).join('\n');
}

// ═══════════════════════════════════════════════════════════
// BGM picker — energetic mood, fallback uplifting
// ═══════════════════════════════════════════════════════════

const BGM_PATHS = {
  energetic: '/opt/vp-marketing/data/bgm/mood_energetic.mp3',
  uplifting: '/opt/vp-marketing/data/bgm/mood_uplifting.mp3',
  default: '/opt/vp-marketing/data/bgm/sonder-soft.mp3',
};

export function pickBgmForTips(): string | undefined {
  for (const p of [BGM_PATHS.energetic, BGM_PATHS.uplifting, BGM_PATHS.default]) {
    if (fs.existsSync(p)) {
      console.log(`[tips-composer] BGM: ${path.basename(p)}`);
      return p;
    }
  }
  console.warn('[tips-composer] no BGM found, video sẽ không có music bed');
  return undefined;
}

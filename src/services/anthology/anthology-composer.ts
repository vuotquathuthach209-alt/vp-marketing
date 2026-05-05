/**
 * Anthology Composer — FFmpeg compose 60-90s cinematic anthology video.
 *
 * Pipeline:
 *   1. Render 6 layer segments (Hook → Context → Encounter → Sensory → Reflection → Closing)
 *   2. Each layer: visual + voiceover + subtle subtitle + cinematic grade + watermark
 *   3. Layer-specific overlay style (hook = title text big, others = clean subtitle)
 *   4. Concat all 6 + add BGM with sidechain ducking
 *   5. Output 1080×1920 vertical MP4
 *
 * Style giữ ĐÚNG TÔNG Tập 1 "Sài Gòn Tháng Năm" baseline:
 *   - Cinematic curves (lift shadows, tame highlights, slight teal-orange)
 *   - Film grain noise
 *   - Vignette mềm
 *   - Watermark Sonder logo nhỏ góc dưới-phải (alpha 0.32)
 *   - BGM mood theo script.bgm_mood (warm/calm/cinematic/intimate/uplifting)
 *
 * Reference skill: sonder-storytelling
 */

import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { synthesizeSonderVoice, audioFileDuration } from '../sonder-voice';
import { getSetting } from '../../db';
import type { AnthologyScript, AnthologyLayer, LayerName } from './anthology-script-writer';
import { getCharacter } from './anthology-engine';

const MEDIA_DIR = '/opt/vp-marketing/data/media';
const ANTH_VOICE_DIR = path.join(MEDIA_DIR, 'anth-voices');
const ANTH_OUT_DIR = path.join(MEDIA_DIR, 'anth-out');
const ANTH_SEG_DIR = path.join(MEDIA_DIR, 'anth-segs');
const SONDER_LOGO = '/opt/vp-marketing/data/brand/sonder-logo.png';
const FONT_BOLD = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';
const FONT_REG = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf';

for (const d of [ANTH_VOICE_DIR, ANTH_OUT_DIR, ANTH_SEG_DIR]) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

const FPS = 30;
const W = 1080;
const H = 1920;

// ═══════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════

export type VisualType = 'image' | 'stock_video';

export interface AnthologyVisual {
  layer_no: number;                   // 1..6
  layer_name: LayerName;
  type: VisualType;
  local_path: string;
  visual_prompt: string;
}

export interface AnthologyVoiceSegment {
  layer_no: number;
  layer_name: LayerName;
  text: string;
  audio_path: string;
  duration_sec: number;
}

// ═══════════════════════════════════════════════════════════
// Voice synthesis — 6 segments (1 per layer)
// ═══════════════════════════════════════════════════════════

/**
 * Synthesize voice cho 6 layers.
 * Voice override theo character (chú Tuấn voice elder, etc) nếu có.
 */
export async function synthesizeAnthologyVoice(
  script: AnthologyScript,
  episodeId: number,
): Promise<AnthologyVoiceSegment[]> {
  // Pick voice ID:
  //   1. Character-specific override (e.g. chú Tuấn → voice elder)
  //   2. Setting `vs_elevenlabs_voice_id_owner` (Ngân clone)
  //   3. Default Ngân (a3AkyqGG4v8Pg7SWQ0Y3) baked in sonder-voice util
  const charProfile = getCharacter(script.primary_character);
  const charVoiceOverride: string | undefined = charProfile?.voice_id_override
    || getSetting('vs_elevenlabs_voice_id_owner')
    || undefined;

  const ts = Date.now();
  const segments: AnthologyVoiceSegment[] = [];
  const modes: string[] = [];

  for (const layer of script.layers) {
    const audioPath = path.join(
      ANTH_VOICE_DIR,
      `anth-${episodeId}-${ts}-l${layer.layer_no}-${layer.layer_name}.mp3`,
    );
    const r = await synthesizeSonderVoice(layer.voiceover_text, audioPath, charVoiceOverride);
    if (!r.ok) throw new Error(`layer ${layer.layer_no} (${layer.layer_name}) synth fail: ${r.error}`);
    modes.push(r.mode);
    segments.push({
      layer_no: layer.layer_no,
      layer_name: layer.layer_name,
      text: layer.voiceover_text,
      audio_path: audioPath,
      duration_sec: audioFileDuration(audioPath),
    });
  }

  const stsCount = modes.filter((m) => m === 'sts').length;
  console.log(
    `[anthology-composer] voice synth: ${segments.length}/6 (${stsCount} STS, ${modes.length - stsCount} edge-only) ep#${episodeId} char=${script.primary_character}`,
  );

  return segments;
}

// ═══════════════════════════════════════════════════════════
// FFmpeg helpers
// ═══════════════════════════════════════════════════════════

function escapeForFFmpeg(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/'/g, '')
    .replace(/:/g, '\\:')
    .replace(/%/g, '\\%')
    .replace(/,/g, '\\,');
}

function wrapText(text: string, maxLen: number, maxLines: number = 3): string[] {
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
  return lines.slice(0, maxLines);
}

// ═══════════════════════════════════════════════════════════
// Cinematic grade (matches Tập 1 baseline)
// ═══════════════════════════════════════════════════════════

const CINEMATIC_GRADE = `eq=saturation=1.05,curves=r='0/0.10 0.5/0.55 1/0.97':g='0/0.08 0.5/0.5 1/0.96':b='0/0.13 0.5/0.5 1/0.92'`;
const FILM_GRAIN = `noise=alls=3:allf=t`;
const VIGNETTE = `vignette=PI/4`;

// ═══════════════════════════════════════════════════════════
// Per-layer rendering
// ═══════════════════════════════════════════════════════════

async function renderLayerSegment(opts: {
  layer: AnthologyLayer;
  visual: AnthologyVisual;
  audioPath: string;
  duration: number;
  outputPath: string;
  isFirstLayer: boolean;
  isLastLayer: boolean;
  episodeTitle?: string;
}): Promise<void> {
  const { layer, visual, audioPath, duration, outputPath, isFirstLayer, isLastLayer, episodeTitle } = opts;

  // Visual base — adapt by type
  let inputArgs: string[];
  let videoFilter: string;

  if (visual.type === 'stock_video') {
    inputArgs = ['-stream_loop', '-1', '-t', duration.toFixed(3), '-i', visual.local_path];
    videoFilter = `[0:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setpts=PTS-STARTPTS,fps=${FPS},${CINEMATIC_GRADE},${FILM_GRAIN},${VIGNETTE}`;
  } else {
    // Static image with subtle Ken Burns zoom
    const frames = Math.max(1, Math.round(duration * FPS));
    inputArgs = ['-framerate', String(FPS), '-loop', '1', '-t', duration.toFixed(3), '-i', visual.local_path];
    videoFilter = `[0:v]scale=1620:2880:force_original_aspect_ratio=increase,crop=1620:2880,zoompan=z='min(zoom+0.0008,1.18)':d=${frames}:s=${W}x${H}:fps=${FPS},setpts=PTS-STARTPTS,${CINEMATIC_GRADE},${FILM_GRAIN},${VIGNETTE}`;
  }

  // Layer-specific overlays
  let overlayFilter = '';

  if (layer.layer_name === 'hook') {
    // Hook: BIG centered text, top-third, dramatic
    const wrapped = wrapText(layer.voiceover_text, 22, 3);
    const startY = 360;
    const lineH = 100;

    // Optional episode title small at very top (ep#N format)
    if (episodeTitle) {
      const titleEsc = escapeForFFmpeg(episodeTitle);
      overlayFilter += `,drawbox=x=0:y=140:w=${W}:h=70:color=black@0.40:t=fill`;
      overlayFilter += `,drawtext=fontfile=${FONT_REG}:text='${titleEsc}':fontsize=38:fontcolor=white@0.90:x=(w-text_w)/2:y=156`;
    }

    // Hook text box
    overlayFilter += `,drawbox=x=40:y=${startY - 30}:w=${W - 80}:h=${30 + wrapped.length * lineH + 20}:color=black@0.55:t=fill`;
    wrapped.forEach((line, idx) => {
      const escLine = escapeForFFmpeg(line);
      overlayFilter += `,drawtext=fontfile=${FONT_BOLD}:text='${escLine}':fontsize=64:fontcolor=white:borderw=4:bordercolor=black@0.9:x=(w-text_w)/2:y=${startY + idx * lineH}`;
    });
  } else if (layer.layer_name === 'closing') {
    // Closing: poetic 1-2 lines centered, smaller, italic-ish feel
    const wrapped = wrapText(layer.voiceover_text, 26, 2);
    const startY = H / 2 - 40;
    const lineH = 80;

    overlayFilter += `,drawbox=x=60:y=${startY - 20}:w=${W - 120}:h=${20 + wrapped.length * lineH + 20}:color=black@0.45:t=fill`;
    wrapped.forEach((line, idx) => {
      const escLine = escapeForFFmpeg(line);
      overlayFilter += `,drawtext=fontfile=${FONT_REG}:text='${escLine}':fontsize=52:fontcolor=white@0.95:borderw=3:bordercolor=black@0.85:x=(w-text_w)/2:y=${startY + idx * lineH}`;
    });
  } else {
    // Layers 2-5 (context/encounter/sensory/reflection): clean subtitle bottom
    const wrapped = wrapText(layer.voiceover_text, 24, 3);
    const subtitleStartY = H - 380;
    const lineH = 76;

    wrapped.forEach((line, idx) => {
      const escLine = escapeForFFmpeg(line);
      overlayFilter += `,drawbox=x=40:y=${subtitleStartY + idx * lineH}:w=${W - 80}:h=68:color=black@0.55:t=fill`;
      overlayFilter += `,drawtext=fontfile=${FONT_BOLD}:text='${escLine}':fontsize=44:fontcolor=white:borderw=2:bordercolor=black:x=(w-text_w)/2:y=${subtitleStartY + idx * lineH + 10}`;
    });
  }

  // Fade in/out
  const fadeIn = isFirstLayer ? 0.6 : 0.35;
  const fadeOut = isLastLayer ? 0.8 : 0.35;
  const fadeFilter = `,fade=t=in:st=0:d=${fadeIn}:alpha=0,fade=t=out:st=${(duration - fadeOut).toFixed(2)}:d=${fadeOut}:alpha=0`;

  videoFilter += `${overlayFilter}${fadeFilter}[outv_pre]`;

  // Watermark Sonder logo (alpha 0.32, bottom-right)
  const useWatermark = fs.existsSync(SONDER_LOGO);
  if (useWatermark) {
    inputArgs.push('-i', SONDER_LOGO);
    videoFilter += `;[1:v]colorkey=0xFFFFFF:0.10:0.05,scale=88:88,format=rgba,colorchannelmixer=aa=0.32[wm];[outv_pre][wm]overlay=W-w-32:H-h-72[outv]`;
  } else {
    videoFilter += `;[outv_pre]copy[outv]`;
  }

  const audioInputIdx = useWatermark ? 2 : 1;
  const audioFilter = `[${audioInputIdx}:a]aresample=48000,apad=whole_dur=${duration.toFixed(3)},atrim=duration=${duration.toFixed(3)},asetpts=PTS-STARTPTS[outa]`;

  const args = [
    ...inputArgs,
    '-i', audioPath,
    '-filter_complex', `${videoFilter};${audioFilter}`,
    '-map', '[outv]',
    '-map', '[outa]',
    '-c:v', 'libx264', '-profile:v', 'high', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p',
    '-r', String(FPS), '-g', String(FPS * 2),
    '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2',
    '-t', duration.toFixed(3),
    '-movflags', '+faststart',
    '-y', outputPath,
  ];

  const r = spawnSync('ffmpeg', args, { encoding: 'utf8', maxBuffer: 100 * 1024 * 1024 });
  if (r.status !== 0) {
    const errTail = (r.stderr || '').split('\n').slice(-30).join('\n');
    throw new Error(`renderLayerSegment fail (layer ${layer.layer_no} ${layer.layer_name}): ${errTail}`);
  }
}

// ═══════════════════════════════════════════════════════════
// Main compose entry
// ═══════════════════════════════════════════════════════════

export interface ComposeOpts {
  script: AnthologyScript;
  visuals: AnthologyVisual[];          // 6 (1 per layer)
  voiceSegments: AnthologyVoiceSegment[];  // 6
  bgmPath?: string;
  outputPath: string;
  episodeNo?: number;                  // for "Tập N" header
}

export interface ComposeResult {
  output_path: string;
  duration_sec: number;
  size_bytes: number;
  segments_rendered: number;
}

export async function composeAnthologyVideo(opts: ComposeOpts): Promise<ComposeResult> {
  const { script, visuals, voiceSegments, bgmPath, outputPath, episodeNo } = opts;

  if (script.layers.length !== 6) throw new Error(`script must have 6 layers, got ${script.layers.length}`);
  if (visuals.length !== 6) throw new Error(`expected 6 visuals, got ${visuals.length}`);
  if (voiceSegments.length !== 6) throw new Error(`expected 6 voice segments, got ${voiceSegments.length}`);

  const ffCheck = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' });
  if (ffCheck.status !== 0) throw new Error('ffmpeg not available on PATH');

  // Sort by layer_no to be safe
  const layers = [...script.layers].sort((a, b) => a.layer_no - b.layer_no);
  const sortedVisuals = [...visuals].sort((a, b) => a.layer_no - b.layer_no);
  const sortedVoice = [...voiceSegments].sort((a, b) => a.layer_no - b.layer_no);

  const ts = Date.now();
  const segDir = path.join(ANTH_SEG_DIR, `ep-${episodeNo || 'X'}-${ts}`);
  if (!fs.existsSync(segDir)) fs.mkdirSync(segDir, { recursive: true });

  const segPaths: string[] = [];
  const titleHeader = episodeNo ? `Tập ${episodeNo} • ${script.title}` : script.title;

  try {
    // ─── Render 6 layer segments ───
    for (let i = 0; i < 6; i++) {
      const layer = layers[i];
      const visual = sortedVisuals[i];
      const voice = sortedVoice[i];

      // Sanity check alignment
      if (visual.layer_no !== layer.layer_no || voice.layer_no !== layer.layer_no) {
        throw new Error(`layer alignment mismatch at index ${i}: layer=${layer.layer_no} visual=${visual.layer_no} voice=${voice.layer_no}`);
      }

      // Duration: target from script + actual voice + breathing room
      // Min/max guard: hook 3-7s, others 8-32s, closing 5-10s
      const audioDur = voice.duration_sec || 0;
      const target = layer.duration_target_sec || 10;
      let segDur: number;

      if (layer.layer_name === 'hook') {
        segDur = Math.max(3, Math.min(7, Math.max(audioDur + 0.6, target)));
      } else if (layer.layer_name === 'closing') {
        segDur = Math.max(5, Math.min(10, Math.max(audioDur + 1.0, target)));
      } else {
        segDur = Math.max(8, Math.min(32, Math.max(audioDur + 0.8, target)));
      }

      const segOut = path.join(segDir, `${String(i + 1).padStart(2, '0')}-${layer.layer_name}.mp4`);

      console.log(
        `[anthology-composer] layer ${i + 1}/6 ${layer.layer_name} | visual=${visual.type} | dur=${segDur.toFixed(1)}s (audio=${audioDur.toFixed(1)}s, target=${target}s)`,
      );

      await renderLayerSegment({
        layer,
        visual,
        audioPath: voice.audio_path,
        duration: segDur,
        outputPath: segOut,
        isFirstLayer: i === 0,
        isLastLayer: i === 5,
        episodeTitle: i === 0 ? titleHeader : undefined,
      });
      segPaths.push(segOut);
    }

    // ─── Concat + BGM ───
    const concatList = path.join(segDir, 'concat.txt');
    fs.writeFileSync(concatList, segPaths.map((p) => `file '${p}'`).join('\n'));

    const finalArgs: string[] = ['-f', 'concat', '-safe', '0', '-i', concatList];
    let mapAudio = '0:a';
    let filterComplex = '';

    if (bgmPath && fs.existsSync(bgmPath)) {
      finalArgs.push('-stream_loop', '-1', '-i', bgmPath);
      // Voice EQ + compressor + sidechain ducking BGM (fade-out implicit via duration=first)
      filterComplex = [
        `[0:a]equalizer=f=120:t=q:w=2:g=-3,equalizer=f=2400:t=q:w=2:g=2,acompressor=threshold=0.1:ratio=3:attack=20:release=200,asplit=2[voice_main][voice_sc]`,
        `[1:a]volume=0.20,afade=t=in:st=0:d=2.0[bgm_pre]`,
        `[bgm_pre][voice_sc]sidechaincompress=threshold=0.04:ratio=10:attack=5:release=300:level_sc=1[bgm_ducked]`,
        `[voice_main][bgm_ducked]amix=inputs=2:duration=first:weights=1.0 0.65[outa]`,
      ].join(';');
      mapAudio = '[outa]';
    }

    finalArgs.push(
      ...(filterComplex ? ['-filter_complex', filterComplex] : []),
      '-map', '0:v', '-map', mapAudio,
      '-c:v', 'libx264', '-profile:v', 'high', '-preset', 'medium', '-crf', '19', '-pix_fmt', 'yuv420p',
      '-r', String(FPS),
      '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2',
      '-movflags', '+faststart',
      '-y', outputPath,
    );

    const r = spawnSync('ffmpeg', finalArgs, { encoding: 'utf8', maxBuffer: 200 * 1024 * 1024 });
    if (r.status !== 0) {
      const errTail = (r.stderr || '').split('\n').slice(-30).join('\n');
      throw new Error(`anthology final compose fail: ${errTail}`);
    }

    const duration = audioFileDuration(outputPath);
    const size = fs.statSync(outputPath).size;

    // Cleanup
    for (const p of segPaths) try { fs.unlinkSync(p); } catch {}
    try { fs.unlinkSync(concatList); } catch {}
    try { fs.rmdirSync(segDir); } catch {}

    console.log(`[anthology-composer] ✅ rendered "${script.title}" duration=${duration.toFixed(1)}s size=${(size / 1024 / 1024).toFixed(2)}MB`);

    return {
      output_path: outputPath,
      duration_sec: duration,
      size_bytes: size,
      segments_rendered: segPaths.length,
    };
  } catch (e) {
    // Cleanup on error
    for (const p of segPaths) try { fs.unlinkSync(p); } catch {}
    try { fs.rmSync(segDir, { recursive: true, force: true }); } catch {}
    throw e;
  }
}

// ═══════════════════════════════════════════════════════════
// BGM picker — based on script.bgm_mood + LICENSE PROVENANCE CHECK
// ═══════════════════════════════════════════════════════════
//
// CRITICAL (post 2026-05-05 BGM violation): BGM file MUST be listed in
// /opt/vp-marketing/data/bgm/bgm-licenses.json with verified=true.
// Files without provenance = REJECTED to prevent copyright violation
// (untraceable BGM caused FB takedown of ep#14).

const BGM_DIR = '/opt/vp-marketing/data/bgm';
const BGM_LICENSES_PATH = path.join(BGM_DIR, 'bgm-licenses.json');

const BGM_MOOD_FILES: Record<string, string[]> = {
  warm:       ['mood_warm.mp3', 'mood_intimate.mp3', 'pixabay-relaxing-piano.mp3'],
  calm:       ['mood_calm.mp3', 'mood_warm.mp3', 'pixabay-relaxing-piano.mp3'],
  cinematic:  ['mood_cinematic.mp3', 'mood_uplifting.mp3', 'mood_warm.mp3'],
  intimate:   ['mood_intimate.mp3', 'mood_warm.mp3', 'pixabay-relaxing-piano.mp3'],
  uplifting:  ['mood_uplifting.mp3', 'mood_cinematic.mp3', 'mood_warm.mp3'],
};

interface BgmLicense {
  provider?: string;
  license?: string;
  verified?: boolean;
}

interface BgmLicensesFile {
  tracks: Record<string, BgmLicense>;
}

let bgmLicensesCache: BgmLicensesFile | null = null;
let bgmLicensesCachedAt = 0;

function loadBgmLicenses(): BgmLicensesFile {
  const TTL_MS = 60_000;
  if (bgmLicensesCache && Date.now() - bgmLicensesCachedAt < TTL_MS) return bgmLicensesCache;
  if (!fs.existsSync(BGM_LICENSES_PATH)) {
    bgmLicensesCache = { tracks: {} };
  } else {
    try {
      bgmLicensesCache = JSON.parse(fs.readFileSync(BGM_LICENSES_PATH, 'utf-8'));
    } catch (e: any) {
      console.warn(`[anthology-composer] bgm-licenses.json parse fail: ${e?.message}`);
      bgmLicensesCache = { tracks: {} };
    }
  }
  bgmLicensesCachedAt = Date.now();
  return bgmLicensesCache!;
}

function isBgmVerified(filename: string): boolean {
  const licenses = loadBgmLicenses();
  const track = licenses.tracks[filename];
  return !!(track && track.verified === true);
}

export function pickBgmForAnthology(mood: string): string | undefined {
  const candidates = BGM_MOOD_FILES[mood] || BGM_MOOD_FILES.warm;

  for (const filename of candidates) {
    const p = path.join(BGM_DIR, filename);
    if (!fs.existsSync(p)) continue;

    // CRITICAL: provenance check — REJECT untraceable BGM
    if (!isBgmVerified(filename)) {
      console.warn(`[anthology-composer] ⚠ BGM REJECTED (no provenance): ${filename} — add to bgm-licenses.json with verified=true`);
      continue;
    }

    console.log(`[anthology-composer] BGM: ${filename} (mood=${mood}) ✅ verified`);
    return p;
  }

  // Final fallback — only if also verified
  for (const fbName of ['mood_warm.mp3', 'pixabay-relaxing-piano.mp3']) {
    const fbPath = path.join(BGM_DIR, fbName);
    if (fs.existsSync(fbPath) && isBgmVerified(fbName)) {
      console.log(`[anthology-composer] BGM fallback verified: ${fbName} (mood=${mood} not found)`);
      return fbPath;
    }
  }

  console.warn(`[anthology-composer] ❌ NO VERIFIED BGM available for mood=${mood} — video will be silent (no music bed)`);
  return undefined;
}

// ═══════════════════════════════════════════════════════════
// Output path helper
// ═══════════════════════════════════════════════════════════

export function buildAnthologyOutputPath(episodeNo: number, characterSlug: string): string {
  const stamp = new Date().toISOString().slice(0, 10);
  const safeChar = characterSlug.replace(/[^a-z0-9]/gi, '');
  return path.join(ANTH_OUT_DIR, `anth-${stamp}-ep${episodeNo}-${safeChar}.mp4`);
}

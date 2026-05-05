/**
 * Cinema Composer — FFmpeg stitch 18-23 pre-rendered shots into 5-7 phút final.
 *
 * Per-shot processing:
 *   - Take pre-rendered video from provider (Veo/Hailuo/Seedance/Hedra)
 *   - Apply cinematic grade (curves teal-orange, film grain, vignette)
 *   - Overlay subtitle (if voiceover_text) bottom-third
 *   - Mix audio: shot's own audio (Veo ambient, Hedra lip-sync) + ElevenLabs VO
 *   - Cross-fade transition between shots (0.4s)
 *   - Watermark Sonder logo bottom-right (alpha 0.32)
 *
 * Final pass:
 *   - Concat all 18-23 shots với cross-fades
 *   - Add BGM with sidechain ducking
 *   - 1080x1920 H.264 portrait MP4
 *   - 60s TEASER cut (Act II climax) for FB Reels
 *
 * Reference skill: sonder-cinema
 */

import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { audioFileDuration } from '../sonder-voice';
import type { StoryboardShot } from './cinema-storyboard';
import type { CinemaVoiceSegment } from './cinema-voice';
import type { CinemaScript } from './cinema-script-writer';

const MEDIA_DIR = '/opt/vp-marketing/data/media';
const CINEMA_OUT_DIR = path.join(MEDIA_DIR, 'cinema-out');
const CINEMA_SEG_DIR = path.join(MEDIA_DIR, 'cinema-segs');
const SONDER_LOGO = '/opt/vp-marketing/data/brand/sonder-logo.png';
const FONT_BOLD = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';
const FONT_REG = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf';

for (const d of [CINEMA_OUT_DIR, CINEMA_SEG_DIR]) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

const FPS = 30;
const W = 1080;
const H = 1920;

// ═══════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════

export interface CinemaShotMaterial {
  shot_no: number;
  shot: StoryboardShot;
  generated_video_path: string;        // local mp4 from provider
  voice: CinemaVoiceSegment | null;    // voice file (or null/silent)
  has_embedded_audio: boolean;         // Veo audio | Hedra lip-sync
}

export interface ComposeOpts {
  script: CinemaScript;
  episodeId: number;
  episodeNo: number;
  materials: CinemaShotMaterial[];     // sorted by shot_no
  bgmPath?: string;
  outputPath: string;
}

export interface ComposeResult {
  output_path: string;
  duration_sec: number;
  size_bytes: number;
  segments_rendered: number;
  teaser_path?: string;
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

function wrapText(text: string, maxLen: number, maxLines = 3): string[] {
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
// Cinematic grade (matches Anthology baseline)
// ═══════════════════════════════════════════════════════════

const CINEMATIC_GRADE = `eq=saturation=1.05,curves=r='0/0.10 0.5/0.55 1/0.97':g='0/0.08 0.5/0.5 1/0.96':b='0/0.13 0.5/0.5 1/0.92'`;
const FILM_GRAIN = `noise=alls=3:allf=t`;
const VIGNETTE = `vignette=PI/4`;

// ═══════════════════════════════════════════════════════════
// Process 1 shot: regrade + subtitle + watermark + audio mix
// ═══════════════════════════════════════════════════════════

async function processShot(
  material: CinemaShotMaterial,
  outputPath: string,
  episodeNo: number,
  isFirst: boolean,
  isLast: boolean,
  episodeTitle?: string,
): Promise<{ duration: number }> {
  const { shot, generated_video_path: srcVideo, voice, has_embedded_audio } = material;

  // Determine duration target
  // Use shot.duration_target_sec but cap by audio duration if voice exists
  let segDur: number;
  if (voice && voice.audio_path && voice.duration_sec > 0) {
    segDur = Math.max(shot.duration_target_sec, voice.duration_sec + 0.5);
  } else {
    segDur = shot.duration_target_sec;
  }
  // Cap absolute: 4-25s per shot (cinema shouldn't have longer single shots)
  segDur = Math.max(4, Math.min(25, segDur));

  // Build FFmpeg input args
  const inputs: string[] = ['-stream_loop', '-1', '-t', segDur.toFixed(3), '-i', srcVideo];
  let audioInputIdx = 1;                                // next available audio input

  // Add voice input if non-Hedra and voice exists
  const useExternalVoice = voice && voice.audio_path && !has_embedded_audio;
  if (useExternalVoice) {
    inputs.push('-i', voice!.audio_path);
    audioInputIdx = 1;
  }

  // Add Sonder logo input
  const useWatermark = fs.existsSync(SONDER_LOGO);
  if (useWatermark) inputs.push('-i', SONDER_LOGO);

  // ─── Video filter chain ───
  let videoFilter = `[0:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setpts=PTS-STARTPTS,fps=${FPS},${CINEMATIC_GRADE},${FILM_GRAIN},${VIGNETTE}`;

  // Subtitle (bottom-third) for shots với voiceover (skip cold_open + outro)
  let overlayFilter = '';
  const isStorytellingShot = shot.act === 'act1' || shot.act === 'act2' || shot.act === 'act3' || shot.act === 'title';
  if (shot.voiceover_text && shot.voiceover_text.length > 5 && isStorytellingShot) {
    const wrapped = wrapText(shot.voiceover_text, 26, 3);
    const startY = H - 380;
    const lineH = 76;
    wrapped.forEach((line, idx) => {
      const escLine = escapeForFFmpeg(line);
      overlayFilter += `,drawbox=x=40:y=${startY + idx * lineH}:w=${W - 80}:h=68:color=black@0.55:t=fill`;
      overlayFilter += `,drawtext=fontfile=${FONT_BOLD}:text='${escLine}':fontsize=42:fontcolor=white:borderw=2:bordercolor=black:x=(w-text_w)/2:y=${startY + idx * lineH + 10}`;
    });
  }

  // Title card overlay for cold_open or title act
  if (shot.act === 'title' && episodeTitle) {
    const titleEsc = escapeForFFmpeg(episodeTitle);
    overlayFilter += `,drawbox=x=0:y=${H / 2 - 80}:w=${W}:h=160:color=black@0.45:t=fill`;
    overlayFilter += `,drawtext=fontfile=${FONT_REG}:text='${titleEsc}':fontsize=52:fontcolor=white:x=(w-text_w)/2:y=${H / 2 - 30}`;
  }

  // Fade in/out
  const fadeIn = isFirst ? 0.8 : 0.3;
  const fadeOut = isLast ? 1.0 : 0.3;
  const fadeFilter = `,fade=t=in:st=0:d=${fadeIn}:alpha=0,fade=t=out:st=${(segDur - fadeOut).toFixed(2)}:d=${fadeOut}:alpha=0`;

  videoFilter += `${overlayFilter}${fadeFilter}[outv_pre]`;

  // Watermark
  if (useWatermark) {
    const wmInputIdx = useExternalVoice ? 2 : 1;
    videoFilter += `;[${wmInputIdx}:v]colorkey=0xFFFFFF:0.10:0.05,scale=88:88,format=rgba,colorchannelmixer=aa=0.32[wm];[outv_pre][wm]overlay=W-w-32:H-h-72[outv]`;
  } else {
    videoFilter += `;[outv_pre]copy[outv]`;
  }

  // ─── Audio chain ───
  // 3 cases:
  //   A. has_embedded_audio (Veo with audio, Hedra lip-sync) + no external voice → use embedded
  //   B. external voice + no embedded audio (Hailuo, Seedance, Veo no-audio) → use external
  //   C. external voice + embedded audio (Veo audio + we want our VO too) → mix at -8dB embedded
  let audioFilter: string;
  if (useExternalVoice) {
    if (has_embedded_audio) {
      // Mix: external voice 1.0 + embedded ambient at 0.4
      audioFilter = `[0:a]volume=0.4,aresample=48000[amb];[${audioInputIdx}:a]aresample=48000,volume=1.0[vo];[amb][vo]amix=inputs=2:duration=first:weights=0.4 1.0,apad=whole_dur=${segDur.toFixed(3)},atrim=duration=${segDur.toFixed(3)},asetpts=PTS-STARTPTS[outa]`;
    } else {
      // External voice only
      audioFilter = `[${audioInputIdx}:a]aresample=48000,apad=whole_dur=${segDur.toFixed(3)},atrim=duration=${segDur.toFixed(3)},asetpts=PTS-STARTPTS[outa]`;
    }
  } else {
    if (has_embedded_audio) {
      // Use embedded audio (Veo ambient or Hedra lip-sync) directly
      audioFilter = `[0:a]aresample=48000,apad=whole_dur=${segDur.toFixed(3)},atrim=duration=${segDur.toFixed(3)},asetpts=PTS-STARTPTS[outa]`;
    } else {
      // No audio at all → silent
      audioFilter = `aevalsrc=0:duration=${segDur.toFixed(3)}[outa]`;
    }
  }

  // ─── Run FFmpeg ───
  const args = [
    ...inputs,
    '-filter_complex', `${videoFilter};${audioFilter}`,
    '-map', '[outv]',
    '-map', '[outa]',
    '-c:v', 'libx264', '-profile:v', 'high', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p',
    '-r', String(FPS), '-g', String(FPS * 2),
    '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2',
    '-t', segDur.toFixed(3),
    '-movflags', '+faststart',
    '-y', outputPath,
  ];

  const r = spawnSync('ffmpeg', args, { encoding: 'utf8', maxBuffer: 200 * 1024 * 1024 });
  if (r.status !== 0) {
    const errTail = (r.stderr || '').split('\n').slice(-30).join('\n');
    throw new Error(`processShot fail (shot ${shot.shot_no} ${shot.act}): ${errTail}`);
  }

  return { duration: segDur };
}

// ═══════════════════════════════════════════════════════════
// Final concat + BGM mix
// ═══════════════════════════════════════════════════════════

async function concatWithBgm(
  segmentPaths: string[],
  outputPath: string,
  bgmPath?: string,
): Promise<{ duration: number; size: number }> {
  const segDir = path.dirname(segmentPaths[0]);
  const concatList = path.join(segDir, 'concat.txt');
  fs.writeFileSync(concatList, segmentPaths.map((p) => `file '${p}'`).join('\n'));

  const args: string[] = ['-f', 'concat', '-safe', '0', '-i', concatList];
  let mapAudio = '0:a';
  let filterComplex = '';

  if (bgmPath && fs.existsSync(bgmPath)) {
    args.push('-stream_loop', '-1', '-i', bgmPath);
    filterComplex = [
      `[0:a]equalizer=f=120:t=q:w=2:g=-3,equalizer=f=2400:t=q:w=2:g=2,acompressor=threshold=0.1:ratio=3:attack=20:release=200,asplit=2[voice_main][voice_sc]`,
      `[1:a]volume=0.18,afade=t=in:st=0:d=3.0[bgm_pre]`,
      `[bgm_pre][voice_sc]sidechaincompress=threshold=0.04:ratio=10:attack=5:release=350:level_sc=1[bgm_ducked]`,
      `[voice_main][bgm_ducked]amix=inputs=2:duration=first:weights=1.0 0.6[outa]`,
    ].join(';');
    mapAudio = '[outa]';
  }

  args.push(
    ...(filterComplex ? ['-filter_complex', filterComplex] : []),
    '-map', '0:v', '-map', mapAudio,
    '-c:v', 'libx264', '-profile:v', 'high', '-preset', 'medium', '-crf', '19', '-pix_fmt', 'yuv420p',
    '-r', String(FPS),
    '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2',
    '-movflags', '+faststart',
    '-y', outputPath,
  );

  const r = spawnSync('ffmpeg', args, { encoding: 'utf8', maxBuffer: 400 * 1024 * 1024 });
  if (r.status !== 0) {
    const errTail = (r.stderr || '').split('\n').slice(-30).join('\n');
    throw new Error(`concatWithBgm fail: ${errTail}`);
  }

  return {
    duration: audioFileDuration(outputPath),
    size: fs.statSync(outputPath).size,
  };
}

// ═══════════════════════════════════════════════════════════
// Generate FB Reels 60s teaser cut
// (extract Act II climax: best shot + closing line)
// ═══════════════════════════════════════════════════════════

async function generateTeaserCut(
  fullVideoPath: string,
  teaserPath: string,
  totalDuration: number,
): Promise<{ duration: number; size: number }> {
  // Strategy: take first 50-55s of Act II (typically starts around 105s mark)
  // For 6 min video: extract from 60s to 120s = 60s window
  // Vertical: just trim
  const startSec = Math.max(60, Math.min(totalDuration - 80, 100));
  const teaserDur = 58;

  const args = [
    '-ss', startSec.toString(),
    '-i', fullVideoPath,
    '-t', teaserDur.toString(),
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '20',
    '-c:a', 'aac', '-b:a', '160k',
    '-movflags', '+faststart',
    '-y', teaserPath,
  ];

  const r = spawnSync('ffmpeg', args, { encoding: 'utf8', maxBuffer: 100 * 1024 * 1024 });
  if (r.status !== 0) {
    throw new Error(`teaser cut fail: ${(r.stderr || '').slice(-500)}`);
  }

  return {
    duration: audioFileDuration(teaserPath),
    size: fs.statSync(teaserPath).size,
  };
}

// ═══════════════════════════════════════════════════════════
// MAIN ENTRY
// ═══════════════════════════════════════════════════════════

export async function composeCinemaVideo(opts: ComposeOpts): Promise<ComposeResult> {
  const { script, episodeId, episodeNo, materials, bgmPath, outputPath } = opts;

  if (materials.length < 10) throw new Error(`too few materials: ${materials.length} (need 18-23)`);

  // FFmpeg sanity
  const ffCheck = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' });
  if (ffCheck.status !== 0) throw new Error('ffmpeg not available');

  // Sort by shot_no
  const sorted = [...materials].sort((a, b) => a.shot_no - b.shot_no);

  const ts = Date.now();
  const segDir = path.join(CINEMA_SEG_DIR, `ep${episodeNo}-${ts}`);
  fs.mkdirSync(segDir, { recursive: true });

  const titleHeader = `Sonder Cinema #${episodeNo} • ${script.title}`;

  const segPaths: string[] = [];

  try {
    // ─── Process each shot ───
    for (let i = 0; i < sorted.length; i++) {
      const m = sorted[i];
      const segOut = path.join(segDir, `${String(m.shot_no).padStart(2, '0')}-${m.shot.act}.mp4`);

      console.log(`[cinema-composer] shot ${i + 1}/${sorted.length} (${m.shot.act} ${m.shot.shot_type}, ${m.shot.duration_target_sec}s, src=${path.basename(m.generated_video_path)})`);

      try {
        const r = await processShot(
          m,
          segOut,
          episodeNo,
          i === 0,
          i === sorted.length - 1,
          i === 0 || m.shot.act === 'title' ? titleHeader : undefined,
        );
        segPaths.push(segOut);
      } catch (e: any) {
        // 1 shot fail không block whole episode — drop shot, continue
        console.warn(`[cinema-composer] shot ${m.shot_no} fail (DROPPING): ${e?.message}`);
      }
    }

    if (segPaths.length === 0) throw new Error('no shots successfully rendered');

    // ─── Concat with BGM ───
    console.log(`[cinema-composer] concatenating ${segPaths.length} segments + BGM mood=${script.bgm_mood}`);
    const final = await concatWithBgm(segPaths, outputPath, bgmPath);

    // ─── Generate 60s teaser cut for FB Reels ───
    let teaserPath: string | undefined;
    try {
      teaserPath = outputPath.replace(/\.mp4$/, '-teaser60s.mp4');
      const teaserR = await generateTeaserCut(outputPath, teaserPath, final.duration);
      console.log(`[cinema-composer] teaser cut: ${path.basename(teaserPath)} (${teaserR.duration.toFixed(1)}s)`);
    } catch (e: any) {
      console.warn(`[cinema-composer] teaser cut fail (continuing without): ${e?.message}`);
      teaserPath = undefined;
    }

    // Cleanup intermediate segments
    for (const p of segPaths) try { fs.unlinkSync(p); } catch {}
    try { fs.unlinkSync(path.join(segDir, 'concat.txt')); } catch {}
    try { fs.rmdirSync(segDir); } catch {}

    console.log(`[cinema-composer] ✅ rendered "${script.title}" duration=${final.duration.toFixed(1)}s size=${(final.size / 1024 / 1024).toFixed(2)}MB`);

    return {
      output_path: outputPath,
      duration_sec: final.duration,
      size_bytes: final.size,
      segments_rendered: segPaths.length,
      teaser_path: teaserPath,
    };
  } catch (e) {
    // Cleanup on error
    for (const p of segPaths) try { fs.unlinkSync(p); } catch {}
    try { fs.rmSync(segDir, { recursive: true, force: true }); } catch {}
    throw e;
  }
}

// ═══════════════════════════════════════════════════════════
// BGM picker với LICENSE PROVENANCE CHECK
// ═══════════════════════════════════════════════════════════
// CRITICAL: BGM file MUST be in bgm-licenses.json with verified=true
// (post 2026-05-05 BGM violation policy)

const BGM_DIR = '/opt/vp-marketing/data/bgm';
const BGM_LICENSES_PATH = path.join(BGM_DIR, 'bgm-licenses.json');

const BGM_MOOD_FILES: Record<string, string[]> = {
  warm: ['mood_warm.mp3', 'mood_intimate.mp3', 'pixabay-relaxing-piano.mp3'],
  calm: ['mood_calm.mp3', 'mood_warm.mp3', 'pixabay-relaxing-piano.mp3'],
  cinematic: ['mood_cinematic.mp3', 'mood_uplifting.mp3', 'mood_warm.mp3'],
  intimate: ['mood_intimate.mp3', 'mood_warm.mp3', 'pixabay-relaxing-piano.mp3'],
  uplifting: ['mood_uplifting.mp3', 'mood_cinematic.mp3', 'mood_warm.mp3'],
};

let cinemaBgmLicensesCache: any = null;
let cinemaBgmLicensesCachedAt = 0;

function loadCinemaBgmLicenses(): any {
  if (cinemaBgmLicensesCache && Date.now() - cinemaBgmLicensesCachedAt < 60_000) return cinemaBgmLicensesCache;
  if (!fs.existsSync(BGM_LICENSES_PATH)) {
    cinemaBgmLicensesCache = { tracks: {} };
  } else {
    try { cinemaBgmLicensesCache = JSON.parse(fs.readFileSync(BGM_LICENSES_PATH, 'utf-8')); }
    catch { cinemaBgmLicensesCache = { tracks: {} }; }
  }
  cinemaBgmLicensesCachedAt = Date.now();
  return cinemaBgmLicensesCache;
}

function isCinemaBgmVerified(filename: string): boolean {
  const t = loadCinemaBgmLicenses().tracks?.[filename];
  return !!(t && t.verified === true);
}

export function pickBgmForCinema(mood: string): string | undefined {
  const candidates = BGM_MOOD_FILES[mood] || BGM_MOOD_FILES.warm;
  for (const filename of candidates) {
    const p = path.join(BGM_DIR, filename);
    if (!fs.existsSync(p)) continue;
    if (!isCinemaBgmVerified(filename)) {
      console.warn(`[cinema-composer] ⚠ BGM REJECTED (no provenance): ${filename}`);
      continue;
    }
    console.log(`[cinema-composer] BGM: ${filename} ✅ verified`);
    return p;
  }
  console.warn(`[cinema-composer] ❌ no verified BGM for mood=${mood} — silent fallback`);
  return undefined;
}

export function buildCinemaOutputPath(episodeNo: number, characterSlug: string): string {
  const stamp = new Date().toISOString().slice(0, 10);
  const safe = characterSlug.replace(/[^a-z0-9]/gi, '');
  return path.join(CINEMA_OUT_DIR, `cinema-${stamp}-ep${episodeNo}-${safe}.mp4`);
}

/**
 * Weekend Composer — FFmpeg compose 90-120s premium video.
 *
 * Cinematic style (giống story-to-video nhưng cho weekend theme):
 *   - Per-scene render với cinematic grade (curves, film grain, vignette)
 *   - Optional overlay text (timeline "07:00" cho day_in_area theme)
 *   - Concat scenes
 *   - BGM duck với voice
 *   - Sonder watermark
 *
 * Output 1080×1920 vertical MP4.
 */

import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { db, getSetting } from '../../db';
import type { WeekendScene, WeekendThemeType } from './weekend-engine';
import type { WeekendVisual } from './weekend-visuals';
import { THEME_METADATA } from './weekend-engine';
// ⚡ Sonder brand voice — shared utility (skill: sonder-brand-voice)
import { synthesizeSonderVoice, audioFileDuration } from '../sonder-voice';

const MEDIA_DIR = '/opt/vp-marketing/data/media';
const WEEKEND_VOICE_DIR = path.join(MEDIA_DIR, 'weekend-voices');
const WEEKEND_OUT_DIR = path.join(MEDIA_DIR, 'weekend-out');
const SONDER_LOGO = '/opt/vp-marketing/data/brand/sonder-logo.png';

if (!fs.existsSync(WEEKEND_VOICE_DIR)) fs.mkdirSync(WEEKEND_VOICE_DIR, { recursive: true });
if (!fs.existsSync(WEEKEND_OUT_DIR)) fs.mkdirSync(WEEKEND_OUT_DIR, { recursive: true });

const FPS = 30;
const W = 1080;
const H = 1920;

// ═══════════════════════════════════════════════════════════
// Voice synthesis (premium voice — different per theme)
// ═══════════════════════════════════════════════════════════

interface VoiceSegment {
  scene_idx: number;
  text: string;
  audio_path: string;
  duration_sec: number;
}

function pickVoiceIdForTheme(theme: WeekendThemeType): string | undefined {
  // Per-theme voice (allow setting override).
  // Pattern: dùng STS với voice Ngân (a3AkyqGG4v8Pg7SWQ0Y3) cho mọi theme.
  // Nếu admin muốn voice khác cho theme cụ thể, set vs_elevenlabs_voice_id_{style}.
  const meta = THEME_METADATA[theme];
  const settingKey = `vs_elevenlabs_voice_id_${meta.voice_style}`;
  return getSetting(settingKey)
    || getSetting('vs_elevenlabs_voice_id_owner')      // Ngân clone (preferred — same as story)
    || getSetting('vs_elevenlabs_voice_id')
    || undefined;
}

// ═══════════════════════════════════════════════════════════
// Voice synthesis — DELEGATED to ../sonder-voice (brand voice skill)
// All TTS goes through Edge-TTS HoaiMy → ElevenLabs STS với voice Ngân
// ═══════════════════════════════════════════════════════════

// ffprobe duration delegated to sonder-voice utility
function ffprobeDuration(filePath: string): number {
  return audioFileDuration(filePath);
}

export async function synthesizeWeekendVoice(
  scenes: WeekendScene[],
  theme: WeekendThemeType,
  projectId: number,
): Promise<VoiceSegment[]> {
  const themeVoiceOverride = pickVoiceIdForTheme(theme);   // only set if admin overrode per theme
  const ts = Date.now();
  const segments: VoiceSegment[] = [];
  const modes: string[] = [];

  for (let i = 0; i < scenes.length; i++) {
    const sc = scenes[i];
    const audioPath = path.join(WEEKEND_VOICE_DIR, `weekend-${projectId}-${ts}-s${i}.mp3`);
    const r = await synthesizeSonderVoice(sc.text, audioPath, themeVoiceOverride);
    if (!r.ok) throw new Error(`scene ${i + 1} synth fail: ${r.error}`);
    modes.push(r.mode);
    segments.push({
      scene_idx: sc.scene_idx,
      text: sc.text,
      audio_path: audioPath,
      duration_sec: audioFileDuration(audioPath),
    });
  }

  const stsCount = modes.filter(m => m === 'sts').length;
  console.log(`[weekend-composer] voice synth: ${segments.length} segments (${stsCount} STS, ${modes.length - stsCount} edge-only) for theme=${theme}`);

  return segments;
}

// ═══════════════════════════════════════════════════════════
// FFmpeg compose
// ═══════════════════════════════════════════════════════════

function escapeForFFmpeg(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/'/g, '')
    .replace(/:/g, '\\:')
    .replace(/%/g, '\\%')
    .replace(/,/g, '\\,');
}

function wrapText(text: string, maxLen: number): string[] {
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
  return lines.slice(0, 3);
}

async function renderWeekendScene(opts: {
  scene: WeekendScene;
  visual: WeekendVisual;
  audioPath: string;
  duration: number;
  outputPath: string;
}): Promise<void> {
  const { scene, visual, audioPath, duration, outputPath } = opts;
  const FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';

  const cineGrade = `eq=saturation=1.06,curves=r='0/0.12 0.5/0.55 1/0.98':g='0/0.10 0.5/0.5 1/0.97':b='0/0.14 0.5/0.5 1/0.94'`;
  const filmGrain = `noise=alls=4:allf=t`;
  const vignette = `vignette=PI/4`;

  let inputArgs: string[];
  let videoFilter: string;

  if (visual.type === 'stock') {
    inputArgs = ['-stream_loop', '-1', '-t', duration.toFixed(3), '-i', visual.local_path];
    videoFilter = `[0:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setpts=PTS-STARTPTS,fps=${FPS},${cineGrade},${filmGrain},${vignette}`;
  } else {
    // Image with subtle zoom
    const frames = Math.max(1, Math.round(duration * FPS));
    inputArgs = ['-framerate', String(FPS), '-loop', '1', '-t', duration.toFixed(3), '-i', visual.local_path];
    videoFilter = `[0:v]scale=1620:2880:force_original_aspect_ratio=increase,crop=1620:2880,zoompan=z='min(zoom+0.0010,1.20)':d=${frames}:s=${W}x${H}:fps=${FPS},setpts=PTS-STARTPTS,${cineGrade},${filmGrain},${vignette}`;
  }

  // Optional overlay (e.g., timestamp "07:00" for day_in_area)
  let overlayFilter = '';
  if (scene.overlay_text) {
    const txt = escapeForFFmpeg(scene.overlay_text);
    overlayFilter += `,drawbox=x=80:y=80:w=240:h=80:color=black@0.55:t=fill`;
    overlayFilter += `,drawtext=fontfile=${FONT}:text='${txt}':fontsize=58:fontcolor=white:borderw=2:bordercolor=black:x=200-text_w/2:y=98`;
  }

  // Subtitle for voice text (bottom)
  const subtitleLines = wrapText(scene.text, 22).slice(0, 3);
  const subtitleStartY = H - 320;
  subtitleLines.forEach((line, idx) => {
    const escLine = escapeForFFmpeg(line);
    overlayFilter += `,drawbox=x=40:y=${subtitleStartY + idx * 80}:w=${W - 80}:h=72:color=black@0.55:t=fill`;
    overlayFilter += `,drawtext=fontfile=${FONT}:text='${escLine}':fontsize=44:fontcolor=white:borderw=2:bordercolor=black:x=(w-text_w)/2:y=${subtitleStartY + idx * 80 + 12}`;
  });

  const fadeIn = 0.4;
  const fadeOut = 0.4;
  const fadeFilter = `,fade=t=in:st=0:d=${fadeIn}:alpha=0,fade=t=out:st=${(duration - fadeOut).toFixed(2)}:d=${fadeOut}:alpha=0`;

  videoFilter += `${overlayFilter}${fadeFilter}[outv_pre]`;

  // Watermark overlay
  const useWatermark = fs.existsSync(SONDER_LOGO);
  if (useWatermark) {
    inputArgs.push('-i', SONDER_LOGO);
    videoFilter += `;[1:v]colorkey=0xFFFFFF:0.10:0.05,scale=80:80,format=rgba,colorchannelmixer=aa=0.35[wm];[outv_pre][wm]overlay=W-w-30:H-h-60[outv]`;
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
    throw new Error(`renderWeekendScene fail: ${errTail}`);
  }
}

// ═══════════════════════════════════════════════════════════
// Main compose
// ═══════════════════════════════════════════════════════════

export async function composeWeekendVideo(opts: {
  scenes: WeekendScene[];
  visuals: WeekendVisual[];
  voiceSegments: VoiceSegment[];
  bgmPath?: string;
  outputPath: string;
}): Promise<{ output_path: string; duration_sec: number; size_bytes: number }> {
  const { scenes, visuals, voiceSegments, bgmPath, outputPath } = opts;

  if (scenes.length !== visuals.length) throw new Error('scenes/visuals length mismatch');
  if (scenes.length !== voiceSegments.length) throw new Error('scenes/voice mismatch');

  const ts = Date.now();
  const segDir = path.join(WEEKEND_OUT_DIR, `segs-${ts}`);
  if (!fs.existsSync(segDir)) fs.mkdirSync(segDir, { recursive: true });

  const segPaths: string[] = [];

  try {
    // Render each scene
    for (let i = 0; i < scenes.length; i++) {
      const segOut = path.join(segDir, `${String(i).padStart(2, '0')}-scene.mp4`);
      const audioDur = voiceSegments[i].duration_sec;
      const sceneDur = Math.max(6, Math.min(20, audioDur + 1));

      console.log(`[weekend-composer] scene ${i + 1}/${scenes.length} (${scenes[i].beat}, ${visuals[i].type}, ${sceneDur.toFixed(1)}s)`);
      await renderWeekendScene({
        scene: scenes[i],
        visual: visuals[i],
        audioPath: voiceSegments[i].audio_path,
        duration: sceneDur,
        outputPath: segOut,
      });
      segPaths.push(segOut);
    }

    // Concat all scenes
    const concatList = path.join(segDir, 'concat.txt');
    fs.writeFileSync(concatList, segPaths.map(p => `file '${p}'`).join('\n'));

    const finalArgs: string[] = ['-f', 'concat', '-safe', '0', '-i', concatList];
    let mapAudio = '0:a';
    let filterComplex = '';

    if (bgmPath && fs.existsSync(bgmPath)) {
      finalArgs.push('-stream_loop', '-1', '-i', bgmPath);
      filterComplex = [
        `[0:a]equalizer=f=120:t=q:w=2:g=-3,equalizer=f=2400:t=q:w=2:g=2,acompressor=threshold=0.1:ratio=3:attack=20:release=200,asplit=2[voice_main][voice_sc]`,
        `[1:a]volume=0.22,afade=t=in:st=0:d=1.5[bgm_pre]`,
        `[bgm_pre][voice_sc]sidechaincompress=threshold=0.05:ratio=8:attack=5:release=250:level_sc=1[bgm_ducked]`,
        `[voice_main][bgm_ducked]amix=inputs=2:duration=first:weights=1.0 0.7[outa]`,
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
      throw new Error(`weekend final compose fail: ${errTail}`);
    }

    const duration = ffprobeDuration(outputPath);
    const size = fs.statSync(outputPath).size;

    // Cleanup
    for (const p of segPaths) try { fs.unlinkSync(p); } catch {}
    try { fs.unlinkSync(concatList); } catch {}
    try { fs.rmdirSync(segDir); } catch {}

    return { output_path: outputPath, duration_sec: duration, size_bytes: size };
  } catch (e) {
    for (const p of segPaths) try { fs.unlinkSync(p); } catch {}
    try { fs.rmSync(segDir, { recursive: true, force: true }); } catch {}
    throw e;
  }
}

// ═══════════════════════════════════════════════════════════
// BGM picker per theme
// ═══════════════════════════════════════════════════════════

export function pickBgmForTheme(theme: WeekendThemeType): string | undefined {
  const moodMap: Record<string, string[]> = {
    cinematic: ['mood_cinematic.mp3', 'mood_uplifting.mp3', 'mood_warm.mp3'],
    uplifting: ['mood_uplifting.mp3', 'mood_warm.mp3'],
    warm: ['mood_warm.mp3', 'mood_intimate.mp3'],
  };

  const meta = THEME_METADATA[theme];
  const candidates = moodMap[meta.bgm_mood] || moodMap.warm;

  for (const filename of candidates) {
    const p = path.join('/opt/vp-marketing/data/bgm', filename);
    if (fs.existsSync(p)) {
      console.log(`[weekend-composer] BGM: ${filename} for theme ${theme}`);
      return p;
    }
  }

  // Fallback default
  const defaultPath = '/opt/vp-marketing/data/bgm/sonder-soft.mp3';
  if (fs.existsSync(defaultPath)) {
    return defaultPath;
  }

  console.warn(`[weekend-composer] no BGM available — video không có music bed`);
  return undefined;
}

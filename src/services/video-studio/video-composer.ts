/**
 * Video Composer — FFmpeg orchestration.
 *
 * Pipeline:
 *   1. Download all stock clips → local files
 *   2. Per-scene processing:
 *      - Trim to target duration
 *      - Apply LUT color grading (brand consistency)
 *      - Scale/crop to target resolution (1080x1920 portrait)
 *      - Optional: burn subtitle
 *   3. Concat per-scene voice MP3s → full voiceover
 *   4. Concat processed scene clips → full video
 *   5. Mux voice + video
 *   6. Optional: intro/outro, logo watermark
 *   7. Output: final MP4
 *
 * Requires: ffmpeg + ffprobe (standard on Ubuntu VPS)
 */

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import axios from 'axios';
import { db } from '../../db';

const DATA_DIR = path.resolve(process.cwd(), 'data', 'video-studio');
const CLIPS_DIR = path.join(DATA_DIR, 'clips');
const COMPOSED_DIR = path.join(DATA_DIR, 'composed');

function ensureDir(p: string): void {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

export interface ComposeResult {
  success: boolean;
  output_path?: string;
  output_url?: string;
  duration_sec?: number;
  size_bytes?: number;
  error?: string;
  steps_completed: string[];
}

/**
 * Check if ffmpeg is available on system.
 */
export async function checkFFmpeg(): Promise<{ available: boolean; version?: string }> {
  return new Promise((resolve) => {
    const proc = spawn('ffmpeg', ['-version']);
    let out = '';
    proc.stdout.on('data', (d) => { out += d.toString(); });
    proc.on('close', (code) => {
      if (code === 0) {
        const version = (out.match(/ffmpeg version (\S+)/) || [])[1];
        resolve({ available: true, version });
      } else {
        resolve({ available: false });
      }
    });
    proc.on('error', () => resolve({ available: false }));
  });
}

/**
 * Run ffmpeg command with args. Resolve with stdout/stderr.
 */
function runFFmpeg(args: string[], timeoutMs: number = 300000): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error('ffmpeg timeout'));
    }, timeoutMs);
    proc.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stderr });
    });
    proc.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

/**
 * Download URL to local file.
 */
async function downloadClip(url: string, outPath: string): Promise<boolean> {
  try {
    const resp = await axios.get(url, { responseType: 'arraybuffer', timeout: 120000, maxContentLength: 200 * 1024 * 1024 });
    fs.writeFileSync(outPath, Buffer.from(resp.data));
    return true;
  } catch (e: any) {
    console.warn(`[vs-compose] download fail ${url}:`, e?.message);
    return false;
  }
}

/**
 * Process a single scene clip: trim, scale/crop to portrait, apply LUT.
 *
 * Input: raw downloaded clip
 * Output: processed MP4 at target resolution
 */
async function processSceneClip(opts: {
  inputPath: string;
  outputPath: string;
  durationSec: number;
  lutPath?: string;
  targetWidth: number;
  targetHeight: number;
}): Promise<{ success: boolean; error?: string }> {
  // Filter chain:
  //   1. scale+crop to target (preserve aspect, crop overflow)
  //   2. apply LUT if provided
  //   3. normalize fps to 30
  const vfParts: string[] = [];

  // Scale + crop to target resolution (cover — crop excess)
  // For portrait target: scale up to cover target height, then crop width
  vfParts.push(`scale='if(gt(a,${opts.targetWidth}/${opts.targetHeight}),-2,${opts.targetWidth})':'if(gt(a,${opts.targetWidth}/${opts.targetHeight}),${opts.targetHeight},-2)'`);
  vfParts.push(`crop=${opts.targetWidth}:${opts.targetHeight}`);

  if (opts.lutPath && fs.existsSync(opts.lutPath)) {
    vfParts.push(`lut3d=file='${opts.lutPath.replace(/'/g, "\\''")}'`);
  }

  // Normalize fps 30
  vfParts.push('fps=30');

  const args = [
    '-y',
    '-i', opts.inputPath,
    '-t', String(opts.durationSec),
    '-vf', vfParts.join(','),
    '-an',                                          // Strip original audio
    '-c:v', 'libx264',
    '-preset', 'fast',
    '-crf', '22',
    '-pix_fmt', 'yuv420p',
    opts.outputPath,
  ];

  try {
    const r = await runFFmpeg(args, 180000);
    if (r.code !== 0) return { success: false, error: r.stderr.substring(r.stderr.length - 300) };
    return { success: true };
  } catch (e: any) {
    return { success: false, error: e?.message };
  }
}

/**
 * Concatenate list of MP4 clips into single video (no audio).
 */
async function concatVideos(clipPaths: string[], outputPath: string): Promise<{ success: boolean; error?: string }> {
  if (clipPaths.length === 0) return { success: false, error: 'no_clips' };

  // Use concat demuxer for most efficient joining
  const listFile = outputPath.replace(/\.mp4$/, '.list.txt');
  const listContent = clipPaths.map(p => `file '${path.resolve(p).replace(/'/g, "\\''")}'`).join('\n');
  fs.writeFileSync(listFile, listContent);

  const args = [
    '-y',
    '-f', 'concat',
    '-safe', '0',
    '-i', listFile,
    '-c', 'copy',
    outputPath,
  ];

  try {
    const r = await runFFmpeg(args);
    fs.unlinkSync(listFile);   // Cleanup
    if (r.code !== 0) return { success: false, error: r.stderr.substring(r.stderr.length - 300) };
    return { success: true };
  } catch (e: any) {
    return { success: false, error: e?.message };
  }
}

/**
 * Concatenate audio files (per-scene voice MP3s) into single MP3.
 */
async function concatAudios(audioPaths: string[], outputPath: string): Promise<{ success: boolean; error?: string }> {
  if (audioPaths.length === 0) return { success: false, error: 'no_audio' };
  if (audioPaths.length === 1) {
    fs.copyFileSync(audioPaths[0], outputPath);
    return { success: true };
  }

  const listFile = outputPath.replace(/\.mp3$/, '.list.txt');
  const listContent = audioPaths.map(p => `file '${path.resolve(p).replace(/'/g, "\\''")}'`).join('\n');
  fs.writeFileSync(listFile, listContent);

  const args = [
    '-y',
    '-f', 'concat',
    '-safe', '0',
    '-i', listFile,
    '-c', 'copy',
    outputPath,
  ];

  try {
    const r = await runFFmpeg(args);
    fs.unlinkSync(listFile);
    if (r.code !== 0) return { success: false, error: r.stderr.substring(r.stderr.length - 300) };
    return { success: true };
  } catch (e: any) {
    return { success: false, error: e?.message };
  }
}

/**
 * Generate SRT subtitle file from scene texts with timings.
 */
function generateSRT(scenes: Array<{ text: string; duration_sec: number }>, outputPath: string): void {
  let srt = '';
  let currentSec = 0;
  for (let i = 0; i < scenes.length; i++) {
    const start = currentSec;
    const end = currentSec + scenes[i].duration_sec;
    srt += `${i + 1}\n${formatSrtTime(start)} --> ${formatSrtTime(end)}\n${scenes[i].text}\n\n`;
    currentSec = end;
  }
  fs.writeFileSync(outputPath, srt, 'utf-8');
}

function formatSrtTime(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const ms = Math.round((sec - Math.floor(sec)) * 1000);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
}

/**
 * Final mux: combine video + audio + subtitles + optional watermark.
 */
async function muxFinal(opts: {
  videoPath: string;
  audioPath: string;
  subtitlePath?: string;
  watermarkPath?: string;
  outputPath: string;
  subtitleFontColor?: string;
  subtitleOutlineColor?: string;
}): Promise<{ success: boolean; error?: string }> {
  const args = ['-y', '-i', opts.videoPath, '-i', opts.audioPath];

  const filters: string[] = [];

  // Subtitle overlay (burn-in)
  if (opts.subtitlePath && fs.existsSync(opts.subtitlePath)) {
    // Escape paths for filter
    const escapedSrt = opts.subtitlePath.replace(/\\/g, '/').replace(/:/g, '\\:');
    const fontCol = (opts.subtitleFontColor || '#FFEB3B').replace('#', '&H');
    const outlineCol = (opts.subtitleOutlineColor || '#000000').replace('#', '&H');
    filters.push(`[0:v]subtitles='${escapedSrt}':force_style='FontName=DejaVu Sans,FontSize=28,PrimaryColour=&H00${fontCol.substring(2)},OutlineColour=&H00${outlineCol.substring(2)},BorderStyle=3,Outline=2,Shadow=1,Alignment=2,MarginV=80'[vout]`);
  } else {
    filters.push(`[0:v]null[vout]`);
  }

  if (filters.length > 0) {
    args.push('-filter_complex', filters.join(';'));
    args.push('-map', '[vout]', '-map', '1:a');
  } else {
    args.push('-map', '0:v', '-map', '1:a');
  }

  args.push(
    '-c:v', 'libx264',
    '-preset', 'fast',
    '-crf', '22',
    '-c:a', 'aac',
    '-b:a', '128k',
    '-shortest',                              // End when shortest stream ends
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',                // Streaming optimization
    opts.outputPath,
  );

  try {
    const r = await runFFmpeg(args, 300000);
    if (r.code !== 0) return { success: false, error: r.stderr.substring(r.stderr.length - 500) };
    return { success: true };
  } catch (e: any) {
    return { success: false, error: e?.message };
  }
}

/**
 * Probe video file for duration.
 */
async function probeDuration(filePath: string): Promise<number> {
  return new Promise((resolve) => {
    const proc = spawn('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      filePath,
    ]);
    let out = '';
    proc.stdout.on('data', (d) => { out += d.toString(); });
    proc.on('close', () => resolve(parseFloat(out.trim()) || 0));
    proc.on('error', () => resolve(0));
  });
}

// ═══════════════════════════════════════════════════════════
// Main entry
// ═══════════════════════════════════════════════════════════

export async function composeProjectVideo(projectId: number): Promise<ComposeResult> {
  const steps: string[] = [];

  try {
    // Check ffmpeg
    const ff = await checkFFmpeg();
    if (!ff.available) return { success: false, error: 'ffmpeg not installed on server', steps_completed: steps };
    steps.push(`ffmpeg ${ff.version} available`);

    // Load project + scenes + brand kit
    const proj = db.prepare(`SELECT * FROM video_projects WHERE id = ?`).get(projectId) as any;
    if (!proj) return { success: false, error: 'Project not found', steps_completed: steps };

    const brandKit = db.prepare(`SELECT * FROM video_brand_kits WHERE id = ?`).get(proj.brand_kit_id) as any;

    const scenes = db.prepare(`
      SELECT scene_index, text, duration_sec, visual_url, voice_segment_url
      FROM video_scenes WHERE project_id = ?
      ORDER BY scene_index ASC
    `).all(projectId) as any[];

    if (scenes.length === 0) return { success: false, error: 'No scenes', steps_completed: steps };

    // Validate all scenes have visuals + voice
    const missingVisual = scenes.filter(s => !s.visual_url);
    const missingVoice = scenes.filter(s => !s.voice_segment_url);
    if (missingVisual.length > 0) return { success: false, error: `${missingVisual.length} scenes missing visual clips`, steps_completed: steps };
    if (missingVoice.length > 0) return { success: false, error: `${missingVoice.length} scenes missing voice`, steps_completed: steps };

    // Setup dirs
    const projClipsDir = path.join(CLIPS_DIR, String(projectId));
    const projComposedDir = path.join(COMPOSED_DIR, String(projectId));
    ensureDir(projClipsDir);
    ensureDir(projComposedDir);

    // Resolution from brand kit
    const [w, h] = (brandKit?.resolution || '1080x1920').split('x').map((n: string) => parseInt(n, 10));

    // ── Step 1: Download all stock clips ──
    steps.push('downloading clips');
    const downloadedPaths: string[] = [];
    for (const s of scenes) {
      const ext = (s.visual_url.match(/\.(mp4|webm|mov)/i) || ['', 'mp4'])[1].toLowerCase();
      const clipPath = path.join(projClipsDir, `scene_${s.scene_index}_raw.${ext}`);
      if (!fs.existsSync(clipPath)) {
        const ok = await downloadClip(s.visual_url, clipPath);
        if (!ok) return { success: false, error: `Failed to download scene ${s.scene_index} clip`, steps_completed: steps };
      }
      downloadedPaths.push(clipPath);
    }
    steps.push(`downloaded ${downloadedPaths.length} clips`);

    // ── Step 2: Process each scene clip (trim + LUT + scale/crop) ──
    steps.push('processing scenes');
    const processedPaths: string[] = [];
    for (let i = 0; i < scenes.length; i++) {
      const s = scenes[i];
      const outPath = path.join(projClipsDir, `scene_${s.scene_index}_processed.mp4`);
      const r = await processSceneClip({
        inputPath: downloadedPaths[i],
        outputPath: outPath,
        durationSec: s.duration_sec,
        lutPath: brandKit?.color_lut_file,
        targetWidth: w,
        targetHeight: h,
      });
      if (!r.success) {
        return { success: false, error: `Scene ${s.scene_index} processing failed: ${r.error}`, steps_completed: steps };
      }
      processedPaths.push(outPath);
    }
    steps.push(`processed ${processedPaths.length} scenes with LUT`);

    // ── Step 3: Concat processed clips ──
    steps.push('concatenating video');
    const concatVideoPath = path.join(projComposedDir, 'video_only.mp4');
    const concatR = await concatVideos(processedPaths, concatVideoPath);
    if (!concatR.success) return { success: false, error: `Concat video failed: ${concatR.error}`, steps_completed: steps };
    steps.push('video concatenated');

    // ── Step 4: Concat voice MP3s ──
    steps.push('concatenating audio');
    const voicePaths = scenes.map(s => {
      // voice_segment_url is like /api/video-studio/files/{pid}/voices/scene_X.mp3
      // → local path: DATA_DIR/voices/{pid}/scene_X.mp3
      const fname = path.basename(s.voice_segment_url || '');
      return path.join(DATA_DIR, 'voices', String(projectId), fname);
    });
    const concatAudioPath = path.join(projComposedDir, 'voice.mp3');
    const audioR = await concatAudios(voicePaths, concatAudioPath);
    if (!audioR.success) return { success: false, error: `Concat audio failed: ${audioR.error}`, steps_completed: steps };
    steps.push('voice concatenated');

    // ── Step 5: Generate subtitle ──
    steps.push('generating subtitles');
    const srtPath = path.join(projComposedDir, 'subtitles.srt');
    generateSRT(scenes.map(s => ({ text: s.text, duration_sec: s.duration_sec })), srtPath);
    steps.push('subtitles ready');

    // ── Step 6: Mux final ──
    steps.push('final muxing');
    const finalPath = path.join(projComposedDir, 'final.mp4');
    const muxR = await muxFinal({
      videoPath: concatVideoPath,
      audioPath: concatAudioPath,
      subtitlePath: srtPath,
      outputPath: finalPath,
      subtitleFontColor: brandKit?.subtitle_color || '#FFEB3B',
    });
    if (!muxR.success) return { success: false, error: `Mux failed: ${muxR.error}`, steps_completed: steps };
    steps.push('final muxed');

    // ── Probe final ──
    const duration = await probeDuration(finalPath);
    const size = fs.existsSync(finalPath) ? fs.statSync(finalPath).size : 0;

    const relUrl = `/api/video-studio/files/${projectId}/composed/final.mp4`;

    // Update project
    db.prepare(`
      UPDATE video_projects
      SET draft_video_url = ?, status = 'qc_review', updated_at = ?
      WHERE id = ?
    `).run(relUrl, Date.now(), projectId);

    console.log(`[vs-compose] project ${projectId} composed: ${(size / 1024 / 1024).toFixed(1)}MB ${duration.toFixed(1)}s`);

    // Cleanup intermediates (keep final + voice + subtitles)
    try {
      for (const p of downloadedPaths) if (fs.existsSync(p)) fs.unlinkSync(p);
      // Keep processed clips for now for debug, remove if space issue
    } catch {}

    return {
      success: true,
      output_path: finalPath,
      output_url: relUrl,
      duration_sec: duration,
      size_bytes: size,
      steps_completed: steps,
    };
  } catch (e: any) {
    return { success: false, error: e?.message, steps_completed: steps };
  }
}

/**
 * Delete all composed files for a project (cleanup).
 */
export function cleanupProjectFiles(projectId: number): void {
  try {
    const dirs = [
      path.join(CLIPS_DIR, String(projectId)),
      path.join(COMPOSED_DIR, String(projectId)),
      path.join(DATA_DIR, 'voices', String(projectId)),
    ];
    for (const d of dirs) {
      if (fs.existsSync(d)) fs.rmSync(d, { recursive: true, force: true });
    }
  } catch {}
}

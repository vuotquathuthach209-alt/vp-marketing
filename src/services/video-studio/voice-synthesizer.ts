/**
 * Voice Synthesizer — ElevenLabs Multilingual v2 (Vietnamese support).
 *
 * Per-scene TTS: 1 API call per scene → get accurate duration per segment.
 * Audio concat ở composer step (FFmpeg).
 *
 * Cost: $0.30 / 1000 chars Starter. 1 video 90s ~1200 chars = $0.36
 *
 * Vietnamese voice recommendations (need admin test + pick):
 *   - "Mai" (female, warm) — rxXXkTw3I8TepQNJGDPN
 *   - "Lilian" (female, professional) — 2EiwWnXFnvU5JabPnv8n (if available)
 *   - Default: use first VN voice available to account
 */

import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import { db } from '../../db';
import { getApiKey, getVSSetting } from './feature-flag';

const DATA_DIR = path.resolve(process.cwd(), 'data', 'video-studio');
const VOICES_DIR = path.join(DATA_DIR, 'voices');
const API_BASE = 'https://api.elevenlabs.io/v1';

export interface TTSResult {
  scene_index: number;
  audio_path: string;            // Local file path
  audio_url: string;             // Relative URL for serving
  chars_used: number;
  duration_sec: number;          // Actual audio duration (estimated from size)
  cost_cents: number;
}

export interface TTSBatchResult {
  success: boolean;
  scenes_generated: number;
  scenes_failed: number;
  total_chars: number;
  total_cost_cents: number;
  results: TTSResult[];
  error?: string;
}

function ensureVoicesDir(projectId: number): string {
  const dir = path.join(VOICES_DIR, String(projectId));
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Generate TTS audio for a single text chunk.
 */
async function synthesizeChunk(
  voiceId: string,
  text: string,
  outputPath: string,
  voiceSettings: any,
): Promise<{ success: boolean; bytes?: number; error?: string }> {
  const apiKey = getApiKey('elevenlabs');
  if (!apiKey) return { success: false, error: 'no_api_key' };

  try {
    const resp = await axios.post(
      `${API_BASE}/text-to-speech/${voiceId}`,
      {
        text: text.substring(0, 5000),                                 // Cap at 5k chars
        model_id: 'eleven_multilingual_v2',
        voice_settings: {
          stability: voiceSettings?.stability ?? 0.6,
          similarity_boost: voiceSettings?.similarity_boost ?? 0.8,
          style: voiceSettings?.style ?? 0.3,
          use_speaker_boost: voiceSettings?.use_speaker_boost ?? true,
        },
      },
      {
        headers: {
          'xi-api-key': apiKey,
          'Content-Type': 'application/json',
          'Accept': 'audio/mpeg',
        },
        responseType: 'arraybuffer',
        timeout: 60000,
      },
    );

    // Save MP3 to disk
    fs.writeFileSync(outputPath, Buffer.from(resp.data));
    return { success: true, bytes: resp.data.byteLength };
  } catch (e: any) {
    const errMsg = e.response?.data ? Buffer.from(e.response.data).toString('utf8').substring(0, 300) : e.message;
    return { success: false, error: errMsg };
  }
}

/**
 * Estimate audio duration from MP3 file size.
 * Rough: MP3 at 128kbps ≈ 16KB/sec. ElevenLabs default bitrate varies.
 * Better: use ffprobe nếu có. Fallback to estimate.
 */
function estimateDurationFromFile(filePath: string): number {
  try {
    const stat = fs.statSync(filePath);
    // ElevenLabs default ~64-96kbps MP3 → ~10KB/sec
    return Math.round((stat.size / 10000) * 10) / 10;
  } catch { return 0; }
}

/**
 * Main entry — synthesize voice for all scenes of a project.
 * Returns per-scene audio file paths + cost tracking.
 */
export async function synthesizeProjectVoices(projectId: number): Promise<TTSBatchResult> {
  const apiKey = getApiKey('elevenlabs');
  if (!apiKey) {
    return {
      success: false,
      scenes_generated: 0,
      scenes_failed: 0,
      total_chars: 0,
      total_cost_cents: 0,
      results: [],
      error: 'ElevenLabs API key chưa config. Vào Settings → paste API key',
    };
  }

  // Get project + scenes + brand kit voice
  const proj = db.prepare(`SELECT * FROM video_projects WHERE id = ?`).get(projectId) as any;
  if (!proj) return { ...emptyResult(), success: false, error: 'Project not found' };

  const brandKit = db.prepare(`SELECT voice_id, voice_settings_json FROM video_brand_kits WHERE id = ?`).get(proj.brand_kit_id) as any;

  // Resolve voice_id: project-specific > brand kit > settings default
  const voiceId = proj.voice_profile_id
    || brandKit?.voice_id
    || getVSSetting('elevenlabs_voice_id');

  if (!voiceId) {
    return {
      ...emptyResult(),
      success: false,
      error: 'Voice ID chưa config. Vào Settings → nhập ElevenLabs Voice ID (tiếng Việt)',
    };
  }

  const voiceSettings = brandKit?.voice_settings_json ? safeParse(brandKit.voice_settings_json) : null;

  const scenes = db.prepare(`
    SELECT id, scene_index, kind, text, duration_sec
    FROM video_scenes WHERE project_id = ?
    ORDER BY scene_index ASC
  `).all(projectId) as any[];

  if (scenes.length === 0) {
    return { ...emptyResult(), success: false, error: 'No scenes found' };
  }

  const outDir = ensureVoicesDir(projectId);
  const results: TTSResult[] = [];
  let succeeded = 0, failed = 0, totalChars = 0, totalCents = 0;

  for (const scene of scenes) {
    const text = (scene.text || '').trim();
    if (!text) { failed++; continue; }

    const outPath = path.join(outDir, `scene_${scene.scene_index}.mp3`);
    const relUrl = `/api/video-studio/files/${projectId}/voices/scene_${scene.scene_index}.mp3`;

    const chunkResult = await synthesizeChunk(voiceId, text, outPath, voiceSettings);

    if (chunkResult.success) {
      const duration = estimateDurationFromFile(outPath);
      const chars = text.length;
      const cost = Math.ceil((chars / 1000) * 30);        // 30 cents per 1000 chars

      results.push({
        scene_index: scene.scene_index,
        audio_path: outPath,
        audio_url: relUrl,
        chars_used: chars,
        duration_sec: duration,
        cost_cents: cost,
      });

      // Persist to DB: voice_segment_url on scene
      db.prepare(`UPDATE video_scenes SET voice_segment_url = ? WHERE id = ?`).run(relUrl, scene.id);

      // Cost ledger
      db.prepare(`
        INSERT INTO video_cost_ledger (project_id, provider, operation, units_used, cost_cents, metadata_json, created_at)
        VALUES (?, 'elevenlabs', 'tts', ?, ?, ?, ?)
      `).run(projectId, chars, cost, JSON.stringify({ scene_index: scene.scene_index, voice_id: voiceId }), Date.now());

      totalChars += chars;
      totalCents += cost;
      succeeded++;
    } else {
      console.warn(`[vs-voice] scene ${scene.scene_index} failed: ${chunkResult.error}`);
      failed++;
    }
  }

  // Update project total cost
  db.prepare(`UPDATE video_projects SET cost_cents = cost_cents + ? WHERE id = ?`).run(totalCents, projectId);

  console.log(`[vs-voice] project ${projectId}: ${succeeded}/${scenes.length} scenes, ${totalChars} chars, $${(totalCents / 100).toFixed(2)}`);

  return {
    success: failed === 0,
    scenes_generated: succeeded,
    scenes_failed: failed,
    total_chars: totalChars,
    total_cost_cents: totalCents,
    results,
    error: failed > 0 ? `${failed} scenes failed` : undefined,
  };
}

/**
 * List available voices from ElevenLabs account (admin picks voice_id).
 */
export async function listAvailableVoices(): Promise<any[]> {
  const apiKey = getApiKey('elevenlabs');
  if (!apiKey) return [];

  try {
    const resp = await axios.get(`${API_BASE}/voices`, {
      headers: { 'xi-api-key': apiKey },
      timeout: 15000,
    });
    return (resp.data?.voices || []).map((v: any) => ({
      voice_id: v.voice_id,
      name: v.name,
      language: v.labels?.language || 'unknown',
      description: v.description || '',
      preview_url: v.preview_url,
      category: v.category,
    }));
  } catch (e: any) {
    console.warn('[vs-voice] list voices err:', e?.message);
    return [];
  }
}

/**
 * Generate a short voice sample for admin preview (pick voice).
 */
export async function previewVoice(voiceId: string, text: string = 'Xin chào, đây là giọng đọc tiếng Việt của Sonder. Chúc bạn một ngày tốt lành!'): Promise<{ success: boolean; audio_base64?: string; error?: string }> {
  const apiKey = getApiKey('elevenlabs');
  if (!apiKey) return { success: false, error: 'no_api_key' };

  try {
    const resp = await axios.post(
      `${API_BASE}/text-to-speech/${voiceId}`,
      {
        text,
        model_id: 'eleven_multilingual_v2',
        voice_settings: { stability: 0.6, similarity_boost: 0.8 },
      },
      {
        headers: { 'xi-api-key': apiKey, 'Accept': 'audio/mpeg' },
        responseType: 'arraybuffer',
        timeout: 30000,
      },
    );

    return {
      success: true,
      audio_base64: Buffer.from(resp.data).toString('base64'),
    };
  } catch (e: any) {
    return { success: false, error: e?.message };
  }
}

function emptyResult(): TTSBatchResult {
  return { success: false, scenes_generated: 0, scenes_failed: 0, total_chars: 0, total_cost_cents: 0, results: [] };
}

function safeParse(s: string): any { try { return JSON.parse(s); } catch { return null; } }

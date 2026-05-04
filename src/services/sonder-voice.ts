/**
 * Sonder Brand Voice — shared utility cho TTS đồng nhất toàn bộ thương hiệu.
 *
 * Pattern chuẩn: Edge-TTS Vietnamese (HoaiMyNeural) → ElevenLabs STS (Ngân clone).
 * Reference skill: .claude/skills/sonder-brand-voice/SKILL.md
 *
 * USE CASE:
 *   - Mọi feature mới có TTS/voice output (video, podcast, voice notification)
 *   - Import { synthesizeSonderVoice } thay vì copy-paste 2 functions edge+sts
 *
 * EXAMPLE:
 *   import { synthesizeSonderVoice } from './sonder-voice';
 *   const r = await synthesizeSonderVoice('Xin chào...', '/path/output.mp3');
 *   if (r.ok) console.log(`Voice ready (mode=${r.mode})`);
 */

import * as fs from 'fs';
import { spawnSync } from 'child_process';
import axios from 'axios';
import { getSetting } from '../db';

const FormData = require('form-data');

// ═══════════════════════════════════════════════════════════
// Brand voice constants
// ═══════════════════════════════════════════════════════════

/** Default Sonder voice ID (Ngân clone). DO NOT CHANGE without brand team approval. */
export const SONDER_VOICE_ID_DEFAULT = 'a3AkyqGG4v8Pg7SWQ0Y3';

/** Edge-TTS Vietnamese voice (Microsoft Neural — chuẩn pronunciation 99%+) */
export const SONDER_EDGE_VOICE = 'vi-VN-HoaiMyNeural';
export const SONDER_EDGE_RATE = '-3%';
export const SONDER_EDGE_PITCH = '+3Hz';

/** ElevenLabs STS settings — locked for brand consistency */
export const SONDER_STS_SETTINGS = {
  stability: 0.5,
  similarity_boost: 0.85,
  style: 0.3,
  use_speaker_boost: true,
};

export const SONDER_STS_MODEL = 'eleven_multilingual_sts_v2';

// ═══════════════════════════════════════════════════════════
// STEP 1: Edge-TTS Vietnamese
// ═══════════════════════════════════════════════════════════

/**
 * Generate VN reference audio via Microsoft Edge-TTS.
 * Free, chuẩn pronunciation 99%+, used as input cho STS step.
 *
 * Retry: 4 attempts với exponential backoff.
 */
export async function edgeTtsVietnamese(
  text: string,
  outPath: string,
): Promise<{ ok: boolean; error?: string }> {
  const voice = getSetting('vs_edge_tts_voice') || SONDER_EDGE_VOICE;
  const rate = getSetting('vs_edge_tts_rate') || SONDER_EDGE_RATE;
  const pitch = getSetting('vs_edge_tts_pitch') || SONDER_EDGE_PITCH;

  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const r = spawnSync('python3', [
        '-m', 'edge_tts',
        `--voice=${voice}`,
        `--rate=${rate}`,
        `--pitch=${pitch}`,
        `--text`, text,
        `--write-media`, outPath,
      ], { encoding: 'utf8', timeout: 120_000 });

      if (r.status !== 0) throw new Error('edge-tts: ' + (r.stderr || '').slice(-200));
      if (!fs.existsSync(outPath) || fs.statSync(outPath).size < 1000) {
        throw new Error('empty edge audio');
      }
      return { ok: true };
    } catch (e: any) {
      if (attempt < 4) {
        const backoff = attempt * 2;
        console.warn(`[sonder-voice] edge-tts attempt ${attempt} fail, retry in ${backoff}s: ${e?.message?.slice(0, 100)}`);
        await new Promise(r => setTimeout(r, backoff * 1000));
      } else {
        return { ok: false, error: e?.message };
      }
    }
  }
  return { ok: false, error: 'edge-tts max retries' };
}

// ═══════════════════════════════════════════════════════════
// STEP 2: ElevenLabs Speech-to-Speech (Ngân clone)
// ═══════════════════════════════════════════════════════════

/**
 * Convert reference audio (from Edge-TTS) sang giọng Ngân via ElevenLabs STS.
 * Giữ pronunciation từ Edge + apply timbre + style của voice clone.
 */
export async function elevenLabsStsVietnamese(
  refAudioPath: string,
  voiceId: string,
  outPath: string,
): Promise<{ ok: boolean; error?: string }> {
  const apiKey = getSetting('elevenlabs_api_key') || getSetting('vs_elevenlabs_api_key');
  if (!apiKey) return { ok: false, error: 'no_elevenlabs_key' };

  try {
    const form = new FormData();
    form.append('audio', fs.createReadStream(refAudioPath), {
      filename: 'source.mp3',
      contentType: 'audio/mpeg',
    });
    form.append('model_id', SONDER_STS_MODEL);
    form.append('voice_settings', JSON.stringify(SONDER_STS_SETTINGS));

    const resp = await axios.post(
      `https://api.elevenlabs.io/v1/speech-to-speech/${voiceId}`,
      form,
      {
        headers: {
          'xi-api-key': apiKey,
          ...form.getHeaders(),
          'Accept': 'audio/mpeg',
        },
        responseType: 'arraybuffer',
        timeout: 180_000,
        maxContentLength: 50 * 1024 * 1024,
      },
    );

    fs.writeFileSync(outPath, Buffer.from(resp.data));
    return { ok: true };
  } catch (e: any) {
    const errBody = e.response?.data
      ? Buffer.from(e.response.data).toString('utf8').substring(0, 300)
      : e.message;
    return { ok: false, error: errBody };
  }
}

// ═══════════════════════════════════════════════════════════
// COMBINED: Edge-TTS → STS với fallback
// ═══════════════════════════════════════════════════════════

export interface SynthesisResult {
  ok: boolean;
  error?: string;
  mode: 'sts' | 'edge_only' | 'none';
}

/**
 * Synthesize giọng Sonder chuẩn từ Vietnamese text.
 *
 * Pipeline:
 *   1. Edge-TTS (HoaiMyNeural) → reference audio
 *   2. ElevenLabs STS (Ngân) → final audio
 *   3. Fallback Edge-only nếu STS fail
 *
 * @param text Vietnamese text to synthesize
 * @param outPath Output mp3 path
 * @param voiceIdOverride Optional — override default Ngân voice (rare use case)
 * @returns Result với mode (sts | edge_only | none)
 */
export async function synthesizeSonderVoice(
  text: string,
  outPath: string,
  voiceIdOverride?: string,
): Promise<SynthesisResult> {
  // Voice ID priority chain
  const voiceId = voiceIdOverride
    || getSetting('vs_elevenlabs_voice_id_owner')
    || getSetting('vs_elevenlabs_voice_id')
    || SONDER_VOICE_ID_DEFAULT;

  const ts = Date.now() + Math.floor(Math.random() * 1000);
  const edgeRefPath = outPath.replace(/\.mp3$/, `-edge-ref-${ts}.mp3`);

  // Step 1: Edge-TTS reference
  const edgeR = await edgeTtsVietnamese(text, edgeRefPath);
  if (!edgeR.ok) {
    return { ok: false, error: 'edge-tts: ' + edgeR.error, mode: 'none' };
  }

  // Step 2: STS với Ngân (nếu có voiceId + API key)
  if (voiceId) {
    const stsR = await elevenLabsStsVietnamese(edgeRefPath, voiceId, outPath);
    if (stsR.ok) {
      try { fs.unlinkSync(edgeRefPath); } catch {}
      return { ok: true, mode: 'sts' };
    }
    console.warn(`[sonder-voice] STS fail, fallback Edge-only: ${stsR.error?.substring(0, 100)}`);
  }

  // Fallback Edge-only
  fs.copyFileSync(edgeRefPath, outPath);
  try { fs.unlinkSync(edgeRefPath); } catch {}
  return { ok: true, mode: 'edge_only' };
}

// ═══════════════════════════════════════════════════════════
// BATCH: synthesize nhiều segments (paragraph by paragraph)
// ═══════════════════════════════════════════════════════════

export interface BatchSegment {
  text: string;
  out_path: string;
}

/**
 * Synthesize batch nhiều segments — sequential to respect rate limits.
 * Return per-segment result, log mode count.
 */
export async function synthesizeSonderVoiceBatch(
  segments: BatchSegment[],
  voiceIdOverride?: string,
): Promise<{ results: SynthesisResult[]; sts_count: number; edge_only_count: number; failed_count: number }> {
  const results: SynthesisResult[] = [];
  let stsCount = 0, edgeOnlyCount = 0, failedCount = 0;

  for (const seg of segments) {
    const r = await synthesizeSonderVoice(seg.text, seg.out_path, voiceIdOverride);
    results.push(r);
    if (!r.ok) failedCount++;
    else if (r.mode === 'sts') stsCount++;
    else if (r.mode === 'edge_only') edgeOnlyCount++;
  }

  console.log(`[sonder-voice] batch synth: ${segments.length} segments | sts=${stsCount} edge_only=${edgeOnlyCount} failed=${failedCount}`);

  return {
    results,
    sts_count: stsCount,
    edge_only_count: edgeOnlyCount,
    failed_count: failedCount,
  };
}

// ═══════════════════════════════════════════════════════════
// HELPER: get duration via ffprobe
// ═══════════════════════════════════════════════════════════

export function audioFileDuration(filePath: string): number {
  try {
    const r = spawnSync('ffprobe', [
      '-v', 'quiet',
      '-show_entries', 'format=duration',
      '-of', 'csv=p=0',
      filePath,
    ], { encoding: 'utf8' });
    return parseFloat(r.stdout?.trim()) || 0;
  } catch { return 0; }
}

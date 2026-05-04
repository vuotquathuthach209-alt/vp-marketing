/**
 * Cinema Voice — synthesize per-shot voiceover for long-form 5-7 phút.
 *
 * Pipeline:
 *   1. For each shot có voiceover_text → ElevenLabs Multilingual v2 (Ngân clone)
 *   2. TALKING_HEAD shots: VO file passed to Hedra as input (lip-sync)
 *   3. Non-talking shots: VO file overlaid in FFmpeg composer
 *
 * Reference skill: sonder-brand-voice (Ngân voice = a3AkyqGG4v8Pg7SWQ0Y3)
 *                   sonder-cinema
 */

import * as fs from 'fs';
import * as path from 'path';
import { db } from '../../db';
import { synthesizeSonderVoice, audioFileDuration } from '../sonder-voice';
import type { StoryboardShot } from './cinema-storyboard';
import { logCost } from './cinema-cost-tracker';

const MEDIA_DIR = '/opt/vp-marketing/data/media';
const CINEMA_VOICE_DIR = path.join(MEDIA_DIR, 'cinema-voices');

if (!fs.existsSync(CINEMA_VOICE_DIR)) fs.mkdirSync(CINEMA_VOICE_DIR, { recursive: true });

// ═══════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════

export interface CinemaVoiceSegment {
  shot_no: number;
  text: string;
  audio_path: string;
  duration_sec: number;
  mode: 'sts' | 'edge_only' | 'silent';
}

// ═══════════════════════════════════════════════════════════
// Synthesize voice cho all shots có voiceover_text
// ═══════════════════════════════════════════════════════════

export async function synthesizeCinemaVoice(
  shots: StoryboardShot[],
  episodeId: number,
): Promise<CinemaVoiceSegment[]> {
  const segments: CinemaVoiceSegment[] = [];
  const ts = Date.now();
  let totalChars = 0;

  for (const shot of shots) {
    // Empty VO (cold open, outro, b-roll-only) → silent placeholder
    if (!shot.voiceover_text || shot.voiceover_text.trim().length < 3) {
      segments.push({
        shot_no: shot.shot_no,
        text: '',
        audio_path: '',
        duration_sec: 0,
        mode: 'silent',
      });
      continue;
    }

    const audioPath = path.join(CINEMA_VOICE_DIR, `cinema-ep${episodeId}-${ts}-shot${shot.shot_no}.mp3`);
    try {
      const r = await synthesizeSonderVoice(shot.voiceover_text, audioPath);
      if (!r.ok) {
        console.warn(`[cinema-voice] shot ${shot.shot_no} synth fail: ${r.error}`);
        segments.push({
          shot_no: shot.shot_no,
          text: shot.voiceover_text,
          audio_path: '',
          duration_sec: 0,
          mode: 'silent',
        });
        continue;
      }

      const duration = audioFileDuration(audioPath);
      totalChars += shot.voiceover_text.length;

      segments.push({
        shot_no: shot.shot_no,
        text: shot.voiceover_text,
        audio_path: audioPath,
        duration_sec: duration,
        mode: r.mode === 'sts' ? 'sts' : 'edge_only',
      });

      // Update DB row
      db.prepare(`
        UPDATE cinema_shots
        SET voiceover_audio_path = ?, updated_at = ?
        WHERE episode_id = ? AND shot_no = ?
      `).run(audioPath, Date.now(), episodeId, shot.shot_no);
    } catch (e: any) {
      console.warn(`[cinema-voice] shot ${shot.shot_no} unexpected err: ${e?.message}`);
      segments.push({
        shot_no: shot.shot_no,
        text: shot.voiceover_text,
        audio_path: '',
        duration_sec: 0,
        mode: 'silent',
      });
    }
  }

  // Log voice cost (cents per char × 0.03 = $0.30/1k chars ElevenLabs ML v2)
  const voiceCostCents = Math.ceil(totalChars * 0.03);
  if (voiceCostCents > 0) {
    logCost({
      episode_id: episodeId,
      provider: 'elevenlabs',
      operation: 'voice_synth',
      units: totalChars,
      cost_cents: voiceCostCents,
      notes: `${totalChars} chars across ${segments.filter((s) => s.mode !== 'silent').length} shots`,
    });
  }

  const stsCount = segments.filter((s) => s.mode === 'sts').length;
  const edgeCount = segments.filter((s) => s.mode === 'edge_only').length;
  const silentCount = segments.filter((s) => s.mode === 'silent').length;
  console.log(`[cinema-voice] ep#${episodeId}: ${stsCount} STS + ${edgeCount} edge + ${silentCount} silent = ${segments.length} total | ${totalChars} chars cost=$${(voiceCostCents / 100).toFixed(2)}`);

  return segments;
}

// ═══════════════════════════════════════════════════════════
// Helper: get voice segment for shot
// ═══════════════════════════════════════════════════════════

export function getVoiceForShot(segments: CinemaVoiceSegment[], shotNo: number): CinemaVoiceSegment | undefined {
  return segments.find((s) => s.shot_no === shotNo);
}

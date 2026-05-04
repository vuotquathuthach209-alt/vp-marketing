/**
 * Anthology Visuals — fetch visual for each of 6 layers.
 *
 * Strategy per layer:
 *   - hook       → AI image (controlled — character + location framing)
 *   - context    → AI image OR Pexels stock (based on visual_prompt nature)
 *   - encounter  → AI image (CRITICAL — character + Sonder logo placement)
 *   - sensory    → Pexels stock OR AI image close-up
 *   - reflection → AI image (close-up character face)
 *   - closing    → AI image (logo + key prop fade)
 *
 * AI image priority on layers có character + logo placement
 * Pexels priority on sensory layer (texture, b-roll feel)
 *
 * Reference skill: sonder-storytelling
 */

import * as fs from 'fs';
import * as path from 'path';
import axios from 'axios';
import { searchPexels } from '../video-studio/providers/pexels';
import type { AnthologyLayer, LayerName } from './anthology-script-writer';
import type { AnthologyVisual } from './anthology-composer';
import { db } from '../../db';

const MEDIA_DIR = '/opt/vp-marketing/data/media';
const ANTH_VISUALS_DIR = path.join(MEDIA_DIR, 'anth-visuals');

if (!fs.existsSync(ANTH_VISUALS_DIR)) fs.mkdirSync(ANTH_VISUALS_DIR, { recursive: true });

const usedPexelsIds = new Set<string>();

export function resetUsedClips(): void {
  usedPexelsIds.clear();
}

// ═══════════════════════════════════════════════════════════
// AI image gen — Gemini Flash Image via existing imagegen module
// ═══════════════════════════════════════════════════════════

async function generateAIImage(prompt: string, layerName: LayerName): Promise<string | null> {
  try {
    // Layer-specific cinematography hints
    const cineHint: Record<LayerName, string> = {
      hook:       'cinematic establishing shot, shallow DOF, dramatic warm light',
      context:    'medium shot, atmospheric, natural light, environmental storytelling',
      encounter:  'medium close-up, warm interior light, intimate framing, focus on action',
      sensory:    'extreme close-up, macro detail, soft focus, tactile texture',
      reflection: 'close-up portrait, contemplative expression, soft side light, shallow DOF',
      closing:    'wide cinematic, fade to black feel, atmospheric, poetic composition',
    };

    const enhanced = `${prompt}, ${cineHint[layerName] || 'cinematic'}, Vietnamese setting, Saigon atmosphere, authentic Vietnamese faces, no Western faces, editorial photography, shot on Sony A7, vertical 9:16 portrait composition, magazine quality | negative: text overlay, watermark text, blurry, distorted face, cartoon, oversaturated, AI-generated look, plastic skin, low quality`;

    let mediaRow: any;
    try {
      const { generateImageSmart } = require('../imagegen');
      const r = await generateImageSmart(enhanced);
      mediaRow = db.prepare(`SELECT filename FROM media WHERE id = ?`).get(r.mediaId);
    } catch (e: any) {
      console.warn(`[anth-visuals] imagegen fail for ${layerName}:`, e?.message);
      return null;
    }

    if (!mediaRow) return null;
    const isUrl = /^https?:\/\//i.test(mediaRow.filename);
    return isUrl ? mediaRow.filename : path.join(MEDIA_DIR, mediaRow.filename);
  } catch (e: any) {
    console.warn(`[anth-visuals] AI image fail (${layerName}):`, e?.message);
    return null;
  }
}

// ═══════════════════════════════════════════════════════════
// Pexels stock — for b-roll / sensory layers
// ═══════════════════════════════════════════════════════════

function deriveStockQuery(layer: AnthologyLayer): string {
  // Pull keywords from visual_prompt — prioritize action/object
  // Examples:
  //   "Vietnamese woman holding tea cup, warm light" → "vietnamese woman tea"
  //   "phở bowl steam morning sunlight" → "pho vietnamese breakfast"
  const tokens = layer.visual_prompt
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 3 && !STOP_WORDS.has(w));
  return tokens.slice(0, 5).join(' ');
}

const STOP_WORDS = new Set([
  'with', 'wearing', 'holding', 'standing', 'sitting', 'looking', 'showing',
  'cinematic', 'shot', 'photo', 'image', 'composition', 'background', 'scene',
  'small', 'large', 'subtle', 'visible', 'soft', 'warm', 'natural', 'light',
  'lighting', 'focus', 'shallow', 'depth', 'field', 'portrait', 'vertical',
]);

async function fetchPexelsClip(query: string): Promise<{ path: string; duration: number; clipId: string } | null> {
  try {
    if (!query || query.length < 4) return null;

    const clips = await searchPexels(query, {
      orientation: 'portrait',
      perPage: 10,
      minDuration: 4,
      maxDuration: 25,
    });
    if (!clips || clips.length === 0) return null;

    let clip = clips.find(
      (c: any) => !usedPexelsIds.has(String(c.id)) && (c.height >= 1080 || c.width >= 1080),
    );
    if (!clip) clip = clips.find((c: any) => !usedPexelsIds.has(String(c.id))) || clips[0];
    usedPexelsIds.add(String(clip.id));

    const filename = `anth-pexels-${clip.id}.mp4`;
    const localPath = path.join(ANTH_VISUALS_DIR, filename);

    if (!fs.existsSync(localPath)) {
      const resp = await axios.get(clip.clip_url, {
        responseType: 'arraybuffer',
        timeout: 90_000,
        maxContentLength: 50 * 1024 * 1024,
      });
      fs.writeFileSync(localPath, Buffer.from(resp.data));
    }

    return { path: localPath, duration: clip.duration_sec, clipId: String(clip.id) };
  } catch (e: any) {
    console.warn(`[anth-visuals] Pexels "${query.slice(0, 40)}":`, e?.message);
    return null;
  }
}

// ═══════════════════════════════════════════════════════════
// Layer preference: AI vs Pexels
// ═══════════════════════════════════════════════════════════

const LAYER_PREFERENCE: Record<LayerName, 'ai' | 'stock'> = {
  hook:       'ai',      // controlled framing
  context:    'ai',      // character + environment
  encounter:  'ai',      // CRITICAL — character + logo placement
  sensory:    'stock',   // b-roll texture works well from Pexels
  reflection: 'ai',      // close-up character
  closing:    'ai',      // logo + key prop
};

// ═══════════════════════════════════════════════════════════
// Per-layer fetch (with fallback)
// ═══════════════════════════════════════════════════════════

export async function fetchVisualForLayer(layer: AnthologyLayer): Promise<AnthologyVisual | null> {
  const preference = LAYER_PREFERENCE[layer.layer_name] || 'ai';

  const tryAI = async (): Promise<AnthologyVisual | null> => {
    const p = await generateAIImage(layer.visual_prompt, layer.layer_name);
    if (p) {
      console.log(`[anth-visuals] L${layer.layer_no} ${layer.layer_name} → AI image`);
      return {
        layer_no: layer.layer_no,
        layer_name: layer.layer_name,
        type: 'image',
        local_path: p,
        visual_prompt: layer.visual_prompt,
      };
    }
    return null;
  };

  const tryStock = async (): Promise<AnthologyVisual | null> => {
    const q = deriveStockQuery(layer);
    const c = await fetchPexelsClip(q);
    if (c) {
      console.log(`[anth-visuals] L${layer.layer_no} ${layer.layer_name} → Pexels (${path.basename(c.path)})`);
      return {
        layer_no: layer.layer_no,
        layer_name: layer.layer_name,
        type: 'stock_video',
        local_path: c.path,
        visual_prompt: layer.visual_prompt,
      };
    }
    return null;
  };

  if (preference === 'ai') {
    return (await tryAI()) || (await tryStock());
  } else {
    return (await tryStock()) || (await tryAI());
  }
}

// ═══════════════════════════════════════════════════════════
// Fetch all 6 layer visuals (sequential, dedup Pexels)
// ═══════════════════════════════════════════════════════════

export async function fetchAllAnthologyVisuals(layers: AnthologyLayer[]): Promise<Array<AnthologyVisual | null>> {
  resetUsedClips();
  const results: Array<AnthologyVisual | null> = [];

  for (const layer of layers) {
    const v = await fetchVisualForLayer(layer);
    results.push(v);
    // Pause between AI image gens to avoid rate limit
    if (v?.type === 'image') {
      await new Promise((r) => setTimeout(r, 800));
    }
  }

  const okCount = results.filter((r) => r).length;
  console.log(`[anth-visuals] fetched ${okCount}/6 visuals`);

  return results;
}

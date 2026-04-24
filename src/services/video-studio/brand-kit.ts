/**
 * Brand Kit — bộ nhận diện thương hiệu cho video.
 *
 * Quản lý intro/outro clip, logo, LUT color grading, voice, subtitle style.
 * Mục tiêu: mọi video share cùng "look & feel" → consistency cao.
 *
 * Auto-generate defaults khi init (ko cần admin config phức tạp).
 */

import { db } from '../../db';
import * as path from 'path';
import * as fs from 'fs';

export interface BrandKit {
  id: number;
  name: string;
  intro_clip_url?: string;
  outro_clip_url?: string;
  logo_url?: string;
  logo_position: string;
  primary_color: string;
  secondary_color: string;
  subtitle_font: string;
  subtitle_style: string;
  subtitle_color: string;
  color_lut_file?: string;
  aspect_ratio: string;
  resolution: string;
  voice_id?: string;
  voice_settings_json?: string;
  music_mood: string;
  watermark_opacity: number;
  active: number;
  is_default: number;
}

const DATA_DIR = path.resolve(process.cwd(), 'data', 'video-studio');
const LUT_DIR = path.join(DATA_DIR, 'luts');
const BRAND_ASSETS_DIR = path.join(DATA_DIR, 'brand-assets');

function ensureDirs() {
  for (const d of [DATA_DIR, LUT_DIR, BRAND_ASSETS_DIR]) {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  }
}

/**
 * Auto-generate default brand kit khi install module (1 lần).
 *
 * Defaults em chọn:
 * - Name: "Sonder Travel Tips"
 * - Colors: warm orange (#FF6B35) + dark gray (#2B2B2B)
 * - Aspect: 9:16 (vertical cho Reels/Shorts)
 * - Voice: ElevenLabs "Mai" (female VN, warm)
 * - Music mood: upbeat_travel
 * - Subtitle: yellow bold bottom center
 * - LUT: warm cinematic (auto-generated .cube file)
 */
export function ensureDefaultBrandKit(): { id: number; created: boolean; brand_kit: BrandKit } {
  ensureDirs();

  const existing = db.prepare(`SELECT * FROM video_brand_kits WHERE is_default = 1 LIMIT 1`).get() as any;
  if (existing) {
    return { id: existing.id, created: false, brand_kit: existing };
  }

  // Generate default LUT file (warm cinematic look)
  const lutPath = path.join(LUT_DIR, 'sonder-warm-default.cube');
  if (!fs.existsSync(lutPath)) {
    fs.writeFileSync(lutPath, generateDefaultLUT());
  }

  const now = Date.now();
  const voiceSettings = JSON.stringify({
    stability: 0.6,
    similarity_boost: 0.8,
    style: 0.3,
    use_speaker_boost: true,
  });

  const result = db.prepare(`
    INSERT INTO video_brand_kits
      (name, logo_position, primary_color, secondary_color,
       subtitle_font, subtitle_style, subtitle_color,
       color_lut_file, aspect_ratio, resolution,
       voice_settings_json, music_mood, watermark_opacity,
       active, is_default, created_at, updated_at)
    VALUES (?, 'top_right', '#FF6B35', '#2B2B2B',
            'Montserrat-Bold', 'yellow_bottom_shadow', '#FFEB3B',
            ?, '9:16', '1080x1920',
            ?, 'upbeat_travel', 0.7,
            1, 1, ?, ?)
  `).run('Sonder Travel Tips', lutPath, voiceSettings, now, now);

  const created = db.prepare(`SELECT * FROM video_brand_kits WHERE id = ?`).get(result.lastInsertRowid) as BrandKit;
  console.log('[vs-brand-kit] created default brand kit id=', created.id);

  return { id: created.id, created: true, brand_kit: created };
}

/**
 * Generate a simple warm cinematic LUT (.cube format).
 * Format spec: https://wwwimages2.adobe.com/content/dam/acom/en/products/speedgrade/cc/pdfs/cube-lut-specification-1.0.pdf
 *
 * Effect: boost warmth (red +10%, yellow +5%), soft shadows, gentle contrast.
 */
function generateDefaultLUT(): string {
  const SIZE = 17;  // 17³ = 4913 entries
  const lines: string[] = [
    'TITLE "Sonder Warm Cinematic"',
    `LUT_3D_SIZE ${SIZE}`,
    '',
  ];

  for (let b = 0; b < SIZE; b++) {
    for (let g = 0; g < SIZE; g++) {
      for (let r = 0; r < SIZE; r++) {
        const rn = r / (SIZE - 1);
        const gn = g / (SIZE - 1);
        const bn = b / (SIZE - 1);

        // Apply warm shift
        const rOut = Math.min(1, rn * 1.08 + 0.02);      // Red boost
        const gOut = Math.min(1, gn * 1.02 + 0.015);     // Slight yellow
        const bOut = Math.max(0, bn * 0.93 - 0.01);      // Cool down blue

        // Gentle S-curve for contrast
        const sCurve = (x: number) => {
          if (x < 0.5) return 2 * x * x;
          return 1 - 2 * (1 - x) * (1 - x);
        };

        lines.push([
          (sCurve(rOut) * 0.9 + rOut * 0.1).toFixed(6),
          (sCurve(gOut) * 0.9 + gOut * 0.1).toFixed(6),
          (sCurve(bOut) * 0.9 + bOut * 0.1).toFixed(6),
        ].join(' '));
      }
    }
  }

  return lines.join('\n') + '\n';
}

export function getDefaultBrandKit(): BrandKit | null {
  try {
    return db.prepare(`SELECT * FROM video_brand_kits WHERE is_default = 1 AND active = 1 LIMIT 1`).get() as BrandKit;
  } catch { return null; }
}

export function getBrandKit(id: number): BrandKit | null {
  try {
    return db.prepare(`SELECT * FROM video_brand_kits WHERE id = ? AND active = 1`).get(id) as BrandKit;
  } catch { return null; }
}

export function listBrandKits(): BrandKit[] {
  try {
    return db.prepare(`SELECT * FROM video_brand_kits WHERE active = 1 ORDER BY is_default DESC, id ASC`).all() as BrandKit[];
  } catch { return []; }
}

export function updateBrandKit(id: number, updates: Partial<BrandKit>): { success: boolean; error?: string } {
  try {
    const allowed = [
      'name', 'logo_url', 'logo_position', 'primary_color', 'secondary_color',
      'subtitle_font', 'subtitle_style', 'subtitle_color', 'color_lut_file',
      'aspect_ratio', 'resolution', 'voice_id', 'voice_settings_json',
      'music_mood', 'watermark_opacity', 'intro_clip_url', 'outro_clip_url',
    ];
    const sets: string[] = [];
    const vals: any[] = [];
    for (const k of allowed) {
      if ((updates as any)[k] !== undefined) {
        sets.push(`${k} = ?`);
        vals.push((updates as any)[k]);
      }
    }
    if (sets.length === 0) return { success: true };

    sets.push('updated_at = ?');
    vals.push(Date.now());
    vals.push(id);

    db.prepare(`UPDATE video_brand_kits SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
    return { success: true };
  } catch (e: any) {
    return { success: false, error: e?.message };
  }
}

/**
 * Export brand kit as JSON (for backup / sharing).
 */
export function exportBrandKit(id: number): any {
  const kit = getBrandKit(id);
  if (!kit) return null;
  return {
    ...kit,
    voice_settings: kit.voice_settings_json ? JSON.parse(kit.voice_settings_json) : null,
  };
}

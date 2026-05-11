/**
 * Image verifier — compute pHash + EXIF + reverse search → risk score.
 *
 * Uses:
 *   - sharp + raw pixel grayscale (8x8 DCT-lite) → perceptual hash
 *   - exifr (npm) for EXIF — but to avoid new dep, use raw JPEG marker parsing
 *   - Google Vision Web Detection (paid, $1.50/1000)
 *
 * Risk scoring formula:
 *   base = 0
 *   if web_matches > 5: +40
 *   if web_matches > 0: +20
 *   if no_exif: +10
 *   if internal_dupe > 1: +30 (same image used multiple times)
 *   if source == 'sondervn_ota': +25 (hotel partner image — risky as they may post same on their FB)
 *   if in_takedown_blacklist: +100 (auto-block)
 *   if source == 'sonder_drive' AND has_exif: -10 (boost trust)
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { spawnSync } from 'child_process';
import sharp from 'sharp';
import axios from 'axios';
import { db, getSetting } from '../../db';
import type { ImageRiskAssessment, ImageSource, RiskLevel } from './types';

const GOOGLE_VISION_URL = 'https://vision.googleapis.com/v1/images:annotate';
const HASH_SIZE = 8;  // 8x8 = 64-bit pHash
const TMP_CONVERT_DIR = '/tmp/copyright-convert';
if (!fs.existsSync(TMP_CONVERT_DIR)) fs.mkdirSync(TMP_CONVERT_DIR, { recursive: true });

/** Convert HEIC/HEIF/AVIF to JPEG using ffmpeg. Returns path of converted file (caller cleans up). */
function maybeConvertToJpeg(imagePath: string): string {
  const ext = path.extname(imagePath).toLowerCase();
  if (!['.heic', '.heif', '.avif'].includes(ext)) return imagePath;

  const hash = crypto.createHash('md5').update(imagePath).digest('hex').slice(0, 12);
  const outPath = path.join(TMP_CONVERT_DIR, `${hash}.jpg`);
  if (fs.existsSync(outPath)) return outPath;

  try {
    const r = spawnSync('ffmpeg', [
      '-y', '-loglevel', 'error',
      '-i', imagePath,
      '-frames:v', '1',
      '-q:v', '4',
      outPath,
    ], { timeout: 30_000 });
    if (r.status === 0 && fs.existsSync(outPath)) return outPath;
  } catch {}
  return imagePath;  // fallback — let sharp try (and fail with logged warning)
}

/** Compute pHash (perceptual hash) — robust to resizing/recompression. */
export async function computePHash(imagePath: string): Promise<string | null> {
  const readable = maybeConvertToJpeg(imagePath);
  try {
    // Resize to (hashSize+1) × hashSize and grayscale → DCT-like difference
    const buf = await sharp(readable)
      .resize(HASH_SIZE + 1, HASH_SIZE, { fit: 'fill' })
      .grayscale()
      .raw()
      .toBuffer();

    // Compute difference hash: each pixel vs its right neighbor
    let bits = '';
    for (let y = 0; y < HASH_SIZE; y++) {
      for (let x = 0; x < HASH_SIZE; x++) {
        const left = buf[y * (HASH_SIZE + 1) + x];
        const right = buf[y * (HASH_SIZE + 1) + x + 1];
        bits += left < right ? '1' : '0';
      }
    }
    // Convert binary to hex (16 chars)
    let hex = '';
    for (let i = 0; i < bits.length; i += 4) {
      hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
    }
    return hex;
  } catch (e: any) {
    console.warn(`[copyright] pHash fail ${imagePath}:`, e?.message);
    return null;
  }
}

/** Hamming distance between two hex pHashes. 0 = identical, 64 = totally different. */
export function pHashDistance(a: string, b: string): number {
  if (!a || !b || a.length !== b.length) return 999;
  let d = 0;
  for (let i = 0; i < a.length; i++) {
    const xa = parseInt(a[i], 16);
    const xb = parseInt(b[i], 16);
    let xor = xa ^ xb;
    while (xor) { d += xor & 1; xor >>= 1; }
  }
  return d;
}

/** Extract basic EXIF (camera make + taken time) using sharp metadata. */
export async function extractExif(imagePath: string): Promise<{
  camera: string | null;
  taken_at: number | null;
  has_exif: boolean;
  width: number;
  height: number;
}> {
  const readable = maybeConvertToJpeg(imagePath);
  try {
    const meta = await sharp(readable).metadata();
    const exif = (meta.exif ? parseExifBuffer(meta.exif) : {}) as any;
    return {
      camera: exif.make && exif.model ? `${exif.make} ${exif.model}`.trim() : (exif.make || null),
      taken_at: exif.taken_at || null,
      has_exif: !!meta.exif && Object.keys(exif).length > 0,
      width: meta.width || 0,
      height: meta.height || 0,
    };
  } catch (e: any) {
    return { camera: null, taken_at: null, has_exif: false, width: 0, height: 0 };
  }
}

/** Tiny EXIF parser — extracts Make/Model/DateTimeOriginal from EXIF buffer. */
function parseExifBuffer(buf: Buffer): { make?: string; model?: string; taken_at?: number } {
  try {
    const s = buf.toString('latin1');
    const result: any = {};
    // Crude string scan — works for most JPEG EXIF
    const makeMatch = s.match(/Apple|Canon|Nikon|Sony|Samsung|Google|Xiaomi|Huawei|OnePlus|Fujifilm|Olympus|Panasonic|Leica|GoPro/i);
    if (makeMatch) result.make = makeMatch[0];
    // DateTimeOriginal format: "YYYY:MM:DD HH:MM:SS"
    const dateMatch = s.match(/(\d{4}:\d{2}:\d{2}\s\d{2}:\d{2}:\d{2})/);
    if (dateMatch) {
      const [y, mo, rest] = dateMatch[1].split(':');
      const [d, time] = rest.split(' ');
      const iso = `${y}-${mo}-${d}T${time}+07:00`;
      const ts = new Date(iso).getTime();
      if (!isNaN(ts)) result.taken_at = ts;
    }
    return result;
  } catch { return {}; }
}

/** Reverse image search via Google Vision Web Detection.
 *
 * Cost: $1.50 per 1000 (after free tier).
 * Returns: list of URLs where this image appears + count.
 */
export async function reverseImageSearch(imagePath: string): Promise<{
  matches_count: number;
  matches: string[];
  best_guess_label: string | null;
  cost_usd: number;
  error?: string;
}> {
  const apiKey = getSetting('google_cloud_vision_api_key') || getSetting('google_api_key') || process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    return { matches_count: 0, matches: [], best_guess_label: null, cost_usd: 0, error: 'no api key' };
  }

  if (!fs.existsSync(imagePath)) {
    return { matches_count: 0, matches: [], best_guess_label: null, cost_usd: 0, error: 'file not found' };
  }

  try {
    const imageData = fs.readFileSync(imagePath);
    const base64 = imageData.toString('base64');

    const r = await axios.post(
      `${GOOGLE_VISION_URL}?key=${apiKey}`,
      {
        requests: [{
          image: { content: base64 },
          features: [{ type: 'WEB_DETECTION', maxResults: 20 }],
        }],
      },
      { timeout: 30_000 },
    );

    const web = r.data?.responses?.[0]?.webDetection;
    if (!web) return { matches_count: 0, matches: [], best_guess_label: null, cost_usd: 0.0015 };

    // Get matches
    const fullPages = web.pagesWithMatchingImages || [];
    const partialPages = web.partialMatchingImages || [];
    const visuallySimilar = web.visuallySimilarImages || [];
    const fullMatch = web.fullMatchingImages || [];

    const matches = new Set<string>();
    [...fullMatch, ...fullPages, ...partialPages].forEach((m: any) => {
      if (m.url) matches.add(m.url);
    });

    const bestGuess = web.bestGuessLabels?.[0]?.label || null;

    return {
      matches_count: matches.size,
      matches: Array.from(matches).slice(0, 10),
      best_guess_label: bestGuess,
      cost_usd: 0.0015,
    };
  } catch (e: any) {
    const errMsg = e?.response?.data?.error?.message || e?.message;
    return { matches_count: 0, matches: [], best_guess_label: null, cost_usd: 0, error: errMsg };
  }
}

/** Infer image source from file path. */
function inferSource(imagePath: string): ImageSource {
  const lower = imagePath.toLowerCase();
  if (lower.includes('/var/sonder-real-footage/')) return 'sonder_drive';
  if (lower.includes('gdrive') || lower.includes('googleusercontent')) return 'sondervn_ota';
  if (lower.includes('/ai-') || lower.includes('flux')) return 'ai_generated';
  if (lower.includes('pexels')) return 'stock_pexels';
  if (lower.includes('unsplash')) return 'stock_unsplash';
  if (lower.includes('/autopost_')) return 'manual_upload';
  return 'unknown';
}

/** Compute internal dupe count by pHash (Hamming distance ≤ 5 = match). */
function countInternalDupes(phash: string, excludePath: string): { count: number; paths: string[] } {
  if (!phash) return { count: 0, paths: [] };
  const rows = db.prepare(
    `SELECT image_path AS path, phash FROM copyright_phashes WHERE phash IS NOT NULL AND image_path != ?`,
  ).all(excludePath) as Array<{ path: string }>;
  const dupes: string[] = [];
  for (const r of rows) {
    const dist = pHashDistance(phash, (r as any).phash || '');
    if (dist <= 5) dupes.push(r.path);
  }
  return { count: dupes.length, paths: dupes.slice(0, 5) };
}

/** Check known takedown blacklist by pHash. */
function inTakedownBlacklist(phash: string): boolean {
  if (!phash) return false;
  const rows = db.prepare(`SELECT phash FROM copyright_takedown_blacklist`).all() as Array<{ phash: string }>;
  return rows.some((r) => pHashDistance(phash, r.phash) <= 5);
}

/** Compute final risk score + level. */
function scoreRisk(opts: {
  has_exif: boolean;
  web_matches: number;
  internal_dupes: number;
  source: ImageSource;
  in_blacklist: boolean;
}): { score: number; level: RiskLevel; reasons: string[] } {
  const reasons: string[] = [];
  let score = 0;

  if (opts.in_blacklist) {
    reasons.push('Image MATCHES previous FB takedown — DO NOT POST');
    return { score: 100, level: 'critical', reasons };
  }

  if (opts.web_matches > 10) {
    score += 50; reasons.push(`Found on ${opts.web_matches} websites (likely stock/already-shared image)`);
  } else if (opts.web_matches > 3) {
    score += 30; reasons.push(`Found on ${opts.web_matches} other websites — risk of duplicate claim`);
  } else if (opts.web_matches > 0) {
    score += 15; reasons.push(`Found on ${opts.web_matches} other website(s)`);
  }

  if (opts.internal_dupes > 0) {
    score += 25; reasons.push(`Found ${opts.internal_dupes} duplicate(s) in own library — possible re-use`);
  }

  if (!opts.has_exif) {
    score += 15; reasons.push('No EXIF metadata — possibly downloaded/screenshot');
  }

  // Source-based risk
  if (opts.source === 'sondervn_ota') {
    score += 30;
    reasons.push('Source = sondervn.com hotel partner image (hotel may have already posted on their own FB)');
  } else if (opts.source === 'unknown') {
    score += 10;
    reasons.push('Source unknown');
  } else if (opts.source === 'sonder_drive') {
    score -= 5;  // trust bonus
    reasons.push('✓ Source = Sonder Drive divider (anh upload)');
  } else if (opts.source === 'ai_generated') {
    score += 5;
    reasons.push('Source = AI-generated (small risk: C2PA detection)');
  }

  score = Math.max(0, Math.min(100, score));
  const level: RiskLevel =
    score >= 80 ? 'critical' :
    score >= 60 ? 'high' :
    score >= 40 ? 'medium' :
    score >= 20 ? 'low' : 'safe';

  return { score, level, reasons };
}

/** Full assessment — combines all signals. */
export async function assessImage(imagePath: string, opts?: {
  source_override?: ImageSource;
  source_url?: string;
  skip_web_search?: boolean;        // if true, skip paid Google Vision call
}): Promise<ImageRiskAssessment> {
  const exif = await extractExif(imagePath);
  const phash = await computePHash(imagePath);
  const source = opts?.source_override || inferSource(imagePath);

  // Save phash to lookup table (for future internal dupe checks)
  if (phash) {
    db.prepare(
      `INSERT OR REPLACE INTO copyright_phashes (image_path, phash, source, computed_at)
       VALUES (?, ?, ?, ?)`,
    ).run(imagePath, phash, source, Date.now());
  }

  const dupes = phash ? countInternalDupes(phash, imagePath) : { count: 0, paths: [] };
  const blacklisted = phash ? inTakedownBlacklist(phash) : false;

  let webResults = { matches_count: 0, matches: [] as string[], cost_usd: 0 };
  if (!opts?.skip_web_search && !blacklisted) {
    const r = await reverseImageSearch(imagePath);
    webResults = { matches_count: r.matches_count, matches: r.matches, cost_usd: r.cost_usd };
  }

  const risk = scoreRisk({
    has_exif: exif.has_exif,
    web_matches: webResults.matches_count,
    internal_dupes: dupes.count,
    source,
    in_blacklist: blacklisted,
  });

  const now = Date.now();
  const status: ImageRiskAssessment['status'] =
    blacklisted ? 'auto_blocked' :
    risk.score >= 80 ? 'auto_blocked' :
    risk.score >= 40 ? 'pending' :
    'approved';

  const assessment: ImageRiskAssessment = {
    image_path: imagePath,
    perceptual_hash: phash,
    exif_camera: exif.camera,
    exif_taken_at: exif.taken_at,
    has_exif: exif.has_exif,
    source,
    source_url: opts?.source_url || null,
    web_matches_count: webResults.matches_count,
    web_matches: webResults.matches,
    internal_dupe_count: dupes.count,
    internal_dupe_paths: dupes.paths,
    in_takedown_blacklist: blacklisted,
    risk_score: risk.score,
    risk_level: risk.level,
    risk_reasons: risk.reasons,
    status,
    checked_at: now,
    reviewed_by: null,
    reviewed_at: null,
    notes: null,
  };

  // Save full assessment
  db.prepare(
    `INSERT OR REPLACE INTO copyright_assessments
     (image_path, phash, exif_camera, has_exif, source, source_url,
      web_matches_count, web_matches_json, internal_dupe_count, internal_dupe_paths_json,
      in_takedown_blacklist, risk_score, risk_level, risk_reasons_json,
      status, checked_at, reviewed_by, reviewed_at, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    imagePath, phash, exif.camera, exif.has_exif ? 1 : 0, source, opts?.source_url || null,
    webResults.matches_count, JSON.stringify(webResults.matches),
    dupes.count, JSON.stringify(dupes.paths),
    blacklisted ? 1 : 0, risk.score, risk.level, JSON.stringify(risk.reasons),
    status, now, null, null, null,
  );

  return assessment;
}

/** Add image to takedown blacklist (called when FB removes a post). */
export function addToTakedownBlacklist(imagePath: string, reason: string): boolean {
  const phashRow = db.prepare(`SELECT phash FROM copyright_phashes WHERE image_path = ?`).get(imagePath) as { phash: string } | undefined;
  if (!phashRow?.phash) return false;
  db.prepare(
    `INSERT OR REPLACE INTO copyright_takedown_blacklist (phash, image_path, reason, added_at)
     VALUES (?, ?, ?, ?)`,
  ).run(phashRow.phash, imagePath, reason, Date.now());
  return true;
}

/** Quick gate function — return true if image is safe to publish. */
export async function isImageSafeToPublish(imagePath: string, opts?: {
  threshold?: number;            // default 60 — block above this
  allow_pending_review?: boolean;
}): Promise<{ ok: boolean; assessment: ImageRiskAssessment }> {
  const a = await assessImage(imagePath);
  const threshold = opts?.threshold || 60;
  const ok = a.risk_score < threshold && a.status !== 'auto_blocked';
  return { ok, assessment: a };
}

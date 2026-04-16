import { db, getSetting } from '../db';
import axios from 'axios';
import crypto from 'crypto';

/**
 * Google Drive Image Service
 *
 * 2 modes:
 *   Mode 1 (Simple): Folder shared public → scrape file list (NO API key needed)
 *   Mode 2 (API):     API Key with Drive API enabled → Drive API v3
 */

interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
}

// Cache: folderId -> { files, expiresAt }
const cache = new Map<string, { files: DriveFile[]; expiresAt: number }>();
const CACHE_TTL = 60 * 60 * 1000; // 1 hour

/* ═══════════════════════════════════════════
   MODE 1: PUBLIC FOLDER — No API key needed
   Folder MUST be shared "Anyone with the link"
   ═══════════════════════════════════════════ */

async function listPublicFolder(folderId: string): Promise<DriveFile[]> {
  // Google Drive embed page exposes file list as JSON-like content
  // We use the export/download URL pattern with folder listing
  try {
    // Method: Use Google Drive API v3 with no auth — works for public folders!
    const q = encodeURIComponent(`'${folderId}' in parents and (mimeType='image/jpeg' or mimeType='image/png' or mimeType='image/webp') and trashed=false`);
    const fields = encodeURIComponent('files(id,name,mimeType)');
    const url = `https://www.googleapis.com/drive/v3/files?q=${q}&fields=${fields}&pageSize=100&key=`;

    // Try with API key first
    const apiKey = getSetting('gdrive_api_key') || getSetting('google_api_key');
    if (apiKey) {
      const res = await axios.get(url + encodeURIComponent(apiKey), { timeout: 15000 });
      return res.data.files || [];
    }

    // Fallback: scrape the public folder page
    const pageUrl = `https://drive.google.com/embeddedfolderview?id=${folderId}#grid`;
    const { data: html } = await axios.get(pageUrl, {
      timeout: 15000,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
    });

    // Extract file IDs from the embedded page
    const files: DriveFile[] = [];
    // Pattern: /file/d/FILE_ID or data-id="FILE_ID"
    const idRegex = /(?:\/file\/d\/|data-id="|"id":")([\w\-]{20,})/g;
    const nameRegex = /(?:data-tooltip="|"title":")(.*?)"/g;
    let match;
    const seenIds = new Set<string>();

    while ((match = idRegex.exec(html)) !== null) {
      const id = match[1];
      if (seenIds.has(id) || id === folderId) continue;
      seenIds.add(id);
      files.push({ id, name: `image_${files.length + 1}`, mimeType: 'image/jpeg' });
    }

    // Also try JSON pattern from Drive's internal API
    const jsonPattern = /\["([\w\-]{25,})"[^\]]*?"([^"]*?\.(jpe?g|png|webp))"/gi;
    while ((match = jsonPattern.exec(html)) !== null) {
      const id = match[1];
      if (seenIds.has(id)) continue;
      seenIds.add(id);
      files.push({ id, name: match[2], mimeType: `image/${match[3] === 'jpg' ? 'jpeg' : match[3]}` });
    }

    console.log(`[gdrive] Scraped ${files.length} images from public folder ${folderId}`);
    return files;
  } catch (err: any) {
    console.error(`[gdrive] Public folder listing failed:`, err.response?.status, err.message);
    throw new Error(`Khong the doc folder. Dam bao folder da share "Anyone with the link". Loi: ${err.response?.status || err.message}`);
  }
}

/* ═══════════════════════════════════════════
   MODE 2: API KEY — Drive API enabled
   ═══════════════════════════════════════════ */

async function listViaApi(folderId: string): Promise<DriveFile[]> {
  const apiKey = getSetting('gdrive_api_key') || getSetting('google_api_key');
  if (!apiKey) throw new Error('Chua co Google API Key');

  const allFiles: DriveFile[] = [];
  let pageToken: string | undefined;

  const q = encodeURIComponent(`'${folderId}' in parents and (mimeType='image/jpeg' or mimeType='image/png' or mimeType='image/webp') and trashed=false`);
  const fields = encodeURIComponent('nextPageToken,files(id,name,mimeType)');

  do {
    let url = `https://www.googleapis.com/drive/v3/files?q=${q}&fields=${fields}&pageSize=100&key=${encodeURIComponent(apiKey)}`;
    if (pageToken) url += `&pageToken=${encodeURIComponent(pageToken)}`;

    const res = await axios.get(url, { timeout: 15000 });
    allFiles.push(...(res.data.files || []));
    pageToken = res.data.nextPageToken;
  } while (pageToken);

  return allFiles;
}

/* ═══════════════════════════════════════════
   MAIN FUNCTIONS
   ═══════════════════════════════════════════ */

export async function listDriveImages(folderId: string): Promise<DriveFile[]> {
  // Check cache
  const cached = cache.get(folderId);
  if (cached && cached.expiresAt > Date.now()) return cached.files;

  let files: DriveFile[] = [];

  // Try API key mode first (more reliable)
  const apiKey = getSetting('gdrive_api_key') || getSetting('google_api_key');
  if (apiKey) {
    try {
      files = await listViaApi(folderId);
    } catch (err: any) {
      console.warn(`[gdrive] API mode failed (${err.response?.status}), trying public mode...`);
      files = await listPublicFolder(folderId);
    }
  } else {
    // No API key → public folder mode
    files = await listPublicFolder(folderId);
  }

  cache.set(folderId, { files, expiresAt: Date.now() + CACHE_TTL });
  console.log(`[gdrive] Found ${files.length} images in folder ${folderId}`);
  return files;
}

export function getDriveImageUrl(fileId: string): string {
  // Direct download URL — works for public files
  return `https://drive.google.com/uc?export=view&id=${encodeURIComponent(fileId)}`;
}

/** Facebook-compatible direct URL (ldrv.ms redirect won't work on FB) */
export function getDriveDirectUrl(fileId: string): string {
  return `https://lh3.googleusercontent.com/d/${encodeURIComponent(fileId)}`;
}

export async function getRandomDriveImage(folderId: string): Promise<DriveFile & { url: string }> {
  const files = await listDriveImages(folderId);
  if (files.length === 0) throw new Error('Khong tim thay anh nao trong folder');

  // Prefer least-used images from DB
  const hotelRow = db.prepare(
    `SELECT hotel_id FROM gdrive_images WHERE drive_file_id = ? LIMIT 1`
  ).get(files[0].id) as any;

  if (hotelRow) {
    const leastUsed = db.prepare(
      `SELECT drive_file_id FROM gdrive_images WHERE hotel_id = ? ORDER BY used_count ASC, RANDOM() LIMIT 1`
    ).get(hotelRow.hotel_id) as any;
    if (leastUsed) {
      const match = files.find(f => f.id === leastUsed.drive_file_id);
      if (match) return { ...match, url: getDriveDirectUrl(match.id) };
    }
  }

  const file = files[Math.floor(Math.random() * files.length)];
  return { ...file, url: getDriveDirectUrl(file.id) };
}

export async function syncDriveFolder(folderId: string, hotelId: number): Promise<number> {
  const files = await listDriveImages(folderId);

  const upsert = db.prepare(`
    INSERT INTO gdrive_images (hotel_id, drive_file_id, file_name, mime_type, view_url, synced_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(hotel_id, drive_file_id) DO UPDATE SET
      file_name = excluded.file_name,
      view_url = excluded.view_url,
      synced_at = excluded.synced_at
  `);

  const now = Date.now();
  const syncMany = db.transaction(() => {
    for (const f of files) {
      upsert.run(hotelId, f.id, f.name, f.mimeType, getDriveDirectUrl(f.id), now);
    }
  });
  syncMany();

  // Remove stale entries
  const remoteIds = files.map(f => f.id);
  if (remoteIds.length > 0) {
    const ph = remoteIds.map(() => '?').join(',');
    db.prepare(`DELETE FROM gdrive_images WHERE hotel_id = ? AND drive_file_id NOT IN (${ph})`).run(hotelId, ...remoteIds);
  } else {
    db.prepare('DELETE FROM gdrive_images WHERE hotel_id = ?').run(hotelId);
  }

  console.log(`[gdrive] Synced ${files.length} images for hotel ${hotelId}`);
  return files.length;
}

/**
 * V5T Google Drive Sync — pull photos/videos from anh's Drive folder.
 *
 * Reference: skill sonder-content-v5t (real photo pillar)
 *
 * Workflow:
 *   1. Cron 15min: list files in gdrive_folder_id
 *   2. Filter NEW files (not in v5_footage yet)
 *   3. Download → /var/sonder-real-footage/<gdrive_id>-<filename>
 *   4. Analyze image với Gemini Vision → describe + tag
 *   5. Insert v5_footage row
 *
 * Settings used:
 *   gdrive_api_key — Google Drive API key
 *   gdrive_folder_id — folder ID anh post ảnh
 *   google_api_key — Gemini Vision API key
 */

import * as fs from 'fs';
import * as path from 'path';
import axios from 'axios';
import { db, getSetting } from '../../db';
import { analyzeImageContent } from './vision-analyzer';

const FOOTAGE_DIR = process.env.V5_FOOTAGE_DIR || '/var/sonder-real-footage';
if (!fs.existsSync(FOOTAGE_DIR)) fs.mkdirSync(FOOTAGE_DIR, { recursive: true });

interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
  createdTime: string;
  modifiedTime: string;
}

/** List all files in configured Drive folder */
async function listDriveFolder(folderId: string, apiKey: string): Promise<DriveFile[]> {
  try {
    const r = await axios.get('https://www.googleapis.com/drive/v3/files', {
      params: {
        q: `'${folderId}' in parents and trashed=false`,
        fields: 'files(id,name,mimeType,size,createdTime,modifiedTime)',
        key: apiKey,
        pageSize: 100,
      },
      timeout: 30000,
    });
    return r.data.files || [];
  } catch (e: any) {
    console.warn('[gdrive-sync] list fail:', e?.response?.data?.error?.message || e.message);
    return [];
  }
}

/** Download file from Drive to local */
async function downloadDriveFile(fileId: string, apiKey: string, outPath: string): Promise<boolean> {
  try {
    const r = await axios.get(`https://www.googleapis.com/drive/v3/files/${fileId}`, {
      params: { alt: 'media', key: apiKey },
      responseType: 'arraybuffer',
      timeout: 60000,
      maxContentLength: 50 * 1024 * 1024,
    });
    fs.writeFileSync(outPath, Buffer.from(r.data));
    return true;
  } catch (e: any) {
    console.warn(`[gdrive-sync] download ${fileId} fail:`, e?.response?.status || e.message);
    return false;
  }
}

/** Check if Drive file already synced (by gdrive_id stored in notes) */
function isAlreadySynced(driveFileId: string): boolean {
  const r = db.prepare(
    `SELECT id FROM v5_footage WHERE notes LIKE ?`,
  ).get(`%gdrive_id:${driveFileId}%`);
  return !!r;
}

/** Main entry — sync new files from Drive folder */
export async function syncGoogleDriveFolder(): Promise<{
  scanned: number;
  new_files: number;
  downloaded: number;
  analyzed: number;
  errors: string[];
}> {
  const result = {
    scanned: 0,
    new_files: 0,
    downloaded: 0,
    analyzed: 0,
    errors: [] as string[],
  };

  const apiKey = getSetting('gdrive_api_key');
  const folderId = getSetting('gdrive_folder_id');
  if (!apiKey || !folderId) {
    result.errors.push('gdrive_api_key or gdrive_folder_id not configured');
    return result;
  }

  const files = await listDriveFolder(folderId, apiKey);
  result.scanned = files.length;
  console.log(`[gdrive-sync] folder has ${files.length} files`);

  for (const f of files) {
    // Only image + video
    if (!f.mimeType.startsWith('image/') && !f.mimeType.startsWith('video/')) continue;
    if (isAlreadySynced(f.id)) continue;
    result.new_files++;

    // Generate safe filename
    const ext = (f.name.match(/\.[a-zA-Z0-9]+$/) || ['.bin'])[0];
    const safeName = f.name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 60);
    const localPath = path.join(FOOTAGE_DIR, `gdrive-${f.id.slice(-8)}-${safeName}`);

    // Download
    const ok = await downloadDriveFile(f.id, apiKey, localPath);
    if (!ok) {
      result.errors.push(`download fail: ${f.name}`);
      continue;
    }
    result.downloaded++;

    // Analyze image with Gemini Vision (skip videos for now)
    let location = null;
    let character = null;
    let momentTag = null;
    let analysisNotes = '';

    if (f.mimeType.startsWith('image/')) {
      try {
        const analysis = await analyzeImageContent(localPath);
        if (analysis) {
          location = analysis.location;
          character = analysis.character;
          momentTag = analysis.moment_tag;
          analysisNotes = analysis.description || '';
          result.analyzed++;
        }
      } catch (e: any) {
        console.warn(`[gdrive-sync] vision analyze fail for ${f.name}:`, e.message);
      }
    }

    // Insert v5_footage row
    const now = Date.now();
    const mediaType = f.mimeType.startsWith('image/') ? 'image' : 'video';
    db.prepare(
      `INSERT INTO v5_footage
       (filename, path, media_type, location, character, moment_tag,
        uploaded_by, uploaded_at, used_count, notes, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'gdrive-sync', ?, 0, ?, ?)`,
    ).run(
      f.name,
      localPath,
      mediaType,
      location,
      character,
      momentTag,
      now,
      `gdrive_id:${f.id} | ${analysisNotes}`,
      now,
    );

    console.log(`[gdrive-sync] ✅ synced ${f.name} → ${mediaType} | loc=${location} char=${character} moment=${momentTag}`);
  }

  if (result.new_files > 0) {
    console.log(`[gdrive-sync] DONE: scanned=${result.scanned} new=${result.new_files} downloaded=${result.downloaded} analyzed=${result.analyzed}`);
  }

  return result;
}

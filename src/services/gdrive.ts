import { db, getSetting, setSetting } from '../db';
import axios from 'axios';
import crypto from 'crypto';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  thumbnailLink?: string;
  webContentLink?: string;
}

interface DriveListResponse {
  files: DriveFile[];
  nextPageToken?: string;
}

// ---------------------------------------------------------------------------
// Cache: folderId -> { files, expiresAt }
// ---------------------------------------------------------------------------
const cache = new Map<string, { files: DriveFile[]; expiresAt: number }>();
const CACHE_TTL = 60 * 60 * 1000; // 1 hour

// ---------------------------------------------------------------------------
// Auth helpers
// ---------------------------------------------------------------------------

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

async function getServiceAccountToken(jsonKey: string): Promise<string> {
  const sa = JSON.parse(jsonKey);
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
  const payload = base64url(Buffer.from(JSON.stringify({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/drive.readonly',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  })));
  const signature = crypto.sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), sa.private_key);
  const jwt = `${header}.${payload}.${base64url(signature)}`;

  const res = await axios.post('https://oauth2.googleapis.com/token', {
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion: jwt,
  });
  return res.data.access_token as string;
}

async function authHeaders(): Promise<Record<string, string>> {
  const saJson = getSetting('gdrive_service_account_json');
  if (saJson) {
    const token = await getServiceAccountToken(saJson);
    return { Authorization: `Bearer ${token}` };
  }
  // Fallback: no extra headers; API key will be added as query param
  return {};
}

function apiKeyParam(): string {
  const key = getSetting('gdrive_api_key');
  return key ? `&key=${encodeURIComponent(key)}` : '';
}

// ---------------------------------------------------------------------------
// Core functions
// ---------------------------------------------------------------------------

const IMAGE_QUERY = "mimeType='image/jpeg' or mimeType='image/png' or mimeType='image/webp'";

export async function listDriveImages(folderId: string): Promise<DriveFile[]> {
  const cached = cache.get(folderId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.files;
  }

  const headers = await authHeaders();
  const allFiles: DriveFile[] = [];
  let pageToken: string | undefined;

  try {
    do {
      const q = encodeURIComponent(`'${folderId}' in parents and (${IMAGE_QUERY}) and trashed=false`);
      const fields = encodeURIComponent('nextPageToken,files(id,name,mimeType,thumbnailLink,webContentLink)');
      let url = `https://www.googleapis.com/drive/v3/files?q=${q}&fields=${fields}&pageSize=100${apiKeyParam()}`;
      if (pageToken) url += `&pageToken=${encodeURIComponent(pageToken)}`;

      const res = await axios.get<DriveListResponse>(url, { headers });
      allFiles.push(...(res.data.files || []));
      pageToken = res.data.nextPageToken;
    } while (pageToken);

    cache.set(folderId, { files: allFiles, expiresAt: Date.now() + CACHE_TTL });
    console.log(`[gdrive] Listed ${allFiles.length} images in folder ${folderId}`);
    return allFiles;
  } catch (err: any) {
    console.error(`[gdrive] Failed to list folder ${folderId}:`, err.response?.data || err.message);
    throw new Error(`[gdrive] List failed: ${err.message}`);
  }
}

export function getDriveImageUrl(fileId: string): string {
  const key = getSetting('gdrive_api_key');
  const base = `https://drive.google.com/uc?export=view&id=${encodeURIComponent(fileId)}`;
  return key ? `${base}&key=${encodeURIComponent(key)}` : base;
}

export async function getRandomDriveImage(folderId: string): Promise<DriveFile & { url: string }> {
  const files = await listDriveImages(folderId);
  if (files.length === 0) {
    throw new Error(`[gdrive] No images found in folder ${folderId}`);
  }
  const file = files[Math.floor(Math.random() * files.length)];
  return { ...file, url: getDriveImageUrl(file.id) };
}

export async function syncDriveFolder(folderId: string, hotelId: number): Promise<number> {
  const files = await listDriveImages(folderId);

  const upsert = db.prepare(`
    INSERT INTO gdrive_images (hotel_id, drive_file_id, file_name, mime_type, view_url, synced_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(drive_file_id) DO UPDATE SET
      file_name = excluded.file_name,
      mime_type = excluded.mime_type,
      view_url = excluded.view_url,
      synced_at = excluded.synced_at
  `);

  const now = Date.now();
  const syncMany = db.transaction(() => {
    for (const f of files) {
      upsert.run(hotelId, f.id, f.name, f.mimeType, getDriveImageUrl(f.id), now);
    }
  });
  syncMany();

  // Remove files no longer in Drive
  const remoteIds = files.map(f => f.id);
  if (remoteIds.length > 0) {
    const placeholders = remoteIds.map(() => '?').join(',');
    db.prepare(
      `DELETE FROM gdrive_images WHERE hotel_id = ? AND drive_file_id NOT IN (${placeholders})`
    ).run(hotelId, ...remoteIds);
  } else {
    db.prepare('DELETE FROM gdrive_images WHERE hotel_id = ?').run(hotelId);
  }

  console.log(`[gdrive] Synced ${files.length} images for hotel ${hotelId} from folder ${folderId}`);
  return files.length;
}

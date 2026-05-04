/**
 * YouTube Publisher — official YouTube Data API v3.
 *
 * Flow:
 *   1. OAuth 2.0 with refresh_token (long-lived)
 *      - User grants `https://www.googleapis.com/auth/youtube.upload` scope
 *      - System saves refresh_token to settings
 *   2. Each upload: refresh_token → access_token (~1h validity)
 *   3. Resumable Upload API (works well >100MB but also fine for 50MB MP4):
 *      a. POST /upload/youtube/v3/videos?uploadType=resumable
 *         with metadata JSON → returns Location header (session URL)
 *      b. PUT bytes to session URL → returns { id: 'video_id' }
 *   4. URL pattern: https://youtu.be/{video_id} (Shorts: just add #Shorts in title/description)
 *
 * Auto-detection: video 1080x1920 vertical + ≤60s + #Shorts hashtag → YouTube
 * automatically labels as "Shorts" and shows in Shorts tab.
 *
 * Quota: 1600 units per upload, 10k/day free → ~6 uploads/day.
 *
 * Docs: https://developers.google.com/youtube/v3/docs/videos/insert
 */

import axios from 'axios';
import fs from 'fs';
import { db, getSetting, setSetting } from '../db';

const OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const UPLOAD_URL = 'https://www.googleapis.com/upload/youtube/v3/videos';
const SCOPE = 'https://www.googleapis.com/auth/youtube.upload';

/** Build authorization URL for user to grant access. */
export function buildYoutubeAuthUrl(redirectUri: string, state: string): string {
  const clientId = getSetting('youtube_client_id');
  if (!clientId) throw new Error('youtube_client_id not configured. Add via admin settings.');
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SCOPE,
    access_type: 'offline',
    prompt: 'consent',           // Force refresh_token return on every grant
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

/** Exchange authorization code → refresh_token + access_token. Saves refresh_token to DB. */
export async function exchangeYoutubeCode(code: string, redirectUri: string): Promise<{ ok: boolean; error?: string; expires_in?: number }> {
  const clientId = getSetting('youtube_client_id');
  const clientSecret = getSetting('youtube_client_secret');
  if (!clientId || !clientSecret) return { ok: false, error: 'client_id/secret_not_configured' };
  try {
    const r = await axios.post(OAUTH_TOKEN_URL, new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }).toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 30_000,
    });
    if (!r.data.refresh_token) return { ok: false, error: 'no_refresh_token_returned' };
    setSetting('youtube_refresh_token', r.data.refresh_token);
    setSetting('youtube_token_granted_at', String(Date.now()));
    return { ok: true, expires_in: r.data.expires_in };
  } catch (e: any) {
    return { ok: false, error: e?.response?.data?.error_description || e?.response?.data?.error || e?.message };
  }
}

/** Get fresh access_token from refresh_token. */
export async function getYoutubeAccessToken(): Promise<string> {
  const clientId = getSetting('youtube_client_id');
  const clientSecret = getSetting('youtube_client_secret');
  const refreshToken = getSetting('youtube_refresh_token');
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error('youtube_oauth_not_setup: cần connect YouTube qua admin trước');
  }
  const r = await axios.post(OAUTH_TOKEN_URL, new URLSearchParams({
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: 'refresh_token',
  }).toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    timeout: 30_000,
  });
  if (!r.data.access_token) throw new Error('access_token_refresh_failed');
  return r.data.access_token;
}

/** Check OAuth connection status (without making token call). */
export function isYoutubeConnected(): boolean {
  return !!(getSetting('youtube_client_id') && getSetting('youtube_client_secret') && getSetting('youtube_refresh_token'));
}

/** Test connection: try refresh + return user's channel info. */
export async function testYoutubeConnection(): Promise<{ ok: boolean; channel?: any; error?: string }> {
  try {
    const token = await getYoutubeAccessToken();
    const r = await axios.get('https://www.googleapis.com/youtube/v3/channels', {
      params: { part: 'snippet,statistics', mine: true },
      headers: { Authorization: `Bearer ${token}` },
      timeout: 30_000,
    });
    const ch = r.data?.items?.[0];
    if (!ch) return { ok: false, error: 'no_channel_found' };
    return {
      ok: true,
      channel: {
        id: ch.id,
        title: ch.snippet?.title,
        subscribers: ch.statistics?.subscriberCount,
        videos: ch.statistics?.videoCount,
      },
    };
  } catch (e: any) {
    return { ok: false, error: e?.response?.data?.error?.message || e?.message };
  }
}

/** Upload a video file to YouTube as Shorts (vertical 9:16 ≤60s).
 *  Returns { video_id, url, status } or { ok: false, error }. */
export async function publishYoutubeShort(opts: {
  videoPath: string;
  title: string;
  description: string;
  tags?: string[];
  privacyStatus?: 'public' | 'unlisted' | 'private';
  categoryId?: string;
}): Promise<{ ok: boolean; video_id?: string; url?: string; error?: string }> {
  const { videoPath, title, description } = opts;
  const tags = opts.tags ?? [];
  const privacyStatus = opts.privacyStatus ?? 'public';
  const categoryId = opts.categoryId ?? '22';   // 22 = People & Blogs (default safe for storytelling)

  if (!fs.existsSync(videoPath)) return { ok: false, error: 'video_file_not_found' };
  const fileSize = fs.statSync(videoPath).size;

  let accessToken: string;
  try {
    accessToken = await getYoutubeAccessToken();
  } catch (e: any) {
    return { ok: false, error: e.message };
  }

  // ─── 1. Resumable upload init ───
  // Auto-add #Shorts in description if not present (signals YT Shorts mode)
  const shortsDesc = description.includes('#Shorts') ? description : `${description}\n\n#Shorts`;
  const metadata = {
    snippet: {
      title: title.slice(0, 100),                // YT title max 100 chars
      description: shortsDesc.slice(0, 5000),    // YT description max 5000
      tags: tags.slice(0, 30),
      categoryId,
      defaultLanguage: 'vi',
      defaultAudioLanguage: 'vi',
    },
    status: { privacyStatus, selfDeclaredMadeForKids: false },
  };

  let sessionUrl: string;
  try {
    const initR = await axios.post(
      `${UPLOAD_URL}?uploadType=resumable&part=snippet,status`,
      metadata,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json; charset=UTF-8',
          'X-Upload-Content-Type': 'video/mp4',
          'X-Upload-Content-Length': String(fileSize),
        },
        timeout: 60_000,
        maxRedirects: 0,
        validateStatus: (s) => s === 200 || s === 201,
      }
    );
    sessionUrl = initR.headers['location'];
    if (!sessionUrl) return { ok: false, error: 'no_session_url_returned' };
  } catch (e: any) {
    return { ok: false, error: 'init_fail: ' + (e?.response?.data?.error?.message || e?.message) };
  }

  // ─── 2. Upload bytes (single PUT for files <100MB; chunked for larger) ───
  try {
    const stream = fs.createReadStream(videoPath);
    const uploadR = await axios.put(sessionUrl, stream, {
      headers: {
        'Content-Type': 'video/mp4',
        'Content-Length': String(fileSize),
      },
      timeout: 600_000,                  // 10 min for upload
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      validateStatus: (s) => s >= 200 && s < 300,
    });
    const videoId = uploadR.data?.id;
    if (!videoId) return { ok: false, error: 'no_video_id_in_response' };
    return {
      ok: true,
      video_id: videoId,
      url: `https://youtu.be/${videoId}`,
    };
  } catch (e: any) {
    const errMsg = e?.response?.data?.error?.message || e?.response?.data || e?.message;
    return { ok: false, error: 'upload_fail: ' + (typeof errMsg === 'string' ? errMsg : JSON.stringify(errMsg).slice(0, 300)) };
  }
}

/**
 * Cinema Publisher — YouTube long-form (primary) + FB Reels teaser cut.
 *
 * Pipeline:
 *   1. YouTube: upload full 5-7 min video as LONG-FORM (no #Shorts tag)
 *      - Title: "Sonder Cinema #N: <Title>"
 *      - Description: caption_yt + chapter timestamps
 *      - Privacy: public (default, configurable)
 *   2. FB Reels: upload 60s teaser cut as Reel
 *      - Caption: caption_fb_teaser + #sondervn + link to YT
 *
 * Both run concurrently. 1 platform fail không block other.
 *
 * Settings:
 *   cinema_publish_yt_enabled  (default 'true')
 *   cinema_publish_fb_enabled  (default 'true')
 *   cinema_yt_privacy          (public | unlisted | private; default 'public')
 *   cinema_fb_page_id          (specific page; empty = first)
 *
 * Reference skill: sonder-cinema
 */

import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import { db, getSetting } from '../../db';
import { isYoutubeConnected, getYoutubeAccessToken } from '../youtube-publisher';
import type { CinemaScript } from './cinema-script-writer';

const GRAPH = 'https://graph.facebook.com/v22.0';
const YT_UPLOAD_URL = 'https://www.googleapis.com/upload/youtube/v3/videos';
const MEDIA_DIR = '/opt/vp-marketing/data/media';

// ═══════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════

export interface CinemaPublishResult {
  episode_id: number;
  yt: { ok: boolean; video_id?: string; url?: string; error?: string; skipped?: boolean };
  fb: { ok: boolean; post_id?: string; error?: string; skipped?: boolean };
  any_published: boolean;
}

// ═══════════════════════════════════════════════════════════
// YouTube long-form upload (NOT Shorts)
// ═══════════════════════════════════════════════════════════

async function uploadYoutubeLongForm(opts: {
  videoPath: string;
  title: string;
  description: string;
  tags?: string[];
  privacyStatus?: 'public' | 'unlisted' | 'private';
}): Promise<{ ok: boolean; video_id?: string; url?: string; error?: string }> {
  const { videoPath, title, description } = opts;
  const tags = opts.tags ?? [];
  const privacyStatus = opts.privacyStatus ?? 'public';

  if (!fs.existsSync(videoPath)) return { ok: false, error: 'video_file_not_found' };
  const fileSize = fs.statSync(videoPath).size;

  let accessToken: string;
  try {
    accessToken = await getYoutubeAccessToken();
  } catch (e: any) {
    return { ok: false, error: e.message };
  }

  // KHÔNG add #Shorts (this is long-form)
  const metadata = {
    snippet: {
      title: title.slice(0, 100),
      description: description.slice(0, 5000),
      tags: tags.slice(0, 30),
      categoryId: '22',                  // People & Blogs (storytelling)
      defaultLanguage: 'vi',
      defaultAudioLanguage: 'vi',
    },
    status: { privacyStatus, selfDeclaredMadeForKids: false },
  };

  let sessionUrl: string;
  try {
    const initR = await axios.post(
      `${YT_UPLOAD_URL}?uploadType=resumable&part=snippet,status`,
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
      },
    );
    sessionUrl = initR.headers['location'];
    if (!sessionUrl) return { ok: false, error: 'no_session_url' };
  } catch (e: any) {
    return { ok: false, error: 'init_fail: ' + (e?.response?.data?.error?.message || e?.message) };
  }

  try {
    const stream = fs.createReadStream(videoPath);
    const uploadR = await axios.put(sessionUrl, stream, {
      headers: {
        'Content-Type': 'video/mp4',
        'Content-Length': String(fileSize),
      },
      timeout: 1200_000,                 // 20 min for long video
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      validateStatus: (s) => s >= 200 && s < 300,
    });
    const videoId = uploadR.data?.id;
    if (!videoId) return { ok: false, error: 'no_video_id' };
    return { ok: true, video_id: videoId, url: `https://youtu.be/${videoId}` };
  } catch (e: any) {
    const errMsg = e?.response?.data?.error?.message || e?.message;
    return { ok: false, error: 'upload_fail: ' + (typeof errMsg === 'string' ? errMsg : JSON.stringify(errMsg).slice(0, 300)) };
  }
}

// ═══════════════════════════════════════════════════════════
// FB Reels (60s teaser)
// ═══════════════════════════════════════════════════════════

async function publishFbReel(
  pageId: string,
  accessToken: string,
  videoUrl: string,
  description: string,
): Promise<{ ok: boolean; post_id?: string; error?: string }> {
  try {
    const r = await axios.post(
      `${GRAPH}/${pageId}/videos`,
      null,
      {
        params: { file_url: videoUrl, description, access_token: accessToken },
        timeout: 240_000,
      },
    );
    if (r.data?.id) return { ok: true, post_id: r.data.id };
    return { ok: false, error: 'no_post_id' };
  } catch (e: any) {
    return { ok: false, error: 'fb_upload_fail: ' + (e?.response?.data?.error?.message || e?.message) };
  }
}

// ═══════════════════════════════════════════════════════════
// Caption builders
// ═══════════════════════════════════════════════════════════

function buildYouTubeDescription(script: CinemaScript, episodeNo: number): string {
  // Long-form description với caption + closing line + brand soft mention via channel name
  const parts = [
    `Tập ${episodeNo} — ${script.title}`,
    '',
    script.caption_yt || script.premise,
    '',
    `"${script.closing_line}"`,
    '',
    '— Sonder Cinema',
    '1 tập/tuần T7 20:30 VN',
    '',
    `Characters: ${script.primary_character}${script.secondary_characters?.length ? ', ' + script.secondary_characters.join(', ') : ''}`,
  ];
  return parts.filter((p) => p.length > 0 || p === '').join('\n').slice(0, 4500);
}

function buildFbTeaserCaption(script: CinemaScript, episodeNo: number, ytUrl?: string): string {
  // Teaser = ngắn gọn + hook arc + link sang YT để xem full
  const parts = [
    `Tập ${episodeNo} — ${script.title}`,
    '',
    script.caption_fb_teaser || script.premise,
    '',
    ytUrl ? `Xem full 5+ phút: ${ytUrl}` : 'Xem full trên YouTube — search "Sonder Cinema"',
    '',
    '#sondervn',
  ];
  return parts.filter((p) => p.length > 0 || p === '').join('\n').slice(0, 1000);
}

// ═══════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════

function resolveLocalVideoPath(url: string): string | null {
  if (!url) return null;
  const m = url.match(/\/media\/(.+)$/);
  if (!m) return null;
  const localPath = path.join(MEDIA_DIR, m[1]);
  return fs.existsSync(localPath) ? localPath : null;
}

interface FbPageRow { id: number; name: string; fb_page_id: string; access_token: string; }

function pickFbPage(): FbPageRow | null {
  const preferredId = getSetting('cinema_fb_page_id');
  if (preferredId) {
    const row = db.prepare(`SELECT id, name, fb_page_id, access_token FROM pages WHERE fb_page_id = ?`).get(preferredId) as FbPageRow | undefined;
    if (row) return row;
  }
  const first = db.prepare(`SELECT id, name, fb_page_id, access_token FROM pages ORDER BY id ASC LIMIT 1`).get() as FbPageRow | undefined;
  return first || null;
}

// ═══════════════════════════════════════════════════════════
// MAIN: publish 1 episode
// ═══════════════════════════════════════════════════════════

export async function publishCinemaEpisode(episodeId: number): Promise<CinemaPublishResult> {
  const ep = db.prepare(`SELECT * FROM cinema_episodes WHERE id = ?`).get(episodeId) as any;
  if (!ep) throw new Error(`episode #${episodeId} not found`);
  if (ep.status === 'published') throw new Error(`already published`);
  if (!ep.final_video_url) throw new Error(`no final_video_url`);

  let script: CinemaScript | null = null;
  try {
    if (ep.script_json) script = JSON.parse(ep.script_json);
  } catch (e: any) {
    throw new Error(`script JSON parse fail: ${e?.message}`);
  }
  if (!script) throw new Error('no script');

  const localPath = resolveLocalVideoPath(ep.final_video_url);
  const teaserLocalPath = ep.teaser_video_url ? resolveLocalVideoPath(ep.teaser_video_url) : null;

  if (!localPath) throw new Error(`local full video not found`);

  // Settings
  const ytEnabled = (getSetting('cinema_publish_yt_enabled') || 'true') !== 'false';
  const fbEnabled = (getSetting('cinema_publish_fb_enabled') || 'true') !== 'false';

  console.log(`[cinema-publish] ep#${episodeId} (no=${ep.episode_no}, "${ep.title}") → YT:${ytEnabled} FB:${fbEnabled}`);

  // ─── YouTube long-form upload (run first to get URL for FB caption) ───
  type YtR = { ok: boolean; video_id?: string; url?: string; error?: string; skipped?: boolean };
  let ytResult: YtR;

  if (ytEnabled && isYoutubeConnected()) {
    const privacy = (getSetting('cinema_yt_privacy') || 'public') as 'public' | 'unlisted' | 'private';
    const ytTitle = `Sonder Cinema #${ep.episode_no}: ${ep.title}`;
    const ytDesc = buildYouTubeDescription(script, ep.episode_no);
    const ytTags = [
      'sonder', 'sonder vn', 'sonder cinema', 'storytelling vietnam',
      'sài gòn', script.primary_character,
      ...(script.secondary_characters || []),
    ].filter((t, i, a) => a.indexOf(t) === i).slice(0, 30);

    ytResult = await uploadYoutubeLongForm({
      videoPath: localPath,
      title: ytTitle,
      description: ytDesc,
      tags: ytTags,
      privacyStatus: privacy,
    });

    if (ytResult.ok) {
      console.log(`[cinema-publish] ✅ YT ep#${episodeId} → ${ytResult.url}`);
    } else {
      console.warn(`[cinema-publish] ❌ YT ep#${episodeId}: ${ytResult.error}`);
    }
  } else {
    ytResult = { ok: false, skipped: true, error: ytEnabled ? 'youtube_not_connected' : 'yt_disabled' };
  }

  // ─── FB Reels (60s teaser) ───
  type FbR = { ok: boolean; post_id?: string; error?: string; skipped?: boolean };
  let fbResult: FbR;

  if (fbEnabled && ep.teaser_video_url) {
    const page = pickFbPage();
    if (!page) {
      fbResult = { ok: false, error: 'no_fb_pages_configured' };
    } else {
      const fbCaption = buildFbTeaserCaption(script, ep.episode_no, ytResult.ok ? ytResult.url : undefined);
      fbResult = await publishFbReel(page.fb_page_id, page.access_token, ep.teaser_video_url, fbCaption);

      if (fbResult.ok) {
        console.log(`[cinema-publish] ✅ FB teaser ep#${episodeId} → page="${page.name}" post=${fbResult.post_id}`);
      } else {
        console.warn(`[cinema-publish] ❌ FB ep#${episodeId}: ${fbResult.error}`);
      }
    }
  } else {
    fbResult = { ok: false, skipped: true, error: fbEnabled ? 'no_teaser_video' : 'fb_disabled' };
  }

  // ─── Persist results ───
  const anyOk = ytResult.ok || fbResult.ok;
  if (anyOk) {
    db.prepare(`
      UPDATE cinema_episodes
      SET status = 'published',
          yt_video_id = ?,
          fb_video_id = ?,
          published_at = ?,
          updated_at = ?
      WHERE id = ?
    `).run(
      ytResult.ok ? ytResult.video_id || null : null,
      fbResult.ok ? fbResult.post_id || null : null,
      Date.now(),
      Date.now(),
      episodeId,
    );
  } else {
    const errSummary = `yt: ${ytResult.error || 'n/a'} | fb: ${fbResult.error || 'n/a'}`;
    db.prepare(`UPDATE cinema_episodes SET error = ?, updated_at = ? WHERE id = ?`).run(errSummary, Date.now(), episodeId);
  }

  return {
    episode_id: episodeId,
    yt: ytResult,
    fb: fbResult,
    any_published: anyOk,
  };
}

// ═══════════════════════════════════════════════════════════
// Cron entry: pick newest 'approved' Cinema episode and publish
// ═══════════════════════════════════════════════════════════

export async function publishNextScheduledCinemaEpisode(): Promise<{ ok: boolean; result?: CinemaPublishResult; error?: string; skipped?: string }> {
  const series = db.prepare(`SELECT id FROM cinema_series WHERE series_slug = 'sonder-cinema-master'`).get() as any;
  if (!series) return { ok: false, skipped: 'no_cinema_series' };

  const ep = db.prepare(`
    SELECT id, episode_no, title FROM cinema_episodes
    WHERE series_id = ? AND status = 'approved' AND final_video_url IS NOT NULL
    ORDER BY episode_no DESC LIMIT 1
  `).get(series.id) as any;

  if (!ep) {
    console.log('[cinema-publish] cron: no approved cinema episode');
    return { ok: true, skipped: 'no_approved_episode' };
  }

  console.log(`[cinema-publish] cron: publishing ep#${ep.id} (no=${ep.episode_no}, "${ep.title}")`);

  try {
    const result = await publishCinemaEpisode(ep.id);
    return { ok: result.any_published, result };
  } catch (e: any) {
    return { ok: false, error: e?.message };
  }
}

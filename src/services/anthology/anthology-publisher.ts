/**
 * Anthology Publisher — auto-publish episodes to Facebook + YouTube.
 *
 * Pipeline:
 *   1. Take 1 'approved' episode (newest first)
 *   2. Build platform-specific captions:
 *      - FB Reels: caption_text + 1-2 hashtags (subtle)
 *      - YouTube Shorts: title + description + #Shorts hashtag
 *   3. Upload concurrently to FB + YT (independent — 1 platform fail không block other)
 *   4. Update story_episodes:
 *      - fb_post_ids JSON (Facebook video IDs)
 *      - Add yt_video_id column
 *      - status = 'published'
 *   5. Trigger postPublishBookkeeping (persist facts + bump counters + advance arc)
 *
 * Settings (admin tunable):
 *   vs_anthology_publish_fb_enabled (default 'true')
 *   vs_anthology_publish_yt_enabled (default 'true')
 *   vs_anthology_fb_page_id           (specific page; empty → first page)
 *   vs_anthology_yt_privacy           (public | unlisted | private; default 'public')
 *
 * Reference skill: sonder-storytelling
 */

import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import { db, getSetting } from '../../db';
import { publishYoutubeShort, isYoutubeConnected } from '../youtube-publisher';
import { type AnthologyScript } from './anthology-script-writer';
import { postPublishBookkeeping } from './anthology-orchestrator';

const GRAPH = 'https://graph.facebook.com/v22.0';
const PUBLIC_BASE = 'https://app.sondervn.com';
const MEDIA_DIR = '/opt/vp-marketing/data/media';

// ═══════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════

export interface PublishResult {
  episode_id: number;
  fb: { ok: boolean; post_id?: string; error?: string; skipped?: boolean };
  yt: { ok: boolean; video_id?: string; url?: string; error?: string; skipped?: boolean };
  any_published: boolean;
}

// ═══════════════════════════════════════════════════════════
// FB Reels upload (file_url variant — fastest)
// ═══════════════════════════════════════════════════════════

async function publishFbVideo(
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
    return { ok: false, error: 'no_video_id_returned' };
  } catch (e: any) {
    const errMsg = e?.response?.data?.error?.message || e?.message;
    return { ok: false, error: 'fb_upload_fail: ' + errMsg };
  }
}

// ═══════════════════════════════════════════════════════════
// Caption builders — platform-specific
// ═══════════════════════════════════════════════════════════

function buildFbCaption(script: AnthologyScript, episodeNo: number): string {
  // FB caption: poetic + 1-2 hashtags
  // Format:
  //   Tập {N} — {Title}
  //
  //   {caption_text}
  //
  //   #sondervn
  const tags = (script.hashtags || ['#sondervn'])
    .slice(0, 2)
    .map((h: string) => h.startsWith('#') ? h : '#' + h)
    .join(' ');

  return `Tập ${episodeNo} — ${script.title}\n\n${script.caption_text}\n\n${tags}`;
}

function buildYoutubeMeta(script: AnthologyScript, episodeNo: number): { title: string; description: string; tags: string[] } {
  // YouTube Shorts: title ≤100 chars + description ≤5000 + tags
  const title = `Tập ${episodeNo} — ${script.title}`.slice(0, 100);

  // Description: caption + closing line + #Shorts auto-appended by publisher
  const closingLine = script.layers?.find((l) => l.layer_name === 'closing')?.voiceover_text || '';
  const desc = [
    script.caption_text,
    '',
    closingLine,
    '',
    '— Sonder Stories. 1 tập/ngày 19:00 VN.',
  ].filter((s) => s.length > 0).join('\n').slice(0, 5000);

  const tags = [
    'sonder',
    'sonder vn',
    'sonder stories',
    'storytelling vietnam',
    'sài gòn',
    script.primary_character,
    ...(script.secondary_characters || []),
  ].filter((t, i, arr) => arr.indexOf(t) === i).slice(0, 30);

  return { title, description: desc, tags };
}

// ═══════════════════════════════════════════════════════════
// Local video path resolver
// ═══════════════════════════════════════════════════════════

function resolveLocalVideoPath(finalVideoUrl: string): string | null {
  if (!finalVideoUrl) return null;

  // URL pattern: https://app.sondervn.com/media/anth-out/anth-2026-05-04-ep1-linh.mp4
  const m = finalVideoUrl.match(/\/media\/(.+)$/);
  if (!m) return null;

  const localPath = path.join(MEDIA_DIR, m[1]);
  if (!fs.existsSync(localPath)) {
    console.warn(`[anth-publisher] local video not found: ${localPath}`);
    return null;
  }
  return localPath;
}

// ═══════════════════════════════════════════════════════════
// Pick FB page (configurable)
// ═══════════════════════════════════════════════════════════

interface FbPageRow { id: number; name: string; fb_page_id: string; access_token: string; }

function pickFbPage(): FbPageRow | null {
  // Allow admin to select specific page via setting
  const preferredId = getSetting('vs_anthology_fb_page_id');
  if (preferredId) {
    const row = db.prepare(`SELECT id, name, fb_page_id, access_token FROM pages WHERE fb_page_id = ?`).get(preferredId) as FbPageRow | undefined;
    if (row) return row;
    console.warn(`[anth-publisher] preferred FB page id "${preferredId}" not found, fallback to first`);
  }

  const first = db.prepare(`SELECT id, name, fb_page_id, access_token FROM pages ORDER BY id ASC LIMIT 1`).get() as FbPageRow | undefined;
  return first || null;
}

// ═══════════════════════════════════════════════════════════
// Per-platform publish
// ═══════════════════════════════════════════════════════════

async function publishOneToFb(
  episodeId: number,
  script: AnthologyScript,
  episodeNo: number,
  videoUrl: string,
): Promise<{ ok: boolean; post_id?: string; error?: string }> {
  const page = pickFbPage();
  if (!page) return { ok: false, error: 'no_fb_pages_configured' };

  const caption = buildFbCaption(script, episodeNo);
  const r = await publishFbVideo(page.fb_page_id, page.access_token, videoUrl, caption);

  if (r.ok && r.post_id) {
    console.log(`[anth-publisher] ✅ FB ep#${episodeId} → page="${page.name}" post_id=${r.post_id}`);
  } else {
    console.warn(`[anth-publisher] ❌ FB ep#${episodeId} fail: ${r.error}`);
  }
  return r;
}

async function publishOneToYt(
  episodeId: number,
  script: AnthologyScript,
  episodeNo: number,
  localVideoPath: string,
): Promise<{ ok: boolean; video_id?: string; url?: string; error?: string }> {
  if (!isYoutubeConnected()) {
    return { ok: false, error: 'youtube_oauth_not_setup' };
  }

  const meta = buildYoutubeMeta(script, episodeNo);
  const privacy = (getSetting('vs_anthology_yt_privacy') || 'public') as 'public' | 'unlisted' | 'private';

  const r = await publishYoutubeShort({
    videoPath: localVideoPath,
    title: meta.title,
    description: meta.description,
    tags: meta.tags,
    privacyStatus: privacy,
    categoryId: '22',  // People & Blogs
  });

  if (r.ok) {
    console.log(`[anth-publisher] ✅ YT ep#${episodeId} → ${r.url}`);
  } else {
    console.warn(`[anth-publisher] ❌ YT ep#${episodeId} fail: ${r.error}`);
  }
  return r;
}

// ═══════════════════════════════════════════════════════════
// Publish single episode (main entry)
// ═══════════════════════════════════════════════════════════

export async function publishEpisode(episodeId: number): Promise<PublishResult> {
  const ep = db.prepare(`SELECT * FROM story_episodes WHERE id = ?`).get(episodeId) as any;
  if (!ep) {
    throw new Error(`episode #${episodeId} not found`);
  }
  if (ep.status === 'published') {
    throw new Error(`episode #${episodeId} already published`);
  }
  if (!ep.final_video_url) {
    throw new Error(`episode #${episodeId} has no final_video_url (not yet rendered)`);
  }

  let script: AnthologyScript | null = null;
  try {
    if (ep.anthology_script_json) script = JSON.parse(ep.anthology_script_json);
  } catch (e: any) {
    throw new Error(`cannot parse anthology_script_json: ${e?.message}`);
  }
  if (!script) throw new Error('script JSON missing');

  const localPath = resolveLocalVideoPath(ep.final_video_url);
  if (!localPath) throw new Error(`local video file not found for url ${ep.final_video_url}`);

  // Settings: per-platform enable
  const fbEnabled = (getSetting('vs_anthology_publish_fb_enabled') || 'true') !== 'false';
  const ytEnabled = (getSetting('vs_anthology_publish_yt_enabled') || 'true') !== 'false';

  console.log(`[anth-publisher] ep#${episodeId} (no=${ep.episode_no}, "${ep.title}") → FB:${fbEnabled} YT:${ytEnabled}`);

  // Run both concurrently (independent; 1 fail → other still attempts)
  type FbR = { ok: boolean; post_id?: string; error?: string; skipped?: boolean };
  type YtR = { ok: boolean; video_id?: string; url?: string; error?: string; skipped?: boolean };

  const fbPromise: Promise<FbR> = fbEnabled
    ? publishOneToFb(episodeId, script, ep.episode_no, ep.final_video_url)
    : Promise.resolve({ ok: false, skipped: true, error: 'fb_disabled' });

  const ytPromise: Promise<YtR> = ytEnabled
    ? publishOneToYt(episodeId, script, ep.episode_no, localPath)
    : Promise.resolve({ ok: false, skipped: true, error: 'yt_disabled' });

  const [fbResult, ytResult] = await Promise.all([fbPromise, ytPromise]);

  // Persist results
  const anyOk = fbResult.ok || ytResult.ok;
  const fbPostIds = fbResult.ok && fbResult.post_id ? [fbResult.post_id] : [];

  if (anyOk) {
    db.prepare(`
      UPDATE story_episodes
      SET status = 'published',
          published_at = ?,
          fb_post_ids = ?,
          yt_video_id = ?,
          updated_at = ?
      WHERE id = ?
    `).run(
      Date.now(),
      fbPostIds.length ? JSON.stringify(fbPostIds) : null,
      ytResult.ok ? ytResult.video_id || null : null,
      Date.now(),
      episodeId,
    );

    // Trigger continuity bookkeeping (persist facts + bump counters + advance arc)
    postPublishBookkeeping(episodeId, script);
  } else {
    // Both failed — leave status (don't mark as failed unless severe)
    const errSummary = `fb: ${fbResult.error || 'n/a'} | yt: ${ytResult.error || 'n/a'}`;
    db.prepare(`UPDATE story_episodes SET error = ?, updated_at = ? WHERE id = ?`)
      .run(errSummary, Date.now(), episodeId);
    console.warn(`[anth-publisher] ⚠ ep#${episodeId} both platforms failed: ${errSummary}`);
  }

  return {
    episode_id: episodeId,
    fb: fbResult as any,
    yt: ytResult as any,
    any_published: anyOk,
  };
}

// ═══════════════════════════════════════════════════════════
// Cron entry: pick newest 'approved' episode and publish
// ═══════════════════════════════════════════════════════════

export async function publishNextScheduledEpisode(): Promise<{ ok: boolean; result?: PublishResult; error?: string; skipped?: string }> {
  // Only published if anthology master series exists
  const series = db.prepare(`SELECT id FROM story_series WHERE month_slug = 'sonder-anthology-master'`).get() as any;
  if (!series) return { ok: false, skipped: 'no_anthology_series' };

  // Pick newest 'approved' episode (cron auto-approved after compose)
  const ep = db.prepare(`
    SELECT id, episode_no, title FROM story_episodes
    WHERE series_id = ? AND status = 'approved' AND final_video_url IS NOT NULL
    ORDER BY episode_no DESC LIMIT 1
  `).get(series.id) as any;

  if (!ep) {
    console.log('[anth-publisher] cron: no approved episode to publish');
    return { ok: true, skipped: 'no_approved_episode' };
  }

  console.log(`[anth-publisher] cron: publishing ep#${ep.id} (no=${ep.episode_no}, "${ep.title}")`);

  try {
    const result = await publishEpisode(ep.id);
    return { ok: result.any_published, result };
  } catch (e: any) {
    console.error('[anth-publisher] cron publish err:', e?.message);
    return { ok: false, error: e?.message };
  }
}

// ═══════════════════════════════════════════════════════════
// Manual single-episode publish (for admin UI button)
// ═══════════════════════════════════════════════════════════

export async function publishEpisodeNow(episodeId: number): Promise<PublishResult> {
  return publishEpisode(episodeId);
}

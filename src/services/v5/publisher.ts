/**
 * V5 Cross-platform Publisher.
 *
 * Posts rendered V5 clips to: FB Reels + IG Reels + TikTok + YouTube Shorts.
 *
 * Reference: skill sonder-content-v5
 *
 * NOTE: Phase 2 implements FB Reels first. IG/TikTok/YT placeholders for Phase 3.
 */

import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import { db, getSetting } from '../../db';

const GRAPH = 'https://graph.facebook.com/v21.0';

export interface PublishResult {
  ok: boolean;
  platform: 'fb' | 'ig' | 'tiktok' | 'youtube';
  platform_post_id?: string;
  error?: string;
}

interface FbPageRow {
  id: number;
  name: string;
  fb_page_id: string;
  access_token: string;
}

function pickFbPage(): FbPageRow | null {
  const row = db.prepare(
    `SELECT id, name, fb_page_id, access_token FROM pages WHERE id = 1 LIMIT 1`,
  ).get() as FbPageRow | undefined;
  return row || null;
}

/* ───────── FB Reels ───────── */

export async function publishToFb(opts: {
  videoPath: string;
  caption: string;
}): Promise<PublishResult> {
  const page = pickFbPage();
  if (!page?.access_token) {
    return { ok: false, platform: 'fb', error: 'no_fb_page_configured' };
  }

  try {
    // FB needs accessible URL or file_url. We use public app.sondervn.com URL.
    const filename = path.basename(opts.videoPath);
    const videoUrl = `https://app.sondervn.com/v5-out/${filename}`;

    const r = await axios.post(
      `${GRAPH}/${page.fb_page_id}/videos`,
      null,
      {
        params: {
          file_url: videoUrl,
          description: opts.caption,
          access_token: page.access_token,
        },
        timeout: 240_000,
      },
    );

    if (r.data?.id) {
      console.log(`[v5-publish] FB Reels OK: video id=${r.data.id}`);
      return { ok: true, platform: 'fb', platform_post_id: r.data.id };
    }
    return { ok: false, platform: 'fb', error: 'no_video_id_returned' };
  } catch (e: any) {
    const msg = e?.response?.data?.error?.message || e.message;
    return { ok: false, platform: 'fb', error: 'fb_upload_fail: ' + msg };
  }
}

/* ───────── IG Reels (Phase 3 — placeholder) ───────── */

export async function publishToInstagram(opts: {
  videoPath: string;
  caption: string;
}): Promise<PublishResult> {
  // TODO Phase 3: requires IG Business Account ID + media container API
  // POST /{ig-user-id}/media → creation_id
  // POST /{ig-user-id}/media_publish → final post
  return { ok: false, platform: 'ig', error: 'ig_not_yet_implemented' };
}

/* ───────── TikTok (Phase 3 — placeholder) ───────── */

export async function publishToTikTok(opts: {
  videoPath: string;
  caption: string;
}): Promise<PublishResult> {
  // TODO Phase 3: TikTok Content Posting API requires app review
  return { ok: false, platform: 'tiktok', error: 'tiktok_not_yet_implemented' };
}

/* ───────── YouTube Shorts (Phase 3 — needs OAuth re-grant scope) ───────── */

export async function publishToYouTube(opts: {
  videoPath: string;
  title: string;
  description: string;
}): Promise<PublishResult> {
  // Existing OAuth tokens have insufficient scope (need youtube.upload)
  // Anh re-grant trên admin panel → em enable
  return { ok: false, platform: 'youtube', error: 'youtube_scope_insufficient' };
}

/* ───────── Caption builder ───────── */

export function buildV5Caption(opts: {
  theme: string;
  title: string;
  hookVoText?: string;
  closingVoText?: string;
  hashtags?: string[];
}): string {
  const tags = (opts.hashtags || ['#sondervn'])
    .slice(0, 3)
    .map(h => h.startsWith('#') ? h : '#' + h)
    .join(' ');

  // Format:
  //   {hook line} (cliffhanger)
  //   ...
  //   {closing line}
  //
  //   #sondervn

  const parts: string[] = [];
  if (opts.hookVoText) parts.push(opts.hookVoText);
  if (opts.closingVoText && opts.closingVoText !== opts.hookVoText) {
    parts.push('...');
    parts.push(opts.closingVoText);
  }
  parts.push('');
  parts.push(tags);

  return parts.join('\n');
}

/* ───────── Main entry — publish 1 variant to 1+ platforms ───────── */

export async function publishV5Variant(opts: {
  rendered_clip_id: number;
  platforms?: Array<'fb' | 'ig' | 'tiktok' | 'youtube'>;
}): Promise<PublishResult[]> {
  const platforms = opts.platforms || ['fb'];

  const clip = db.prepare(
    `SELECT vrc.*, vs.theme, vs.title, vs.body_json, vs.hook_a_json, vs.hook_b_json, vs.hook_c_json
     FROM v5_rendered_clips vrc
     JOIN v5_scripts vs ON vs.id = vrc.script_id
     WHERE vrc.id = ?`,
  ).get(opts.rendered_clip_id) as any;

  if (!clip) {
    return platforms.map(p => ({ ok: false, platform: p, error: 'clip_not_found' }));
  }

  if (!fs.existsSync(clip.output_path)) {
    return platforms.map(p => ({ ok: false, platform: p, error: 'video_file_missing' }));
  }

  // Pick hook from variant
  const hookKey = `hook_${clip.variant}_json` as 'hook_a_json' | 'hook_b_json' | 'hook_c_json';
  const hook = JSON.parse(clip[hookKey]);
  const body = JSON.parse(clip.body_json);

  const caption = buildV5Caption({
    theme: clip.theme,
    title: clip.title,
    hookVoText: hook.vo_text,
    closingVoText: body.closing_vo,
  });

  const results: PublishResult[] = [];

  for (const platform of platforms) {
    let r: PublishResult;
    switch (platform) {
      case 'fb':
        r = await publishToFb({ videoPath: clip.output_path, caption });
        break;
      case 'ig':
        r = await publishToInstagram({ videoPath: clip.output_path, caption });
        break;
      case 'tiktok':
        r = await publishToTikTok({ videoPath: clip.output_path, caption });
        break;
      case 'youtube':
        r = await publishToYouTube({
          videoPath: clip.output_path,
          title: clip.title,
          description: caption,
        });
        break;
    }
    results.push(r);

    // Persist to v5_ab_results
    if (r.ok) {
      db.prepare(
        `INSERT INTO v5_ab_results
         (rendered_clip_id, platform, posted_at, platform_post_id, last_metrics_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(opts.rendered_clip_id, platform, Date.now(), r.platform_post_id || null, Date.now());
    }
  }

  return results;
}

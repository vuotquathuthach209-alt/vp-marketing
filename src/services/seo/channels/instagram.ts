/**
 * Instagram Business Profile SEO audit.
 *
 * Requires IG Business account linked to FB Page (via `instagram_basic` scope).
 *
 * Reads via Graph API:
 *   - IG profile (bio, website, followers_count, media_count)
 *   - Recent media → check hashtag usage + engagement
 *
 * Generates issues:
 *   - "Bio too short / missing keywords"
 *   - "No website link"
 *   - "Using < 5 hashtags per post (target 10-20)"
 *   - "Hashtag diversity low" (using same 5 hashtags every post)
 */

import axios from 'axios';
import { db } from '../../../db';

const GRAPH = 'https://graph.facebook.com/v21.0';

interface PageRow { id: number; fb_page_id: string; access_token: string; name: string; }

export interface IgAudit {
  page_id: number;
  ig_business_id: string;
  ig_username: string;
  // Profile
  has_bio: boolean;
  bio_length: number;
  has_website: boolean;
  followers_count: number;
  media_count: number;
  // Posts
  recent_posts: number;
  avg_hashtags: number;
  unique_hashtags: number;
  hashtag_diversity_score: number;   // 0-1, 1 = all unique
  avg_likes: number;
  avg_comments: number;
  // Scores
  completeness_score: number;
  activity_score: number;
  total_score: number;
  issues: string[];
  top_hashtags: Array<{ tag: string; count: number }>;
  audited_at: number;
}

function getPages(): PageRow[] {
  return db.prepare(`SELECT id, fb_page_id, access_token, name FROM pages`).all() as PageRow[];
}

async function getIgBusinessId(page: PageRow): Promise<string | null> {
  try {
    const r = await axios.get(`${GRAPH}/${page.fb_page_id}`, {
      params: { fields: 'instagram_business_account', access_token: page.access_token },
      timeout: 15_000,
    });
    return r.data?.instagram_business_account?.id || null;
  } catch (e: any) {
    return null;
  }
}

async function fetchIgProfile(igId: string, token: string): Promise<any> {
  const r = await axios.get(`${GRAPH}/${igId}`, {
    params: {
      fields: 'username,biography,website,followers_count,media_count,profile_picture_url',
      access_token: token,
    },
    timeout: 15_000,
  });
  return r.data || {};
}

async function fetchIgRecentMedia(igId: string, token: string): Promise<any[]> {
  const r = await axios.get(`${GRAPH}/${igId}/media`, {
    params: {
      fields: 'id,caption,media_type,timestamp,like_count,comments_count,permalink',
      access_token: token,
      limit: 30,
    },
    timeout: 30_000,
  });
  return r.data?.data || [];
}

function extractHashtags(caption: string): string[] {
  return (caption.match(/#[\p{L}\w]+/gu) || []).map((t) => t.toLowerCase());
}

export async function auditInstagram(page: PageRow): Promise<IgAudit | null> {
  const igId = await getIgBusinessId(page);
  if (!igId) {
    console.log(`[seo-ig] ${page.name}: no IG Business account linked`);
    return null;
  }

  try {
    const profile = await fetchIgProfile(igId, page.access_token);
    const media = await fetchIgRecentMedia(igId, page.access_token);

    const audit: IgAudit = {
      page_id: page.id,
      ig_business_id: igId,
      ig_username: profile.username || '?',
      has_bio: !!profile.biography,
      bio_length: (profile.biography || '').length,
      has_website: !!profile.website,
      followers_count: profile.followers_count || 0,
      media_count: profile.media_count || 0,
      recent_posts: media.length,
      avg_hashtags: 0,
      unique_hashtags: 0,
      hashtag_diversity_score: 0,
      avg_likes: 0,
      avg_comments: 0,
      completeness_score: 0,
      activity_score: 0,
      total_score: 0,
      issues: [],
      top_hashtags: [],
      audited_at: Date.now(),
    };

    // Aggregate hashtags + engagement
    const tagCounts: Record<string, number> = {};
    let totalHashtags = 0;
    let totalLikes = 0;
    let totalComments = 0;
    for (const m of media) {
      const cap = m.caption || '';
      const tags = extractHashtags(cap);
      for (const t of tags) tagCounts[t] = (tagCounts[t] || 0) + 1;
      totalHashtags += tags.length;
      totalLikes += m.like_count || 0;
      totalComments += m.comments_count || 0;
    }
    audit.avg_hashtags = media.length > 0 ? +(totalHashtags / media.length).toFixed(1) : 0;
    audit.unique_hashtags = Object.keys(tagCounts).length;
    audit.hashtag_diversity_score = totalHashtags > 0 ? +(audit.unique_hashtags / totalHashtags).toFixed(2) : 0;
    audit.avg_likes = media.length > 0 ? +(totalLikes / media.length).toFixed(1) : 0;
    audit.avg_comments = media.length > 0 ? +(totalComments / media.length).toFixed(1) : 0;
    audit.top_hashtags = Object.entries(tagCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 15)
      .map(([tag, count]) => ({ tag, count }));

    // Score
    let comp = 0;
    if (audit.has_bio) comp += 15;
    if (audit.bio_length >= 80) comp += 10;
    if (audit.has_website) comp += 15;
    if (audit.followers_count >= 100) comp += 10;
    if (audit.followers_count >= 1000) comp += 10;
    audit.completeness_score = comp;

    let act = 0;
    if (audit.recent_posts >= 12) act += 15;        // ≥ 3/week
    else if (audit.recent_posts >= 4) act += 8;
    if (audit.avg_hashtags >= 10) act += 10;
    else if (audit.avg_hashtags >= 5) act += 5;
    if (audit.hashtag_diversity_score >= 0.6) act += 10;
    else if (audit.hashtag_diversity_score >= 0.4) act += 5;
    if (audit.avg_likes >= 10) act += 10;
    else if (audit.avg_likes >= 1) act += 5;
    audit.activity_score = act;

    audit.total_score = audit.completeness_score + audit.activity_score;

    // Issues
    if (!audit.has_bio) audit.issues.push('CRITICAL: Bio empty — write a bio with primary keywords + emoji + CTA.');
    else if (audit.bio_length < 80) audit.issues.push(`Bio too short (${audit.bio_length}/150 chars).`);
    if (!audit.has_website) audit.issues.push('No website link — Instagram allows ONE clickable link, use it for sondervn.com or Linktree.');
    if (audit.avg_hashtags < 5) audit.issues.push(`Avg ${audit.avg_hashtags} hashtags/post — Instagram allows 30, target 10-20 mix of niche + broad.`);
    if (audit.avg_hashtags > 25) audit.issues.push(`Using ${audit.avg_hashtags} hashtags/post — over 25 may look spammy, target 10-20.`);
    if (audit.hashtag_diversity_score < 0.4 && audit.media_count > 5) audit.issues.push(`Hashtag diversity ${audit.hashtag_diversity_score} — using same tags repeatedly. Rotate hashtags per niche.`);
    if (audit.recent_posts < 12) audit.issues.push(`Only ${audit.recent_posts} posts last month — IG algo rewards consistent 3+/week.`);
    if (audit.followers_count < 100) audit.issues.push(`Only ${audit.followers_count} followers — focus on bio + first 9 posts for grid appearance.`);

    return audit;
  } catch (e: any) {
    console.warn(`[seo-ig] audit fail:`, e?.response?.data?.error?.message || e?.message);
    return null;
  }
}

export async function auditAllInstagram(): Promise<{ audited: number; skipped: number; results: IgAudit[] }> {
  const result = { audited: 0, skipped: 0, results: [] as IgAudit[] };
  for (const page of getPages()) {
    const a = await auditInstagram(page);
    if (a) {
      result.audited++;
      result.results.push(a);
      db.prepare(
        `INSERT OR REPLACE INTO seo_social_audit
         (channel, page_id, profile_id, name, audit_json, score, audited_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run('instagram', page.id, a.ig_business_id, '@' + a.ig_username, JSON.stringify(a), a.total_score, a.audited_at);
    } else result.skipped++;
  }
  return result;
}

export function getLatestInstagramAudit(): IgAudit[] {
  const rows = db.prepare(
    `SELECT audit_json FROM seo_social_audit WHERE channel = 'instagram' ORDER BY audited_at DESC LIMIT 10`,
  ).all() as Array<{ audit_json: string }>;
  return rows.map((r) => JSON.parse(r.audit_json));
}

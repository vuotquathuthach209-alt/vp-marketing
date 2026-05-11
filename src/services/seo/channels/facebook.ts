/**
 * Facebook Page SEO audit.
 *
 * Reads via Graph API:
 *   - Page profile (about, contact, hours, address) → check completeness
 *   - Recent posts → check posting cadence + engagement
 *   - Page "response_rate" + "response_time" → admin responsiveness signal
 *
 * Generates issues like:
 *   - "About too short" / "Missing hours" / "Missing website link"
 *   - "Posting < 3/week — try 3-5"
 *   - "Avg first-hour engagement < 1% — content needs work"
 */

import axios from 'axios';
import { db } from '../../../db';

const GRAPH = 'https://graph.facebook.com/v21.0';

interface PageRow { id: number; fb_page_id: string; access_token: string; name: string; }

export interface FbPageAudit {
  page_id: number;
  fb_page_id: string;
  name: string;
  // Profile completeness
  has_about: boolean;
  about_length: number;
  has_phone: boolean;
  has_website: boolean;
  has_email: boolean;
  has_address: boolean;
  has_hours: boolean;
  has_category: boolean;
  followers: number;
  rating: number | null;
  rating_count: number;
  // Engagement
  posts_last_30d: number;
  posts_per_week: number;
  avg_engagement: number;
  // Score 0-100
  completeness_score: number;
  activity_score: number;
  total_score: number;
  // Issues
  issues: string[];
  // Last audited
  audited_at: number;
}

function getPages(): PageRow[] {
  return db.prepare(`SELECT id, fb_page_id, access_token, name FROM pages`).all() as PageRow[];
}

async function fetchPageProfile(page: PageRow): Promise<any> {
  const r = await axios.get(`${GRAPH}/${page.fb_page_id}`, {
    params: {
      fields: 'name,about,description,phone,emails,website,location,hours,category,fan_count,followers_count,overall_star_rating,rating_count,is_published',
      access_token: page.access_token,
    },
    timeout: 15_000,
  });
  return r.data || {};
}

async function fetchRecentPosts(page: PageRow): Promise<any[]> {
  const since = Math.floor((Date.now() - 30 * 86400_000) / 1000);
  const r = await axios.get(`${GRAPH}/${page.fb_page_id}/published_posts`, {
    params: {
      fields: 'id,created_time,reactions.summary(total_count).limit(0),comments.summary(total_count).limit(0),shares',
      access_token: page.access_token,
      since,
      limit: 100,
    },
    timeout: 30_000,
  });
  return r.data?.data || [];
}

export async function auditFacebookPage(page: PageRow): Promise<FbPageAudit | null> {
  try {
    const profile = await fetchPageProfile(page);
    const posts = await fetchRecentPosts(page);

    const aboutText = profile.about || profile.description || '';
    const audit: FbPageAudit = {
      page_id: page.id,
      fb_page_id: page.fb_page_id,
      name: profile.name || page.name,
      // Completeness
      has_about: !!aboutText,
      about_length: aboutText.length,
      has_phone: !!profile.phone,
      has_website: !!profile.website,
      has_email: !!(profile.emails && profile.emails.length > 0),
      has_address: !!(profile.location && (profile.location.street || profile.location.city)),
      has_hours: !!(profile.hours && Object.keys(profile.hours).length > 0),
      has_category: !!profile.category,
      followers: profile.followers_count || profile.fan_count || 0,
      rating: profile.overall_star_rating || null,
      rating_count: profile.rating_count || 0,
      // Activity
      posts_last_30d: posts.length,
      posts_per_week: +(posts.length / (30 / 7)).toFixed(1),
      avg_engagement: 0,
      // To compute
      completeness_score: 0,
      activity_score: 0,
      total_score: 0,
      issues: [],
      audited_at: Date.now(),
    };

    // Compute avg engagement
    if (posts.length > 0) {
      let total = 0;
      for (const p of posts) {
        const r = p.reactions?.summary?.total_count || 0;
        const c = p.comments?.summary?.total_count || 0;
        const s = p.shares?.count || 0;
        total += r + c + s;
      }
      audit.avg_engagement = +(total / posts.length).toFixed(1);
    }

    // Compute completeness score (out of 60)
    let comp = 0;
    if (audit.has_about) comp += 10;
    if (audit.about_length >= 100) comp += 5;
    if (audit.has_phone) comp += 8;
    if (audit.has_website) comp += 10;
    if (audit.has_email) comp += 5;
    if (audit.has_address) comp += 8;
    if (audit.has_hours) comp += 7;
    if (audit.has_category) comp += 7;
    audit.completeness_score = comp;

    // Activity score (out of 40)
    let act = 0;
    if (audit.posts_per_week >= 3) act += 15;
    else if (audit.posts_per_week >= 1) act += 8;
    if (audit.avg_engagement >= 10) act += 15;
    else if (audit.avg_engagement >= 1) act += 8;
    if (audit.followers >= 1000) act += 10;
    else if (audit.followers >= 100) act += 5;
    audit.activity_score = act;

    audit.total_score = audit.completeness_score + audit.activity_score;

    // Issues
    if (!audit.has_about) audit.issues.push('CRITICAL: Page has no About text — add a clear 1-2 paragraph description with primary keywords.');
    else if (audit.about_length < 100) audit.issues.push(`About too short (${audit.about_length} chars) — expand to ≥150 chars with location + service keywords.`);
    if (!audit.has_website) audit.issues.push('Missing Website link — add sondervn.com URL for traffic flow.');
    if (!audit.has_phone) audit.issues.push('Missing phone number — improves local-search trust.');
    if (!audit.has_email) audit.issues.push('Missing email address — adds contact methods for SEO crawlers.');
    if (!audit.has_address) audit.issues.push('Missing address/location — critical for local SEO (Google + FB).');
    if (!audit.has_hours) audit.issues.push('Missing business hours — affects local pack ranking.');
    if (!audit.has_category) audit.issues.push('Missing Page category — must be set for FB ranking algo.');
    if (audit.posts_per_week < 3) audit.issues.push(`Posting only ${audit.posts_per_week}/week — Sonder/OTA Pages should target 3-5/week for algo boost.`);
    if (audit.avg_engagement < 1 && audit.posts_last_30d > 0) audit.issues.push(`Avg engagement only ${audit.avg_engagement}/post — content may be suppressed. Try V5T pipeline + carousel format.`);
    if (audit.followers < 100) audit.issues.push(`Only ${audit.followers} followers — too small for FB Insights API to unlock.`);
    if (audit.rating_count === 0) audit.issues.push('No reviews — encourage real guests to leave reviews on Page (positive signal).');

    return audit;
  } catch (e: any) {
    console.warn(`[seo-fb] audit ${page.name} fail:`, e?.response?.data?.error?.message || e?.message);
    return null;
  }
}

/** Audit all configured pages + persist. */
export async function auditAllFacebookPages(): Promise<{ audited: number; errors: number; results: FbPageAudit[] }> {
  const result = { audited: 0, errors: 0, results: [] as FbPageAudit[] };
  for (const page of getPages()) {
    const a = await auditFacebookPage(page);
    if (a) {
      result.audited++;
      result.results.push(a);
      // Persist
      db.prepare(
        `INSERT OR REPLACE INTO seo_social_audit
         (channel, page_id, profile_id, name, audit_json, score, audited_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run('facebook', page.id, page.fb_page_id, a.name, JSON.stringify(a), a.total_score, a.audited_at);
    } else {
      result.errors++;
    }
  }
  return result;
}

/** Get latest audit from DB. */
export function getLatestFacebookAudit(): FbPageAudit[] {
  const rows = db.prepare(
    `SELECT audit_json FROM seo_social_audit WHERE channel = 'facebook' ORDER BY audited_at DESC LIMIT 10`,
  ).all() as Array<{ audit_json: string }>;
  return rows.map((r) => JSON.parse(r.audit_json));
}

/**
 * SEO Scorecard — compute 0-100 score per page based on audit data.
 *
 * Weights (total 100):
 *   - Title quality:       15 (length 30-60, not empty, unique-ish)
 *   - Meta description:    15 (length 120-160, not empty)
 *   - Headings:            10 (exactly 1 h1, has h2)
 *   - Content depth:       10 (≥300 words, more = better up to 1500)
 *   - Schema.org:          15 (presence + correct type for page_type)
 *   - Image alt-text:      10 (% of images with alt)
 *   - Open Graph:           5 (og:title + og:description + og:image)
 *   - Canonical:            5 (presence)
 *   - Language:             5 (html[lang] attr)
 *   - Load time:           10 (<1s=10, <3s=7, <5s=3, >5s=0)
 *
 * Score grade:
 *   90-100: A — Excellent
 *   75-89:  B — Good
 *   60-74:  C — OK, needs polish
 *   40-59:  D — Many issues
 *   0-39:   F — Critical problems
 */

import { db } from '../../db';
import type { SeoPage } from './types';

export interface ScorecardBreakdown {
  title: { score: number; max: number; reason: string };
  meta: { score: number; max: number; reason: string };
  headings: { score: number; max: number; reason: string };
  content: { score: number; max: number; reason: string };
  schema: { score: number; max: number; reason: string };
  alt: { score: number; max: number; reason: string };
  og: { score: number; max: number; reason: string };
  canonical: { score: number; max: number; reason: string };
  language: { score: number; max: number; reason: string };
  load_time: { score: number; max: number; reason: string };
}

export interface ScorecardResult {
  score: number;
  grade: 'A' | 'B' | 'C' | 'D' | 'F';
  breakdown: ScorecardBreakdown;
}

export function gradePage(p: SeoPage): ScorecardResult {
  const b: ScorecardBreakdown = {
    title: scoreTitle(p),
    meta: scoreMeta(p),
    headings: scoreHeadings(p),
    content: scoreContent(p),
    schema: scoreSchema(p),
    alt: scoreAlt(p),
    og: scoreOG(p),
    canonical: scoreCanonical(p),
    language: scoreLanguage(p),
    load_time: scoreLoadTime(p),
  };

  const score = Math.round(
    b.title.score + b.meta.score + b.headings.score + b.content.score +
    b.schema.score + b.alt.score + b.og.score + b.canonical.score +
    b.language.score + b.load_time.score,
  );

  const grade: ScorecardResult['grade'] =
    score >= 90 ? 'A' :
    score >= 75 ? 'B' :
    score >= 60 ? 'C' :
    score >= 40 ? 'D' : 'F';

  return { score, grade, breakdown: b };
}

function scoreTitle(p: SeoPage): ScorecardBreakdown['title'] {
  const max = 15;
  if (!p.title) return { score: 0, max, reason: 'No <title>' };
  const len = p.title.length;
  if (len < 15) return { score: 5, max, reason: `Title too short (${len} chars, want ≥30)` };
  if (len < 30) return { score: 10, max, reason: `Title a bit short (${len} chars, want 30-60)` };
  if (len <= 60) return { score: max, max, reason: `Title length ideal (${len} chars)` };
  if (len <= 70) return { score: 12, max, reason: `Title slightly long (${len} chars, may truncate)` };
  return { score: 7, max, reason: `Title too long (${len} chars, Google will truncate)` };
}

function scoreMeta(p: SeoPage): ScorecardBreakdown['meta'] {
  const max = 15;
  if (!p.meta_description) return { score: 0, max, reason: 'No meta description' };
  const len = p.meta_description.length;
  if (len < 50) return { score: 5, max, reason: `Meta too short (${len} chars, want ≥120)` };
  if (len < 120) return { score: 10, max, reason: `Meta a bit short (${len} chars, want 120-160)` };
  if (len <= 160) return { score: max, max, reason: `Meta length ideal (${len} chars)` };
  if (len <= 200) return { score: 12, max, reason: `Meta slightly long (${len} chars, may truncate)` };
  return { score: 8, max, reason: `Meta too long (${len} chars, truncated by Google)` };
}

function scoreHeadings(p: SeoPage): ScorecardBreakdown['headings'] {
  const max = 10;
  if (!p.h1) return { score: 0, max, reason: 'No <h1>' };
  let score = 6;
  let parts = ['<h1> present'];
  if (p.h2_count > 0) { score += 4; parts.push(`${p.h2_count} <h2> for structure`); }
  return { score, max, reason: parts.join(', ') };
}

function scoreContent(p: SeoPage): ScorecardBreakdown['content'] {
  const max = 10;
  const w = p.word_count || 0;
  if (w < 100) return { score: 0, max, reason: `Thin content (${w} words, want ≥300)` };
  if (w < 300) return { score: 4, max, reason: `Below threshold (${w} words, want ≥300)` };
  if (w < 600) return { score: 7, max, reason: `OK content (${w} words)` };
  if (w < 1500) return { score: max, max, reason: `Strong content (${w} words)` };
  return { score: 9, max, reason: `Long content (${w} words) — may be too much for some queries` };
}

function scoreSchema(p: SeoPage): ScorecardBreakdown['schema'] {
  const max = 15;
  if (!p.has_schema) {
    return { score: 0, max, reason: p.page_type === 'hotel' ? 'No JSON-LD on a HOTEL page (critical)' : 'No JSON-LD schema' };
  }
  let types: string[] = [];
  try { types = JSON.parse(p.schema_types || '[]'); } catch {}
  // Bonus if hotel page has Hotel/LodgingBusiness schema
  if (p.page_type === 'hotel') {
    const hasHotel = types.some((t) => /Hotel|LodgingBusiness|BedAndBreakfast/i.test(t));
    if (hasHotel) return { score: max, max, reason: `Has Hotel schema: ${types.join(', ')}` };
    return { score: 8, max, reason: `Has schema but missing Hotel type: ${types.join(', ')}` };
  }
  return { score: 12, max, reason: `Has schema: ${types.join(', ')}` };
}

function scoreAlt(p: SeoPage): ScorecardBreakdown['alt'] {
  const max = 10;
  if (p.image_count === 0) return { score: max, max, reason: 'No images on page' };
  const pct = Math.round((p.images_with_alt / p.image_count) * 100);
  if (pct === 100) return { score: max, max, reason: 'All images have alt text' };
  if (pct >= 80) return { score: 8, max, reason: `${pct}% images have alt (${p.images_with_alt}/${p.image_count})` };
  if (pct >= 50) return { score: 5, max, reason: `${pct}% images have alt (${p.images_with_alt}/${p.image_count})` };
  if (pct > 0) return { score: 2, max, reason: `Only ${pct}% images have alt (${p.images_with_alt}/${p.image_count})` };
  return { score: 0, max, reason: `0% — all ${p.image_count} images missing alt` };
}

function scoreOG(p: SeoPage): ScorecardBreakdown['og'] {
  const max = 5;
  let s = 0;
  const parts: string[] = [];
  if (p.og_title) { s += 1.5; parts.push('og:title'); } else parts.push('NO og:title');
  if (p.og_description) { s += 1.5; parts.push('og:description'); } else parts.push('NO og:description');
  if (p.og_image) { s += 2; parts.push('og:image'); } else parts.push('NO og:image');
  return { score: Math.round(s), max, reason: parts.join(', ') };
}

function scoreCanonical(p: SeoPage): ScorecardBreakdown['canonical'] {
  const max = 5;
  if (p.canonical_url) return { score: max, max, reason: 'Has canonical URL' };
  return { score: 0, max, reason: 'No canonical URL (risk of duplicate content)' };
}

function scoreLanguage(p: SeoPage): ScorecardBreakdown['language'] {
  const max = 5;
  if (p.language) return { score: max, max, reason: `lang="${p.language}"` };
  return { score: 0, max, reason: 'No html[lang] attribute' };
}

function scoreLoadTime(p: SeoPage): ScorecardBreakdown['load_time'] {
  const max = 10;
  const ms = p.load_time_ms || 9999;
  if (ms <= 1000) return { score: max, max, reason: `Fast (${ms}ms)` };
  if (ms <= 3000) return { score: 7, max, reason: `OK (${ms}ms)` };
  if (ms <= 5000) return { score: 3, max, reason: `Slow (${ms}ms)` };
  return { score: 0, max, reason: `Very slow (${ms}ms) — Google penalizes` };
}

/** Persist scorecard to DB. */
export function persistScorecard(pageId: number, result: ScorecardResult): void {
  db.prepare(
    `INSERT OR REPLACE INTO seo_page_scores (page_id, score, breakdown, graded_at) VALUES (?, ?, ?, ?)`,
  ).run(pageId, result.score, JSON.stringify(result.breakdown), Date.now());
}

/** Grade all pages + persist. */
export function gradeAllPages(): { graded: number; avg_score: number; distribution: Record<string, number> } {
  const pages = db.prepare(`SELECT * FROM seo_pages`).all() as SeoPage[];
  let totalScore = 0;
  const distribution = { A: 0, B: 0, C: 0, D: 0, F: 0 };
  for (const p of pages) {
    const r = gradePage(p);
    persistScorecard(p.id, r);
    totalScore += r.score;
    distribution[r.grade]++;
  }
  return {
    graded: pages.length,
    avg_score: pages.length > 0 ? Math.round(totalScore / pages.length) : 0,
    distribution,
  };
}

/** Get scorecard for one page (computes on demand if missing). */
export function getPageScore(pageId: number): { score: number; breakdown: ScorecardBreakdown; grade: string } | null {
  const cached = db.prepare(
    `SELECT page_id, score, breakdown FROM seo_page_scores WHERE page_id = ?`,
  ).get(pageId) as { page_id: number; score: number; breakdown: string } | undefined;

  if (cached) {
    return {
      score: cached.score,
      breakdown: JSON.parse(cached.breakdown),
      grade: cached.score >= 90 ? 'A' : cached.score >= 75 ? 'B' : cached.score >= 60 ? 'C' : cached.score >= 40 ? 'D' : 'F',
    };
  }

  const page = db.prepare(`SELECT * FROM seo_pages WHERE id = ?`).get(pageId) as SeoPage | undefined;
  if (!page) return null;
  const r = gradePage(page);
  persistScorecard(pageId, r);
  return r;
}

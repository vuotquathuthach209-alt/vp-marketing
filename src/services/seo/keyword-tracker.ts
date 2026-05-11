/**
 * SEO Keyword Ranking Tracker.
 *
 * Strategy (cost-conscious for solo hotel):
 *   1. Primary: Google Custom Search JSON API
 *      - Free tier: 100 queries/day
 *      - $5 per 1000 queries above
 *      - Best for tracking sondervn.com rank for specific keywords
 *      - Limitation: returns site-restricted search if cx is configured
 *
 *   2. Fallback: SerpAPI (if google_cse not configured but serpapi_key is)
 *      - $50/month for 5000 searches
 *      - Full Google SERP scrape (organic + ads + features)
 *
 *   3. Manual: Admin enters rank via UI (always works, free)
 *
 * For each tracked keyword, store rank history → show trend.
 */

import axios from 'axios';
import { db, getSetting } from '../../db';

const GOOGLE_CSE_API = 'https://www.googleapis.com/customsearch/v1';
const SERPAPI = 'https://serpapi.com/search';

type RankSource = 'cse' | 'serpapi' | 'manual';

interface RankResult {
  rank: number | null;          // 1-100 or null if not in top 100
  source: RankSource;
  cost_usd: number;
  total_results: number | null;
  serp_features?: string[];     // sitelinks, faq, image_pack, etc.
  error?: string;
}

/** Resolve URL pattern → check if any result URL matches the target site/page. */
function findRankInResults(items: Array<{ link: string }>, targetHost: string, targetPath?: string): number | null {
  for (let i = 0; i < items.length; i++) {
    try {
      const u = new URL(items[i].link);
      if (u.hostname.replace(/^www\./, '') !== targetHost.replace(/^www\./, '')) continue;
      // If targetPath specified, also require path match
      if (targetPath) {
        const targetPathNorm = targetPath.replace(/\/+$/, '');
        const resultPathNorm = u.pathname.replace(/\/+$/, '');
        if (!resultPathNorm.startsWith(targetPathNorm)) continue;
      }
      return i + 1;
    } catch {}
  }
  return null;
}

/** Check rank via Google Custom Search API. Requires google_cse_api_key + google_cse_id settings. */
async function checkRankViaCSE(keyword: string, targetUrl: string): Promise<RankResult> {
  const apiKey = getSetting('google_cse_api_key') || getSetting('google_api_key');
  const cx = getSetting('google_cse_id');
  if (!apiKey || !cx) return { rank: null, source: 'cse', cost_usd: 0, total_results: null, error: 'google_cse_api_key or google_cse_id not configured' };

  let target: URL;
  try { target = new URL(targetUrl); }
  catch { return { rank: null, source: 'cse', cost_usd: 0, total_results: null, error: `invalid target URL: ${targetUrl}` }; }

  try {
    // CSE returns max 10 per call; do up to 5 calls (top 50) to find rank
    let rank: number | null = null;
    let totalResults = 0;
    for (let start = 1; start <= 50; start += 10) {
      const r = await axios.get(GOOGLE_CSE_API, {
        params: { key: apiKey, cx, q: keyword, num: 10, start, lr: 'lang_vi', gl: 'vn' },
        timeout: 15_000,
      });
      const items: any[] = r.data?.items || [];
      totalResults = parseInt(r.data?.searchInformation?.totalResults || '0', 10);
      if (items.length === 0) break;
      const offset = start - 1;
      const localRank = findRankInResults(items, target.hostname, target.pathname);
      if (localRank !== null) {
        rank = offset + localRank;
        break;
      }
      // Rate-limit gentle
      await new Promise((r) => setTimeout(r, 200));
    }

    // Cost: $5 per 1000 queries beyond 100 free/day
    return { rank, source: 'cse', cost_usd: 0.005, total_results: totalResults || null };
  } catch (e: any) {
    const msg = e?.response?.data?.error?.message || e?.message || 'unknown';
    return { rank: null, source: 'cse', cost_usd: 0, total_results: null, error: msg };
  }
}

/** Check rank via SerpAPI. Requires serpapi_key setting. */
async function checkRankViaSerpApi(keyword: string, targetUrl: string): Promise<RankResult> {
  const apiKey = getSetting('serpapi_key');
  if (!apiKey) return { rank: null, source: 'serpapi', cost_usd: 0, total_results: null, error: 'serpapi_key not configured' };

  let target: URL;
  try { target = new URL(targetUrl); }
  catch { return { rank: null, source: 'serpapi', cost_usd: 0, total_results: null, error: `invalid target URL: ${targetUrl}` }; }

  try {
    const r = await axios.get(SERPAPI, {
      params: { engine: 'google', q: keyword, gl: 'vn', hl: 'vi', num: 100, api_key: apiKey },
      timeout: 30_000,
    });
    const organic: any[] = r.data?.organic_results || [];
    const rank = findRankInResults(organic, target.hostname, target.pathname);
    const features: string[] = [];
    if (r.data?.knowledge_graph) features.push('knowledge_graph');
    if (r.data?.local_results) features.push('local_pack');
    if (r.data?.image_results || r.data?.inline_images) features.push('image_pack');
    if (r.data?.related_questions) features.push('faq');
    return {
      rank,
      source: 'serpapi',
      cost_usd: 0.01,  // approx $50/5000 = $0.01/query
      total_results: r.data?.search_information?.total_results || null,
      serp_features: features,
    };
  } catch (e: any) {
    const msg = e?.response?.data?.error || e?.message || 'unknown';
    return { rank: null, source: 'serpapi', cost_usd: 0, total_results: null, error: msg };
  }
}

/** Public: check rank for one keyword. Auto-picks CSE or SerpAPI based on configured settings. */
export async function checkKeywordRank(keyword: string, targetUrl: string): Promise<RankResult> {
  // Prefer SerpAPI if configured (more accurate, no site-restricted issue)
  if (getSetting('serpapi_key')) return checkRankViaSerpApi(keyword, targetUrl);
  return checkRankViaCSE(keyword, targetUrl);
}

/** Update DB with new rank + append to history. */
export function recordKeywordRank(keywordId: number, rank: number | null): void {
  const now = Date.now();
  const existing = db.prepare(`SELECT current_rank FROM seo_keywords WHERE id = ?`).get(keywordId) as { current_rank: number | null } | undefined;
  const prev = existing?.current_rank ?? null;

  db.prepare(
    `UPDATE seo_keywords SET prev_rank = ?, current_rank = ?, last_checked_at = ? WHERE id = ?`,
  ).run(prev, rank, now, keywordId);

  db.prepare(
    `INSERT INTO seo_keyword_history (keyword_id, rank, checked_at) VALUES (?, ?, ?)`,
  ).run(keywordId, rank, now);
}

/** Batch check all tracked keywords. Used by daily cron. */
export async function checkAllKeywords(opts?: { onlyStale?: boolean }): Promise<{
  total: number;
  checked: number;
  skipped: number;
  errors: number;
  cost_usd: number;
  results: Array<{ keyword: string; rank: number | null; change: number | null; source: RankSource; error?: string }>;
}> {
  const result = { total: 0, checked: 0, skipped: 0, errors: 0, cost_usd: 0, results: [] as any[] };
  const onlyStale = opts?.onlyStale !== false;  // default true
  const staleMs = 6 * 60 * 60 * 1000;  // 6 hours

  let sql = `SELECT id, keyword, target_url, current_rank FROM seo_keywords`;
  if (onlyStale) sql += ` WHERE last_checked_at IS NULL OR last_checked_at < ${Date.now() - staleMs}`;
  const keywords = db.prepare(sql).all() as Array<{ id: number; keyword: string; target_url: string | null; current_rank: number | null }>;
  result.total = keywords.length;

  for (const k of keywords) {
    if (!k.target_url) {
      result.skipped++;
      result.results.push({ keyword: k.keyword, rank: null, change: null, source: 'manual', error: 'no target_url' });
      continue;
    }
    const r = await checkKeywordRank(k.keyword, k.target_url);
    if (r.error && r.error.includes('not configured')) {
      result.skipped++;
      result.results.push({ keyword: k.keyword, rank: null, change: null, source: r.source, error: r.error });
      continue;
    }
    recordKeywordRank(k.id, r.rank);
    const change = r.rank !== null && k.current_rank !== null ? k.current_rank - r.rank : null;
    result.results.push({ keyword: k.keyword, rank: r.rank, change, source: r.source, error: r.error });
    if (r.error) result.errors++;
    else result.checked++;
    result.cost_usd += r.cost_usd;
    // Throttle 1.5s between calls to respect API limits
    await new Promise((r) => setTimeout(r, 1500));
  }

  return result;
}

/** Manual rank entry (admin enters from their own SERP check). */
export function setManualRank(keywordId: number, rank: number | null): void {
  recordKeywordRank(keywordId, rank);
}

/** Get rank history (last 30 entries) for sparkline. */
export function getKeywordHistory(keywordId: number, limit = 30): Array<{ rank: number | null; checked_at: number }> {
  return db.prepare(
    `SELECT rank, checked_at FROM seo_keyword_history WHERE keyword_id = ? ORDER BY checked_at DESC LIMIT ?`,
  ).all(keywordId, limit) as any[];
}

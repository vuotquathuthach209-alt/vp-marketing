/**
 * SEO Crawler — fetches a URL, parses HTML, extracts SEO-relevant data.
 *
 * Strategy:
 *   1. axios GET with User-Agent
 *   2. cheerio parse → extract title, meta, h1/h2, schema.org JSON-LD, images, links
 *   3. Compute load_time_ms, word_count, schema_types, alt coverage
 *   4. Identify SEO issues (missing meta, thin content, multiple h1, etc.)
 *   5. Save to seo_pages + seo_issues
 */

import axios from 'axios';
import * as cheerio from 'cheerio';
import { db } from '../../db';
import type { CrawlResult, SeoIssueType, SeoIssueSeverity, SeoPage } from './types';

const USER_AGENT = 'Mozilla/5.0 (compatible; SonderSEO/1.0; +https://app.sondervn.com/seo-bot)';
const TIMEOUT_MS = 20_000;
const MAX_HTML_SIZE = 5 * 1024 * 1024;  // 5MB cap to avoid memory blowup

function detectPageType(url: string, $: cheerio.CheerioAPI): SeoPage['page_type'] {
  const p = new URL(url).pathname.toLowerCase();
  if (p === '/' || p === '') return 'homepage';
  // sondervn.com hotel detail URLs: /khach-san/{slug}, /hotel/{slug}, /property/{id}, etc.
  if (/\/(khach-san|hotel|property|stay|room)\/[^/]+/.test(p)) return 'hotel';
  if (/\/(blog|news|tin-tuc|bai-viet)\//.test(p)) return 'blog';
  if (/\/(danh-muc|category|listing|search)/.test(p)) return 'category';
  // Heuristic: if page has Hotel schema, it's a hotel page
  const ldScripts = $('script[type="application/ld+json"]');
  for (let i = 0; i < ldScripts.length; i++) {
    try {
      const data = JSON.parse($(ldScripts[i]).html() || '{}');
      const types = Array.isArray(data) ? data.map((d) => d['@type']) : [data['@type']];
      if (types.some((t) => /Hotel|Lodging|BedAndBreakfast/i.test(t || ''))) return 'hotel';
    } catch {}
  }
  return 'other';
}

function extractSchemaTypes($: cheerio.CheerioAPI): string[] {
  const types = new Set<string>();
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const data = JSON.parse($(el).html() || '{}');
      const items = Array.isArray(data) ? data : [data];
      for (const item of items) {
        const t = item['@type'];
        if (typeof t === 'string') types.add(t);
        else if (Array.isArray(t)) t.forEach((x) => typeof x === 'string' && types.add(x));
      }
    } catch {}
  });
  // Also check for microdata
  $('[itemscope][itemtype]').each((_, el) => {
    const t = $(el).attr('itemtype') || '';
    const match = t.match(/schema\.org\/(\w+)/);
    if (match) types.add(match[1]);
  });
  return Array.from(types);
}

function classifyLinks(baseUrl: string, $: cheerio.CheerioAPI): { internal: string[]; external: string[] } {
  let baseHost: string;
  try { baseHost = new URL(baseUrl).hostname; } catch { return { internal: [], external: [] }; }

  const internal = new Set<string>();
  const external = new Set<string>();

  $('a[href]').each((_, el) => {
    const href = ($(el).attr('href') || '').trim();
    if (!href || href.startsWith('#') || href.startsWith('javascript:') || href.startsWith('mailto:') || href.startsWith('tel:')) return;
    try {
      const abs = new URL(href, baseUrl).toString();
      const host = new URL(abs).hostname;
      if (host === baseHost) internal.add(abs);
      else external.add(abs);
    } catch {}
  });

  return { internal: Array.from(internal), external: Array.from(external) };
}

/** Crawl one URL and return parsed SEO data + identified issues. */
export async function crawlUrl(url: string): Promise<CrawlResult> {
  const t0 = Date.now();
  try {
    const r = await axios.get(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,*/*' },
      timeout: TIMEOUT_MS,
      maxContentLength: MAX_HTML_SIZE,
      validateStatus: () => true,
      decompress: true,
    });
    const loadTime = Date.now() - t0;
    const status = r.status;

    if (status >= 400 || typeof r.data !== 'string') {
      return {
        url, ok: false, status, load_time_ms: loadTime,
        page: null,
        issues: [{
          type: 'http_error', severity: 'critical',
          message: `HTTP ${status} when fetching page`,
          recommendation: 'Page returns non-2xx — fix the underlying route or remove from sitemap',
          context: String(status), fixed: 0, fixed_at: null,
        }],
        links: { internal: [], external: [] },
        error: `HTTP ${status}`,
      };
    }

    const $ = cheerio.load(r.data);

    // Extract fields
    const title = $('head title').first().text().trim() || null;
    const meta_description = $('meta[name="description"]').attr('content')?.trim() || null;
    const meta_keywords = $('meta[name="keywords"]').attr('content')?.trim() || null;
    const canonical_url = $('link[rel="canonical"]').attr('href')?.trim() || null;
    const h1s = $('h1').map((_, el) => $(el).text().trim()).get().filter(Boolean);
    const h1 = h1s[0] || null;
    const h2_count = $('h2').length;
    const language = $('html').attr('lang') || null;

    // Word count: text content of body, normalize whitespace
    const bodyText = $('body').clone()
      .find('script,style,noscript,nav,footer,header').remove().end()
      .text().replace(/\s+/g, ' ').trim();
    const word_count = bodyText ? bodyText.split(/\s+/).length : 0;

    // OG tags
    const og_title = $('meta[property="og:title"]').attr('content')?.trim() || null;
    const og_description = $('meta[property="og:description"]').attr('content')?.trim() || null;
    const og_image = $('meta[property="og:image"]').attr('content')?.trim() || null;

    // Schema
    const schema_types = extractSchemaTypes($);

    // Images
    const allImages = $('img').toArray();
    const image_count = allImages.length;
    const images_with_alt = allImages.filter((el) => {
      const alt = $(el).attr('alt');
      return alt !== undefined && alt.trim().length > 0;
    }).length;
    const images_without_alt = image_count - images_with_alt;

    // Links
    const links = classifyLinks(url, $);
    const internal_links = links.internal.length;
    const external_links = links.external.length;

    // Page type
    const page_type = detectPageType(url, $);

    const page: Partial<SeoPage> = {
      url, title, meta_description, meta_keywords, canonical_url,
      h1, h2_count, word_count,
      status_code: status, load_time_ms: loadTime,
      has_schema: schema_types.length > 0 ? 1 : 0,
      schema_types: JSON.stringify(schema_types),
      internal_links, external_links,
      image_count, images_with_alt, images_without_alt,
      og_title, og_description, og_image,
      page_type, language,
      last_crawled_at: Date.now(),
    };

    // Identify issues
    const issues: CrawlResult['issues'] = [];
    const pushIssue = (type: SeoIssueType, sev: SeoIssueSeverity, msg: string, rec: string, ctx: string | null = null) => {
      issues.push({ type, severity: sev, message: msg, recommendation: rec, context: ctx, fixed: 0, fixed_at: null });
    };

    if (!title) pushIssue('missing_title', 'critical', 'Page has no <title>', 'Add a unique, descriptive <title> 30-60 chars');
    else if (title.length > 65) pushIssue('title_too_long', 'warning', `Title is ${title.length} chars (>65)`, 'Shorten to 30-60 chars so Google does not truncate', title);
    else if (title.length < 15) pushIssue('title_too_short', 'warning', `Title is only ${title.length} chars`, 'Expand to 30-60 chars with keywords', title);

    if (!meta_description) pushIssue('missing_meta_description', 'warning', 'No <meta name="description">', 'Add a 120-160 char description that compels click-through');
    else if (meta_description.length > 170) pushIssue('meta_too_long', 'info', `Meta description is ${meta_description.length} chars`, 'Trim to 120-160 chars', meta_description);
    else if (meta_description.length < 50) pushIssue('meta_too_short', 'info', `Meta description is only ${meta_description.length} chars`, 'Expand to 120-160 chars', meta_description);

    if (!canonical_url) pushIssue('missing_canonical', 'info', 'No <link rel="canonical">', 'Add a canonical URL to prevent duplicate content issues');

    if (h1s.length === 0) pushIssue('missing_h1', 'warning', 'Page has no <h1>', 'Add a single <h1> describing the page topic');
    else if (h1s.length > 1) pushIssue('multiple_h1', 'warning', `Page has ${h1s.length} <h1> elements`, 'Use exactly one <h1>; convert others to <h2>/<h3>', h1s.join(' | '));

    if (word_count < 300) pushIssue('thin_content', 'warning', `Page has only ${word_count} words`, 'Aim for ≥300 words of substantive content; thin pages rank poorly');

    if (schema_types.length === 0) {
      // Only critical on hotel pages, info elsewhere
      pushIssue('no_schema', page_type === 'hotel' ? 'critical' : 'info',
        'No schema.org JSON-LD detected',
        page_type === 'hotel'
          ? 'Add Hotel + LocalBusiness JSON-LD with name, address, rating, priceRange'
          : 'Add relevant schema.org markup to improve rich-snippet eligibility');
    }

    if (images_without_alt > 0) {
      pushIssue('missing_alt', 'warning',
        `${images_without_alt} of ${image_count} images have no alt text`,
        'Add descriptive Vietnamese alt text — improves accessibility AND image-search ranking',
        String(images_without_alt));
    }

    if (!og_image) pushIssue('missing_og_image', 'info', 'No og:image meta', 'Add og:image so social shares get a proper preview');
    if (!language) pushIssue('missing_lang', 'info', '<html> tag has no lang attribute', 'Set <html lang="vi"> to help search engines understand');

    if (loadTime > 3000) pushIssue('slow_load', 'warning', `Page load ${loadTime}ms (>3s)`, 'Compress images, defer JS, enable CDN caching — Google ranks fast pages higher', String(loadTime));

    return { url, ok: true, status, load_time_ms: loadTime, page, issues, links };
  } catch (e: any) {
    return {
      url, ok: false, status: 0, load_time_ms: Date.now() - t0, page: null,
      issues: [{
        type: 'http_error', severity: 'critical',
        message: `Fetch failed: ${e?.message || 'unknown'}`,
        recommendation: 'Check DNS / TLS / firewall',
        context: e?.message || null, fixed: 0, fixed_at: null,
      }],
      links: { internal: [], external: [] },
      error: e?.message,
    };
  }
}

/** Save a CrawlResult to DB (upsert seo_pages by url + insert new issues). */
export function persistCrawlResult(r: CrawlResult): { page_id: number; issues_added: number } {
  const now = Date.now();

  // Upsert page
  const existing = db.prepare(`SELECT id FROM seo_pages WHERE url = ?`).get(r.url) as { id: number } | undefined;

  let pageId: number;
  if (existing) {
    db.prepare(
      `UPDATE seo_pages SET
         title = ?, meta_description = ?, meta_keywords = ?, canonical_url = ?,
         h1 = ?, h2_count = ?, word_count = ?,
         status_code = ?, load_time_ms = ?,
         has_schema = ?, schema_types = ?,
         internal_links = ?, external_links = ?,
         image_count = ?, images_with_alt = ?, images_without_alt = ?,
         og_title = ?, og_description = ?, og_image = ?,
         page_type = ?, language = ?,
         last_crawled_at = ?
       WHERE id = ?`,
    ).run(
      r.page?.title || null,
      r.page?.meta_description || null,
      r.page?.meta_keywords || null,
      r.page?.canonical_url || null,
      r.page?.h1 || null,
      r.page?.h2_count || 0,
      r.page?.word_count || 0,
      r.page?.status_code || 0,
      r.page?.load_time_ms || 0,
      r.page?.has_schema || 0,
      r.page?.schema_types || '[]',
      r.page?.internal_links || 0,
      r.page?.external_links || 0,
      r.page?.image_count || 0,
      r.page?.images_with_alt || 0,
      r.page?.images_without_alt || 0,
      r.page?.og_title || null,
      r.page?.og_description || null,
      r.page?.og_image || null,
      r.page?.page_type || 'other',
      r.page?.language || null,
      now,
      existing.id,
    );
    pageId = existing.id;
    // Mark old issues fixed if not in new list (by type)
    const currentTypes = new Set(r.issues.map((i) => i.type));
    db.prepare(
      `UPDATE seo_issues SET fixed = 1, fixed_at = ? WHERE page_id = ? AND fixed = 0 AND type NOT IN (${
        [...currentTypes].map(() => '?').join(',') || "''"
      })`,
    ).run(now, pageId, ...currentTypes);
  } else {
    const ins = db.prepare(
      `INSERT INTO seo_pages
       (url, title, meta_description, meta_keywords, canonical_url,
        h1, h2_count, word_count, status_code, load_time_ms,
        has_schema, schema_types, internal_links, external_links,
        image_count, images_with_alt, images_without_alt,
        og_title, og_description, og_image,
        page_type, language, last_crawled_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      r.url,
      r.page?.title || null,
      r.page?.meta_description || null,
      r.page?.meta_keywords || null,
      r.page?.canonical_url || null,
      r.page?.h1 || null,
      r.page?.h2_count || 0,
      r.page?.word_count || 0,
      r.page?.status_code || 0,
      r.page?.load_time_ms || 0,
      r.page?.has_schema || 0,
      r.page?.schema_types || '[]',
      r.page?.internal_links || 0,
      r.page?.external_links || 0,
      r.page?.image_count || 0,
      r.page?.images_with_alt || 0,
      r.page?.images_without_alt || 0,
      r.page?.og_title || null,
      r.page?.og_description || null,
      r.page?.og_image || null,
      r.page?.page_type || 'other',
      r.page?.language || null,
      now, now,
    );
    pageId = ins.lastInsertRowid as number;
  }

  // Insert new issues that don't already exist (by page_id + type)
  let added = 0;
  for (const issue of r.issues) {
    const dup = db.prepare(
      `SELECT id FROM seo_issues WHERE page_id = ? AND type = ? AND fixed = 0`,
    ).get(pageId, issue.type);
    if (dup) continue;
    db.prepare(
      `INSERT INTO seo_issues
       (page_id, type, severity, message, recommendation, context, fixed, fixed_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(pageId, issue.type, issue.severity, issue.message, issue.recommendation, issue.context, 0, null, now);
    added++;
  }

  return { page_id: pageId, issues_added: added };
}

/** Crawl multiple URLs in series (with throttle) and persist. */
export async function crawlBatch(urls: string[], throttleMs = 500): Promise<{
  total: number;
  ok: number;
  fail: number;
  total_issues_added: number;
}> {
  const result = { total: urls.length, ok: 0, fail: 0, total_issues_added: 0 };
  for (const url of urls) {
    try {
      const r = await crawlUrl(url);
      const p = persistCrawlResult(r);
      if (r.ok) result.ok++;
      else result.fail++;
      result.total_issues_added += p.issues_added;
      console.log(`[seo-crawl] ${r.ok ? '✓' : '✗'} ${url} → ${r.status} (${r.load_time_ms}ms, ${r.issues.length} issues)`);
    } catch (e: any) {
      result.fail++;
      console.warn(`[seo-crawl] err ${url}:`, e?.message);
    }
    if (throttleMs > 0) await new Promise((r) => setTimeout(r, throttleMs));
  }
  return result;
}

/** Discover URLs from a sitemap.xml — returns first 200 URLs. */
export async function discoverFromSitemap(sitemapUrl: string): Promise<string[]> {
  try {
    const r = await axios.get(sitemapUrl, { headers: { 'User-Agent': USER_AGENT }, timeout: TIMEOUT_MS });
    const xml = String(r.data || '');

    // Index sitemap → recurse
    if (xml.includes('<sitemapindex')) {
      const childUrls = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1].trim());
      const all: string[] = [];
      for (const child of childUrls.slice(0, 10)) {
        const sub = await discoverFromSitemap(child);
        all.push(...sub);
        if (all.length > 200) break;
      }
      return all.slice(0, 200);
    }

    // Regular urlset
    const urls = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1].trim());
    return urls.slice(0, 200);
  } catch (e: any) {
    console.warn('[seo-crawl] sitemap fetch fail:', e?.message);
    return [];
  }
}

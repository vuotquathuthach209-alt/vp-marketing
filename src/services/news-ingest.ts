/**
 * News Ingest — Phase N-1.
 *
 * 1. Fetch RSS feeds từ whitelist nguồn uy tín.
 * 2. Parse với regex (không thêm dep mới).
 * 3. Dedupe bằng url_hash.
 * 4. Extract og:image từ article page (optional, fire-and-forget).
 * 5. Lưu vào news_articles với status='ingested'.
 *
 * Rate limit: 1 req/source/2s.
 * TTL: chỉ lấy articles published trong 48h.
 */
import axios from 'axios';
import crypto from 'crypto';
import { db } from '../db';
import { NewsSource, getEnabledSources } from './news-sources';

const MAX_AGE_MS = 48 * 3600 * 1000;  // chỉ ingest articles ≤ 48h
const MAX_ARTICLES_PER_SOURCE = 30;   // tránh spam DB
const USER_AGENT = 'SonderBot/1.0 (+https://app.sondervn.com)';

export interface RawArticle {
  title: string;
  link: string;
  pub_date: number;      // epoch ms
  description?: string;
  image?: string;
}

/* ═══════════════════════════════════════════
   RSS PARSER (regex-based, lightweight)
   ═══════════════════════════════════════════ */

/** Extract nội dung giữa 2 tag, bao gồm CDATA handling. */
function extractTag(xml: string, tag: string): string | null {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const m = xml.match(re);
  if (!m) return null;
  let content = m[1].trim();
  // Strip CDATA
  const cdata = content.match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/);
  if (cdata) content = cdata[1].trim();
  return content;
}

/** Decode common HTML entities cơ bản */
function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)));
}

/** Strip HTML tags, giữ text only */
function stripHtml(s: string): string {
  return decodeEntities(s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
}

/** Try extract image URL từ RSS <item> (enclosure | media:content | media:thumbnail | img trong description) */
function extractRssImage(itemXml: string): string | undefined {
  // Atom/RSS: <enclosure url="..." type="image/..."/>
  const enc = itemXml.match(/<enclosure[^>]*url=["']([^"']+)["'][^>]*type=["']image\//i);
  if (enc) return enc[1];
  // <media:content url="..." medium="image"
  const mc = itemXml.match(/<media:content[^>]*url=["']([^"']+)["'][^>]*(?:medium=["']image["']|type=["']image\/)/i);
  if (mc) return mc[1];
  // <media:thumbnail url="..."/>
  const mt = itemXml.match(/<media:thumbnail[^>]*url=["']([^"']+)["']/i);
  if (mt) return mt[1];
  // <description> có <img src="...">
  const imgInDesc = itemXml.match(/<img[^>]*src=["']([^"']+)["']/i);
  if (imgInDesc) return imgInDesc[1];
  return undefined;
}

/** Parse 1 RSS/Atom feed → list items */
export function parseRSS(xml: string): RawArticle[] {
  const out: RawArticle[] = [];
  // RSS <item> hoặc Atom <entry>
  const itemRe = /<(item|entry)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/gi;
  let m: RegExpExecArray | null;
  while ((m = itemRe.exec(xml)) !== null) {
    const block = m[0];
    const title = extractTag(block, 'title');
    let link = extractTag(block, 'link');
    // Atom <link href="..."/>
    if (!link || link.trim() === '') {
      const atomLink = block.match(/<link[^>]*href=["']([^"']+)["']/i);
      if (atomLink) link = atomLink[1];
    }
    const pubRaw = extractTag(block, 'pubDate') || extractTag(block, 'published') || extractTag(block, 'updated') || extractTag(block, 'dc:date');
    const description = extractTag(block, 'description') || extractTag(block, 'summary') || extractTag(block, 'content:encoded') || extractTag(block, 'content');
    const image = extractRssImage(block);

    if (!title || !link) continue;
    const pubTs = pubRaw ? Date.parse(pubRaw) : Date.now();
    if (isNaN(pubTs)) continue;

    out.push({
      title: decodeEntities(title).slice(0, 500),
      link: decodeEntities(link).trim(),
      pub_date: pubTs,
      description: description ? stripHtml(description).slice(0, 2000) : undefined,
      image,
    });
    if (out.length >= MAX_ARTICLES_PER_SOURCE) break;
  }
  return out;
}

/* ═══════════════════════════════════════════
   OG IMAGE EXTRACTOR (fire-and-forget)
   ═══════════════════════════════════════════ */

/** Fetch article HTML → extract og:image. Dùng khi RSS không có image. */
export async function fetchOgImage(url: string): Promise<string | undefined> {
  try {
    const resp = await axios.get(url, {
      timeout: 10_000,
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,*/*' },
      maxContentLength: 2_000_000,  // 2MB max
      responseType: 'text',
    });
    const html = String(resp.data || '').slice(0, 50_000);  // chỉ đọc đầu
    const og = html.match(/<meta[^>]*property=["']og:image["'][^>]*content=["']([^"']+)["']/i)
      || html.match(/<meta[^>]*content=["']([^"']+)["'][^>]*property=["']og:image["']/i)
      || html.match(/<meta[^>]*name=["']twitter:image["'][^>]*content=["']([^"']+)["']/i);
    if (og) return og[1];
  } catch { /* timeout / 4xx / 5xx → null */ }
  return undefined;
}

/* ═══════════════════════════════════════════
   INGEST CORE
   ═══════════════════════════════════════════ */

function urlHash(url: string): string {
  return crypto.createHash('sha256').update(url.toLowerCase().trim()).digest('hex').slice(0, 32);
}

/** Ingest 1 source → trả về số articles mới insert */
export async function ingestSource(source: NewsSource): Promise<{ fetched: number; new: number; skipped: number; errors: number }> {
  const t0 = Date.now();
  let xml: string;
  try {
    const resp = await axios.get(source.feed_url, {
      timeout: 15_000,
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*' },
      maxContentLength: 5_000_000,  // 5MB
      responseType: 'text',
    });
    xml = String(resp.data || '');
  } catch (e: any) {
    console.warn(`[news-ingest] ${source.id} fetch fail: ${e?.message}`);
    return { fetched: 0, new: 0, skipped: 0, errors: 1 };
  }

  const items = parseRSS(xml);
  const cutoff = Date.now() - MAX_AGE_MS;
  const now = Date.now();
  let newCount = 0;
  let skipCount = 0;

  for (const it of items) {
    // Skip quá cũ
    if (it.pub_date < cutoff) { skipCount++; continue; }
    const hash = urlHash(it.link);

    // Dedupe by url (UNIQUE constraint + explicit check)
    const existing = db.prepare(`SELECT id FROM news_articles WHERE url_hash = ? LIMIT 1`).get(hash) as any;
    if (existing) { skipCount++; continue; }

    try {
      db.prepare(
        `INSERT INTO news_articles
         (url, url_hash, title, body, source, source_tier, published_at, fetched_at, lang, status, created_at, last_state_change_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ingested', ?, ?)
         ON CONFLICT(url) DO NOTHING`
      ).run(
        it.link, hash, it.title, it.description || null,
        source.id, source.tier, it.pub_date, now, source.lang, now, now
      );
      newCount++;
    } catch (e: any) {
      console.warn(`[news-ingest] insert fail ${it.link}: ${e?.message}`);
    }
  }

  const elapsed = Date.now() - t0;
  console.log(`[news-ingest] ${source.id} fetched=${items.length} new=${newCount} skipped=${skipCount} ${elapsed}ms`);
  return { fetched: items.length, new: newCount, skipped: skipCount, errors: 0 };
}

/** Ingest TẤT CẢ enabled sources với rate limit */
export async function ingestAll(): Promise<{ sources: number; new: number; fetched: number; skipped: number; errors: number; elapsed_ms: number }> {
  const t0 = Date.now();
  const sources = getEnabledSources();
  const agg = { sources: sources.length, new: 0, fetched: 0, skipped: 0, errors: 0, elapsed_ms: 0 };

  for (const s of sources) {
    const r = await ingestSource(s);
    agg.new += r.new;
    agg.fetched += r.fetched;
    agg.skipped += r.skipped;
    agg.errors += r.errors;
    // Rate limit between sources
    await new Promise(res => setTimeout(res, s.rate_limit_ms));
  }

  agg.elapsed_ms = Date.now() - t0;
  console.log(`[news-ingest] DONE sources=${agg.sources} new=${agg.new} fetched=${agg.fetched} skipped=${agg.skipped} errors=${agg.errors} ${agg.elapsed_ms}ms`);
  return agg;
}

/** Cleanup — xóa articles quá cũ (>30 ngày) + status=filtered_out */
export function cleanupOldArticles(): { deleted: number } {
  const cutoff = Date.now() - 30 * 24 * 3600_000;
  const r = db.prepare(
    `DELETE FROM news_articles WHERE published_at < ? AND status IN ('filtered_out', 'safety_failed', 'rejected')`
  ).run(cutoff);
  return { deleted: r.changes };
}

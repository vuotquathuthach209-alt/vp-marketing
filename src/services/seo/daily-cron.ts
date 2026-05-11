/**
 * SEO Daily Cron — auto-discover + audit sondervn.com nightly.
 *
 * Runs at 3:30 AM VN time (off-peak, after backup at 4 AM).
 *
 * Steps:
 *   1. Discover URLs from sitemap (or fallback list)
 *   2. Crawl each (throttle 500ms) → save to seo_pages + new seo_issues
 *   3. Snapshot summary stats → seo_daily_snapshot
 *   4. Compute diff vs yesterday → notify if regressions
 *
 * Cost: ~$0 (cheerio + axios, no LLM unless alt-text gen also runs)
 */

import { db, getSetting } from '../../db';
import { crawlBatch, discoverFromSitemap } from './crawler';
import { checkAllKeywords } from './keyword-tracker';

const DEFAULT_SITEMAP = 'https://sondervn.com/sitemap.xml';
const FALLBACK_URLS = [
  'https://sondervn.com/',
  'https://sondervn.com/khach-san',
  'https://sondervn.com/lien-he',
  'https://sondervn.com/ve-chung-toi',
];

interface DailySnapshot {
  date: string;                       // YYYY-MM-DD VN
  total_pages: number;
  total_issues_open: number;
  critical_count: number;
  warning_count: number;
  info_count: number;
  schema_coverage_pct: number;
  alt_coverage_pct: number;
  avg_load_time_ms: number;
  keywords_tracked: number;
  keywords_top10: number;
  keywords_top30: number;
}

function todayStr(): string {
  const now = new Date();
  // Convert to VN timezone
  const vn = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Ho_Chi_Minh' }));
  return `${vn.getFullYear()}-${String(vn.getMonth() + 1).padStart(2, '0')}-${String(vn.getDate()).padStart(2, '0')}`;
}

/** Snapshot current SEO state into seo_daily_snapshot. */
function snapshotToday(): DailySnapshot {
  const r1 = db.prepare(`SELECT COUNT(*) AS n FROM seo_pages`).get() as { n: number };
  const r2 = db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN severity = 'critical' THEN 1 ELSE 0 END) AS critical,
      SUM(CASE WHEN severity = 'warning' THEN 1 ELSE 0 END) AS warning,
      SUM(CASE WHEN severity = 'info' THEN 1 ELSE 0 END) AS info
    FROM seo_issues WHERE fixed = 0
  `).get() as any;
  const r3 = db.prepare(`SELECT
      SUM(CASE WHEN has_schema = 1 THEN 1 ELSE 0 END) AS with_schema,
      SUM(image_count) AS img_total,
      SUM(images_with_alt) AS img_with_alt,
      AVG(load_time_ms) AS avg_load
    FROM seo_pages WHERE last_crawled_at > ${Date.now() - 24 * 60 * 60_000}`,
  ).get() as any;
  const r4 = db.prepare(`
    SELECT COUNT(*) AS total,
      SUM(CASE WHEN current_rank <= 10 THEN 1 ELSE 0 END) AS top10,
      SUM(CASE WHEN current_rank <= 30 THEN 1 ELSE 0 END) AS top30
    FROM seo_keywords
  `).get() as any;

  const schemaCovPct = r1.n > 0 ? Math.round(((r3?.with_schema || 0) / r1.n) * 100) : 0;
  const altCovPct = (r3?.img_total || 0) > 0 ? Math.round(((r3?.img_with_alt || 0) / r3.img_total) * 100) : 0;

  const snap: DailySnapshot = {
    date: todayStr(),
    total_pages: r1.n,
    total_issues_open: r2?.total || 0,
    critical_count: r2?.critical || 0,
    warning_count: r2?.warning || 0,
    info_count: r2?.info || 0,
    schema_coverage_pct: schemaCovPct,
    alt_coverage_pct: altCovPct,
    avg_load_time_ms: Math.round(r3?.avg_load || 0),
    keywords_tracked: r4?.total || 0,
    keywords_top10: r4?.top10 || 0,
    keywords_top30: r4?.top30 || 0,
  };

  db.prepare(
    `INSERT OR REPLACE INTO seo_daily_snapshot
     (date, total_pages, total_issues_open, critical_count, warning_count, info_count,
      schema_coverage_pct, alt_coverage_pct, avg_load_time_ms,
      keywords_tracked, keywords_top10, keywords_top30, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    snap.date, snap.total_pages, snap.total_issues_open,
    snap.critical_count, snap.warning_count, snap.info_count,
    snap.schema_coverage_pct, snap.alt_coverage_pct, snap.avg_load_time_ms,
    snap.keywords_tracked, snap.keywords_top10, snap.keywords_top30,
    Date.now(),
  );

  return snap;
}

/** Compare today's snapshot to yesterday's — return human-readable diff list. */
function computeDiff(): string[] {
  const yesterday = new Date(); yesterday.setDate(yesterday.getDate() - 1);
  const yvn = new Date(yesterday.toLocaleString('en-US', { timeZone: 'Asia/Ho_Chi_Minh' }));
  const ystr = `${yvn.getFullYear()}-${String(yvn.getMonth() + 1).padStart(2, '0')}-${String(yvn.getDate()).padStart(2, '0')}`;

  const today = db.prepare(`SELECT * FROM seo_daily_snapshot WHERE date = ?`).get(todayStr()) as any;
  const yesterdayRow = db.prepare(`SELECT * FROM seo_daily_snapshot WHERE date = ?`).get(ystr) as any;
  if (!today || !yesterdayRow) return [];

  const diffs: string[] = [];
  const compare = (label: string, today_v: number, yest_v: number, betterWhenLower = false) => {
    if (today_v === yest_v) return;
    const delta = today_v - yest_v;
    const arrow = (betterWhenLower ? delta < 0 : delta > 0) ? '✅' : '⚠️';
    diffs.push(`${arrow} ${label}: ${yest_v} → ${today_v} (${delta > 0 ? '+' : ''}${delta})`);
  };
  compare('Pages crawled', today.total_pages, yesterdayRow.total_pages, false);
  compare('Total open issues', today.total_issues_open, yesterdayRow.total_issues_open, true);
  compare('Critical issues', today.critical_count, yesterdayRow.critical_count, true);
  compare('Warning issues', today.warning_count, yesterdayRow.warning_count, true);
  compare('Schema coverage %', today.schema_coverage_pct, yesterdayRow.schema_coverage_pct, false);
  compare('Alt-text coverage %', today.alt_coverage_pct, yesterdayRow.alt_coverage_pct, false);
  compare('Avg load time (ms)', today.avg_load_time_ms, yesterdayRow.avg_load_time_ms, true);
  compare('Keywords in top 10', today.keywords_top10, yesterdayRow.keywords_top10, false);
  compare('Keywords in top 30', today.keywords_top30, yesterdayRow.keywords_top30, false);
  return diffs;
}

export async function runDailySeoCron(): Promise<{
  ok: boolean;
  crawled: number;
  issues_added: number;
  cost_usd: number;
  snapshot: DailySnapshot;
  diff_vs_yesterday: string[];
  errors: string[];
}> {
  const errors: string[] = [];
  const sitemap = getSetting('seo_sitemap_url') || DEFAULT_SITEMAP;

  // 1. Discover URLs
  let urls = await discoverFromSitemap(sitemap);
  if (urls.length === 0) {
    urls = FALLBACK_URLS;
    errors.push('sitemap empty/unreachable, using fallback URLs');
  }
  console.log(`[seo-cron] crawling ${urls.length} URLs from ${sitemap}`);

  // 2. Crawl batch
  const cr = await crawlBatch(urls, 600);

  // 3. Check keyword ranks (only stale ones, respects API budget)
  let kwResult = { checked: 0, cost_usd: 0 };
  if (getSetting('serpapi_key') || (getSetting('google_cse_api_key') && getSetting('google_cse_id'))) {
    try {
      const r = await checkAllKeywords({ onlyStale: true });
      kwResult.checked = r.checked;
      kwResult.cost_usd = r.cost_usd;
    } catch (e: any) {
      errors.push('keyword check fail: ' + (e?.message || 'unknown'));
    }
  }

  // 4. Snapshot
  const snap = snapshotToday();

  // 5. Diff vs yesterday
  const diff = computeDiff();
  if (diff.length > 0) {
    console.log('[seo-cron] diff vs yesterday:');
    diff.forEach((d) => console.log('  ' + d));
  }

  // 6. Notify if critical regression
  try {
    const { notifyAll } = require('../telegram');
    if (snap.critical_count > 0 || diff.some((d) => d.includes('⚠️') && d.includes('Critical'))) {
      await notifyAll(
        `🔍 *SEO Daily Report* (${snap.date})\n` +
        `Pages: ${snap.total_pages} | Issues: ${snap.total_issues_open}\n` +
        `  🔴 Critical: ${snap.critical_count}\n` +
        `  🟡 Warnings: ${snap.warning_count}\n` +
        `Schema: ${snap.schema_coverage_pct}% | Alt: ${snap.alt_coverage_pct}%\n` +
        `Avg load: ${snap.avg_load_time_ms}ms\n` +
        `Keywords top10: ${snap.keywords_top10}/${snap.keywords_tracked}\n\n` +
        (diff.length > 0 ? '*Δ vs yesterday:*\n' + diff.slice(0, 8).join('\n') : 'No change vs yesterday'),
      );
    }
  } catch {}

  return {
    ok: true,
    crawled: cr.ok,
    issues_added: cr.total_issues_added,
    cost_usd: kwResult.cost_usd,
    snapshot: snap,
    diff_vs_yesterday: diff,
    errors,
  };
}

/** Get snapshot history (for trend chart). */
export function getSnapshotHistory(days = 30): any[] {
  const cutoff = todayStr();
  // Just get last N rows
  return db.prepare(
    `SELECT * FROM seo_daily_snapshot ORDER BY date DESC LIMIT ?`,
  ).all(days).reverse();  // chronological order
}

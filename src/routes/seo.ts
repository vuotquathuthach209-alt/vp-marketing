/**
 * SEO Admin routes — crawl, audit, schema, alt-text, keyword tracking.
 *
 * All endpoints require admin auth (mounted at /api/seo with authMiddleware).
 * Dashboard at /admin/seo/dashboard (HTML, behind same auth).
 */

import { Router } from 'express';
import { db } from '../db';
import { crawlUrl, crawlBatch, discoverFromSitemap, persistCrawlResult } from '../services/seo/crawler';
import { generateAllHotelSchemas, generateHotelSchema } from '../services/seo/schema-gen';
import { generateAltsForFootage, generateAltForUrl } from '../services/seo/alt-text';
import { checkKeywordRank, recordKeywordRank, checkAllKeywords, setManualRank, getKeywordHistory } from '../services/seo/keyword-tracker';
import { gradePage, gradeAllPages, getPageScore, persistScorecard } from '../services/seo/scorecard';
import { runDailySeoCron, getSnapshotHistory } from '../services/seo/daily-cron';

const router = Router();

/* ───────── Overview ───────── */

router.get('/overview', (_req, res) => {
  const stats = {
    total_pages: (db.prepare(`SELECT COUNT(*) AS n FROM seo_pages`).get() as any).n,
    pages_by_type: db.prepare(`SELECT page_type, COUNT(*) AS n FROM seo_pages GROUP BY page_type`).all(),
    issues_open: (db.prepare(`SELECT COUNT(*) AS n FROM seo_issues WHERE fixed = 0`).get() as any).n,
    issues_by_severity: db.prepare(`
      SELECT severity, COUNT(*) AS n FROM seo_issues WHERE fixed = 0 GROUP BY severity
    `).all(),
    issues_by_type: db.prepare(`
      SELECT type, COUNT(*) AS n FROM seo_issues WHERE fixed = 0 GROUP BY type ORDER BY n DESC LIMIT 10
    `).all(),
    schema_coverage: db.prepare(`
      SELECT
        SUM(CASE WHEN has_schema = 1 THEN 1 ELSE 0 END) AS with_schema,
        SUM(CASE WHEN has_schema = 0 THEN 1 ELSE 0 END) AS without_schema,
        COUNT(*) AS total
      FROM seo_pages
    `).get(),
    alt_coverage: db.prepare(`
      SELECT
        SUM(images_with_alt) AS with_alt,
        SUM(images_without_alt) AS without_alt,
        SUM(image_count) AS total
      FROM seo_pages
    `).get(),
    keywords_tracked: (db.prepare(`SELECT COUNT(*) AS n FROM seo_keywords`).get() as any).n,
    schemas_generated: (db.prepare(`SELECT COUNT(*) AS n FROM seo_schemas`).get() as any).n,
    alt_suggestions_pending: (db.prepare(`SELECT COUNT(*) AS n FROM seo_image_alt WHERE status = 'pending'`).get() as any).n,
  };
  res.json({ ok: true, summary: stats });
});

/* ───────── Pages ───────── */

router.get('/pages', (req, res) => {
  const pageType = (req.query.type as string) || null;
  const limit = Math.min(parseInt(String(req.query.limit || '100'), 10), 500);
  let sql = `SELECT p.*, (SELECT COUNT(*) FROM seo_issues si WHERE si.page_id = p.id AND si.fixed = 0) AS open_issues
             FROM seo_pages p`;
  const params: any[] = [];
  if (pageType) { sql += ` WHERE p.page_type = ?`; params.push(pageType); }
  sql += ` ORDER BY p.last_crawled_at DESC LIMIT ?`;
  params.push(limit);
  res.json({ items: db.prepare(sql).all(...params) });
});

router.get('/pages/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const page = db.prepare(`SELECT * FROM seo_pages WHERE id = ?`).get(id);
  if (!page) return res.status(404).json({ error: 'page not found' });
  const issues = db.prepare(`SELECT * FROM seo_issues WHERE page_id = ? ORDER BY severity, created_at DESC`).all(id);
  res.json({ page, issues });
});

/* ───────── Crawl ───────── */

router.post('/crawl/url', async (req, res) => {
  const url = (req.body?.url || '').trim();
  if (!url) return res.status(400).json({ error: 'url required' });
  try {
    const r = await crawlUrl(url);
    const p = persistCrawlResult(r);
    res.json({ ok: r.ok, status: r.status, load_time_ms: r.load_time_ms, page_id: p.page_id, issues_found: r.issues.length });
  } catch (e: any) { res.status(500).json({ error: e?.message }); }
});

router.post('/crawl/sitemap', async (req, res) => {
  const sitemap = (req.body?.sitemap || 'https://sondervn.com/sitemap.xml').trim();
  try {
    const urls = await discoverFromSitemap(sitemap);
    if (urls.length === 0) return res.json({ ok: false, error: 'no URLs found in sitemap' });
    // Don't block — kick off async crawl
    crawlBatch(urls, 600).then((r) => {
      console.log(`[seo-crawl] batch done:`, r);
    }).catch((e) => console.warn('[seo-crawl] batch err:', e?.message));
    res.json({ ok: true, discovered: urls.length, message: 'crawling in background — refresh dashboard in 5-10 min' });
  } catch (e: any) { res.status(500).json({ error: e?.message }); }
});

/* ───────── Issues ───────── */

router.get('/issues', (req, res) => {
  const severity = (req.query.severity as string) || null;
  const type = (req.query.type as string) || null;
  const showFixed = req.query.fixed === 'true';
  let sql = `SELECT si.*, sp.url, sp.title FROM seo_issues si JOIN seo_pages sp ON sp.id = si.page_id WHERE 1=1`;
  const params: any[] = [];
  if (!showFixed) sql += ` AND si.fixed = 0`;
  if (severity) { sql += ` AND si.severity = ?`; params.push(severity); }
  if (type) { sql += ` AND si.type = ?`; params.push(type); }
  sql += ` ORDER BY CASE si.severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, si.created_at DESC LIMIT 200`;
  res.json({ items: db.prepare(sql).all(...params) });
});

router.post('/issues/:id/fix', (req, res) => {
  const r = db.prepare(`UPDATE seo_issues SET fixed = 1, fixed_at = ? WHERE id = ?`).run(Date.now(), req.params.id);
  res.json({ ok: r.changes > 0 });
});

/* ───────── Schema gen ───────── */

router.post('/schemas/generate-all', (_req, res) => {
  try {
    const r = generateAllHotelSchemas();
    res.json({ ok: true, ...r });
  } catch (e: any) { res.status(500).json({ error: e?.message }); }
});

router.get('/schemas', (req, res) => {
  const hotelId = req.query.hotel_id ? parseInt(String(req.query.hotel_id), 10) : null;
  let sql = `SELECT s.*, hp.name_canonical AS hotel_name
             FROM seo_schemas s LEFT JOIN hotel_profile hp ON hp.hotel_id = s.hotel_id`;
  const params: any[] = [];
  if (hotelId) { sql += ` WHERE s.hotel_id = ?`; params.push(hotelId); }
  sql += ` ORDER BY s.generated_at DESC`;
  res.json({ items: db.prepare(sql).all(...params) });
});

router.get('/schemas/:id', (req, res) => {
  const s = db.prepare(`SELECT * FROM seo_schemas WHERE id = ?`).get(req.params.id);
  if (!s) return res.status(404).json({ error: 'schema not found' });
  res.json(s);
});

/* ───────── Alt-text ───────── */

router.post('/alt-text/footage', async (req, res) => {
  const limit = Math.min(parseInt(String(req.body?.limit || '20'), 10), 100);
  try {
    const r = await generateAltsForFootage({ limit });
    res.json({ ok: true, ...r });
  } catch (e: any) { res.status(500).json({ error: e?.message }); }
});

router.post('/alt-text/url', async (req, res) => {
  const imageUrl = (req.body?.image_url || '').trim();
  const pageUrl = (req.body?.page_url || '').trim() || undefined;
  if (!imageUrl) return res.status(400).json({ error: 'image_url required' });
  try {
    const r = await generateAltForUrl(imageUrl, pageUrl);
    res.json(r);
  } catch (e: any) { res.status(500).json({ error: e?.message }); }
});

router.get('/alt-text', (req, res) => {
  const status = (req.query.status as string) || 'pending';
  const items = db.prepare(
    `SELECT * FROM seo_image_alt WHERE status = ? ORDER BY created_at DESC LIMIT 200`,
  ).all(status);
  res.json({ items });
});

router.post('/alt-text/:id/apply', (req, res) => {
  db.prepare(`UPDATE seo_image_alt SET status = 'applied', applied_at = ? WHERE id = ?`).run(Date.now(), req.params.id);
  res.json({ ok: true });
});

router.post('/alt-text/:id/skip', (req, res) => {
  db.prepare(`UPDATE seo_image_alt SET status = 'skipped' WHERE id = ?`).run(req.params.id);
  res.json({ ok: true });
});

/* ───────── Keywords ───────── */

router.get('/keywords', (_req, res) => {
  const items = db.prepare(`SELECT * FROM seo_keywords ORDER BY current_rank ASC NULLS LAST, keyword ASC`).all();
  res.json({ items });
});

router.post('/keywords', (req, res) => {
  const { keyword, target_url, category, search_volume } = req.body || {};
  if (!keyword) return res.status(400).json({ error: 'keyword required' });
  try {
    db.prepare(
      `INSERT OR REPLACE INTO seo_keywords (keyword, target_url, category, search_volume, current_rank, prev_rank, last_checked_at, created_at)
       VALUES (?, ?, ?, ?, NULL, NULL, NULL, ?)`,
    ).run(String(keyword).trim().toLowerCase(), target_url || null, category || null, search_volume || 0, Date.now());
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e?.message }); }
});

router.delete('/keywords/:id', (req, res) => {
  db.prepare(`DELETE FROM seo_keyword_history WHERE keyword_id = ?`).run(req.params.id);
  db.prepare(`DELETE FROM seo_keywords WHERE id = ?`).run(req.params.id);
  res.json({ ok: true });
});

/** Check rank for ONE keyword (uses CSE or SerpAPI). */
router.post('/keywords/:id/check', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const kw = db.prepare(`SELECT * FROM seo_keywords WHERE id = ?`).get(id) as any;
  if (!kw) return res.status(404).json({ error: 'keyword not found' });
  if (!kw.target_url) return res.status(400).json({ error: 'target_url required for auto-check' });
  try {
    const r = await checkKeywordRank(kw.keyword, kw.target_url);
    if (!r.error) recordKeywordRank(id, r.rank);
    res.json(r);
  } catch (e: any) { res.status(500).json({ error: e?.message }); }
});

/** Batch check all keywords. Used by manual button + daily cron. */
router.post('/keywords/check-all', async (_req, res) => {
  try {
    const r = await checkAllKeywords({ onlyStale: false });
    res.json({ ok: true, ...r });
  } catch (e: any) { res.status(500).json({ error: e?.message }); }
});

/** Manual rank entry: admin types a rank they checked themselves. */
router.post('/keywords/:id/manual-rank', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const rank = req.body?.rank;
  if (rank !== null && (typeof rank !== 'number' || rank < 1 || rank > 100)) {
    return res.status(400).json({ error: 'rank must be 1-100 or null' });
  }
  setManualRank(id, rank);
  res.json({ ok: true });
});

/** Rank history for sparkline. */
router.get('/keywords/:id/history', (req, res) => {
  const limit = Math.min(parseInt(String(req.query.limit || '30'), 10), 100);
  res.json({ items: getKeywordHistory(parseInt(req.params.id, 10), limit) });
});

/** Save google_cse_id (and optionally api key + serpapi_key) without leaving Keywords tab. */
router.post('/keyword-config', (req, res) => {
  const { setSetting } = require('../db');
  const { google_cse_id, google_cse_api_key, serpapi_key } = req.body || {};
  if (google_cse_id !== undefined) setSetting('google_cse_id', String(google_cse_id).trim());
  if (google_cse_api_key) setSetting('google_cse_api_key', String(google_cse_api_key).trim());
  if (serpapi_key) setSetting('serpapi_key', String(serpapi_key).trim());
  res.json({ ok: true });
});

/** Test connection to whichever provider is configured by fetching rank for keyword "sondervn". */
router.post('/keyword-config/test', async (_req, res) => {
  try {
    const r = await checkKeywordRank('sondervn', 'https://sondervn.com');
    res.json(r);
  } catch (e: any) { res.status(500).json({ error: e?.message }); }
});

/** Seed 42 curated Sondervn keywords (branded + long-tail + medium-tail + head terms). Idempotent. */
router.post('/keywords/seed-sondervn', (_req, res) => {
  try {
    const { seedSondervnKeywords } = require('../services/seo/seed-keywords');
    const r = seedSondervnKeywords();
    res.json({ ok: true, ...r });
  } catch (e: any) { res.status(500).json({ error: e?.message }); }
});

/** Bulk insert keywords from JSON array (admin paste / CSV import). */
router.post('/keywords/bulk', (req, res) => {
  const items = Array.isArray(req.body?.items) ? req.body.items : null;
  if (!items) return res.status(400).json({ error: 'items array required' });
  try {
    const { bulkInsertKeywords } = require('../services/seo/seed-keywords');
    const r = bulkInsertKeywords(items);
    res.json({ ok: true, ...r });
  } catch (e: any) { res.status(500).json({ error: e?.message }); }
});

/** Tell dashboard which auto-check provider is configured. */
router.get('/keyword-config', (_req, res) => {
  const { getSetting } = require('../db');
  const hasCSE = !!(getSetting('google_cse_api_key') || getSetting('google_api_key')) && !!getSetting('google_cse_id');
  const hasSerpAPI = !!getSetting('serpapi_key');
  let configured = 'Manual only';
  if (hasSerpAPI) configured = '✅ SerpAPI ($50/mo for 5000 queries, full SERP)';
  else if (hasCSE) configured = '✅ Google Custom Search (100 free/day, $5/1000 above)';
  res.json({ configured, has_cse: hasCSE, has_serpapi: hasSerpAPI });
});

/* ───────── SEO Article Writer ───────── */

router.post('/articles/generate', async (req, res) => {
  const { keyword_target, angle, hotel_id, language, target_word_count } = req.body || {};
  if (!keyword_target) return res.status(400).json({ error: 'keyword_target required' });
  try {
    const { generateArticle, saveArticle } = require('../services/seo/article-writer');
    const draft = await generateArticle({
      keyword_target,
      angle,
      hotel_id: hotel_id ? parseInt(hotel_id, 10) : null,
      language: language || 'vi',
      target_word_count: target_word_count ? parseInt(target_word_count, 10) : 1800,
    });
    if (!draft) return res.status(500).json({ error: 'generation failed (LLM returned invalid JSON)' });
    const id = saveArticle(draft, { hotel_id, angle });
    res.json({ ok: true, id, draft });
  } catch (e: any) { res.status(500).json({ error: e?.message }); }
});

router.get('/articles', (req, res) => {
  const { listArticles } = require('../services/seo/article-writer');
  res.json({ items: listArticles({
    status: req.query.status as any,
    limit: req.query.limit ? parseInt(String(req.query.limit), 10) : undefined,
  }) });
});

router.get('/articles/:id', (req, res) => {
  const { getArticle } = require('../services/seo/article-writer');
  const a = getArticle(parseInt(req.params.id, 10));
  if (!a) return res.status(404).json({ error: 'not found' });
  res.json(a);
});

router.post('/articles/:id/approve', (req, res) => {
  const { approveArticle } = require('../services/seo/article-writer');
  const ok = approveArticle(parseInt(req.params.id, 10));
  res.json({ ok });
});

router.post('/articles/:id/mark-published', (req, res) => {
  const { markPublished } = require('../services/seo/article-writer');
  const url = (req.body?.url || '').trim();
  if (!url) return res.status(400).json({ error: 'url required' });
  const ok = markPublished(parseInt(req.params.id, 10), url);
  res.json({ ok });
});

router.delete('/articles/:id', (req, res) => {
  const { deleteArticle } = require('../services/seo/article-writer');
  const ok = deleteArticle(parseInt(req.params.id, 10));
  res.json({ ok });
});

router.get('/articles-suggest-topics', (_req, res) => {
  const { suggestTopics } = require('../services/seo/article-writer');
  res.json({ items: suggestTopics({ limit: 15 }) });
});

router.get('/articles/:id/copy', (req, res) => {
  const { getArticle } = require('../services/seo/article-writer');
  const a = getArticle(parseInt(req.params.id, 10));
  if (!a) return res.status(404).json({ error: 'not found' });
  // Render the full Markdown package admin can paste into sondervn.com CMS
  const fullMd = `---
title: ${a.title}
slug: ${a.slug}
meta_description: ${a.meta_description}
---

# ${a.h1}

${a.body_md}

## FAQ

${(a.faq || []).map((f: any) => `**${f.question}**\n\n${f.answer}\n`).join('\n')}

---

## SEO Schema (paste vào <head>)

\`\`\`html
<script type="application/ld+json">${JSON.stringify(a.article_schema, null, 2)}</script>
${a.faq_schema ? '<script type="application/ld+json">' + JSON.stringify(a.faq_schema, null, 2) + '</script>' : ''}
\`\`\`
`;
  res.json({
    markdown: fullMd,
    html: a.body_html,
    article_schema: a.article_schema,
    faq_schema: a.faq_schema,
  });
});

/* ───────── Scorecard (Phase C) ───────── */

router.get('/scorecard/:page_id', (req, res) => {
  const id = parseInt(req.params.page_id, 10);
  const r = getPageScore(id);
  if (!r) return res.status(404).json({ error: 'page not found' });
  res.json(r);
});

router.post('/scorecard/grade-all', (_req, res) => {
  try {
    const r = gradeAllPages();
    res.json({ ok: true, ...r });
  } catch (e: any) { res.status(500).json({ error: e?.message }); }
});

/* ───────── Daily cron manual trigger + snapshot history (Phase A) ───────── */

router.post('/cron/run-now', async (_req, res) => {
  try {
    const r = await runDailySeoCron();
    res.json(r);
  } catch (e: any) { res.status(500).json({ error: e?.message }); }
});

router.get('/snapshots', (req, res) => {
  const days = Math.min(parseInt(String(req.query.days || '30'), 10), 90);
  res.json({ items: getSnapshotHistory(days) });
});

/* ───────── Dashboard HTML ───────── */

router.get('/dashboard', (_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html>
<html lang="vi">
<head>
<meta charset="utf-8"><title>SEO Dashboard — Sonder</title>
<style>
  body{font-family:-apple-system,'Segoe UI',sans-serif;max-width:1400px;margin:24px auto;padding:0 20px;color:#333;background:#fafaf7}
  h1{font-weight:300;color:#3b3a30;margin:0 0 8px}
  h2{font-weight:400;color:#5a4f3a;margin-top:32px;border-bottom:1px solid #d0c8b0;padding-bottom:6px}
  h3{font-weight:500;color:#6a5f4a;margin:16px 0 8px}
  .meta{color:#888;font-size:13px;margin-bottom:20px}
  .stats{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:12px;margin:16px 0}
  .stat{background:#fff;border:1px solid #e0d8c0;border-radius:8px;padding:14px}
  .stat .num{font-size:28px;font-weight:300;color:#3b3a30}
  .stat .lbl{font-size:12px;color:#888;text-transform:uppercase;letter-spacing:0.05em}
  .stat-critical .num{color:#c43}
  .stat-warning .num{color:#a86b3c}
  .stat-info .num{color:#5a7a9a}
  table{border-collapse:collapse;width:100%;background:#fff;border-radius:6px;overflow:hidden;margin:10px 0}
  th,td{padding:8px 12px;text-align:left;border-bottom:1px solid #e8e0c8;font-size:13px;vertical-align:top}
  th{background:#f0e8d0;font-weight:500}
  .badge{display:inline-block;padding:2px 8px;border-radius:10px;font-size:11px}
  .b-critical{background:#fde2da;color:#c43}
  .b-warning{background:#fde8d4;color:#a86b3c}
  .b-info{background:#d4e0ec;color:#5a7a9a}
  .b-fixed{background:#d8e8d8;color:#5a8a5a}
  button{padding:6px 14px;border:1px solid #c0b890;background:#fff;border-radius:4px;cursor:pointer;font-size:13px}
  button:hover{background:#f0e8d0}
  .btn-primary{background:#3b3a30;color:#fff;border-color:#3b3a30}
  .btn-primary:hover{background:#5a4f3a}
  .actions{display:flex;flex-wrap:wrap;gap:8px;margin:12px 0}
  pre{background:#1a1a18;color:#e8e0c8;padding:14px;border-radius:6px;font-size:12px;overflow-x:auto;max-height:400px}
  input[type=text],input[type=url]{padding:6px 10px;border:1px solid #c0b890;border-radius:4px;font-size:13px;min-width:200px}
  .tabs{display:flex;border-bottom:2px solid #d0c8b0;margin:20px 0 12px}
  .tab{padding:8px 16px;cursor:pointer;border-bottom:2px solid transparent;margin-bottom:-2px}
  .tab.active{border-color:#a86b3c;color:#a86b3c;font-weight:500}
  .empty{padding:30px;text-align:center;color:#888;font-style:italic}
  .url-cell{max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
</style>
</head>
<body>
<h1>🔍 SEO Dashboard — Sonder Vietnam</h1>
<div class="meta" id="lastUpdated">Loading...</div>

<div class="actions">
  <button class="btn-primary" onclick="crawlSitemap()">🕷️ Crawl sondervn.com sitemap</button>
  <input type="url" id="crawlUrl" placeholder="https://sondervn.com/khach-san/abc" />
  <button onclick="crawlOne()">Crawl 1 URL</button>
  <button onclick="genSchemas()">🏷️ Generate hotel schemas</button>
  <button onclick="genAlts()">🖼️ Auto alt-text (20 photos)</button>
  <button onclick="gradeAll()">⭐ Grade all pages</button>
  <button onclick="runDailyCron()">📅 Run daily cron now</button>
  <button onclick="load()">🔄 Refresh</button>
</div>

<div id="content">Loading…</div>

<script>
let activeTab = 'overview';

async function load() {
  const r = await fetch('/api/seo/overview').then((r) => r.json());
  document.getElementById('lastUpdated').textContent = 'Updated: ' + new Date().toLocaleString('vi-VN');
  const s = r.summary;

  let html = '';
  html += '<h2>📊 Tổng quan</h2><div class="stats">';
  html += card('total', 'Pages crawled', s.total_pages);
  html += card('critical', '🔴 Critical issues', s.issues_by_severity?.find?.((x) => x.severity === 'critical')?.n || 0);
  html += card('warning', '🟡 Warnings', s.issues_by_severity?.find?.((x) => x.severity === 'warning')?.n || 0);
  html += card('info', 'ℹ️ Info', s.issues_by_severity?.find?.((x) => x.severity === 'info')?.n || 0);
  html += card('total', 'Schemas generated', s.schemas_generated);
  html += card('total', 'Alt-text pending', s.alt_suggestions_pending);
  html += '</div>';

  if (s.schema_coverage) {
    const sc = s.schema_coverage;
    const pct = sc.total > 0 ? Math.round((sc.with_schema / sc.total) * 100) : 0;
    html += '<h3>Schema coverage</h3>';
    html += '<div style="background:#e8e0c8;border-radius:8px;overflow:hidden;height:24px;width:300px;display:inline-block;">';
    html += '<div style="background:#5a8a5a;height:100%;width:' + pct + '%"></div>';
    html += '</div>';
    html += ' <strong>' + pct + '%</strong> (' + sc.with_schema + '/' + sc.total + ' pages)';
  }

  if (s.alt_coverage) {
    const ac = s.alt_coverage;
    const pct = ac.total > 0 ? Math.round((ac.with_alt / ac.total) * 100) : 0;
    html += '<h3>Image alt-text coverage</h3>';
    html += '<div style="background:#e8e0c8;border-radius:8px;overflow:hidden;height:24px;width:300px;display:inline-block;">';
    html += '<div style="background:#a86b3c;height:100%;width:' + pct + '%"></div>';
    html += '</div>';
    html += ' <strong>' + pct + '%</strong> (' + ac.with_alt + '/' + ac.total + ' images)';
  }

  // Tabs
  html += '<div class="tabs">';
  for (const t of ['articles', 'issues', 'pages', 'schemas', 'alts', 'keywords']) {
    html += '<div class="tab ' + (activeTab === t ? 'active' : '') + '" onclick="switchTab(\\'' + t + '\\')">' + tabLabel(t) + '</div>';
  }
  html += '</div>';

  html += '<div id="tabContent">Loading tab…</div>';

  document.getElementById('content').innerHTML = html;
  await loadTab(activeTab);
}

function tabLabel(t) {
  return { articles: '📝 Articles (Write for web)', issues: '🔴 Issues', pages: '📄 Pages', schemas: '🏷️ Schemas', alts: '🖼️ Alt-text', keywords: '🔑 Keywords' }[t] || t;
}

function card(slug, label, num) {
  return '<div class="stat stat-' + slug + '"><div class="num">' + num + '</div><div class="lbl">' + label + '</div></div>';
}

async function switchTab(t) { activeTab = t; await load(); }

async function loadTab(t) {
  const wrap = document.getElementById('tabContent');

  if (t === 'articles') {
    const r = await fetch('/api/seo/articles?limit=50').then((x) => x.json());
    const topics = await fetch('/api/seo/articles-suggest-topics').then((x) => x.json());

    let h = '<h3>✍️ Write a new SEO article</h3>';
    h += '<div style="background:#fff;border:1px solid #e0d8c0;border-radius:6px;padding:14px;margin:8px 0">';
    h += '<div style="display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin-bottom:8px">';
    h += '<input type="text" id="artKw" placeholder="Keyword target (e.g., khách sạn Q1 Sài Gòn)" style="flex:1;min-width:300px" />';
    h += '<select id="artAngle"><option value="destination_guide">🗺️ Destination guide</option><option value="hotel_comparison">⭐ Hotel comparison</option><option value="travel_tips">💡 Travel tips</option><option value="local_insider">🌃 Local insider</option><option value="how_to">📋 How-to</option><option value="list_post">🔢 Listicle</option><option value="seasonal">🍂 Seasonal</option><option value="news_local">📰 News local</option></select>';
    h += '<input type="number" id="artWords" placeholder="Words (default 1800)" style="width:120px" />';
    h += '<button class="btn-primary" onclick="generateArticle()">Generate Article ($0.01-0.03)</button>';
    h += '</div>';

    if (topics.items && topics.items.length > 0) {
      h += '<div style="font-size:12px;color:#666;margin-top:8px"><strong>💡 Suggested topics:</strong> ';
      h += topics.items.slice(0, 5).map(function (t) {
        return '<a href="#" onclick="document.getElementById(\\'artKw\\').value=\\'' + escapeAttr(t.keyword) + '\\';return false" style="margin:0 6px;color:#a86b3c">"' + escapeHtml(t.keyword) + '"</a>';
      }).join(' | ');
      h += '</div>';
    }
    h += '</div>';

    h += '<h3>📚 Article library</h3>';
    if (r.items.length === 0) {
      h += '<div class="empty">Chưa có bài. Generate 1 bài ở form trên.</div>';
    } else {
      h += '<table><thead><tr><th>Title</th><th>Keyword</th><th>Words</th><th>Status</th><th>Created</th><th>Actions</th></tr></thead><tbody>';
      for (const a of r.items) {
        const statusBadge = a.status === 'published' ? '<span class="badge b-safe">published</span>'
          : a.status === 'reviewed' ? '<span class="badge b-info">reviewed</span>'
          : a.status === 'rejected' ? '<span class="badge b-critical">rejected</span>'
          : '<span class="badge b-warning">draft</span>';
        h += '<tr><td><strong>' + escapeHtml((a.title || '').slice(0, 60)) + '</strong>';
        if (a.published_url) h += '<br><a href="' + escapeAttr(a.published_url) + '" target="_blank" style="font-size:11px">' + escapeHtml(a.published_url.slice(0, 50)) + '</a>';
        h += '</td>';
        h += '<td style="font-size:11px">' + escapeHtml(a.keyword_target || '—') + '</td>';
        h += '<td>' + a.word_count + '</td>';
        h += '<td>' + statusBadge + '</td>';
        h += '<td style="font-size:11px">' + new Date(a.created_at).toLocaleDateString('vi-VN') + '</td>';
        h += '<td>';
        h += '<button onclick="viewArticle(' + a.id + ')">👀 View</button> ';
        if (a.status === 'draft') h += '<button onclick="approveArt(' + a.id + ')">✓ Approve</button> ';
        if (a.status !== 'published') h += '<button onclick="markPub(' + a.id + ')">🚀 Mark published</button> ';
        h += '<button onclick="copyArt(' + a.id + ')">📋 Copy</button> ';
        h += '<button onclick="delArt(' + a.id + ')">🗑️</button>';
        h += '</td></tr>';
      }
      h += '</tbody></table>';
    }

    h += '<div id="articleView" style="margin-top:20px"></div>';
    wrap.innerHTML = h;
    return;
  }

  if (t === 'issues') {
    const r = await fetch('/api/seo/issues').then((x) => x.json());
    if (r.items.length === 0) return wrap.innerHTML = '<div class="empty">No open issues 🎉</div>';
    let h = '<table><thead><tr><th>Severity</th><th>Type</th><th>Page</th><th>Message</th><th>Recommendation</th><th></th></tr></thead><tbody>';
    for (const i of r.items) {
      h += '<tr><td><span class="badge b-' + i.severity + '">' + i.severity + '</span></td>';
      h += '<td><code>' + i.type + '</code></td>';
      h += '<td class="url-cell" title="' + escapeAttr(i.url) + '">' + escapeHtml((i.title || i.url).slice(0, 70)) + '</td>';
      h += '<td>' + escapeHtml(i.message) + '</td>';
      h += '<td>' + escapeHtml(i.recommendation) + '</td>';
      h += '<td><button onclick="fixIssue(' + i.id + ')">✓ Fixed</button></td></tr>';
    }
    h += '</tbody></table>';
    wrap.innerHTML = h;
    return;
  }
  if (t === 'pages') {
    const r = await fetch('/api/seo/pages?limit=100').then((x) => x.json());
    if (r.items.length === 0) return wrap.innerHTML = '<div class="empty">No pages crawled. Bấm "Crawl sitemap" ở trên.</div>';
    let h = '<table><thead><tr><th>URL</th><th>Type</th><th>Title</th><th>Words</th><th>Schema</th><th>Issues</th><th>Score</th><th></th></tr></thead><tbody>';
    for (const p of r.items) {
      h += '<tr><td class="url-cell"><a href="' + escapeAttr(p.url) + '" target="_blank">' + escapeHtml(p.url.slice(0, 60)) + '</a></td>';
      h += '<td>' + p.page_type + '</td>';
      h += '<td>' + escapeHtml((p.title || '—').slice(0, 50)) + '</td>';
      h += '<td>' + p.word_count + '</td>';
      h += '<td>' + (p.has_schema ? '✅' : '❌') + '</td>';
      h += '<td>' + (p.open_issues > 0 ? '<span class="badge b-warning">' + p.open_issues + '</span>' : '0') + '</td>';
      h += '<td><span id="score-' + p.id + '">…</span></td>';
      h += '<td><button onclick="showScore(' + p.id + ')">📊</button></td></tr>';
    }
    h += '</tbody></table>';
    h += '<div id="scoreView"></div>';
    wrap.innerHTML = h;
    // Load scores async
    for (const p of r.items) loadScoreCell(p.id);
    return;
  }
  if (t === 'schemas') {
    const r = await fetch('/api/seo/schemas').then((x) => x.json());
    if (r.items.length === 0) return wrap.innerHTML = '<div class="empty">No schemas. Bấm "Generate hotel schemas" ở trên.</div>';
    let h = '<table><thead><tr><th>Hotel</th><th>Type</th><th>URL</th><th>JSON</th></tr></thead><tbody>';
    for (const s of r.items) {
      const safe = s.id;
      h += '<tr><td>' + escapeHtml(s.hotel_name || ('#' + s.hotel_id)) + '</td>';
      h += '<td><span class="badge b-info">' + s.schema_type + '</span></td>';
      h += '<td class="url-cell">' + escapeHtml(s.applied_to_url || '—') + '</td>';
      h += '<td><button onclick="showSchema(' + safe + ')">📋 View</button></td></tr>';
    }
    h += '</tbody></table>';
    h += '<div id="schemaView"></div>';
    wrap.innerHTML = h;
    return;
  }
  if (t === 'alts') {
    const r = await fetch('/api/seo/alt-text?status=pending').then((x) => x.json());
    if (r.items.length === 0) return wrap.innerHTML = '<div class="empty">No alt-text suggestions. Bấm "Auto alt-text" ở trên.</div>';
    let h = '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:12px">';
    for (const a of r.items) {
      const img = a.image_url.startsWith('http') ? a.image_url : ('/v5t-footage/' + a.image_url.split('/').pop());
      h += '<div style="background:#fff;border:1px solid #e0d8c0;border-radius:6px;padding:10px">';
      h += '<img src="' + escapeAttr(img) + '" style="width:100%;height:120px;object-fit:cover;border-radius:4px;background:#eee" loading="lazy"/>';
      h += '<div style="font-size:12px;margin-top:6px"><strong>VI:</strong> ' + escapeHtml(a.suggested_alt_vi || '—') + '</div>';
      h += '<div style="font-size:12px;color:#666;margin-top:4px"><strong>EN:</strong> ' + escapeHtml(a.suggested_alt_en || '—') + '</div>';
      h += '<div style="margin-top:8px;display:flex;gap:6px">';
      h += '<button onclick="applyAlt(' + a.id + ')">✅ Apply</button>';
      h += '<button onclick="skipAlt(' + a.id + ')">⏭️ Skip</button>';
      h += '</div></div>';
    }
    h += '</div>';
    wrap.innerHTML = h;
    return;
  }
  if (t === 'keywords') {
    const r = await fetch('/api/seo/keywords').then((x) => x.json());
    const cfg = await fetch('/api/seo/keyword-config').then((x) => x.json());

    let h = '';

    // Inline CSE/SerpAPI config (collapsed if configured)
    if (!cfg.has_cse && !cfg.has_serpapi) {
      h += '<div style="background:#fff3e0;border:2px solid #ffb74d;border-radius:8px;padding:14px;margin-bottom:14px">';
      h += '<div style="font-weight:bold;margin-bottom:6px">⚠️ Auto rank-check chưa sẵn sàng</div>';
      h += '<div style="font-size:13px;color:#444;margin-bottom:10px">Cần 1 trong 2 provider để daily cron tự check rank trên Google. Khuyến nghị <strong>Google CSE</strong> (100 free query/day, đủ cho 30-50 keyword check 1 lần/ngày).</div>';
      h += '<div style="font-size:13px;margin-bottom:8px"><strong>Bước 1:</strong> Tạo CSE engine tại <a href="https://programmablesearchengine.google.com" target="_blank">programmablesearchengine.google.com</a> → "Search the entire web" → copy "Search engine ID"</div>';
      h += '<div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-top:10px">';
      h += '<input type="text" id="cseId" placeholder="Paste Google CSE ID (e.g., 017xxx:yyy)" style="flex:1;min-width:300px" />';
      h += '<button class="btn-primary" onclick="saveCseId()">💾 Save CSE ID</button>';
      h += '<button onclick="testConnection()">🧪 Test connection</button>';
      h += '</div>';
      h += '<div style="font-size:11px;color:#888;margin-top:6px">API key (google_api_key) đã có sẵn từ Settings. Chỉ cần CSE ID.</div>';
      h += '</div>';
    }

    h += '<div class="actions">';
    h += '<input type="text" id="kw" placeholder="Keyword (e.g. khách sạn Q1 Sài Gòn)" />';
    h += '<input type="url" id="kwUrl" placeholder="Target URL" />';
    h += '<button class="btn-primary" onclick="addKeyword()">Add keyword</button>';
    if (r.items.length === 0) h += '<button onclick="seedSondervn()" style="background:#a86b3c;color:white">🌱 Seed 42 Sondervn keywords (1 click)</button>';
    if (r.items.length > 0) h += '<button onclick="checkAllRanks()">🔄 Check all ranks now</button>';
    h += '</div>';
    h += '<div style="font-size:12px;color:#666;margin:8px 0">Configured: ' + cfg.configured + '</div>';
    if (r.items.length === 0) {
      h += '<div class="empty">';
      h += '<strong>Chưa có keyword tracking.</strong><br><br>';
      h += '👉 <strong>Click "🌱 Seed 42 Sondervn keywords"</strong> ở trên để bulk-insert curated list:<br><br>';
      h += '<div style="display:inline-block;text-align:left;background:#fff;padding:12px;border-radius:6px;border:1px solid #e0d8c0;font-size:13px">';
      h += '• 8 BRANDED (sondervn, sonder vn, sonder apartment...)<br>';
      h += '• 16 LONG-TAIL cụ thể (khách sạn Q1 dưới 500k, homestay Cô Giang...) — target top 10 trong 2-5 tháng<br>';
      h += '• 12 MEDIUM-TAIL (khách sạn Q1 giá rẻ, homestay Đà Lạt...) — 6-12 tháng<br>';
      h += '• 6 HEAD TERMS (khách sạn Sài Gòn...) — chỉ track baseline';
      h += '</div><br><br>';
      h += '<em style="color:#888;font-size:12px">Hoặc thêm từng keyword thủ công ở form phía trên.</em>';
      h += '</div>';
    } else {
      h += '<table><thead><tr><th>Keyword</th><th>Target URL</th><th>Rank</th><th>Δ</th><th>Trend (last 10)</th><th>Last checked</th><th>Actions</th></tr></thead><tbody>';
      for (const k of r.items) {
        const change = (k.prev_rank !== null && k.current_rank !== null) ? (k.prev_rank - k.current_rank) : null;
        const changeHtml = change === null ? '—'
          : change > 0 ? '<span style="color:#5a8a5a">▲ ' + change + '</span>'
          : change < 0 ? '<span style="color:#c43">▼ ' + Math.abs(change) + '</span>'
          : '<span style="color:#888">—</span>';
        const lastCheck = k.last_checked_at ? new Date(k.last_checked_at).toLocaleDateString('vi-VN') : 'never';
        h += '<tr><td><strong>' + escapeHtml(k.keyword) + '</strong>'
           + (k.category ? '<br><span class="badge b-info">' + k.category + '</span>' : '') + '</td>';
        h += '<td class="url-cell" title="' + escapeAttr(k.target_url || '') + '">' + escapeHtml((k.target_url || '—').slice(0, 50)) + '</td>';
        h += '<td><strong style="font-size:18px;color:' + (k.current_rank && k.current_rank <= 10 ? '#5a8a5a' : k.current_rank && k.current_rank <= 30 ? '#a86b3c' : '#888') + '">' + (k.current_rank ? '#' + k.current_rank : '—') + '</strong></td>';
        h += '<td>' + changeHtml + '</td>';
        h += '<td><span id="spark-' + k.id + '" style="font-family:monospace;font-size:11px;color:#5a7a9a">…</span></td>';
        h += '<td style="font-size:11px;color:#888">' + lastCheck + '</td>';
        h += '<td>';
        h += '<button onclick="checkOneRank(' + k.id + ')" title="Auto-check via API">🔄</button> ';
        h += '<button onclick="manualRank(' + k.id + ')" title="Type rank manually">✏️</button> ';
        h += '<button onclick="delKeyword(' + k.id + ')">🗑️</button>';
        h += '</td></tr>';
      }
      h += '</tbody></table>';
    }
    wrap.innerHTML = h;
    // Load sparklines async
    for (const k of r.items) loadSparkline(k.id);
    return;
  }
}

function escapeHtml(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function escapeAttr(s) { return escapeHtml(s); }

async function crawlSitemap() {
  if (!confirm('Crawl sondervn.com sitemap? (may take 5-10 minutes for 100+ pages)')) return;
  const r = await fetch('/api/seo/crawl/sitemap', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).then((x) => x.json());
  alert(JSON.stringify(r, null, 2));
  setTimeout(load, 2000);
}
async function crawlOne() {
  const url = document.getElementById('crawlUrl').value.trim();
  if (!url) return alert('Enter URL');
  const r = await fetch('/api/seo/crawl/url', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }) }).then((x) => x.json());
  alert(JSON.stringify(r, null, 2));
  load();
}
async function genSchemas() {
  const r = await fetch('/api/seo/schemas/generate-all', { method: 'POST' }).then((x) => x.json());
  alert('Generated ' + r.generated + ' schemas (skipped ' + r.skipped + ')');
  load();
}
async function genAlts() {
  if (!confirm('Generate alt-text for 20 footage photos via Gemini Vision? (~$0.002)')) return;
  const r = await fetch('/api/seo/alt-text/footage', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ limit: 20 }) }).then((x) => x.json());
  alert(JSON.stringify(r, null, 2));
  load();
}
async function fixIssue(id) { await fetch('/api/seo/issues/' + id + '/fix', { method: 'POST' }); loadTab(activeTab); }
async function applyAlt(id) { await fetch('/api/seo/alt-text/' + id + '/apply', { method: 'POST' }); loadTab(activeTab); }
async function skipAlt(id) { await fetch('/api/seo/alt-text/' + id + '/skip', { method: 'POST' }); loadTab(activeTab); }
async function showSchema(id) {
  const s = await fetch('/api/seo/schemas/' + id).then((x) => x.json());
  document.getElementById('schemaView').innerHTML = '<h3>Schema: ' + escapeHtml(s.schema_type) + '</h3><pre>' + escapeHtml(s.schema_json) + '</pre>';
}
async function addKeyword() {
  const keyword = document.getElementById('kw').value.trim();
  const target_url = document.getElementById('kwUrl').value.trim();
  if (!keyword) return alert('Enter keyword');
  await fetch('/api/seo/keywords', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ keyword, target_url }) });
  loadTab('keywords');
}

async function seedSondervn() {
  if (!confirm('Seed 42 curated Sondervn keywords?\\n\\n• 8 branded (sondervn, sonder apartment...)\\n• 16 long-tail (khách sạn Q1 dưới 500k...)\\n• 12 medium-tail (khách sạn Q1 giá rẻ...)\\n• 6 head terms (khách sạn Sài Gòn...)\\n\\nIdempotent — chạy lại không tạo trùng.')) return;
  const r = await fetch('/api/seo/keywords/seed-sondervn', { method: 'POST' }).then((x) => x.json());
  if (r.error) return alert('Error: ' + r.error);
  alert('✅ Seeded!\\n\\nInserted: ' + r.inserted + '\\nSkipped (đã tồn tại): ' + r.skipped + '\\nTotal: ' + r.total + '\\n\\nTip: configure Google CSE / SerpAPI trong Settings để auto-check rank hằng ngày (3:30 AM VN).');
  loadTab('keywords');
}

async function saveCseId() {
  const id = document.getElementById('cseId').value.trim();
  if (!id) return alert('Nhập CSE ID');
  if (!/^[\\w:-]+$/.test(id)) { if (!confirm('CSE ID có vẻ lạ. Vẫn save?')) return; }
  const r = await fetch('/api/seo/keyword-config', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ google_cse_id: id }),
  }).then((x) => x.json());
  if (r.error) return alert('Error: ' + r.error);
  alert('✅ CSE ID saved. Click 🧪 Test connection để verify.');
  loadTab('keywords');
}

async function testConnection() {
  const btn = event.target; const orig = btn.textContent;
  btn.textContent = '⏳ Testing...'; btn.disabled = true;
  try {
    const r = await fetch('/api/seo/keyword-config/test', { method: 'POST' }).then((x) => x.json());
    if (r.error) alert('❌ FAILED:\\n\\n' + r.error + '\\n\\nKiểm tra:\\n- CSE ID đã save đúng?\\n- API key có quyền Custom Search API? (Google Cloud Console → APIs & Services → enable "Custom Search API")');
    else if (r.rank) alert('✅ OK!\\n\\nKeyword "sondervn" → rank #' + r.rank + '\\nSource: ' + r.source + '\\nTotal results: ' + (r.total_results || 'n/a') + '\\nCost: $' + (r.cost_usd || 0).toFixed(4));
    else alert('⚠️ Connection OK nhưng "sondervn" không rank trong top 50.\\n\\nTotal results: ' + (r.total_results || 0) + '\\n\\n(Bình thường cho domain mới — site chưa được Google index nhiều)');
  } finally { btn.textContent = orig; btn.disabled = false; }
}
async function delKeyword(id) {
  if (!confirm('Delete?')) return;
  await fetch('/api/seo/keywords/' + id, { method: 'DELETE' });
  loadTab('keywords');
}

async function checkOneRank(id) {
  const r = await fetch('/api/seo/keywords/' + id + '/check', { method: 'POST' }).then((x) => x.json());
  if (r.error) alert('Error: ' + r.error);
  else alert('Source=' + r.source + ' Rank=' + (r.rank || 'not in top 50') + ' Cost=$' + (r.cost_usd || 0).toFixed(4));
  loadTab('keywords');
}

async function checkAllRanks() {
  if (!confirm('Auto-check all keywords now? Uses Google CSE or SerpAPI quota.')) return;
  const r = await fetch('/api/seo/keywords/check-all', { method: 'POST' }).then((x) => x.json());
  alert('Checked: ' + r.checked + '\\nErrors: ' + r.errors + '\\nSkipped: ' + r.skipped + '\\nCost: $' + (r.cost_usd || 0).toFixed(4));
  loadTab('keywords');
}

async function manualRank(id) {
  const raw = prompt('Nhập rank (1-100, để trống = không có trong top 100):', '');
  if (raw === null) return;
  const rank = raw.trim() === '' ? null : parseInt(raw, 10);
  if (rank !== null && (isNaN(rank) || rank < 1 || rank > 100)) { alert('Rank phải là số 1-100'); return; }
  await fetch('/api/seo/keywords/' + id + '/manual-rank', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rank }) });
  loadTab('keywords');
}

/* ───── Article (SEO writer) handlers ───── */

async function generateArticle() {
  const keyword_target = document.getElementById('artKw').value.trim();
  if (!keyword_target) return alert('Nhập keyword target trước (ví dụ: "khách sạn Q1 Sài Gòn giá dưới 500k")');
  const angle = document.getElementById('artAngle').value;
  const wordsRaw = document.getElementById('artWords').value.trim();
  const target_word_count = wordsRaw ? parseInt(wordsRaw, 10) : 1800;
  if (target_word_count < 600 || target_word_count > 4000) { alert('Word count: 600-4000'); return; }

  if (!confirm('Generate SEO article cho "' + keyword_target + '"?\\n\\nAngle: ' + angle + '\\nWords: ' + target_word_count + '\\nCost: ~$0.01-0.03 (Claude Sonnet)\\n\\nMất ~30-60s.')) return;

  const view = document.getElementById('articleView');
  if (view) view.innerHTML = '<div style="background:#fff3e0;border:1px solid #ffb74d;border-radius:6px;padding:14px"><strong>⏳ Đang generate...</strong> Claude đang viết bài, vui lòng đợi ~30-60s (đừng refresh)</div>';

  try {
    const r = await fetch('/api/seo/articles/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keyword_target, angle, target_word_count }),
    }).then((x) => x.json());
    if (r.error) { alert('Generate failed: ' + r.error); if (view) view.innerHTML = ''; return; }
    document.getElementById('artKw').value = '';
    document.getElementById('artWords').value = '';
    await loadTab('articles');
    viewArticle(r.id);
  } catch (e) {
    alert('Network error: ' + e.message);
  }
}

async function viewArticle(id) {
  const a = await fetch('/api/seo/articles/' + id).then((x) => x.json());
  if (a.error) return alert(a.error);
  let h = '<div style="background:#fff;border:2px solid #a86b3c;border-radius:8px;padding:20px;margin-top:14px">';
  h += '<div style="display:flex;justify-content:space-between;align-items:start;margin-bottom:10px">';
  h += '<h2 style="margin:0;flex:1">' + escapeHtml(a.title || '—') + '</h2>';
  h += '<button onclick="document.getElementById(\\'articleView\\').innerHTML=\\'\\'" style="background:#eee;border:none;border-radius:4px;padding:4px 10px;cursor:pointer">✕ Close</button>';
  h += '</div>';
  h += '<div style="font-size:12px;color:#666;margin-bottom:8px">';
  h += 'Slug: <code>' + escapeHtml(a.slug) + '</code> · ';
  h += 'Words: ' + a.word_count + ' · ';
  h += 'Keyword: <strong>' + escapeHtml(a.keyword_target || '—') + '</strong> · ';
  h += 'Status: <span class="badge b-' + (a.status === 'published' ? 'safe' : a.status === 'reviewed' ? 'info' : 'warning') + '">' + a.status + '</span>';
  h += '</div>';
  h += '<div style="background:#faf6e8;border-left:3px solid #a86b3c;padding:8px 12px;margin:10px 0;font-style:italic;color:#666">Meta: ' + escapeHtml(a.meta_description || '—') + '</div>';

  if (a.related_keywords && a.related_keywords.length > 0) {
    h += '<div style="margin:10px 0"><strong>Related keywords:</strong> ' + a.related_keywords.map((k) => '<span class="badge b-info" style="margin:2px">' + escapeHtml(k) + '</span>').join('') + '</div>';
  }
  if (a.internal_links && a.internal_links.length > 0) {
    h += '<div style="margin:10px 0"><strong>Internal link suggestions:</strong><ul style="margin:4px 0">';
    for (const l of a.internal_links) h += '<li><code>' + escapeHtml(l.url) + '</code> — anchor: "' + escapeHtml(l.anchor) + '"</li>';
    h += '</ul></div>';
  }
  if (a.image_suggestions && a.image_suggestions.length > 0) {
    h += '<div style="margin:10px 0"><strong>Image suggestions:</strong><ul style="margin:4px 0">';
    for (const s of a.image_suggestions) h += '<li>' + escapeHtml(s) + '</li>';
    h += '</ul></div>';
  }

  h += '<hr style="margin:14px 0;border:none;border-top:1px solid #e0d8c0">';
  h += '<div style="background:#fafafa;padding:14px;border-radius:6px;line-height:1.7;font-size:14px">' + (a.body_html || '<pre>' + escapeHtml(a.body_md || '') + '</pre>') + '</div>';

  if (a.faq && a.faq.length > 0) {
    h += '<hr style="margin:14px 0;border:none;border-top:1px solid #e0d8c0">';
    h += '<h3>FAQ</h3>';
    for (const f of a.faq) {
      h += '<div style="margin:8px 0"><strong>Q: ' + escapeHtml(f.question) + '</strong><br><span style="color:#444">A: ' + escapeHtml(f.answer) + '</span></div>';
    }
  }

  h += '<hr style="margin:14px 0;border:none;border-top:1px solid #e0d8c0">';
  h += '<div style="display:flex;gap:8px;flex-wrap:wrap">';
  if (a.status === 'draft') h += '<button class="btn-primary" onclick="approveArt(' + a.id + ')">✓ Approve</button>';
  if (a.status !== 'published') h += '<button onclick="markPub(' + a.id + ')">🚀 Mark published</button>';
  h += '<button onclick="copyArt(' + a.id + ')">📋 Copy full package (MD + Schema)</button>';
  h += '<button onclick="delArt(' + a.id + ')" style="background:#fee;border-color:#c54;color:#c54">🗑️ Delete</button>';
  h += '</div>';
  h += '</div>';

  document.getElementById('articleView').innerHTML = h;
  document.getElementById('articleView').scrollIntoView({ behavior: 'smooth' });
}

async function approveArt(id) {
  await fetch('/api/seo/articles/' + id + '/approve', { method: 'POST' });
  loadTab('articles');
}

async function markPub(id) {
  const url = prompt('URL bài đã đăng trên sondervn.com (ví dụ: https://sondervn.com/blog/khach-san-q1-sai-gon):', 'https://sondervn.com/blog/');
  if (!url) return;
  const r = await fetch('/api/seo/articles/' + id + '/mark-published', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: url.trim() }) }).then((x) => x.json());
  if (r.error) alert(r.error);
  loadTab('articles');
}

async function copyArt(id) {
  const r = await fetch('/api/seo/articles/' + id + '/copy').then((x) => x.json());
  if (r.error) return alert(r.error);
  const pkg = r.markdown;
  try {
    await navigator.clipboard.writeText(pkg);
    alert('✅ Đã copy full package (MD + Schema) vào clipboard.\\n\\nPaste vào sondervn.com CMS:\\n1. Body: paste phần Markdown (chỉ phần content, bỏ frontmatter & schema)\\n2. Meta title/description: lấy từ frontmatter\\n3. <head>: paste 2 thẻ <script type="application/ld+json"> ở cuối');
  } catch {
    // Fallback: show in textarea
    const w = window.open('', '_blank', 'width=800,height=600');
    w.document.write('<textarea style="width:100%;height:100%;font-family:monospace;font-size:12px">' + pkg.replace(/</g, '&lt;') + '</textarea>');
  }
}

async function delArt(id) {
  if (!confirm('Xoá bài này? Không thể undo.')) return;
  await fetch('/api/seo/articles/' + id, { method: 'DELETE' });
  loadTab('articles');
}

async function loadScoreCell(pageId) {
  try {
    const r = await fetch('/api/seo/scorecard/' + pageId).then((x) => x.json());
    const el = document.getElementById('score-' + pageId);
    if (!el) return;
    const color = r.grade === 'A' ? '#5a8a5a' : r.grade === 'B' ? '#7ba37b' : r.grade === 'C' ? '#a86b3c' : r.grade === 'D' ? '#c54' : '#a30';
    el.innerHTML = '<strong style="color:' + color + '">' + r.score + '</strong> <span class="badge" style="background:' + color + ';color:white">' + r.grade + '</span>';
  } catch {}
}

async function showScore(pageId) {
  const r = await fetch('/api/seo/scorecard/' + pageId).then((x) => x.json());
  if (r.error) return alert(r.error);
  let h = '<h3>Page #' + pageId + ' — Score: ' + r.score + ' (' + r.grade + ')</h3>';
  h += '<table><thead><tr><th>Factor</th><th>Score</th><th>Reason</th></tr></thead><tbody>';
  for (const [k, v] of Object.entries(r.breakdown)) {
    const pct = Math.round((v.score / v.max) * 100);
    const color = pct === 100 ? '#5a8a5a' : pct >= 70 ? '#7ba37b' : pct >= 40 ? '#a86b3c' : '#c54';
    h += '<tr><td><code>' + k + '</code></td>';
    h += '<td><strong style="color:' + color + '">' + v.score + '/' + v.max + '</strong></td>';
    h += '<td>' + escapeHtml(v.reason) + '</td></tr>';
  }
  h += '</tbody></table>';
  document.getElementById('scoreView').innerHTML = h;
  document.getElementById('scoreView').scrollIntoView({ behavior: 'smooth' });
}

async function gradeAll() {
  if (!confirm('Grade all crawled pages?')) return;
  const r = await fetch('/api/seo/scorecard/grade-all', { method: 'POST' }).then((x) => x.json());
  alert('Graded ' + r.graded + ' pages. Avg score: ' + r.avg_score + '\\nDistribution: ' + JSON.stringify(r.distribution));
  load();
}

async function runDailyCron() {
  if (!confirm('Run daily SEO cron now? (crawl + audit + keyword check)')) return;
  const r = await fetch('/api/seo/cron/run-now', { method: 'POST' }).then((x) => x.json());
  alert('Crawled: ' + r.crawled + '\\nNew issues: ' + r.issues_added + '\\nCost: $' + (r.cost_usd || 0).toFixed(4) + '\\n\\nDiff vs yesterday:\\n' + (r.diff_vs_yesterday || []).join('\\n'));
  load();
}

async function loadSparkline(id) {
  try {
    const r = await fetch('/api/seo/keywords/' + id + '/history?limit=10').then((x) => x.json());
    const items = (r.items || []).reverse();  // oldest first
    if (items.length === 0) {
      const el = document.getElementById('spark-' + id);
      if (el) el.textContent = '(no history)';
      return;
    }
    // Sparkline using unicode block chars
    const ranks = items.map((i) => i.rank);
    const valid = ranks.filter((r) => r !== null);
    if (valid.length === 0) {
      const el = document.getElementById('spark-' + id);
      if (el) el.textContent = items.map(() => '·').join('');
      return;
    }
    const min = Math.min(...valid);
    const max = Math.max(...valid);
    const range = max - min || 1;
    const blocks = '▁▂▃▄▅▆▇█';
    const spark = ranks.map((r) => {
      if (r === null) return '·';
      // Inverted: rank #1 = top = █, rank #50 = bottom = ▁
      const norm = 1 - ((r - min) / range);
      const idx = Math.min(7, Math.floor(norm * 7));
      return blocks[idx];
    }).join('');
    const el = document.getElementById('spark-' + id);
    if (el) el.textContent = spark + ' (best #' + min + ', worst #' + max + ')';
  } catch {}
}

async function checkKeywordConfig() {
  try {
    const r = await fetch('/api/seo/keyword-config').then((x) => x.json());
    return r.configured || 'Manual only (configure google_cse_api_key + google_cse_id, or serpapi_key, in Settings for auto-check)';
  } catch { return 'Manual only'; }
}

load();
</script>
</body></html>`);
});

export default router;

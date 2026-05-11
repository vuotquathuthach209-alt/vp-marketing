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
  db.prepare(`DELETE FROM seo_keywords WHERE id = ?`).run(req.params.id);
  res.json({ ok: true });
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
  for (const t of ['issues', 'pages', 'schemas', 'alts', 'keywords']) {
    html += '<div class="tab ' + (activeTab === t ? 'active' : '') + '" onclick="switchTab(\\'' + t + '\\')">' + tabLabel(t) + '</div>';
  }
  html += '</div>';

  html += '<div id="tabContent">Loading tab…</div>';

  document.getElementById('content').innerHTML = html;
  await loadTab(activeTab);
}

function tabLabel(t) {
  return { issues: '🔴 Issues', pages: '📄 Pages', schemas: '🏷️ Schemas', alts: '🖼️ Alt-text', keywords: '🔑 Keywords' }[t] || t;
}

function card(slug, label, num) {
  return '<div class="stat stat-' + slug + '"><div class="num">' + num + '</div><div class="lbl">' + label + '</div></div>';
}

async function switchTab(t) { activeTab = t; await load(); }

async function loadTab(t) {
  const wrap = document.getElementById('tabContent');
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
    let h = '<table><thead><tr><th>URL</th><th>Type</th><th>Title</th><th>Words</th><th>Schema</th><th>Issues</th></tr></thead><tbody>';
    for (const p of r.items) {
      h += '<tr><td class="url-cell"><a href="' + escapeAttr(p.url) + '" target="_blank">' + escapeHtml(p.url.slice(0, 60)) + '</a></td>';
      h += '<td>' + p.page_type + '</td>';
      h += '<td>' + escapeHtml((p.title || '—').slice(0, 50)) + '</td>';
      h += '<td>' + p.word_count + '</td>';
      h += '<td>' + (p.has_schema ? '✅' : '❌') + '</td>';
      h += '<td>' + (p.open_issues > 0 ? '<span class="badge b-warning">' + p.open_issues + '</span>' : '0') + '</td></tr>';
    }
    h += '</tbody></table>';
    wrap.innerHTML = h;
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
    let h = '<div class="actions">';
    h += '<input type="text" id="kw" placeholder="Keyword (e.g. khách sạn Q1 Sài Gòn)" />';
    h += '<input type="url" id="kwUrl" placeholder="Target URL" />';
    h += '<button class="btn-primary" onclick="addKeyword()">Add keyword</button>';
    h += '</div>';
    if (r.items.length === 0) {
      h += '<div class="empty">Chưa có keyword nào. Thêm keyword phía trên để track ranking.</div>';
    } else {
      h += '<table><thead><tr><th>Keyword</th><th>Category</th><th>Target URL</th><th>Volume</th><th>Rank</th><th></th></tr></thead><tbody>';
      for (const k of r.items) {
        h += '<tr><td><strong>' + escapeHtml(k.keyword) + '</strong></td>';
        h += '<td>' + (k.category || '—') + '</td>';
        h += '<td class="url-cell">' + escapeHtml(k.target_url || '—') + '</td>';
        h += '<td>' + (k.search_volume || 0) + '</td>';
        h += '<td>' + (k.current_rank ? '#' + k.current_rank : '—') + '</td>';
        h += '<td><button onclick="delKeyword(' + k.id + ')">🗑️</button></td></tr>';
      }
      h += '</tbody></table>';
    }
    wrap.innerHTML = h;
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
async function delKeyword(id) {
  if (!confirm('Delete?')) return;
  await fetch('/api/seo/keywords/' + id, { method: 'DELETE' });
  loadTab('keywords');
}

load();
</script>
</body></html>`);
});

export default router;

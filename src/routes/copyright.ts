/**
 * Copyright protection admin routes.
 *
 * Endpoints:
 *   GET  /api/copyright/overview              — stats
 *   POST /api/copyright/scan-all              — scan all images, compute pHash + EXIF + risk score
 *   POST /api/copyright/scan-one              — scan single image (POST { path })
 *   GET  /api/copyright/assessments           — list with filter
 *   GET  /api/copyright/review-queue          — pending review items
 *   POST /api/copyright/review/:path/approve  — mark image approved
 *   POST /api/copyright/review/:path/reject   — mark image rejected + add to blacklist
 *   POST /api/copyright/blacklist             — manually add image to takedown blacklist
 *   GET  /admin/copyright/dashboard           — HTML UI
 */

import { Router } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { db } from '../db';
import { assessImage, addToTakedownBlacklist, computePHash } from '../services/copyright/verifier';

const router = Router();

/* ───────── Overview ───────── */

router.get('/overview', (_req, res) => {
  const stats = {
    total_assessed: (db.prepare(`SELECT COUNT(*) AS n FROM copyright_assessments`).get() as any).n,
    by_level: db.prepare(`SELECT risk_level, COUNT(*) AS n FROM copyright_assessments GROUP BY risk_level`).all(),
    by_status: db.prepare(`SELECT status, COUNT(*) AS n FROM copyright_assessments GROUP BY status`).all(),
    by_source: db.prepare(`SELECT source, COUNT(*) AS n FROM copyright_assessments GROUP BY source`).all(),
    blacklisted: (db.prepare(`SELECT COUNT(*) AS n FROM copyright_takedown_blacklist`).get() as any).n,
    pending_review: (db.prepare(`SELECT COUNT(*) AS n FROM copyright_review_queue WHERE status = 'pending'`).get() as any).n,
    auto_blocked: (db.prepare(`SELECT COUNT(*) AS n FROM copyright_assessments WHERE status = 'auto_blocked'`).get() as any).n,
    avg_risk: (db.prepare(`SELECT AVG(risk_score) AS s FROM copyright_assessments`).get() as any).s || 0,
  };
  res.json({ ok: true, summary: stats });
});

/* ───────── Scan ───────── */

router.post('/scan-one', async (req, res) => {
  const p = (req.body?.path || '').trim();
  if (!p) return res.status(400).json({ error: 'path required' });
  if (!fs.existsSync(p)) return res.status(404).json({ error: 'file not found' });
  try {
    const r = await assessImage(p, { skip_web_search: req.body?.skip_web_search });
    res.json({ ok: true, assessment: r });
  } catch (e: any) { res.status(500).json({ error: e?.message }); }
});

router.post('/scan-all', async (req, res) => {
  // Background scan all v5_footage + media + gdrive_images
  const skipWeb = req.body?.skip_web_search !== false;  // default skip to save cost
  const limit = parseInt(String(req.body?.limit || '200'), 10);

  // Gather paths
  const v5 = db.prepare(`SELECT path FROM v5_footage WHERE path IS NOT NULL ORDER BY id DESC LIMIT ?`).all(limit) as Array<{ path: string }>;
  const media = db.prepare(`SELECT filename FROM media WHERE filename LIKE '%.jpg' OR filename LIKE '%.png' OR filename LIKE '%.jpeg' ORDER BY id DESC LIMIT ?`).all(limit) as Array<{ filename: string }>;
  // Note: media table stores either URL or local filename
  const paths = new Set<string>();
  for (const r of v5) if (r.path) paths.add(r.path);
  for (const r of media) if (r.filename && !r.filename.startsWith('http')) {
    const p = `/opt/vp-marketing/data/media/${r.filename}`;
    if (fs.existsSync(p)) paths.add(p);
  }

  // Don't block the HTTP request — fire off in background
  res.json({ ok: true, queued: paths.size, skip_web_search: skipWeb, message: 'scanning in background — check overview in 1-2 min' });

  (async () => {
    let done = 0, errors = 0;
    for (const p of paths) {
      try {
        await assessImage(p, { skip_web_search: skipWeb });
        done++;
      } catch (e: any) { errors++; }
    }
    console.log(`[copyright] background scan done: ${done}/${paths.size} (errors=${errors})`);
  })().catch(() => {});
});

/* ───────── Assessments + Review Queue ───────── */

router.get('/assessments', (req, res) => {
  let sql = `SELECT * FROM copyright_assessments WHERE 1=1`;
  const params: any[] = [];
  if (req.query.risk_level) { sql += ` AND risk_level = ?`; params.push(req.query.risk_level); }
  if (req.query.status) { sql += ` AND status = ?`; params.push(req.query.status); }
  sql += ` ORDER BY risk_score DESC, checked_at DESC LIMIT 200`;
  res.json({ items: db.prepare(sql).all(...params) });
});

router.get('/review-queue', (_req, res) => {
  const rows = db.prepare(
    `SELECT rq.*, ca.risk_score, ca.risk_level, ca.risk_reasons_json, ca.source, ca.phash
     FROM copyright_review_queue rq
     LEFT JOIN copyright_assessments ca ON ca.image_path = rq.image_path
     WHERE rq.status = 'pending'
     ORDER BY ca.risk_score DESC, rq.created_at DESC
     LIMIT 100`,
  ).all();
  res.json({ items: rows });
});

router.post('/review/approve', (req, res) => {
  const p = (req.body?.path || '').trim();
  if (!p) return res.status(400).json({ error: 'path required' });
  const now = Date.now();
  db.prepare(`UPDATE copyright_assessments SET status = 'approved', reviewed_by = 'admin', reviewed_at = ? WHERE image_path = ?`).run(now, p);
  db.prepare(`UPDATE copyright_review_queue SET status = 'approved', reviewed_by = 'admin', reviewed_at = ? WHERE image_path = ?`).run(now, p);
  res.json({ ok: true });
});

router.post('/review/reject', (req, res) => {
  const p = (req.body?.path || '').trim();
  const reason = req.body?.reason || 'admin reject';
  if (!p) return res.status(400).json({ error: 'path required' });
  const now = Date.now();
  db.prepare(`UPDATE copyright_assessments SET status = 'rejected', reviewed_by = 'admin', reviewed_at = ? WHERE image_path = ?`).run(now, p);
  db.prepare(`UPDATE copyright_review_queue SET status = 'rejected', reviewed_by = 'admin', reviewed_at = ? WHERE image_path = ?`).run(now, p);
  // Also add to blacklist so it never gets used again
  const phash = (db.prepare(`SELECT phash FROM copyright_phashes WHERE image_path = ?`).get(p) as any)?.phash;
  if (phash) {
    db.prepare(
      `INSERT OR REPLACE INTO copyright_takedown_blacklist (phash, image_path, reason, added_at) VALUES (?, ?, ?, ?)`,
    ).run(phash, p, reason, now);
  }
  res.json({ ok: true, blacklisted: !!phash });
});

router.post('/blacklist', (req, res) => {
  const p = (req.body?.path || '').trim();
  const reason = req.body?.reason || 'manual';
  const fbPostId = req.body?.fb_post_id || null;
  if (!p) return res.status(400).json({ error: 'path required' });

  // Compute phash if not already
  let phash = (db.prepare(`SELECT phash FROM copyright_phashes WHERE image_path = ?`).get(p) as any)?.phash;
  (async () => {
    if (!phash && fs.existsSync(p)) phash = await computePHash(p);
    if (phash) {
      db.prepare(
        `INSERT OR REPLACE INTO copyright_takedown_blacklist (phash, image_path, reason, fb_post_id, added_at) VALUES (?, ?, ?, ?, ?)`,
      ).run(phash, p, reason, fbPostId, Date.now());
    }
  })().catch(() => {});

  res.json({ ok: true, will_blacklist: !!phash || fs.existsSync(p) });
});

/**
 * Auto-blacklist by FB post ID: admin pastes fb_post_id of takedown'd post → we look up
 * its images (from v5t_post_images or posts) → compute pHash → add all to blacklist.
 * Future posts with similar images will be auto-blocked.
 */
router.post('/blacklist-from-fb-post', async (req, res) => {
  const fbPostId = (req.body?.fb_post_id || '').trim();
  const reason = req.body?.reason || 'FB Rights Manager takedown';
  if (!fbPostId) return res.status(400).json({ error: 'fb_post_id required' });

  const blacklisted: string[] = [];
  const errors: string[] = [];

  // Strategy A: V5T post with fb_post_id
  const v5tPost = db.prepare(`SELECT id FROM v5t_posts WHERE fb_post_id = ?`).get(fbPostId) as { id: number } | undefined;
  if (v5tPost) {
    const images = db.prepare(`SELECT composed_path FROM v5t_post_images WHERE post_id = ?`).all(v5tPost.id) as Array<{ composed_path: string }>;
    for (const img of images) {
      if (!fs.existsSync(img.composed_path)) {
        errors.push(`file missing: ${img.composed_path}`);
        continue;
      }
      try {
        const phash = await computePHash(img.composed_path);
        if (phash) {
          db.prepare(
            `INSERT OR REPLACE INTO copyright_takedown_blacklist (phash, image_path, reason, fb_post_id, added_at) VALUES (?, ?, ?, ?, ?)`,
          ).run(phash, img.composed_path, reason, fbPostId, Date.now());
          blacklisted.push(img.composed_path);
        }
      } catch (e: any) { errors.push(`pHash fail: ${e.message}`); }
    }
  }

  // Strategy B: legacy posts table with fb_post_id
  const legacyPost = db.prepare(`SELECT p.id, m.filename FROM posts p LEFT JOIN media m ON m.id = p.media_id WHERE p.fb_post_id = ?`).get(fbPostId) as { id: number; filename: string } | undefined;
  if (legacyPost?.filename) {
    const filename = legacyPost.filename;
    if (filename.startsWith('http')) {
      errors.push(`legacy post used URL: ${filename.slice(0, 80)} — cannot pHash without download`);
    } else {
      const fullPath = `/opt/vp-marketing/data/media/${filename}`;
      if (fs.existsSync(fullPath)) {
        try {
          const phash = await computePHash(fullPath);
          if (phash) {
            db.prepare(
              `INSERT OR REPLACE INTO copyright_takedown_blacklist (phash, image_path, reason, fb_post_id, added_at) VALUES (?, ?, ?, ?, ?)`,
            ).run(phash, fullPath, reason, fbPostId, Date.now());
            blacklisted.push(fullPath);
          }
        } catch (e: any) { errors.push(`pHash fail: ${e.message}`); }
      }
    }
  }

  // Also flag any v5_footage row that linked to this fb_post via v5t_post_images
  if (v5tPost) {
    db.prepare(
      `UPDATE copyright_assessments SET status = 'rejected', notes = ? , reviewed_at = ?
       WHERE image_path IN (SELECT composed_path FROM v5t_post_images WHERE post_id = ?)`,
    ).run('FB takedown: ' + reason, Date.now(), v5tPost.id);
  }

  if (blacklisted.length === 0 && errors.length === 0) {
    return res.json({ ok: false, message: 'No matching post found in DB for fb_post_id', fb_post_id: fbPostId });
  }

  res.json({
    ok: true,
    fb_post_id: fbPostId,
    blacklisted_count: blacklisted.length,
    blacklisted,
    errors,
    message: `Blocked ${blacklisted.length} image(s) from future use. Similar images (pHash distance ≤5) will auto-block.`,
  });
});

/** Stats per source — important for understanding where risk comes from. */
router.get('/source-risk', (_req, res) => {
  const rows = db.prepare(`
    SELECT source,
      COUNT(*) AS total,
      AVG(risk_score) AS avg_score,
      SUM(CASE WHEN risk_level IN ('high', 'critical') THEN 1 ELSE 0 END) AS high_risk_count,
      SUM(CASE WHEN status = 'auto_blocked' THEN 1 ELSE 0 END) AS blocked_count
    FROM copyright_assessments
    GROUP BY source
    ORDER BY avg_score DESC
  `).all();
  res.json({ items: rows });
});

/* ───────── Dashboard HTML ───────── */

router.get('/dashboard', (_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html>
<html lang="vi"><head>
<meta charset="utf-8"><title>Copyright Shield — Sondervn</title>
<style>
  body{font-family:-apple-system,'Segoe UI',sans-serif;max-width:1500px;margin:24px auto;padding:0 20px;color:#333;background:#fafaf7}
  h1{font-weight:300;color:#3b3a30;margin:0 0 8px}
  h2{font-weight:400;color:#5a4f3a;margin-top:24px;border-bottom:1px solid #d0c8b0;padding-bottom:6px}
  h3{font-weight:500;color:#6a5f4a;margin:14px 0 6px}
  .meta{color:#888;font-size:13px;margin-bottom:16px}
  .stats{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:12px;margin:12px 0}
  .stat{background:#fff;border:1px solid #e0d8c0;border-radius:8px;padding:12px}
  .stat .num{font-size:24px;font-weight:300}
  .stat .lbl{font-size:11px;color:#888;text-transform:uppercase;letter-spacing:0.04em}
  .stat-critical .num{color:#a00}
  .stat-high .num{color:#c43}
  .stat-medium .num{color:#a86b3c}
  .stat-low .num{color:#7a8a4a}
  .stat-safe .num{color:#5a8a5a}
  .actions{margin:14px 0;display:flex;gap:8px;flex-wrap:wrap}
  button{padding:6px 12px;border:1px solid #c0b890;background:#fff;border-radius:4px;cursor:pointer;font-size:13px}
  button:hover{background:#f0e8d0}
  .btn-primary{background:#a00;color:#fff;border-color:#a00}
  .btn-primary:hover{background:#c00}
  .btn-good{background:#5a8a5a;color:#fff;border-color:#5a8a5a}
  .btn-good:hover{background:#7a9a7a}
  table{border-collapse:collapse;width:100%;background:#fff;border-radius:6px;overflow:hidden;font-size:12px;margin:8px 0}
  th,td{padding:6px 10px;text-align:left;border-bottom:1px solid #e8e0c8;vertical-align:top}
  th{background:#f0e8d0;font-weight:500;font-size:11px}
  .badge{display:inline-block;padding:1px 6px;border-radius:8px;font-size:10px;font-weight:500}
  .level-critical{background:#a00;color:#fff}
  .level-high{background:#fde2da;color:#c43}
  .level-medium{background:#fde8d4;color:#a86b3c}
  .level-low{background:#f0e8d0;color:#7a6f4a}
  .level-safe{background:#d8e8d8;color:#5a8a5a}
  .photos{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:12px;margin:8px 0}
  .photo{background:#fff;border:1px solid #e0d8c0;border-radius:6px;padding:8px;font-size:11px;position:relative}
  .photo img{width:100%;height:140px;object-fit:cover;border-radius:4px;background:#eee}
  .photo .score{position:absolute;top:6px;right:6px;background:rgba(255,255,255,0.95);padding:2px 8px;border-radius:10px;font-weight:600}
  .photo .reasons{font-size:10px;color:#666;margin-top:4px;line-height:1.3}
  .photo .actions-row{display:flex;gap:4px;margin-top:6px}
  .empty{padding:24px;text-align:center;color:#888;font-style:italic}
  .tabs{display:flex;border-bottom:2px solid #d0c8b0;margin:16px 0 12px}
  .tab{padding:8px 14px;cursor:pointer;border-bottom:2px solid transparent;margin-bottom:-2px}
  .tab.active{border-color:#a86b3c;color:#a86b3c;font-weight:500}
  code{background:#f0e8d0;padding:1px 4px;border-radius:3px;font-size:11px}
</style></head><body>
<h1>🛡️ Copyright Shield — Sondervn</h1>
<div class="meta" id="last">Loading…</div>

<div class="actions">
  <button class="btn-primary" onclick="scanAll()">⚡ Scan ALL images (fast, no web search)</button>
  <button class="btn-primary" onclick="scanAllWithWeb()">🔍 Scan with Google Vision (~$0.20)</button>
  <button onclick="reportTakedown()" style="background:#a00;color:#fff;border-color:#a00">🚨 Report FB takedown</button>
  <button onclick="load()">⟳ Refresh</button>
</div>

<div id="overview"></div>

<div class="tabs">
  <div class="tab active" data-t="review-queue" onclick="switchTab('review-queue')">⚠️ Review queue</div>
  <div class="tab" data-t="auto-blocked" onclick="switchTab('auto-blocked')">🚫 Auto-blocked</div>
  <div class="tab" data-t="blacklist" onclick="switchTab('blacklist')">⛔ Takedown blacklist</div>
  <div class="tab" data-t="by-source" onclick="switchTab('by-source')">📊 Risk by source</div>
  <div class="tab" data-t="all" onclick="switchTab('all')">📋 All assessments</div>
</div>

<div id="content">Loading…</div>

<script>
let activeTab = 'review-queue';

async function load() {
  const r = await fetch('/api/copyright/overview').then((r) => r.json());
  document.getElementById('last').textContent = 'Updated: ' + new Date().toLocaleString('vi-VN');
  const s = r.summary;
  let h = '<h2>📊 Risk Overview</h2><div class="stats">';
  h += card('total', 'Total assessed', s.total_assessed);
  h += card('critical', '🚫 Auto-blocked', s.auto_blocked);
  h += card('high', '⚠️ Pending review', s.pending_review);
  h += card('total', '⛔ Blacklist', s.blacklisted);
  h += card('medium', 'Avg risk score', s.avg_risk?.toFixed?.(1) || 0);
  h += '</div>';
  h += '<h3>By risk level</h3><div class="stats">';
  for (const lv of ['critical', 'high', 'medium', 'low', 'safe']) {
    h += card(lv, lv, s.by_level?.find?.((x) => x.risk_level === lv)?.n || 0);
  }
  h += '</div>';
  document.getElementById('overview').innerHTML = h;
  await loadTab(activeTab);
}

function card(slug, label, num) { return '<div class="stat stat-' + slug + '"><div class="num">' + num + '</div><div class="lbl">' + label + '</div></div>'; }
function escapeHtml(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

async function switchTab(t) { activeTab = t; document.querySelectorAll('.tab').forEach(e => e.classList.toggle('active', e.dataset.t === t)); await loadTab(t); }

function thumbnail(imagePath) {
  if (!imagePath) return '';
  if (imagePath.startsWith('http')) return imagePath;
  // Real footage maps to /v5t-footage/ via nginx
  const fn = imagePath.split('/').pop();
  if (imagePath.includes('sonder-real-footage')) return '/v5t-footage/' + fn;
  if (imagePath.includes('v5t-out')) return '/v5t-out/' + fn;
  if (imagePath.includes('/data/media/')) return '/media/' + fn;
  return '';
}

async function loadTab(t) {
  const wrap = document.getElementById('content');
  if (t === 'review-queue') {
    const r = await fetch('/api/copyright/review-queue').then((x) => x.json());
    if (r.items.length === 0) return wrap.innerHTML = '<div class="empty">✅ No images pending review.</div>';
    let h = '<div class="photos">';
    for (const item of r.items) {
      const reasons = item.risk_reasons_json ? JSON.parse(item.risk_reasons_json) : [];
      h += '<div class="photo">';
      h += '<img src="' + thumbnail(item.image_path) + '" loading="lazy" onerror="this.style.background=\\'#fdd\\'">';
      h += '<div class="score level-' + (item.risk_level || 'medium') + '">' + (item.risk_score || 0) + '</div>';
      h += '<div><span class="badge level-' + item.risk_level + '">' + item.risk_level + '</span> <code>' + (item.source || '?') + '</code></div>';
      h += '<div class="reasons">' + reasons.slice(0, 3).map(escapeHtml).join('<br>') + '</div>';
      h += '<div class="actions-row"><button class="btn-good" onclick="approve(\\'' + escapeHtml(item.image_path) + '\\')">✓ Approve</button>';
      h += '<button class="btn-primary" onclick="reject(\\'' + escapeHtml(item.image_path) + '\\')">✗ Reject</button></div>';
      h += '</div>';
    }
    h += '</div>';
    wrap.innerHTML = h;
    return;
  }
  if (t === 'auto-blocked') {
    const r = await fetch('/api/copyright/assessments?status=auto_blocked').then((x) => x.json());
    if (r.items.length === 0) return wrap.innerHTML = '<div class="empty">✅ No auto-blocked images.</div>';
    let h = '<div class="photos">';
    for (const item of r.items) {
      const reasons = JSON.parse(item.risk_reasons_json || '[]');
      h += '<div class="photo">';
      h += '<img src="' + thumbnail(item.image_path) + '" loading="lazy" onerror="this.style.background=\\'#fdd\\'">';
      h += '<div class="score level-' + (item.risk_level || 'critical') + '">' + (item.risk_score || 0) + '</div>';
      h += '<div><span class="badge level-' + item.risk_level + '">' + item.risk_level + '</span> <code>' + (item.source || '?') + '</code></div>';
      h += '<div class="reasons">' + reasons.slice(0, 3).map(escapeHtml).join('<br>') + '</div>';
      h += '</div>';
    }
    h += '</div>';
    wrap.innerHTML = h;
    return;
  }
  if (t === 'blacklist') {
    const r = await fetch('/api/copyright/assessments?status=rejected').then((x) => x.json());
    // Also fetch direct takedowns
    let h = '<table><thead><tr><th>Path</th><th>Reason</th><th>Date</th></tr></thead><tbody>';
    if (r.items.length === 0) h += '<tr><td colspan="3" class="empty">No items.</td></tr>';
    for (const it of r.items) {
      h += '<tr><td><code>' + escapeHtml((it.image_path || '').slice(-50)) + '</code></td>';
      h += '<td>' + escapeHtml(it.notes || it.risk_level) + '</td>';
      h += '<td>' + (it.reviewed_at ? new Date(it.reviewed_at).toLocaleDateString('vi-VN') : '—') + '</td></tr>';
    }
    h += '</tbody></table>';
    wrap.innerHTML = h;
    return;
  }
  if (t === 'by-source') {
    const r = await fetch('/api/copyright/source-risk').then((x) => x.json());
    let h = '<table><thead><tr><th>Source</th><th>Total</th><th>Avg risk</th><th>High-risk</th><th>Auto-blocked</th></tr></thead><tbody>';
    for (const s of r.items) {
      h += '<tr><td><code>' + s.source + '</code></td><td>' + s.total + '</td>';
      h += '<td><strong>' + s.avg_score.toFixed(1) + '</strong></td>';
      h += '<td><span class="badge level-' + (s.high_risk_count > 0 ? 'high' : 'safe') + '">' + s.high_risk_count + '</span></td>';
      h += '<td><span class="badge level-' + (s.blocked_count > 0 ? 'critical' : 'safe') + '">' + s.blocked_count + '</span></td></tr>';
    }
    h += '</tbody></table>';
    wrap.innerHTML = h;
    return;
  }
  if (t === 'all') {
    const r = await fetch('/api/copyright/assessments').then((x) => x.json());
    if (r.items.length === 0) return wrap.innerHTML = '<div class="empty">No assessments. Bấm "Scan ALL" ở trên.</div>';
    let h = '<table><thead><tr><th>Image</th><th>Source</th><th>Score</th><th>Level</th><th>EXIF</th><th>Web matches</th><th>Status</th></tr></thead><tbody>';
    for (const a of r.items) {
      h += '<tr>';
      h += '<td><img src="' + thumbnail(a.image_path) + '" style="width:60px;height:40px;object-fit:cover;border-radius:3px;background:#eee" loading="lazy"></td>';
      h += '<td><code>' + a.source + '</code></td>';
      h += '<td><strong>' + a.risk_score + '</strong></td>';
      h += '<td><span class="badge level-' + a.risk_level + '">' + a.risk_level + '</span></td>';
      h += '<td>' + (a.has_exif ? '✅ ' + (a.exif_camera || 'yes') : '❌') + '</td>';
      h += '<td>' + (a.web_matches_count > 0 ? '<span class="badge level-high">' + a.web_matches_count + '</span>' : '0') + '</td>';
      h += '<td><span class="badge level-' + (a.status === 'approved' ? 'safe' : a.status === 'rejected' || a.status === 'auto_blocked' ? 'critical' : 'medium') + '">' + a.status + '</span></td>';
      h += '</tr>';
    }
    h += '</tbody></table>';
    wrap.innerHTML = h;
    return;
  }
}

async function scanAll() {
  if (!confirm('Scan ALL images (no Google Vision API — free, but only EXIF + pHash)?')) return;
  const r = await fetch('/api/copyright/scan-all', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ skip_web_search: true, limit: 500 }),
  }).then((x) => x.json());
  alert('Queued ' + r.queued + ' images. Check dashboard in 1-2 min.');
  setTimeout(load, 3000);
}

async function scanAllWithWeb() {
  if (!confirm('Scan ALL with Google Vision Web Detection? Cost: ~$1.50 per 1000 images. Continue?')) return;
  const r = await fetch('/api/copyright/scan-all', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ skip_web_search: false, limit: 200 }),
  }).then((x) => x.json());
  alert('Queued ' + r.queued + ' images. Background scan. ~5-10 min.');
  setTimeout(load, 5000);
}

async function approve(p) {
  await fetch('/api/copyright/review/approve', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: p }),
  });
  loadTab(activeTab);
}

async function reject(p) {
  const reason = prompt('Lý do reject? (sẽ add vào blacklist)', 'manual reject');
  if (!reason) return;
  await fetch('/api/copyright/review/reject', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: p, reason }),
  });
  loadTab(activeTab);
}

async function reportTakedown() {
  const fbPostId = prompt(
    'FB Post ID bị gỡ?\\n\\nVí dụ: 892083053979896_122128287051105277\\n(copy từ FB → Sự việc → notification)',
    '',
  );
  if (!fbPostId || !fbPostId.trim()) return;
  const reason = prompt('Lý do gỡ? (default: FB Rights Manager takedown)', 'FB Rights Manager takedown') || 'FB takedown';
  const r = await fetch('/api/copyright/blacklist-from-fb-post', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fb_post_id: fbPostId.trim(), reason }),
  }).then((x) => x.json());
  alert(JSON.stringify(r, null, 2));
  load();
}

load();
</script>
</body></html>`);
});

export default router;

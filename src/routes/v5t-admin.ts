/**
 * V5T Admin Routes — review posts + manual trigger.
 */

import { Router } from 'express';
import { db } from '../db';
import { runV5TGeneratePhase, runV5TPublishPhase } from '../services/v5t/orchestrator';

const router = Router();

router.get('/posts', (req, res) => {
  const status = (req.query.status as string) || null;
  let sql = `SELECT id, type, theme, hook_pattern, status, fb_post_id, created_at FROM v5t_posts`;
  const params: any[] = [];
  if (status) { sql += ` WHERE status = ?`; params.push(status); }
  sql += ` ORDER BY id DESC LIMIT 100`;

  const posts = db.prepare(sql).all(...params) as any[];
  for (const p of posts) {
    p.images = db.prepare(
      `SELECT id, position, source, composed_path, has_text_overlay
       FROM v5t_post_images WHERE post_id = ? ORDER BY position`,
    ).all(p.id);
    for (const img of p.images) {
      const filename = require('path').basename(img.composed_path);
      img.public_url = `https://app.sondervn.com/v5t-out/${filename}`;
    }
  }
  res.json({ ok: true, count: posts.length, posts });
});

router.get('/posts/:id', (req, res) => {
  const p = db.prepare(`SELECT * FROM v5t_posts WHERE id = ?`).get(req.params.id) as any;
  if (!p) return res.status(404).json({ error: 'not found' });
  p.hashtags = JSON.parse(p.hashtags || '[]');
  p.poll_options = p.poll_options ? JSON.parse(p.poll_options) : null;
  p.images = db.prepare(
    `SELECT * FROM v5t_post_images WHERE post_id = ? ORDER BY position`,
  ).all(req.params.id);
  for (const img of p.images) {
    const filename = require('path').basename(img.composed_path);
    img.public_url = `https://app.sondervn.com/v5t-out/${filename}`;
  }
  res.json({ ok: true, post: p });
});

router.post('/posts/:id/approve', (req, res) => {
  const r = db.prepare(
    `UPDATE v5t_posts SET status = 'approved' WHERE id = ? AND status IN ('rendered','draft')`,
  ).run(req.params.id);
  if (r.changes === 0) return res.status(400).json({ error: 'cannot approve' });
  res.json({ ok: true });
});

router.post('/posts/:id/reject', (req, res) => {
  db.prepare(`UPDATE v5t_posts SET status = 'failed' WHERE id = ?`).run(req.params.id);
  res.json({ ok: true });
});

/**
 * GET /admin/v5t/inventory — JSON: counts + photos never used, with thumbnails.
 * Slices: by content_type, by location, by moment_tag.
 * Useful to verify after Drive sync that ảnh quán/hẻm got tagged content_type=tips.
 */
router.get('/inventory', (_req, res) => {
  // Aggregate counts
  const byType = db.prepare(`
    SELECT
      SUM(CASE WHEN notes LIKE '%content_type:tips%' THEN 1 ELSE 0 END) AS tips,
      SUM(CASE WHEN notes LIKE '%content_type:story%' THEN 1 ELSE 0 END) AS story,
      SUM(CASE WHEN notes LIKE '%content_type:general%' THEN 1 ELSE 0 END) AS general,
      SUM(CASE WHEN notes IS NULL OR notes NOT LIKE '%content_type:%' THEN 1 ELSE 0 END) AS untagged,
      COUNT(*) AS total
    FROM v5_footage
    WHERE media_type = 'image' OR media_type IS NULL
  `).get() as any;

  const byLocation = db.prepare(`
    SELECT COALESCE(location, '(unknown)') AS location, COUNT(*) AS n
    FROM v5_footage
    WHERE media_type = 'image' OR media_type IS NULL
    GROUP BY location
    ORDER BY n DESC
  `).all() as any[];

  const byMomentTag = db.prepare(`
    SELECT COALESCE(moment_tag, '(unknown)') AS moment_tag, COUNT(*) AS n
    FROM v5_footage
    WHERE media_type = 'image' OR media_type IS NULL
    GROUP BY moment_tag
    ORDER BY n DESC
    LIMIT 30
  `).all() as any[];

  // Inventory: never-used photos (the picker pool)
  const neverUsed = db.prepare(`
    SELECT vf.id, vf.filename, vf.path, vf.location, vf.moment_tag, vf.notes,
           CASE
             WHEN vf.notes LIKE '%content_type:tips%' THEN 'tips'
             WHEN vf.notes LIKE '%content_type:story%' THEN 'story'
             WHEN vf.notes LIKE '%content_type:general%' THEN 'general'
             ELSE 'untagged'
           END AS content_type
    FROM v5_footage vf
    WHERE (vf.media_type = 'image' OR vf.media_type IS NULL)
      AND NOT EXISTS (SELECT 1 FROM v5t_post_images vpi WHERE vpi.footage_id = vf.id)
      AND NOT EXISTS (SELECT 1 FROM v5t_posts vp WHERE vp.picked_footage_id = vf.id AND vp.status != 'failed')
    ORDER BY vf.id DESC
  `).all() as any[];

  // Used photos (linked to a post)
  const usedPhotos = db.prepare(`
    SELECT vf.id, vf.filename, vf.location, vf.moment_tag,
           vp.id AS post_id, vp.type AS post_type, vp.status AS post_status,
           vp.fb_post_id
    FROM v5_footage vf
    JOIN v5t_post_images vpi ON vpi.footage_id = vf.id
    JOIN v5t_posts vp ON vp.id = vpi.post_id
    WHERE (vf.media_type = 'image' OR vf.media_type IS NULL)
    GROUP BY vf.id
    ORDER BY vp.id DESC
  `).all() as any[];

  // Add thumbnail URL — nginx alias /v5t-footage/ → /var/sonder-real-footage/
  for (const p of neverUsed) {
    const filename = require('path').basename(p.path);
    p.thumb_url = `https://app.sondervn.com/v5t-footage/${filename}`;
    // Strip notes blob to keep payload light, keep just the description part
    if (p.notes) {
      const m = p.notes.match(/\|\s*(.+?)\s*$/);
      p.description = m ? m[1].trim() : null;
      delete p.notes;
    }
    delete p.path;
  }

  // Posts pipeline
  const byStatus = db.prepare(`
    SELECT status, COUNT(*) AS n FROM v5t_posts GROUP BY status
  `).all() as any[];

  // Recent Drive sync activity (last 20 photos by created_at)
  const recentSyncs = db.prepare(`
    SELECT id, filename, location, moment_tag,
           datetime(created_at/1000, 'unixepoch') AS synced_at
    FROM v5_footage
    WHERE (media_type = 'image' OR media_type IS NULL)
      AND uploaded_by = 'gdrive-sync'
    ORDER BY created_at DESC
    LIMIT 20
  `).all() as any[];

  res.json({
    ok: true,
    summary: {
      total_photos: byType.total,
      never_used: neverUsed.length,
      used: usedPhotos.length,
      by_content_type: {
        tips: byType.tips,
        story: byType.story,
        general: byType.general,
        untagged: byType.untagged,
      },
      pipeline: byStatus.reduce((acc, r) => ({ ...acc, [r.status]: r.n }), {}),
    },
    by_location: byLocation,
    by_moment_tag: byMomentTag,
    never_used: neverUsed,
    used: usedPhotos,
    recent_syncs: recentSyncs,
  });
});

/** GET /admin/v5t/inventory-view — HTML dashboard for inventory. */
router.get('/inventory-view', (_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html>
<html lang="vi">
<head>
<meta charset="utf-8"><title>V5T Inventory — Sonder</title>
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
  .stat-tips .num{color:#a86b3c}
  .stat-story .num{color:#5a8a5a}
  .stat-general .num{color:#5a7a9a}
  .stat-untagged .num{color:#c54}
  .photos{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:10px;margin:12px 0}
  .photo{background:#fff;border-radius:6px;overflow:hidden;border:1px solid #e0d8c0;font-size:11px}
  .photo img{width:100%;height:160px;object-fit:cover;display:block;background:#eee}
  .photo .info{padding:6px 8px;line-height:1.3}
  .photo .id{color:#888;font-size:10px}
  .photo .loc{color:#5a6a7a}
  .photo .tag{color:#a86b3c;font-style:italic}
  .photo .desc{color:#666;font-size:11px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;margin-top:3px}
  .ct-badge{display:inline-block;padding:1px 6px;border-radius:8px;font-size:10px;margin-left:4px}
  .ct-tips{background:#fde8d4;color:#a86b3c}
  .ct-story{background:#d8e8d8;color:#5a8a5a}
  .ct-general{background:#d4e0ec;color:#5a7a9a}
  .ct-untagged{background:#ffd0d0;color:#c54}
  table{border-collapse:collapse;width:100%;background:#fff;border-radius:6px;overflow:hidden}
  th,td{padding:8px 12px;text-align:left;border-bottom:1px solid #e8e0c8;font-size:13px}
  th{background:#f0e8d0;font-weight:500}
  .filter{margin:12px 0}
  .filter button{margin-right:6px;padding:6px 14px;border:1px solid #c0b890;background:#fff;border-radius:14px;cursor:pointer;font-size:13px}
  .filter button.active{background:#3b3a30;color:#fff;border-color:#3b3a30}
  .empty{padding:40px;text-align:center;color:#888;font-style:italic}
  .refresh-btn{padding:8px 16px;background:#3b3a30;color:#fff;border:none;border-radius:4px;cursor:pointer}
</style>
</head>
<body>
<h1>📸 V5T Inventory — Drive Divider Status</h1>
<div class="meta" id="lastSync">Loading...</div>

<button class="refresh-btn" onclick="load()">🔄 Refresh</button>
<a href="/admin/v5t/dashboard" style="margin-left:12px">→ Posts Admin</a>

<div id="content">Loading...</div>

<script>
async function load() {
  const r = await fetch('/admin/v5t/inventory').then(r => r.json());
  const s = r.summary;

  document.getElementById('lastSync').textContent =
    'Updated: ' + new Date().toLocaleString('vi-VN') +
    ' · Total ' + s.total_photos + ' photos in v5_footage';

  let html = '';

  // === Top stats ===
  html += '<h2>Tổng quan inventory</h2>';
  html += '<div class="stats">';
  html += statCard('total', 'Tổng ảnh', s.total_photos);
  html += statCard('never-used', '✨ Chưa dùng (sẵn sàng pick)', s.never_used);
  html += statCard('used', 'Đã dùng trong post', s.used);
  html += '</div>';

  // === Content type breakdown ===
  html += '<h3>Phân loại nội dung (Vision tag)</h3>';
  html += '<div class="stats">';
  html += statCard('tips', '🍜 TIPS (quán/hẻm/cafe)', s.by_content_type.tips);
  html += statCard('story', '🌙 STORY (moment Sonder)', s.by_content_type.story);
  html += statCard('general', '🏠 GENERAL (phòng/decor)', s.by_content_type.general);
  html += statCard('untagged', '❓ Chưa tag', s.by_content_type.untagged);
  html += '</div>';

  // === Posts pipeline ===
  html += '<h3>Posts pipeline</h3><div class="stats">';
  for (const [k, v] of Object.entries(s.pipeline || {})) {
    html += statCard(k, k, v);
  }
  html += '</div>';

  // === Locations ===
  html += '<h2>Phân bố theo location</h2>';
  html += '<table><thead><tr><th>Location</th><th>Count</th><th>Bar</th></tr></thead><tbody>';
  const maxLoc = Math.max(...r.by_location.map(l => l.n), 1);
  for (const l of r.by_location) {
    const pct = Math.round((l.n / maxLoc) * 100);
    html += \`<tr><td>\${l.location}</td><td><b>\${l.n}</b></td><td><div style="background:#a86b3c;height:14px;width:\${pct}%"></div></td></tr>\`;
  }
  html += '</tbody></table>';

  // === Moment tags top 30 ===
  html += '<h2>Phân bố moment_tag (top 30 — đa dạng tốt)</h2>';
  html += '<table><thead><tr><th>Moment tag</th><th>Count</th></tr></thead><tbody>';
  for (const m of r.by_moment_tag) {
    html += \`<tr><td><span class="tag">\${m.moment_tag}</span></td><td><b>\${m.n}</b></td></tr>\`;
  }
  html += '</tbody></table>';

  // === Never used photos with thumbnails ===
  html += '<h2>✨ Ảnh chưa dùng — sẵn sàng cho post tiếp theo (' + r.never_used.length + ')</h2>';
  html += '<div class="filter">';
  html += '<button class="active" data-filter="all" onclick="filterPhotos(\\'all\\')">Tất cả</button>';
  html += '<button data-filter="tips" onclick="filterPhotos(\\'tips\\')">🍜 TIPS</button>';
  html += '<button data-filter="story" onclick="filterPhotos(\\'story\\')">🌙 STORY</button>';
  html += '<button data-filter="general" onclick="filterPhotos(\\'general\\')">🏠 GENERAL</button>';
  html += '<button data-filter="untagged" onclick="filterPhotos(\\'untagged\\')">❓ Untagged</button>';
  html += '</div>';

  if (r.never_used.length === 0) {
    html += '<div class="empty">😱 Hết ảnh chưa dùng! Anh up ảnh mới vào Drive divider hoặc đợi cron sync 15p.</div>';
  } else {
    html += '<div class="photos" id="photoGrid">';
    for (const p of r.never_used) {
      html += \`<div class="photo" data-ct="\${p.content_type}">
        <img src="\${p.thumb_url}" loading="lazy" onerror="this.style.background='#fdd';this.alt='Missing'">
        <div class="info">
          <div class="id">#\${p.id}<span class="ct-badge ct-\${p.content_type}">\${p.content_type}</span></div>
          <div class="loc">\${p.location || '—'}</div>
          <div class="tag">\${p.moment_tag || '—'}</div>
          \${p.description ? \`<div class="desc">\${p.description}</div>\` : ''}
        </div>
      </div>\`;
    }
    html += '</div>';
  }

  // === Used photos (compact list) ===
  if (r.used.length > 0) {
    html += '<h2>📤 Ảnh đã dùng (' + r.used.length + ')</h2>';
    html += '<table><thead><tr><th>Photo ID</th><th>Filename</th><th>Location</th><th>Post #</th><th>Type</th><th>Status</th><th>FB</th></tr></thead><tbody>';
    for (const u of r.used) {
      const fbLink = u.fb_post_id ? \`<a href="https://facebook.com/\${u.fb_post_id}" target="_blank">view</a>\` : '—';
      html += \`<tr><td>#\${u.id}</td><td>\${u.filename}</td><td>\${u.location || '—'}</td><td>#\${u.post_id}</td><td>\${u.post_type}</td><td>\${u.post_status}</td><td>\${fbLink}</td></tr>\`;
    }
    html += '</tbody></table>';
  }

  // === Recent syncs ===
  html += '<h2>🔄 Drive sync gần đây (20 ảnh mới nhất)</h2>';
  html += '<table><thead><tr><th>ID</th><th>Filename</th><th>Location</th><th>Moment tag</th><th>Synced</th></tr></thead><tbody>';
  for (const s of r.recent_syncs) {
    html += \`<tr><td>#\${s.id}</td><td>\${s.filename}</td><td>\${s.location || '—'}</td><td><span class="tag">\${s.moment_tag || '—'}</span></td><td>\${s.synced_at}</td></tr>\`;
  }
  html += '</tbody></table>';

  document.getElementById('content').innerHTML = html;
}

function statCard(slug, label, num) {
  return \`<div class="stat stat-\${slug}"><div class="num">\${num}</div><div class="lbl">\${label}</div></div>\`;
}

function filterPhotos(ct) {
  document.querySelectorAll('.filter button').forEach(b => {
    b.classList.toggle('active', b.dataset.filter === ct);
  });
  document.querySelectorAll('#photoGrid .photo').forEach(p => {
    p.style.display = (ct === 'all' || p.dataset.ct === ct) ? '' : 'none';
  });
}

load();
setInterval(load, 60000);
</script>
</body></html>`);
});

router.post('/generate-now', async (req, res) => {
  try {
    const r = await runV5TGeneratePhase({ type: req.body?.type, generated_by: 'manual-admin' });
    res.json(r);
  } catch (e: any) {
    res.status(500).json({ error: e?.message });
  }
});

router.post('/publish-now', async (_req, res) => {
  try {
    const r = await runV5TPublishPhase();
    res.json(r);
  } catch (e: any) {
    res.status(500).json({ error: e?.message });
  }
});

/** Trigger Google Drive sync immediately (instead of waiting 15-min cron) */
router.post('/sync-drive-now', async (_req, res) => {
  try {
    const { syncGoogleDriveFolder } = require('../services/v5t/gdrive-sync');
    const r = await syncGoogleDriveFolder();
    res.json(r);
  } catch (e: any) {
    res.status(500).json({ error: e?.message });
  }
});

/** Re-tag photos that vision missed (rerun backfill on untagged photos) */
router.post('/backfill-vision', async (req, res) => {
  try {
    const { backfillVisionTags } = require('../services/v5t/gdrive-sync');
    const limit = Math.min(parseInt(req.body?.limit || '100', 10), 200);
    const r = await backfillVisionTags(limit);
    res.json(r);
  } catch (e: any) {
    res.status(500).json({ error: e?.message });
  }
});

router.get('/dashboard', (_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="utf-8"><title>Sonder V5T Posts Admin</title>
  <style>
    body{font-family:-apple-system,sans-serif;max-width:1200px;margin:24px auto;padding:0 20px;color:#333}
    h1{font-weight:400;color:#3b3a30}
    .card{background:#fff;border:1px solid #e0e0e0;border-radius:8px;padding:16px;margin-bottom:16px}
    .images{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:8px;margin:12px 0}
    .images img{width:100%;border-radius:4px}
    .badge{padding:2px 8px;border-radius:12px;font-size:12px;margin-right:4px}
    .b-draft{background:#ffd}.b-rendered{background:#def}.b-approved{background:#dfd}.b-posted{background:#cfc}.b-failed{background:#fdd}
    button{padding:8px 16px;border:none;border-radius:4px;cursor:pointer;font-size:14px}
    .btn-approve{background:#4a7;color:white}.btn-reject{background:#c64;color:white}.btn-trigger{background:#36a;color:white}
    .meta{color:#888;font-size:12px}
    .caption{white-space:pre-wrap;font-size:13px;background:#f8f8f8;padding:8px;border-radius:4px;margin-top:8px;font-family:Georgia,serif}
  </style>
</head>
<body>
  <h1>📸 Sonder V5T Text/Image Admin</h1>
  <div style="margin-bottom:16px">
    <button class="btn-trigger" onclick="trigger('tips_post')">⚡ TIPS Post (5 quán phở...)</button>
    <button class="btn-trigger" onclick="trigger('story_post')">⚡ STORY Post (chú Tuấn pha trà...)</button>
    <button class="btn-trigger" onclick="publishNext()" style="margin-left:24px">📤 Publish Next</button>
    <button class="btn-trigger" onclick="syncDrive()" style="background:#7a5;margin-left:24px">🔄 Sync Drive Now</button>
    <a href="/admin/v5t/inventory-view" style="margin-left:24px;padding:8px 16px;background:#a86b3c;color:#fff;text-decoration:none;border-radius:4px">📊 Inventory</a>
  </div>
  <div id="posts">Loading...</div>
  <script>
    async function load() {
      const r = await fetch('/admin/v5t/posts').then(r => r.json());
      document.getElementById('posts').innerHTML = r.posts.map(p => \`
        <div class="card">
          <strong>#\${p.id}</strong> [\${p.type}] [\${p.theme}]
          <span class="badge b-\${p.status}">\${p.status}</span>
          <span class="meta">\${new Date(p.created_at).toLocaleString('vi-VN')}</span>
          \${p.fb_post_id ? \` · <a href="https://facebook.com/\${p.fb_post_id}" target="_blank">FB post</a>\` : ''}
          <div class="images">
            \${p.images.map(i => \`<img src="\${i.public_url}" alt="img \${i.position}">\`).join('') || '<em>No images</em>'}
          </div>
          <div class="caption" id="cap-\${p.id}"></div>
          <div style="margin-top:12px">
            <button onclick="loadCap(\${p.id})">Show caption</button>
            \${p.status === 'rendered' ? \`
              <button class="btn-approve" onclick="approve(\${p.id})">✓ Approve</button>
              <button class="btn-reject" onclick="reject(\${p.id})">✗ Reject</button>
            \` : ''}
          </div>
        </div>\`).join('') || '<p>No V5T posts. Click ⚡ to generate.</p>';
    }
    async function loadCap(id) {
      const r = await fetch(\`/admin/v5t/posts/\${id}\`).then(r => r.json());
      document.getElementById('cap-' + id).textContent = 'A: ' + r.post.caption_a + '\\n\\nB: ' + r.post.caption_b + '\\n\\nC: ' + r.post.caption_c;
    }
    async function approve(id) { await fetch(\`/admin/v5t/posts/\${id}/approve\`, {method:'POST'}); load(); }
    async function reject(id) { await fetch(\`/admin/v5t/posts/\${id}/reject\`, {method:'POST'}); load(); }
    async function trigger(type) {
      if (!confirm(\`Generate 1 \${type} post?\`)) return;
      const btn = event.target;
      btn.disabled = true; btn.textContent = '⏳';
      const r = await fetch('/admin/v5t/generate-now', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({type})
      }).then(r => r.json());
      btn.disabled = false; btn.textContent = '⚡ ' + type;
      alert(JSON.stringify(r, null, 2));
      load();
    }
    async function publishNext() {
      if (!confirm('Publish next approved post?')) return;
      const r = await fetch('/admin/v5t/publish-now', {method:'POST'}).then(r => r.json());
      alert(JSON.stringify(r, null, 2));
      load();
    }
    async function syncDrive() {
      if (!confirm('Sync Google Drive divider folder now?')) return;
      const btn = event.target;
      btn.disabled = true; btn.textContent = '⏳ syncing...';
      const r = await fetch('/admin/v5t/sync-drive-now', {method:'POST'}).then(r => r.json());
      btn.disabled = false; btn.textContent = '🔄 Sync Drive Now';
      alert('Drive sync result:\\n' + JSON.stringify(r, null, 2));
      load();
    }
    load();
    setInterval(load, 30000);
  </script>
</body>
</html>`);
});

export default router;

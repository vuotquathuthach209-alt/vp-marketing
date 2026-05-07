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
    <button class="btn-trigger" onclick="trigger('carousel')">⚡ Carousel</button>
    <button class="btn-trigger" onclick="trigger('single_image')">⚡ Single</button>
    <button class="btn-trigger" onclick="trigger('poll')">⚡ Poll</button>
    <button class="btn-trigger" onclick="trigger('question')">⚡ Question</button>
    <button class="btn-trigger" onclick="publishNext()" style="margin-left:24px">📤 Publish Next</button>
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
    load();
    setInterval(load, 30000);
  </script>
</body>
</html>`);
});

export default router;

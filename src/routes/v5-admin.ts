/**
 * V5 Admin Routes — review scripts, approve, manual trigger.
 *
 * Mounted at: /admin/v5
 *
 * Endpoints:
 *   GET    /admin/v5/scripts            — list scripts with variants
 *   GET    /admin/v5/scripts/:id        — detail
 *   POST   /admin/v5/scripts/:id/approve  — approve → ready for publish cron
 *   POST   /admin/v5/scripts/:id/reject   — mark failed
 *   POST   /admin/v5/generate-now       — trigger pipeline immediately
 *   POST   /admin/v5/publish-now        — trigger publish next approved
 *   GET    /admin/v5/budget             — FAL spending status
 *   GET    /admin/v5/footage/stats      — footage repository stats
 */

import { Router } from 'express';
import { db, getSetting } from '../db';
import { runV5GeneratePhase, runV5PublishPhase } from '../services/v5/orchestrator';
import { getBudgetStatus } from '../services/v5/fal-generator';

const router = Router();

/** GET /admin/v5/scripts — list with variants */
router.get('/scripts', (req, res) => {
  const status = (req.query.status as string) || null;
  let sql = `SELECT id, theme, title, status, total_duration_target_sec, bgm_mood,
                    generated_by, created_at FROM v5_scripts`;
  const params: any[] = [];
  if (status) {
    sql += ` WHERE status = ?`;
    params.push(status);
  }
  sql += ` ORDER BY id DESC LIMIT 100`;

  const scripts = db.prepare(sql).all(...params) as any[];

  // Attach variants
  for (const s of scripts) {
    s.variants = db.prepare(
      `SELECT id, variant, hook_pattern, output_path, duration_sec, size_mb, cost_usd, rendered_at
       FROM v5_rendered_clips WHERE script_id = ? ORDER BY variant`,
    ).all(s.id);
    // Public URL for each variant
    for (const v of s.variants) {
      const filename = require('path').basename(v.output_path);
      v.public_url = `https://app.sondervn.com/v5-out/${filename}`;
    }
  }

  res.json({ ok: true, count: scripts.length, scripts });
});

/** GET /admin/v5/scripts/:id — full detail with body + hooks */
router.get('/scripts/:id', (req, res) => {
  const s = db.prepare(`SELECT * FROM v5_scripts WHERE id = ?`).get(req.params.id) as any;
  if (!s) return res.status(404).json({ error: 'not found' });

  s.body = JSON.parse(s.body_json || '{}');
  s.hook_a = JSON.parse(s.hook_a_json || '{}');
  s.hook_b = JSON.parse(s.hook_b_json || '{}');
  s.hook_c = JSON.parse(s.hook_c_json || '{}');
  s.visual_plan = JSON.parse(s.visual_plan_json || '{}');
  delete s.body_json;
  delete s.hook_a_json;
  delete s.hook_b_json;
  delete s.hook_c_json;
  delete s.visual_plan_json;

  s.variants = db.prepare(
    `SELECT * FROM v5_rendered_clips WHERE script_id = ? ORDER BY variant`,
  ).all(req.params.id) as any[];
  for (const v of s.variants) {
    const filename = require('path').basename(v.output_path);
    v.public_url = `https://app.sondervn.com/v5-out/${filename}`;
  }

  res.json({ ok: true, script: s });
});

/** POST /admin/v5/scripts/:id/approve */
router.post('/scripts/:id/approve', (req, res) => {
  const r = db.prepare(
    `UPDATE v5_scripts SET status = 'approved' WHERE id = ? AND status IN ('rendered', 'draft')`,
  ).run(req.params.id);
  if (r.changes === 0) return res.status(400).json({ error: 'cannot approve (not in rendered/draft state)' });
  res.json({ ok: true, approved: req.params.id });
});

/** POST /admin/v5/scripts/:id/reject */
router.post('/scripts/:id/reject', (req, res) => {
  const reason = (req.body?.reason as string) || 'admin_rejected';
  db.prepare(`UPDATE v5_scripts SET status = 'failed' WHERE id = ?`).run(req.params.id);
  res.json({ ok: true, rejected: req.params.id, reason });
});

/** POST /admin/v5/generate-now — manual trigger Stage A */
router.post('/generate-now', async (req, res) => {
  const theme = req.body?.theme;
  try {
    const r = await runV5GeneratePhase({ theme, generated_by: 'manual-admin' });
    res.json(r);
  } catch (e: any) {
    res.status(500).json({ error: e?.message || 'unknown' });
  }
});

/** POST /admin/v5/publish-now — manual trigger Stage B */
router.post('/publish-now', async (_req, res) => {
  try {
    const r = await runV5PublishPhase();
    res.json(r);
  } catch (e: any) {
    res.status(500).json({ error: e?.message || 'unknown' });
  }
});

/** GET /admin/v5/budget */
router.get('/budget', (_req, res) => {
  res.json({ ok: true, ...getBudgetStatus() });
});

/** GET /admin/v5/footage/stats */
router.get('/footage/stats', (_req, res) => {
  const total = (db.prepare(`SELECT COUNT(*) as c FROM v5_footage`).get() as any).c;
  const byLocation = db.prepare(
    `SELECT location, COUNT(*) as c FROM v5_footage GROUP BY location`,
  ).all();
  const byCharacter = db.prepare(
    `SELECT character, COUNT(*) as c FROM v5_footage GROUP BY character`,
  ).all();
  const unused = (db.prepare(`SELECT COUNT(*) as c FROM v5_footage WHERE used_count = 0`).get() as any).c;

  res.json({
    ok: true,
    total,
    unused,
    by_location: byLocation,
    by_character: byCharacter,
  });
});

/** GET /admin/v5/dashboard — HTML dashboard */
router.get('/dashboard', (_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="utf-8">
  <title>Sonder V5 Content Admin</title>
  <style>
    body { font-family: -apple-system, sans-serif; max-width: 1200px; margin: 24px auto; padding: 0 20px; color: #333; }
    h1 { font-weight: 400; color: #3b3a30; }
    .card { background: #fff; border: 1px solid #e0e0e0; border-radius: 8px; padding: 16px; margin-bottom: 16px; }
    .variants { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin-top: 12px; }
    .variant { background: #f8f8f8; padding: 8px; border-radius: 4px; }
    .variant video { width: 100%; max-height: 400px; }
    .badge { display: inline-block; padding: 2px 8px; border-radius: 12px; font-size: 12px; margin-right: 4px; }
    .b-draft { background: #ffd; }
    .b-rendered { background: #def; }
    .b-approved { background: #dfd; }
    .b-posted { background: #cfc; }
    .b-failed { background: #fdd; }
    button { padding: 8px 16px; border: none; border-radius: 4px; cursor: pointer; font-size: 14px; }
    .btn-approve { background: #4a7; color: white; }
    .btn-reject { background: #c64; color: white; }
    .btn-trigger { background: #36a; color: white; }
    .meta { color: #888; font-size: 12px; margin-top: 8px; }
    .toolbar { margin-bottom: 16px; }
  </style>
</head>
<body>
  <h1>🎬 Sonder V5 Content Admin</h1>
  <div class="toolbar">
    <button class="btn-trigger" onclick="triggerGen()">⚡ Generate Now</button>
    <button class="btn-trigger" onclick="triggerPub()">📤 Publish Next</button>
    <span id="budget" class="meta"></span>
  </div>
  <div id="scripts">Loading...</div>

  <script>
    const fmt = (n) => Math.round(n * 100) / 100;

    async function loadBudget() {
      const r = await fetch('/admin/v5/budget').then(r => r.json());
      document.getElementById('budget').textContent =
        \`💰 Budget: \$\${fmt(r.spent)} / \$\${r.budget} (\${fmt(r.pct)}% used, \$\${fmt(r.remaining)} remaining)\`;
    }

    async function loadScripts() {
      const r = await fetch('/admin/v5/scripts').then(r => r.json());
      const html = r.scripts.map(s => \`
        <div class="card">
          <div>
            <strong>#\${s.id}</strong> [\${s.theme}] <em>\${s.title}</em>
            <span class="badge b-\${s.status}">\${s.status}</span>
            <span class="meta">\${new Date(s.created_at).toLocaleString('vi-VN')}</span>
          </div>
          <div class="variants">
            \${s.variants.map(v => \`
              <div class="variant">
                <strong>\${v.variant.toUpperCase()}</strong> \${v.hook_pattern}<br>
                <video controls preload="metadata" src="\${v.public_url}"></video>
                <div class="meta">\${fmt(v.duration_sec)}s · \${fmt(v.size_mb)}MB · \$\${fmt(v.cost_usd)}</div>
              </div>
            \`).join('') || '<em>No variants rendered</em>'}
          </div>
          <div style="margin-top:12px">
            \${s.status === 'rendered' ? \`
              <button class="btn-approve" onclick="approve(\${s.id})">✓ Approve</button>
              <button class="btn-reject" onclick="reject(\${s.id})">✗ Reject</button>
            \` : ''}
          </div>
        </div>
      \`).join('');
      document.getElementById('scripts').innerHTML = html || '<p>No scripts yet. Click Generate Now.</p>';
    }

    async function approve(id) {
      await fetch(\`/admin/v5/scripts/\${id}/approve\`, { method: 'POST' });
      loadScripts();
    }
    async function reject(id) {
      const reason = prompt('Lý do reject?') || 'admin_rejected';
      await fetch(\`/admin/v5/scripts/\${id}/reject\`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason }),
      });
      loadScripts();
    }
    async function triggerGen() {
      if (!confirm('Generate 1 V5 script + 3 variants now? (~2-3 min, ~\$0.30)')) return;
      const btn = event.target;
      btn.disabled = true; btn.textContent = '⏳ Generating (3 min)...';
      const r = await fetch('/admin/v5/generate-now', { method: 'POST' }).then(r => r.json());
      btn.disabled = false; btn.textContent = '⚡ Generate Now';
      alert(JSON.stringify(r, null, 2));
      loadScripts(); loadBudget();
    }
    async function triggerPub() {
      if (!confirm('Publish next approved script to FB?')) return;
      const r = await fetch('/admin/v5/publish-now', { method: 'POST' }).then(r => r.json());
      alert(JSON.stringify(r, null, 2));
      loadScripts();
    }

    loadBudget();
    loadScripts();
    setInterval(() => { loadBudget(); loadScripts(); }, 30000);
  </script>
</body>
</html>`);
});

export default router;

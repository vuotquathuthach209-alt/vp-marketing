/**
 * Customer Care admin routes.
 *
 * NO auto-reply. Endpoints are READ-ONLY aggregation + template lookup.
 * Admin still types the final response themselves on FB/IG/Google.
 */

import { Router } from 'express';
import { db } from '../db';
import { syncReviews, addManualGoogleReview, listReviews, reviewStats, markResponded } from '../services/care/reviews';
import { syncInbox, listComments, inboxStats, markCommentResponded } from '../services/care/inbox';
import { listTemplates, getTemplate, upsertTemplate, deleteTemplate, renderTemplate, suggestTemplates, seedDefaultTemplates } from '../services/care/templates';
import { auditAllFacebookPages, getLatestFacebookAudit } from '../services/seo/channels/facebook';
import { auditAllInstagram, getLatestInstagramAudit } from '../services/seo/channels/instagram';

const router = Router();

/* ───────── Overview ───────── */

router.get('/overview', (_req, res) => {
  res.json({
    ok: true,
    reviews: reviewStats(),
    inbox: inboxStats(),
    templates: {
      total: (db.prepare(`SELECT COUNT(*) AS n FROM care_templates WHERE active = 1`).get() as any).n,
    },
    social: {
      facebook_pages: (db.prepare(`SELECT COUNT(*) AS n FROM seo_social_audit WHERE channel = 'facebook'`).get() as any).n,
      instagram_profiles: (db.prepare(`SELECT COUNT(*) AS n FROM seo_social_audit WHERE channel = 'instagram'`).get() as any).n,
    },
  });
});

/* ───────── Reviews ───────── */

router.get('/reviews', (req, res) => {
  const items = listReviews({
    source: req.query.source as any,
    sentiment: req.query.sentiment as any,
    needs_response: req.query.needs_response === 'true',
    is_urgent: req.query.urgent === 'true',
    limit: parseInt(String(req.query.limit || '100'), 10),
  });
  res.json({ items });
});

router.post('/reviews/sync', async (_req, res) => {
  try {
    const r = await syncReviews({ since_days: 90 });
    res.json({ ok: true, ...r });
  } catch (e: any) { res.status(500).json({ error: e?.message }); }
});

router.post('/reviews/manual', (req, res) => {
  const { hotel_id, author_name, rating, text } = req.body || {};
  if (!author_name || !rating || !text) return res.status(400).json({ error: 'author_name, rating, text required' });
  try {
    const r = addManualGoogleReview({ hotel_id, author_name, rating: parseInt(rating, 10), text });
    res.json({ ok: true, ...r });
  } catch (e: any) { res.status(500).json({ error: e?.message }); }
});

router.post('/reviews/:id/responded', (req, res) => {
  markResponded(parseInt(req.params.id, 10), req.body?.response_text);
  res.json({ ok: true });
});

/* ───────── Inbox (FB comments) ───────── */

router.get('/inbox', (req, res) => {
  const items = listComments({
    sentiment: req.query.sentiment as any,
    is_question: req.query.is_question === 'true',
    needs_response: req.query.needs_response === 'true',
    limit: parseInt(String(req.query.limit || '100'), 10),
  });
  res.json({ items });
});

router.post('/inbox/sync', async (_req, res) => {
  try {
    const r = await syncInbox({ since_days: 14 });
    res.json({ ok: true, ...r });
  } catch (e: any) { res.status(500).json({ error: e?.message }); }
});

router.post('/inbox/:id/responded', (req, res) => {
  markCommentResponded(parseInt(req.params.id, 10));
  res.json({ ok: true });
});

/* ───────── Templates ───────── */

router.get('/templates', (req, res) => {
  res.json({ items: listTemplates({
    category: req.query.category as any,
    language: req.query.language as any,
    active_only: req.query.all !== 'true',
  }) });
});

router.get('/templates/:id', (req, res) => {
  const t = getTemplate(parseInt(req.params.id, 10));
  if (!t) return res.status(404).json({ error: 'not found' });
  res.json(t);
});

router.post('/templates', (req, res) => {
  try {
    const r = upsertTemplate(req.body);
    res.json({ ok: true, ...r });
  } catch (e: any) { res.status(400).json({ error: e?.message }); }
});

router.delete('/templates/:id', (req, res) => {
  const ok = deleteTemplate(parseInt(req.params.id, 10));
  res.json({ ok });
});

router.post('/templates/:id/render', (req, res) => {
  const r = renderTemplate(parseInt(req.params.id, 10), req.body?.variables || {});
  if (!r) return res.status(404).json({ error: 'template not found' });
  res.json(r);
});

router.post('/templates/suggest', (req, res) => {
  const { text, language, category, limit } = req.body || {};
  if (!text) return res.status(400).json({ error: 'text required' });
  res.json({ items: suggestTemplates(text, { language, category, limit }) });
});

router.post('/templates/seed', (_req, res) => {
  const created = seedDefaultTemplates();
  res.json({ ok: true, created });
});

/* ───────── Social SEO (FB Page + IG audit) ───────── */

router.post('/social/facebook/audit', async (_req, res) => {
  try {
    const r = await auditAllFacebookPages();
    res.json({ ok: true, ...r });
  } catch (e: any) { res.status(500).json({ error: e?.message }); }
});

router.get('/social/facebook', (_req, res) => {
  res.json({ items: getLatestFacebookAudit() });
});

router.post('/social/instagram/audit', async (_req, res) => {
  try {
    const r = await auditAllInstagram();
    res.json({ ok: true, ...r });
  } catch (e: any) { res.status(500).json({ error: e?.message }); }
});

router.get('/social/instagram', (_req, res) => {
  res.json({ items: getLatestInstagramAudit() });
});

/* ───────── Dashboard HTML ───────── */

router.get('/dashboard', (_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html>
<html lang="vi"><head>
<meta charset="utf-8"><title>Customer Care — Sondervn</title>
<style>
  body{font-family:-apple-system,'Segoe UI',sans-serif;max-width:1400px;margin:24px auto;padding:0 20px;color:#333;background:#fafaf7}
  h1{font-weight:300;color:#3b3a30;margin:0 0 8px}
  h2{font-weight:400;color:#5a4f3a;margin-top:24px;border-bottom:1px solid #d0c8b0;padding-bottom:6px}
  h3{font-weight:500;color:#6a5f4a;margin:14px 0 6px}
  .meta{color:#888;font-size:13px;margin-bottom:16px}
  .stats{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:12px;margin:12px 0}
  .stat{background:#fff;border:1px solid #e0d8c0;border-radius:8px;padding:12px}
  .stat .num{font-size:24px;font-weight:300}
  .stat .lbl{font-size:11px;color:#888;text-transform:uppercase;letter-spacing:0.04em}
  .stat-positive .num{color:#5a8a5a}
  .stat-negative .num{color:#c54}
  .stat-urgent .num{color:#a30}
  .stat-warn .num{color:#a86b3c}
  .tabs{display:flex;border-bottom:2px solid #d0c8b0;margin:16px 0 12px;flex-wrap:wrap}
  .tab{padding:8px 14px;cursor:pointer;border-bottom:2px solid transparent;margin-bottom:-2px}
  .tab.active{border-color:#a86b3c;color:#a86b3c;font-weight:500}
  .actions{margin:10px 0;display:flex;gap:6px;flex-wrap:wrap}
  button{padding:6px 12px;border:1px solid #c0b890;background:#fff;border-radius:4px;cursor:pointer;font-size:13px}
  button:hover{background:#f0e8d0}
  .btn-primary{background:#3b3a30;color:#fff;border-color:#3b3a30}
  .btn-primary:hover{background:#5a4f3a}
  table{border-collapse:collapse;width:100%;background:#fff;border-radius:6px;overflow:hidden;font-size:13px;margin:8px 0}
  th,td{padding:8px 12px;text-align:left;border-bottom:1px solid #e8e0c8;vertical-align:top}
  th{background:#f0e8d0;font-weight:500;font-size:12px}
  .badge{display:inline-block;padding:1px 7px;border-radius:10px;font-size:10px;font-weight:500}
  .b-positive{background:#d8e8d8;color:#5a8a5a}
  .b-negative{background:#fde2da;color:#c43}
  .b-neutral{background:#f0e8d0;color:#7a6f4a}
  .b-urgent{background:#a30;color:#fff}
  .empty{padding:30px;text-align:center;color:#888;font-style:italic}
  textarea,input[type=text],input[type=url],select{padding:6px 10px;border:1px solid #c0b890;border-radius:4px;font-size:13px;font-family:inherit}
  textarea{width:100%;min-height:80px}
  .review-text{white-space:pre-wrap;max-width:400px}
  pre{background:#fdf8e8;padding:10px;border-radius:4px;font-size:12px;white-space:pre-wrap;border:1px solid #e8d8b0}
  .template-card{background:#fff;border:1px solid #e0d8c0;border-radius:6px;padding:12px;margin:8px 0}
  .template-card .title{font-weight:500;margin-bottom:4px}
  .template-card .body{white-space:pre-wrap;font-size:12px;color:#555;font-family:Georgia,serif}
</style></head><body>
<h1>💬 Customer Care — Sondervn</h1>
<div class="meta" id="last">Loading…</div>

<div class="actions">
  <button class="btn-primary" onclick="syncReviews()">🔄 Sync FB Reviews</button>
  <button onclick="syncInbox()">📥 Sync FB Comments</button>
  <button onclick="auditFB()">📊 Audit FB Pages</button>
  <button onclick="auditIG()">📷 Audit Instagram</button>
  <button onclick="seedTemplates()">🌱 Seed default templates</button>
  <button onclick="load()">⟳ Refresh</button>
</div>

<div class="tabs">
  <div class="tab active" data-t="reviews" onclick="switchTab('reviews')">⭐ Reviews</div>
  <div class="tab" data-t="inbox" onclick="switchTab('inbox')">💬 Comments inbox</div>
  <div class="tab" data-t="templates" onclick="switchTab('templates')">📝 Response templates</div>
  <div class="tab" data-t="social-fb" onclick="switchTab('social-fb')">📘 Facebook SEO</div>
  <div class="tab" data-t="social-ig" onclick="switchTab('social-ig')">📷 Instagram SEO</div>
</div>

<div id="overview"></div>
<div id="content">Loading…</div>

<script>
let activeTab = 'reviews';

async function load() {
  const r = await fetch('/api/care/overview').then((r) => r.json());
  document.getElementById('last').textContent = 'Updated: ' + new Date().toLocaleString('vi-VN');
  let h = '<h2>📊 Tổng quan</h2><div class="stats">';
  h += card('total', 'Reviews total', r.reviews.total);
  h += card('positive', 'Positive', r.reviews.by_sentiment?.find?.((x) => x.sentiment === 'positive')?.n || 0);
  h += card('negative', 'Negative', r.reviews.by_sentiment?.find?.((x) => x.sentiment === 'negative')?.n || 0);
  h += card('urgent', '🚨 Urgent', r.reviews.urgent);
  h += card('warn', 'Needs response', r.reviews.needs_response);
  h += card('total', 'Inbox last 24h', r.inbox.last_24h);
  h += card('warn', 'Comments needing response', r.inbox.needs_response);
  h += card('total', 'Active templates', r.templates.total);
  h += card('total', 'FB Pages audited', r.social.facebook_pages);
  h += card('total', 'IG profiles audited', r.social.instagram_profiles);
  h += '</div>';
  document.getElementById('overview').innerHTML = h;
  await loadTab(activeTab);
}

function card(slug, label, num) { return '<div class="stat stat-' + slug + '"><div class="num">' + num + '</div><div class="lbl">' + label + '</div></div>'; }
function escapeHtml(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function escapeAttr(s) { return escapeHtml(s); }

async function switchTab(t) { activeTab = t; document.querySelectorAll('.tab').forEach(el => el.classList.toggle('active', el.dataset.t === t)); await loadTab(t); }

async function loadTab(t) {
  const wrap = document.getElementById('content');
  if (t === 'reviews') {
    const r = await fetch('/api/care/reviews?limit=80').then((x) => x.json());
    if (r.items.length === 0) return wrap.innerHTML = '<div class="empty">Chưa có review nào. Bấm "Sync FB Reviews" hoặc nhập manual Google review.</div>';
    let h = '<table><thead><tr><th>Source</th><th>Author</th><th>Sentiment</th><th>Text</th><th>Date</th><th></th></tr></thead><tbody>';
    for (const v of r.items) {
      const sent = '<span class="badge b-' + v.sentiment + '">' + v.sentiment + '</span>'
        + (v.is_urgent ? ' <span class="badge b-urgent">URGENT</span>' : '');
      h += '<tr><td>' + v.source + '</td>';
      h += '<td><strong>' + escapeHtml(v.author_name || '?') + '</strong>' + (v.rating ? '<br>⭐'.repeat(v.rating) : '') + '</td>';
      h += '<td>' + sent + '<br><span style="font-size:11px;color:#666">' + escapeHtml(v.sentiment_reason || '') + '</span></td>';
      h += '<td class="review-text">' + escapeHtml((v.text || '').slice(0, 400)) + '</td>';
      h += '<td style="font-size:11px;color:#888">' + new Date(v.created_at_source).toLocaleDateString('vi-VN') + '</td>';
      h += '<td>';
      if (!v.has_response) h += '<button onclick="suggestForReview(' + v.id + ')">💡 Suggest reply</button> ';
      h += '<button onclick="markResponded(' + v.id + ')">✓ Replied</button>';
      h += '</td></tr>';
    }
    h += '</tbody></table>';
    wrap.innerHTML = h;
    return;
  }
  if (t === 'inbox') {
    const r = await fetch('/api/care/inbox?limit=80').then((x) => x.json());
    if (r.items.length === 0) return wrap.innerHTML = '<div class="empty">No comments synced. Bấm "Sync FB Comments".</div>';
    let h = '<table><thead><tr><th>Author</th><th>Comment</th><th>Sentiment</th><th>Flag</th><th>When</th><th></th></tr></thead><tbody>';
    for (const c of r.items) {
      h += '<tr><td><strong>' + escapeHtml(c.author_name || '?') + '</strong></td>';
      h += '<td class="review-text">' + escapeHtml((c.text || '').slice(0, 400)) + '</td>';
      h += '<td><span class="badge b-' + c.sentiment + '">' + c.sentiment + '</span></td>';
      h += '<td>' + (c.is_question ? '❓' : '') + (c.needs_response ? ' ⚠️' : '') + '</td>';
      h += '<td style="font-size:11px">' + new Date(c.detected_at).toLocaleDateString('vi-VN') + '</td>';
      h += '<td><button onclick="suggestForComment(' + c.id + ')">💡</button> <button onclick="markComResponded(' + c.id + ')">✓</button></td>';
      h += '</tr>';
    }
    h += '</tbody></table>';
    wrap.innerHTML = h;
    return;
  }
  if (t === 'templates') {
    const r = await fetch('/api/care/templates?all=true').then((x) => x.json());
    let h = '<div class="actions"><button class="btn-primary" onclick="newTemplate()">+ Add template</button></div>';
    if (r.items.length === 0) {
      h += '<div class="empty">No templates. Bấm "Seed default templates" để tạo 6 mẫu sẵn.</div>';
    } else {
      for (const t of r.items) {
        h += '<div class="template-card">';
        h += '<div class="title">' + escapeHtml(t.title) + ' <span class="badge b-neutral">' + t.category + '</span> <span class="badge b-' + (t.active ? 'positive' : 'neutral') + '">' + (t.active ? 'active' : 'paused') + '</span> <span style="color:#888;font-size:11px">used ' + t.use_count + 'x</span></div>';
        h += '<div class="body">' + escapeHtml(t.body) + '</div>';
        h += '<div style="margin-top:8px;display:flex;gap:6px"><button onclick="editTemplate(' + t.id + ')">Edit</button><button onclick="copyTemplate(' + t.id + ')">📋 Copy</button><button onclick="delTemplate(' + t.id + ')">🗑️</button></div>';
        h += '</div>';
      }
    }
    wrap.innerHTML = h;
    return;
  }
  if (t === 'social-fb') {
    const r = await fetch('/api/care/social/facebook').then((x) => x.json());
    if (r.items.length === 0) return wrap.innerHTML = '<div class="empty">No audit yet. Bấm "Audit FB Pages".</div>';
    let h = '';
    for (const a of r.items) {
      const colorScore = a.total_score >= 80 ? '#5a8a5a' : a.total_score >= 60 ? '#a86b3c' : '#c54';
      h += '<h3>' + escapeHtml(a.name) + ' <span style="color:' + colorScore + ';font-size:28px">' + a.total_score + '/100</span></h3>';
      h += '<div class="stats">';
      h += card('total', 'Followers', a.followers);
      h += card('total', 'Posts /week', a.posts_per_week);
      h += card('total', 'Avg engage', a.avg_engagement);
      h += card('total', 'Completeness', a.completeness_score + '/60');
      h += card('total', 'Activity', a.activity_score + '/40');
      h += '</div>';
      if (a.issues.length > 0) {
        h += '<h3>Issues to fix</h3><ul>';
        for (const i of a.issues) h += '<li>' + escapeHtml(i) + '</li>';
        h += '</ul>';
      }
    }
    wrap.innerHTML = h;
    return;
  }
  if (t === 'social-ig') {
    const r = await fetch('/api/care/social/instagram').then((x) => x.json());
    if (r.items.length === 0) return wrap.innerHTML = '<div class="empty">No IG audit. Bấm "Audit Instagram" (cần IG Business linked to FB Page).</div>';
    let h = '';
    for (const a of r.items) {
      const colorScore = a.total_score >= 80 ? '#5a8a5a' : a.total_score >= 60 ? '#a86b3c' : '#c54';
      h += '<h3>@' + escapeHtml(a.ig_username) + ' <span style="color:' + colorScore + ';font-size:28px">' + a.total_score + '/100</span></h3>';
      h += '<div class="stats">';
      h += card('total', 'Followers', a.followers_count);
      h += card('total', 'Media count', a.media_count);
      h += card('total', 'Posts last 30 (sample)', a.recent_posts);
      h += card('total', 'Avg hashtags', a.avg_hashtags);
      h += card('total', 'Hashtag diversity', a.hashtag_diversity_score);
      h += card('total', 'Avg likes', a.avg_likes);
      h += '</div>';
      if (a.issues.length > 0) {
        h += '<h3>Issues</h3><ul>';
        for (const i of a.issues) h += '<li>' + escapeHtml(i) + '</li>';
        h += '</ul>';
      }
      if (a.top_hashtags && a.top_hashtags.length > 0) {
        h += '<h3>Top hashtags used</h3><div>';
        for (const t of a.top_hashtags) h += '<span class="badge b-neutral" style="margin:2px;font-size:11px">' + escapeHtml(t.tag) + ' (' + t.count + ')</span>';
        h += '</div>';
      }
    }
    wrap.innerHTML = h;
    return;
  }
}

async function syncReviews() {
  if (!confirm('Sync FB Reviews now? (gọi Graph API)')) return;
  const r = await fetch('/api/care/reviews/sync', { method: 'POST' }).then((x) => x.json());
  alert(JSON.stringify(r, null, 2));
  load();
}
async function syncInbox() {
  if (!confirm('Sync FB Comments inbox?')) return;
  const r = await fetch('/api/care/inbox/sync', { method: 'POST' }).then((x) => x.json());
  alert(JSON.stringify(r, null, 2));
  load();
}
async function auditFB() {
  const r = await fetch('/api/care/social/facebook/audit', { method: 'POST' }).then((x) => x.json());
  alert(JSON.stringify(r, null, 2));
  load();
}
async function auditIG() {
  const r = await fetch('/api/care/social/instagram/audit', { method: 'POST' }).then((x) => x.json());
  alert(JSON.stringify(r, null, 2));
  load();
}
async function seedTemplates() {
  const r = await fetch('/api/care/templates/seed', { method: 'POST' }).then((x) => x.json());
  alert('Created: ' + r.created);
  load();
}
async function markResponded(id) { await fetch('/api/care/reviews/' + id + '/responded', { method: 'POST' }); loadTab('reviews'); }
async function markComResponded(id) { await fetch('/api/care/inbox/' + id + '/responded', { method: 'POST' }); loadTab('inbox'); }
async function delTemplate(id) { if (!confirm('Delete?')) return; await fetch('/api/care/templates/' + id, { method: 'DELETE' }); loadTab('templates'); }

async function suggestForReview(id) {
  // Get review text first
  const r = await fetch('/api/care/reviews?limit=200').then((x) => x.json());
  const review = r.items.find((x) => x.id === id);
  if (!review) return;
  const s = await fetch('/api/care/templates/suggest', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: review.text, language: review.language || 'vi', limit: 3 }),
  }).then((x) => x.json());
  if (!s.items || s.items.length === 0) return alert('No matching templates.');
  let msg = 'Suggested templates:\\n\\n';
  for (const t of s.items) msg += '— ' + t.title + ' (match=' + t.match_score.toFixed(1) + ')\\n' + t.body.slice(0, 150) + '...\\n\\n';
  alert(msg);
}

async function suggestForComment(id) {
  const r = await fetch('/api/care/inbox?limit=200').then((x) => x.json());
  const c = r.items.find((x) => x.id === id);
  if (!c) return;
  const s = await fetch('/api/care/templates/suggest', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: c.text, language: 'vi', limit: 3 }),
  }).then((x) => x.json());
  if (!s.items || s.items.length === 0) return alert('No matching templates.');
  let msg = 'Suggested templates:\\n\\n';
  for (const t of s.items) msg += '— ' + t.title + '\\n' + t.body + '\\n\\n';
  alert(msg);
}

async function copyTemplate(id) {
  const r = await fetch('/api/care/templates/' + id + '/render', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ variables: {} }),
  }).then((x) => x.json());
  if (r.rendered) {
    navigator.clipboard.writeText(r.rendered);
    alert('Copied to clipboard:\\n\\n' + r.rendered);
  }
}

function newTemplate() {
  const title = prompt('Title:'); if (!title) return;
  const category = prompt('Category (greeting | thanks | apology | info_room | info_pricing | response_positive_review | response_negative_review | response_question | follow_up | other):', 'response_question'); if (!category) return;
  const body = prompt('Body (use {{var}} for placeholders):'); if (!body) return;
  fetch('/api/care/templates', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, category, body, language: 'vi' }),
  }).then(() => loadTab('templates'));
}

function editTemplate(id) {
  fetch('/api/care/templates/' + id).then((r) => r.json()).then((t) => {
    const body = prompt('Edit body:', t.body); if (body === null) return;
    const title = prompt('Edit title:', t.title); if (title === null) return;
    fetch('/api/care/templates', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, title, category: t.category, body, language: t.language }),
    }).then(() => loadTab('templates'));
  });
}

load();
</script>
</body></html>`);
});

export default router;

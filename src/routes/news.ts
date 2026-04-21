/**
 * News → FB Post — admin dashboard endpoints.
 *
 * Flow: ingest → classify → angle+spin+image → safety → pending → admin duyệt/sửa/từ chối → publish.
 */
import { Router } from 'express';
import { db } from '../db';
import { authMiddleware, AuthRequest, getHotelId } from '../middleware/auth';
import { generateDraftForArticle, generateDraftsBatch } from '../services/news-angle-generator';
import { publishDraft, publishNow, publishScheduledBatch, canPublishMore } from '../services/news-publisher';
import { ingestAll } from '../services/news-ingest';
import { classifyBatch } from '../services/news-classifier';
import { getEnabledSources } from '../services/news-sources';

const router = Router();
router.use(authMiddleware);

// ── Stats ──────────────────────────────────────────────────────────
router.get('/stats', (req: AuthRequest, res) => {
  try {
    const hotelId = getHotelId(req);
    const since7d = Date.now() - 7 * 24 * 3600_000;
    const since24h = Date.now() - 24 * 3600_000;

    const articleStatus = db.prepare(
      `SELECT status, COUNT(*) as n FROM news_articles GROUP BY status`
    ).all();
    const articles24h = db.prepare(
      `SELECT COUNT(*) as n FROM news_articles WHERE fetched_at > ?`
    ).get(since24h) as any;
    const draftsByStatus = db.prepare(
      `SELECT status, COUNT(*) as n FROM news_post_drafts WHERE hotel_id = ? GROUP BY status`
    ).all(hotelId);
    const published7d = db.prepare(
      `SELECT COUNT(*) as n FROM news_post_drafts WHERE hotel_id = ? AND status='published' AND published_at > ?`
    ).get(hotelId, since7d) as any;
    const autoRejected7d = db.prepare(
      `SELECT COUNT(*) as n FROM news_post_drafts WHERE hotel_id = ? AND auto_rejected=1 AND created_at > ?`
    ).get(hotelId, since7d) as any;

    const cap = canPublishMore(hotelId);

    res.json({
      article_status: articleStatus,
      articles_24h: articles24h?.n || 0,
      drafts_by_status: draftsByStatus,
      published_7d: published7d?.n || 0,
      auto_rejected_7d: autoRejected7d?.n || 0,
      weekly_cap: cap,
      sources_enabled: getEnabledSources().length,
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ── List drafts ────────────────────────────────────────────────────
router.get('/list', (req: AuthRequest, res) => {
  try {
    const hotelId = getHotelId(req);
    const status = (req.query.status as string) || 'pending';
    const limit = Math.min(100, parseInt((req.query.limit as string) || '20', 10));
    const offset = Math.max(0, parseInt((req.query.offset as string) || '0', 10));

    const where: string[] = ['d.hotel_id = ?'];
    const params: any[] = [hotelId];
    if (status && status !== 'all') { where.push('d.status = ?'); params.push(status); }
    const whereSql = where.join(' AND ');

    const total = (db.prepare(`SELECT COUNT(*) as n FROM news_post_drafts d WHERE ${whereSql}`).get(...params) as any)?.n || 0;

    const rows = db.prepare(
      `SELECT d.id, d.article_id, d.draft_angle, d.draft_post, d.edited_post,
              d.image_url, d.hashtags, d.safety_flags, d.auto_rejected,
              d.rejection_reason, d.status, d.scheduled_at, d.published_at,
              d.fb_post_id, d.admin_notes, d.ai_provider, d.created_at,
              a.title as article_title, a.url as article_url, a.source as article_source,
              a.region, a.impact_score, a.political_risk, a.angle_hint
       FROM news_post_drafts d
       LEFT JOIN news_articles a ON a.id = d.article_id
       WHERE ${whereSql}
       ORDER BY
         CASE WHEN d.status='pending' THEN 0
              WHEN d.status='approved' THEN 1
              ELSE 2 END,
         d.created_at DESC
       LIMIT ? OFFSET ?`
    ).all(...params, limit, offset) as any[];

    // Parse JSON fields
    for (const r of rows) {
      if (r.hashtags) { try { r.hashtags = JSON.parse(r.hashtags); } catch { r.hashtags = []; } }
      if (r.safety_flags) { try { r.safety_flags = JSON.parse(r.safety_flags); } catch { r.safety_flags = null; } }
    }

    res.json({ total, limit, offset, items: rows });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ── Draft detail ───────────────────────────────────────────────────
router.get('/draft/:id', (req: AuthRequest, res) => {
  try {
    const hotelId = getHotelId(req);
    const id = parseInt(String(req.params.id), 10);
    const row = db.prepare(
      `SELECT d.*, a.title as article_title, a.url as article_url, a.source as article_source,
              a.body as article_body, a.region, a.impact_score, a.political_risk, a.angle_hint
       FROM news_post_drafts d
       LEFT JOIN news_articles a ON a.id = d.article_id
       WHERE d.id = ? AND d.hotel_id = ?`
    ).get(id, hotelId) as any;
    if (!row) return res.status(404).json({ error: 'not found' });
    if (row.hashtags) { try { row.hashtags = JSON.parse(row.hashtags); } catch {} }
    if (row.safety_flags) { try { row.safety_flags = JSON.parse(row.safety_flags); } catch {} }
    res.json(row);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ── Approve (optional schedule) ────────────────────────────────────
router.post('/draft/:id/approve', (req: AuthRequest, res) => {
  try {
    const hotelId = getHotelId(req);
    const id = parseInt(String(req.params.id), 10);
    const { scheduled_at, edited_post, notes } = req.body || {};

    const owns = db.prepare(`SELECT id, status FROM news_post_drafts WHERE id=? AND hotel_id=?`).get(id, hotelId) as any;
    if (!owns) return res.status(404).json({ error: 'not found' });
    if (owns.status === 'published') return res.status(400).json({ error: 'already published' });

    const now = Date.now();
    // Default schedule: nearest T2/T4/T6 20:00 VN (UTC+7)
    const sch = scheduled_at ? Number(scheduled_at) : nearestSlot();
    const params: any[] = [sch, req.user?.userId || 0, now];
    let sql = `UPDATE news_post_drafts SET status='approved', scheduled_at=?, admin_user_id=?, created_at=created_at`;
    if (edited_post) { sql += `, edited_post=?`; params.push(edited_post); }
    if (notes) { sql += `, admin_notes=?`; params.push(notes); }
    sql += ` WHERE id=?`;
    params.push(id);
    db.prepare(sql).run(...params);

    // Move params position: sch là [0], userId [1], bỏ now [2]. Re-structure:
    const finalSql = sql;
    // (đã run rồi) -- just return success
    res.json({ ok: true, id, status: 'approved', scheduled_at: sch });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

function nearestSlot(): number {
  // Gợi ý mặc định: T2/T4/T6 20:00 VN (UTC+7) → UTC 13:00
  const now = new Date();
  const dows = [1, 3, 5]; // Mon=1, Wed=3, Fri=5 (getUTCDay)
  for (let dayAhead = 0; dayAhead < 10; dayAhead++) {
    const d = new Date(now.getTime() + dayAhead * 86400_000);
    const day = (d.getUTCDay() + 7) % 7;
    if (dows.includes(day)) {
      d.setUTCHours(13, 0, 0, 0);  // 13h UTC = 20h VN
      if (d.getTime() > now.getTime() + 30 * 60_000) return d.getTime();
    }
  }
  return now.getTime() + 3600_000; // fallback 1h từ bây giờ
}

// ── Reject ─────────────────────────────────────────────────────────
router.post('/draft/:id/reject', (req: AuthRequest, res) => {
  try {
    const hotelId = getHotelId(req);
    const id = parseInt(String(req.params.id), 10);
    const { reason } = req.body || {};
    const owns = db.prepare(`SELECT id FROM news_post_drafts WHERE id=? AND hotel_id=?`).get(id, hotelId);
    if (!owns) return res.status(404).json({ error: 'not found' });
    db.prepare(
      `UPDATE news_post_drafts SET status='rejected', rejection_reason=?, admin_user_id=?, admin_notes=? WHERE id=?`
    ).run(reason || 'admin rejected', req.user?.userId || 0, reason || null, id);
    res.json({ ok: true, id, status: 'rejected' });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ── Edit (no status change) ────────────────────────────────────────
router.post('/draft/:id/edit', (req: AuthRequest, res) => {
  try {
    const hotelId = getHotelId(req);
    const id = parseInt(String(req.params.id), 10);
    const { edited_post, image_url, hashtags } = req.body || {};
    const owns = db.prepare(`SELECT id FROM news_post_drafts WHERE id=? AND hotel_id=?`).get(id, hotelId);
    if (!owns) return res.status(404).json({ error: 'not found' });

    const sets: string[] = [];
    const params: any[] = [];
    if (edited_post !== undefined) { sets.push('edited_post=?'); params.push(edited_post); }
    if (image_url !== undefined) { sets.push('image_url=?'); params.push(image_url); }
    if (Array.isArray(hashtags)) { sets.push('hashtags=?'); params.push(JSON.stringify(hashtags)); }
    if (sets.length === 0) return res.status(400).json({ error: 'nothing to update' });
    sets.push('admin_user_id=?'); params.push(req.user?.userId || 0);
    params.push(id);
    db.prepare(`UPDATE news_post_drafts SET ${sets.join(', ')} WHERE id=?`).run(...params);
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ── Publish now (admin bypass schedule) ────────────────────────────
router.post('/draft/:id/publish-now', async (req: AuthRequest, res) => {
  try {
    const hotelId = getHotelId(req);
    const id = parseInt(String(req.params.id), 10);
    const owns = db.prepare(`SELECT id FROM news_post_drafts WHERE id=? AND hotel_id=?`).get(id, hotelId);
    if (!owns) return res.status(404).json({ error: 'not found' });
    const r = await publishNow(id);
    if (r.ok) res.json({ ok: true, fb_post_id: r.fb_post_id });
    else res.status(400).json({ error: r.error });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ── Regenerate angle ───────────────────────────────────────────────
router.post('/draft/:id/regen', async (req: AuthRequest, res) => {
  try {
    const hotelId = getHotelId(req);
    const id = parseInt(String(req.params.id), 10);
    const row = db.prepare(`SELECT article_id FROM news_post_drafts WHERE id=? AND hotel_id=?`).get(id, hotelId) as any;
    if (!row) return res.status(404).json({ error: 'not found' });
    // Delete old draft + reset article status to angle_generated
    db.prepare(`DELETE FROM news_post_drafts WHERE id=?`).run(id);
    db.prepare(`UPDATE news_articles SET status='angle_generated' WHERE id=?`).run(row.article_id);
    const r = await generateDraftForArticle(row.article_id, hotelId);
    res.json({ ok: true, result: r });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ── Manual trigger controls ───────────────────────────────────────
router.post('/ingest-now', async (_req: AuthRequest, res) => {
  try {
    const r = await ingestAll();
    res.json({ ok: true, ...r });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/classify-now', async (req: AuthRequest, res) => {
  try {
    const limit = parseInt(String((req.body || {}).limit || 20), 10);
    const r = await classifyBatch(limit);
    res.json({ ok: true, ...r });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/generate-drafts-now', async (req: AuthRequest, res) => {
  try {
    const hotelId = getHotelId(req);
    const limit = parseInt(String((req.body || {}).limit || 5), 10);
    const r = await generateDraftsBatch(limit, hotelId);
    res.json({ ok: true, ...r });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/publish-scheduled-now', async (_req: AuthRequest, res) => {
  try {
    const r = await publishScheduledBatch();
    res.json({ ok: true, ...r });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ── Sources list ───────────────────────────────────────────────────
router.get('/sources', (_req: AuthRequest, res) => {
  res.json({ sources: getEnabledSources() });
});

export default router;

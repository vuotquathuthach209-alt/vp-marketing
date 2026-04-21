/**
 * Content Intelligence API — phân tích + remix bài viết.
 */
import { Router } from 'express';
import { db } from '../db';
import { authMiddleware, AuthRequest, getHotelId } from '../middleware/auth';
import {
  getTopInternalPosts,
  extractInternalPatterns,
  analyzeInspiration,
  remixPost,
} from '../services/content-intelligence';

const router = Router();
router.use(authMiddleware);

/* ═══════════════════ MODULE 1: Internal Post Miner ═══════════════════ */

router.get('/internal-top', (req: AuthRequest, res) => {
  try {
    const days = Math.min(90, Math.max(1, parseInt((req.query.days as string) || '30', 10)));
    const limit = Math.min(50, Math.max(5, parseInt((req.query.limit as string) || '20', 10)));
    const posts = getTopInternalPosts({ hotelId: getHotelId(req), days, limit });
    const patterns = extractInternalPatterns(posts);
    res.json({
      period_days: days,
      total: posts.length,
      posts,
      patterns,
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

/* ═══════════════════ MODULE 2: Inspiration Analyzer ═══════════════════ */

router.post('/inspiration/analyze', async (req: AuthRequest, res) => {
  try {
    const hotelId = getHotelId(req);
    const { text, source_name, source_url, source_type, language } = req.body || {};
    if (!text || typeof text !== 'string' || text.length < 30) {
      return res.status(400).json({ error: 'text required (≥30 chars)' });
    }
    if (text.length > 5000) {
      return res.status(400).json({ error: 'text too long (max 5000)' });
    }

    const analysis = await analyzeInspiration(text);
    if (!analysis) {
      return res.status(500).json({ error: 'analysis failed' });
    }

    const now = Date.now();
    const r = db.prepare(
      `INSERT INTO inspiration_posts (
        hotel_id, source_name, source_url, source_type, original_text, language,
        pattern_hook, pattern_emotion, pattern_structure, pattern_cta,
        topic_tags, ai_insights, remix_angle_suggestions,
        status, created_at, analyzed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'analyzed', ?, ?)`
    ).run(
      hotelId, source_name || null, source_url || null, source_type || 'facebook',
      text, language || 'vi',
      analysis.hook, analysis.emotion, analysis.structure, analysis.cta,
      JSON.stringify(analysis.topic_tags), analysis.why_it_works,
      JSON.stringify(analysis.remix_angles),
      now, now,
    );
    res.json({ ok: true, id: Number(r.lastInsertRowid), analysis });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/inspiration/list', (req: AuthRequest, res) => {
  try {
    const hotelId = getHotelId(req);
    const limit = Math.min(100, Math.max(5, parseInt((req.query.limit as string) || '20', 10)));
    const rows = db.prepare(
      `SELECT id, source_name, source_url, source_type,
              substr(original_text, 1, 200) as preview,
              pattern_hook, pattern_emotion, pattern_structure, pattern_cta,
              topic_tags, remix_angle_suggestions, ai_insights,
              likes, comments, shares, engagement_rate,
              status, created_at
       FROM inspiration_posts WHERE hotel_id = ?
       ORDER BY created_at DESC LIMIT ?`
    ).all(hotelId, limit) as any[];
    for (const r of rows) {
      try { r.topic_tags = r.topic_tags ? JSON.parse(r.topic_tags) : []; } catch { r.topic_tags = []; }
      try { r.remix_angle_suggestions = r.remix_angle_suggestions ? JSON.parse(r.remix_angle_suggestions) : []; } catch { r.remix_angle_suggestions = []; }
    }
    res.json({ items: rows });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/inspiration/:id', (req: AuthRequest, res) => {
  try {
    const hotelId = getHotelId(req);
    const id = parseInt(String(req.params.id), 10);
    const row = db.prepare(
      `SELECT * FROM inspiration_posts WHERE id = ? AND hotel_id = ?`
    ).get(id, hotelId) as any;
    if (!row) return res.status(404).json({ error: 'not found' });
    try { row.topic_tags = row.topic_tags ? JSON.parse(row.topic_tags) : []; } catch {}
    try { row.remix_angle_suggestions = row.remix_angle_suggestions ? JSON.parse(row.remix_angle_suggestions) : []; } catch {}
    res.json(row);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/inspiration/:id/update-metrics', (req: AuthRequest, res) => {
  try {
    const hotelId = getHotelId(req);
    const id = parseInt(String(req.params.id), 10);
    const { likes, comments, shares, reach } = req.body || {};
    const owns = db.prepare(`SELECT id FROM inspiration_posts WHERE id = ? AND hotel_id = ?`).get(id, hotelId);
    if (!owns) return res.status(404).json({ error: 'not found' });
    const engScore = (likes || 0) + 3 * (comments || 0) + 5 * (shares || 0);
    const engRate = reach ? engScore / reach : 0;
    db.prepare(
      `UPDATE inspiration_posts SET likes=?, comments=?, shares=?, reach=?, engagement_rate=? WHERE id=?`
    ).run(likes || 0, comments || 0, shares || 0, reach || 0, engRate, id);
    res.json({ ok: true, engagement_rate: +engRate.toFixed(4) });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.delete('/inspiration/:id', (req: AuthRequest, res) => {
  try {
    const hotelId = getHotelId(req);
    const id = parseInt(String(req.params.id), 10);
    const r = db.prepare(`DELETE FROM inspiration_posts WHERE id = ? AND hotel_id = ?`).run(id, hotelId);
    res.json({ ok: true, deleted: r.changes });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

/* ═══════════════════ MODULE 3: Remixer ═══════════════════ */

router.post('/remix', async (req: AuthRequest, res) => {
  try {
    const hotelId = getHotelId(req);
    const { inspiration_id, target_angle, brand_voice, custom_instruction, custom_text } = req.body || {};

    let inspirationText: string;
    let analysis: any = null;
    let inspId: number | null = null;

    if (inspiration_id) {
      const row = db.prepare(
        `SELECT original_text, pattern_hook, pattern_emotion, pattern_structure, pattern_cta,
                topic_tags, remix_angle_suggestions
         FROM inspiration_posts WHERE id = ? AND hotel_id = ?`
      ).get(inspiration_id, hotelId) as any;
      if (!row) return res.status(404).json({ error: 'inspiration not found' });
      inspirationText = row.original_text;
      inspId = parseInt(String(inspiration_id), 10);
      analysis = {
        hook: row.pattern_hook,
        emotion: row.pattern_emotion,
        structure: row.pattern_structure,
        cta: row.pattern_cta,
      };
    } else if (custom_text) {
      inspirationText = String(custom_text);
    } else {
      return res.status(400).json({ error: 'inspiration_id hoặc custom_text required' });
    }

    // Lookup hotel name + product_group
    const hotel = db.prepare(
      `SELECT name, product_group, brand_voice FROM v_hotel_bot_context WHERE mkt_hotel_id = ? LIMIT 1`
    ).get(hotelId) as any;

    const result = await remixPost({
      inspirationText,
      inspirationAnalysis: analysis,
      targetAngle: target_angle,
      hotelName: hotel?.name,
      brandVoice: brand_voice || hotel?.brand_voice || 'friendly',
      productGroup: hotel?.product_group,
      customInstruction: custom_instruction,
    });

    if (!result) return res.status(500).json({ error: 'remix failed' });

    // Save draft
    const now = Date.now();
    const r = db.prepare(
      `INSERT INTO remix_drafts (
        inspiration_id, hotel_id, remix_angle, remix_text, brand_voice, hashtags,
        ai_provider, ai_tokens_used, status, admin_user_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)`
    ).run(
      inspId, hotelId, target_angle || null, result.remix_text,
      brand_voice || 'friendly', JSON.stringify(result.hashtags),
      result.provider, result.tokens_used, req.user?.userId || 0, now,
    );

    res.json({
      ok: true,
      draft_id: Number(r.lastInsertRowid),
      remix_text: result.remix_text,
      hashtags: result.hashtags,
      originality_score: result.originality_score,
      originality_rating: result.originality_score >= 0.85 ? '✅ An toàn' : result.originality_score >= 0.7 ? '⚠️ Khá giống' : '🚫 Quá giống — nên regenerate',
      provider: result.provider,
      tokens: result.tokens_used,
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/remix/drafts', (req: AuthRequest, res) => {
  try {
    const hotelId = getHotelId(req);
    const status = (req.query.status as string) || 'draft';
    const rows = db.prepare(
      `SELECT d.*, i.source_name, i.source_url, substr(i.original_text, 1, 100) as inspiration_preview
       FROM remix_drafts d
       LEFT JOIN inspiration_posts i ON i.id = d.inspiration_id
       WHERE d.hotel_id = ? AND d.status = ?
       ORDER BY d.created_at DESC LIMIT 50`
    ).all(hotelId, status) as any[];
    for (const r of rows) {
      try { r.hashtags = r.hashtags ? JSON.parse(r.hashtags) : []; } catch { r.hashtags = []; }
    }
    res.json({ drafts: rows });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/remix/:id/approve', (req: AuthRequest, res) => {
  try {
    const hotelId = getHotelId(req);
    const id = parseInt(String(req.params.id), 10);
    const { scheduled_at, edited_text } = req.body || {};
    const owns = db.prepare(`SELECT id FROM remix_drafts WHERE id = ? AND hotel_id = ?`).get(id, hotelId);
    if (!owns) return res.status(404).json({ error: 'not found' });
    const params: any[] = [];
    let sql = `UPDATE remix_drafts SET status = 'approved'`;
    if (scheduled_at) { sql += `, scheduled_at = ?`; params.push(scheduled_at); }
    if (edited_text) { sql += `, remix_text = ?`; params.push(edited_text); }
    sql += ` WHERE id = ?`;
    params.push(id);
    db.prepare(sql).run(...params);
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.delete('/remix/:id', (req: AuthRequest, res) => {
  try {
    const hotelId = getHotelId(req);
    const id = parseInt(String(req.params.id), 10);
    db.prepare(`DELETE FROM remix_drafts WHERE id = ? AND hotel_id = ?`).run(id, hotelId);
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

export default router;

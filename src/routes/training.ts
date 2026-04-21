/**
 * Training Review — Admin duyệt Q&A pairs từ qa_training_cache.
 *
 * Flow:
 *   Bot reply RAG → save tier=pending
 *   Admin vào tab "Training Review" → list pending → approve/reject/edit
 *   Đã approve → next time match ≥ 0.7 sẽ short-circuit LLM (0 token cost)
 *
 * Endpoints:
 *   GET  /api/training/stats            — totals theo tier + provider
 *   GET  /api/training/list             — phân trang + filter
 *   GET  /api/training/:id              — chi tiết (bao gồm embeddings length)
 *   POST /api/training/:id/approve      — duyệt (có thể edit response)
 *   POST /api/training/:id/reject       — từ chối (cần reason)
 *   POST /api/training/:id/blacklist    — chặn pattern spam
 *   POST /api/training/seed             — admin tạo Q&A thủ công (preseed approved)
 *   POST /api/training/promote-trusted  — housekeeping: auto-promote approved → trusted
 */
import { Router } from 'express';
import { db } from '../db';
import { authMiddleware, AuthRequest, getHotelId } from '../middleware/auth';
import {
  approveQA,
  rejectQA,
  blacklistQA,
  saveNewQA,
  autoPromoteTrusted,
  autoDemoteOnBadFeedback,
  getTrainingStats,
} from '../services/intent-matcher';
import {
  manualFeedback,
  getRecentFeedback,
  getFeedbackStats,
} from '../services/qa-feedback-tracker';
import { PRICING, estimateCost } from '../services/costtrack';
import { getSetting, setSetting } from '../db';

const router = Router();
router.use(authMiddleware);

// ── Stats ──────────────────────────────────────────────────────────
router.get('/stats', (req: AuthRequest, res) => {
  try {
    const hotelId = getHotelId(req);
    const stats = getTrainingStats(hotelId);
    // Extra: cache hits 7 days (events table: event_name + ts)
    let cacheHits7d = 0;
    try {
      const ev = db.prepare(
        `SELECT COUNT(*) as n FROM events WHERE event_name = 'qa_cache_hit' AND ts > ?`
      ).get(Date.now() - 7 * 24 * 3600_000) as any;
      cacheHits7d = ev?.n || 0;
    } catch { /* events table may not exist yet */ }
    res.json({ ...stats, cache_hits_7d: cacheHits7d });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ── List với filter + pagination ───────────────────────────────────
router.get('/list', (req: AuthRequest, res) => {
  try {
    const hotelId = getHotelId(req);
    const tier = (req.query.tier as string) || 'pending';
    const provider = (req.query.provider as string) || '';
    const intent = (req.query.intent as string) || '';
    const limit = Math.min(100, parseInt((req.query.limit as string) || '20', 10));
    const offset = Math.max(0, parseInt((req.query.offset as string) || '0', 10));

    const where: string[] = ['hotel_id = ?'];
    const params: any[] = [hotelId];
    if (tier && tier !== 'all') { where.push('tier = ?'); params.push(tier); }
    if (provider) { where.push('ai_provider = ?'); params.push(provider); }
    if (intent) { where.push('intent_category = ?'); params.push(intent); }
    const whereSql = where.join(' AND ');

    const total = (db.prepare(`SELECT COUNT(*) as n FROM qa_training_cache WHERE ${whereSql}`).get(...params) as any)?.n || 0;

    const rows = db.prepare(
      `SELECT id, customer_question, ai_response, admin_edited_response, ai_provider, ai_model,
              ai_tokens_used, tier, hits_count, positive_feedback, negative_feedback, feedback_score,
              intent_category, context_tags, admin_notes, admin_user_id,
              created_at, last_hit_at, approved_at, last_reviewed_at
       FROM qa_training_cache WHERE ${whereSql}
       ORDER BY
         CASE WHEN tier='pending' THEN 0 ELSE 1 END,
         hits_count DESC,
         created_at DESC
       LIMIT ? OFFSET ?`
    ).all(...params, limit, offset) as any[];

    // Parse context_tags JSON
    for (const r of rows) {
      if (r.context_tags) {
        try { r.context_tags = JSON.parse(r.context_tags); } catch { r.context_tags = []; }
      } else {
        r.context_tags = [];
      }
    }

    res.json({ total, limit, offset, items: rows });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ── Detail (phải khớp cụ thể id là số, tránh catch "cost-stats" etc.) ─
router.get('/:id(\\d+)', (req: AuthRequest, res) => {
  try {
    const hotelId = getHotelId(req);
    const id = parseInt(String(req.params.id), 10);
    const row = db.prepare(
      `SELECT * FROM qa_training_cache WHERE id = ? AND hotel_id = ?`
    ).get(id, hotelId) as any;
    if (!row) return res.status(404).json({ error: 'not found' });

    // Không trả blob embedding (quá lớn), chỉ info
    if (row.question_embedding) {
      row.question_embedding_bytes = (row.question_embedding as Buffer).length;
      delete row.question_embedding;
    }
    if (row.context_tags) {
      try { row.context_tags = JSON.parse(row.context_tags); } catch {}
    }
    res.json(row);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ── Approve ────────────────────────────────────────────────────────
router.post('/:id/approve', (req: AuthRequest, res) => {
  try {
    const hotelId = getHotelId(req);
    const id = parseInt(String(req.params.id), 10);
    const row = db.prepare(`SELECT id FROM qa_training_cache WHERE id = ? AND hotel_id = ?`).get(id, hotelId) as any;
    if (!row) return res.status(404).json({ error: 'not found' });

    const { notes, edited_response } = req.body || {};
    const userId = req.user?.userId || 0;
    approveQA(id, userId, notes, edited_response);

    res.json({ ok: true, id, tier: 'approved' });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ── Reject ─────────────────────────────────────────────────────────
router.post('/:id/reject', (req: AuthRequest, res) => {
  try {
    const hotelId = getHotelId(req);
    const id = parseInt(String(req.params.id), 10);
    const { reason } = req.body || {};
    if (!reason || typeof reason !== 'string' || reason.length < 3) {
      return res.status(400).json({ error: 'reason required (≥3 chars)' });
    }
    const row = db.prepare(`SELECT id FROM qa_training_cache WHERE id = ? AND hotel_id = ?`).get(id, hotelId) as any;
    if (!row) return res.status(404).json({ error: 'not found' });

    const userId = req.user?.userId || 0;
    rejectQA(id, userId, reason);
    res.json({ ok: true, id, tier: 'rejected' });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ── Blacklist (spam/troll pattern) ─────────────────────────────────
router.post('/:id/blacklist', (req: AuthRequest, res) => {
  try {
    const hotelId = getHotelId(req);
    const id = parseInt(String(req.params.id), 10);
    const { reason } = req.body || {};
    const row = db.prepare(`SELECT id FROM qa_training_cache WHERE id = ? AND hotel_id = ?`).get(id, hotelId) as any;
    if (!row) return res.status(404).json({ error: 'not found' });

    const userId = req.user?.userId || 0;
    blacklistQA(id, userId, reason);
    res.json({ ok: true, id, tier: 'blacklisted' });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ── Admin seed thủ công (preseed 'approved' từ đầu) ───────────────
router.post('/seed', async (req: AuthRequest, res) => {
  try {
    const hotelId = getHotelId(req);
    const { question, response, intent_category, notes } = req.body || {};
    if (!question || typeof question !== 'string' || question.trim().length < 3)
      return res.status(400).json({ error: 'question required (≥3 chars)' });
    if (!response || typeof response !== 'string' || response.trim().length < 3)
      return res.status(400).json({ error: 'response required (≥3 chars)' });

    const userId = req.user?.userId || 0;
    const saved = await saveNewQA({
      hotelId,
      question: question.trim(),
      response: response.trim(),
      provider: 'admin_edit',
      intentCategory: intent_category || 'manual_seed',
      initialTier: 'approved',
    });
    // Stamp admin info ngay
    if (saved.is_new) {
      const now = Date.now();
      db.prepare(`UPDATE qa_training_cache
        SET approved_at=?, last_reviewed_at=?, admin_user_id=?, admin_notes=?
        WHERE id = ?`).run(now, now, userId, notes || 'manual seed', saved.qa_cache_id);
    }
    res.json({ ok: true, ...saved });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ── Housekeeping: promote approved → trusted ──────────────────────
router.post('/promote-trusted', (_req: AuthRequest, res) => {
  try {
    const promoted = autoPromoteTrusted();
    const demoted = autoDemoteOnBadFeedback();
    res.json({ ok: true, promoted, demoted });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ── Phase 3: Feedback endpoints ───────────────────────────────────
router.get('/:id/feedback', (req: AuthRequest, res) => {
  try {
    const hotelId = getHotelId(req);
    const id = parseInt(String(req.params.id), 10);
    // Verify ownership
    const owns = db.prepare(`SELECT id FROM qa_training_cache WHERE id = ? AND hotel_id = ?`).get(id, hotelId);
    if (!owns) return res.status(404).json({ error: 'not found' });
    const items = getRecentFeedback(id, 50);
    res.json({ items });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/:id/feedback', (req: AuthRequest, res) => {
  try {
    const hotelId = getHotelId(req);
    const id = parseInt(String(req.params.id), 10);
    const { sentiment, note } = req.body || {};
    if (!['positive', 'negative', 'neutral'].includes(sentiment)) {
      return res.status(400).json({ error: 'sentiment must be positive/negative/neutral' });
    }
    const owns = db.prepare(`SELECT id FROM qa_training_cache WHERE id = ? AND hotel_id = ?`).get(id, hotelId);
    if (!owns) return res.status(404).json({ error: 'not found' });
    manualFeedback({ qa_cache_id: id, sentiment, note, admin_user_id: req.user?.userId });
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/feedback/stats', (req: AuthRequest, res) => {
  try {
    const hotelId = getHotelId(req);
    const days = Math.min(90, Math.max(1, parseInt((req.query.days as string) || '7', 10)));
    const since = Date.now() - days * 24 * 3600_000;
    const stats = getFeedbackStats(hotelId, since);
    res.json({ days, ...stats });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════
// v11: FAQ Discovery + Bulk actions + Similar detection
// ═══════════════════════════════════════════════════════════════════

/** FAQ Discovery: phân tích câu khách hỏi → gợi ý admin duyệt */
router.get('/discover-faqs', async (req: AuthRequest, res) => {
  try {
    const hotelId = getHotelId(req);
    const days = Math.min(30, Math.max(1, parseInt((req.query.days as string) || '14', 10)));
    const minFreq = Math.max(2, parseInt((req.query.min_frequency as string) || '2', 10));
    const { discoverFaqs } = require('../services/faq-discovery');
    const r = await discoverFaqs({ hotelId, days, minFrequency: minFreq, limit: 30 });
    res.json(r);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

/** Admin click "Add to training" từ 1 FAQ cluster */
router.post('/discover-faqs/add', async (req: AuthRequest, res) => {
  try {
    const hotelId = getHotelId(req);
    const { question, response, intent_category, notes } = req.body || {};
    if (!question || typeof question !== 'string' || question.trim().length < 3)
      return res.status(400).json({ error: 'question required' });
    if (!response || typeof response !== 'string' || response.trim().length < 3)
      return res.status(400).json({ error: 'response required' });

    const saved = await saveNewQA({
      hotelId,
      question: question.trim(),
      response: response.trim(),
      provider: 'admin_edit',
      intentCategory: intent_category || 'from_faq_discovery',
      initialTier: 'approved',
    });
    if (saved.is_new) {
      const now = Date.now();
      db.prepare(`UPDATE qa_training_cache
        SET approved_at=?, last_reviewed_at=?, admin_user_id=?, admin_notes=?
        WHERE id = ?`).run(now, now, req.user?.userId || 0,
          notes || 'Added from FAQ Discovery', saved.qa_cache_id);
    }
    res.json({ ok: true, ...saved });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

/** Bulk approve nhiều entries cùng lúc */
router.post('/bulk/approve', (req: AuthRequest, res) => {
  try {
    const hotelId = getHotelId(req);
    const { ids, notes } = req.body || {};
    if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: 'ids array required' });
    if (ids.length > 100) return res.status(400).json({ error: 'max 100 ids per batch' });

    const userId = req.user?.userId || 0;
    const now = Date.now();
    let approved = 0;
    for (const rawId of ids) {
      const id = parseInt(String(rawId), 10);
      if (isNaN(id)) continue;
      // Verify ownership
      const owns = db.prepare(
        `SELECT id FROM qa_training_cache WHERE id = ? AND hotel_id = ? AND tier = 'pending'`
      ).get(id, hotelId);
      if (!owns) continue;
      approveQA(id, userId, notes || 'bulk approve');
      approved++;
    }
    res.json({ ok: true, approved, requested: ids.length });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

/** Bulk reject */
router.post('/bulk/reject', (req: AuthRequest, res) => {
  try {
    const hotelId = getHotelId(req);
    const { ids, reason } = req.body || {};
    if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: 'ids array required' });
    if (!reason || typeof reason !== 'string') return res.status(400).json({ error: 'reason required' });
    if (ids.length > 100) return res.status(400).json({ error: 'max 100 ids per batch' });

    const userId = req.user?.userId || 0;
    let rejected = 0;
    for (const rawId of ids) {
      const id = parseInt(String(rawId), 10);
      if (isNaN(id)) continue;
      const owns = db.prepare(`SELECT id FROM qa_training_cache WHERE id = ? AND hotel_id = ?`).get(id, hotelId);
      if (!owns) continue;
      rejectQA(id, userId, reason);
      rejected++;
    }
    res.json({ ok: true, rejected, requested: ids.length });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

/** Detect similar entries — gợi ý admin merge */
router.get('/similar', async (req: AuthRequest, res) => {
  try {
    const hotelId = getHotelId(req);
    const threshold = Math.max(0.7, Math.min(0.99, parseFloat((req.query.threshold as string) || '0.9')));
    const { detectSimilarEntries } = require('../services/faq-discovery');
    const pairs = await detectSimilarEntries(hotelId, threshold);
    res.json({ threshold, pairs });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

/** Merge 2 entries: giữ entry A, delete entry B, hits_count A += B */
router.post('/merge', (req: AuthRequest, res) => {
  try {
    const hotelId = getHotelId(req);
    const { keep_id, remove_id } = req.body || {};
    const kid = parseInt(String(keep_id), 10);
    const rid = parseInt(String(remove_id), 10);
    if (isNaN(kid) || isNaN(rid) || kid === rid) {
      return res.status(400).json({ error: 'keep_id và remove_id required và phải khác nhau' });
    }
    const keep = db.prepare(`SELECT * FROM qa_training_cache WHERE id = ? AND hotel_id = ?`).get(kid, hotelId) as any;
    const rem = db.prepare(`SELECT * FROM qa_training_cache WHERE id = ? AND hotel_id = ?`).get(rid, hotelId) as any;
    if (!keep || !rem) return res.status(404).json({ error: 'entry not found' });

    const now = Date.now();
    // Merge hits + feedback scores
    db.prepare(
      `UPDATE qa_training_cache
       SET hits_count = hits_count + ?,
           positive_feedback = positive_feedback + ?,
           negative_feedback = negative_feedback + ?,
           last_hit_at = MAX(last_hit_at, ?),
           last_reviewed_at = ?,
           admin_notes = COALESCE(admin_notes || '; ', '') || 'Merged #' || ?
       WHERE id = ?`
    ).run(rem.hits_count || 0, rem.positive_feedback || 0, rem.negative_feedback || 0,
      rem.last_hit_at || 0, now, rem.id, kid);

    // Delete the removed entry
    db.prepare(`DELETE FROM qa_training_cache WHERE id = ?`).run(rid);

    res.json({ ok: true, kept: kid, removed: rid });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════
// Phase 4: Cost dashboard + Threshold tuning + Confidence distribution
// ═══════════════════════════════════════════════════════════════════

/**
 * GET /api/training/cost-stats
 * Aggregate token usage + cost + cache-hit savings.
 * Query: ?days=7 (default 7)
 */
router.get('/cost-stats', (req: AuthRequest, res) => {
  try {
    const hotelId = getHotelId(req);
    const days = Math.min(90, Math.max(1, parseInt((req.query.days as string) || '7', 10)));
    const since = Date.now() - days * 24 * 3600_000;

    // 1. Tokens + cost từ qa_training_cache (replies đã save với provider info)
    const byProvider = db.prepare(
      `SELECT ai_provider, ai_model, COUNT(*) as calls,
              SUM(ai_tokens_used) as tokens_out,
              SUM(hits_count) as total_hits
       FROM qa_training_cache
       WHERE hotel_id = ? AND created_at > ?
       GROUP BY ai_provider, ai_model
       ORDER BY calls DESC`
    ).all(hotelId, since) as any[];

    // 2. Cost estimate cho từng row (dựa PRICING table)
    let totalTokens = 0;
    let totalCostUsd = 0;
    for (const p of byProvider) {
      const tokOut = p.tokens_out || 0;
      // Estimate input tokens ~3x output (typical RAG)
      const tokIn = tokOut * 3;
      const cost = estimateCost(p.ai_model || p.ai_provider || '', tokIn, tokOut);
      p.tokens_in_est = tokIn;
      p.cost_usd_est = +cost.toFixed(6);
      totalTokens += tokIn + tokOut;
      totalCostUsd += cost;
    }

    // 3. Cache hit stats — hits_count = tổng lần match-hit (0 LLM cost mỗi lần)
    const hitStats = db.prepare(
      `SELECT SUM(hits_count) as total_hits,
              SUM(CASE WHEN tier IN ('trusted', 'approved') THEN hits_count ELSE 0 END) as served_hits
       FROM qa_training_cache WHERE hotel_id = ?`
    ).get(hotelId) as any;
    const totalHits = hitStats?.total_hits || 0;
    const servedHits = hitStats?.served_hits || 0;  // hits từ tier có thể dùng

    // 4. Ước tính savings: mỗi served_hit tương đương 1 Gemini Flash call ~200 out tokens
    const AVG_REPLY_TOKENS = 200;
    const avgCostPerCall = estimateCost('gemini-2.5-flash', AVG_REPLY_TOKENS * 3, AVG_REPLY_TOKENS);
    const savingsUsd = servedHits * avgCostPerCall;

    // 5. Cache hit rate: servedHits / (servedHits + new LLM calls)
    const newLLMCalls = byProvider.reduce((a, p) => a + (p.calls || 0), 0);
    const totalRequests = servedHits + newLLMCalls;
    const hitRate = totalRequests > 0 ? servedHits / totalRequests : 0;

    res.json({
      period_days: days,
      total_tokens_est: totalTokens,
      total_cost_usd_est: +totalCostUsd.toFixed(6),
      cache_hits_total: totalHits,
      cache_hits_served: servedHits,
      new_llm_calls: newLLMCalls,
      hit_rate: +hitRate.toFixed(3),
      savings_usd_est: +savingsUsd.toFixed(4),
      by_provider: byProvider,
      pricing_table: PRICING,
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * GET /api/training/confidence-dist
 * Histogram phân bố confidence từ recent matches (logs trong events table).
 */
router.get('/confidence-dist', (req: AuthRequest, res) => {
  try {
    const hotelId = getHotelId(req);
    const days = Math.min(30, Math.max(1, parseInt((req.query.days as string) || '7', 10)));
    const since = Date.now() - days * 24 * 3600_000;

    // Pull confidence values từ events.meta JSON (qa_cache_hit events)
    const rows = db.prepare(
      `SELECT meta FROM events
       WHERE event_name = 'qa_cache_hit' AND hotel_id = ? AND ts > ?
       ORDER BY ts DESC LIMIT 2000`
    ).all(hotelId, since) as any[];

    const buckets: Record<string, number> = {
      '0.50-0.60': 0, '0.60-0.65': 0, '0.65-0.70': 0, '0.70-0.75': 0,
      '0.75-0.80': 0, '0.80-0.85': 0, '0.85-0.90': 0, '0.90-0.95': 0,
      '0.95-1.00': 0,
    };
    let total = 0;
    for (const r of rows) {
      try {
        const m = typeof r.meta === 'string' ? JSON.parse(r.meta) : r.meta;
        const conf = Number(m?.confidence);
        if (isNaN(conf) || conf < 0.5) continue;
        total++;
        if (conf < 0.60) buckets['0.50-0.60']++;
        else if (conf < 0.65) buckets['0.60-0.65']++;
        else if (conf < 0.70) buckets['0.65-0.70']++;
        else if (conf < 0.75) buckets['0.70-0.75']++;
        else if (conf < 0.80) buckets['0.75-0.80']++;
        else if (conf < 0.85) buckets['0.80-0.85']++;
        else if (conf < 0.90) buckets['0.85-0.90']++;
        else if (conf < 0.95) buckets['0.90-0.95']++;
        else buckets['0.95-1.00']++;
      } catch {}
    }

    res.json({
      period_days: days,
      total_samples: total,
      buckets,
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * GET /api/training/threshold — current match threshold (persisted in settings)
 */
router.get('/threshold', (_req: AuthRequest, res) => {
  try {
    const v = getSetting('qa_match_threshold');
    const threshold = v ? parseFloat(v) : 0.7;  // default 0.7
    res.json({ threshold, default: 0.7, min: 0.5, max: 0.95 });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * POST /api/training/threshold { value: 0.7 }
 */
router.post('/threshold', (req: AuthRequest, res) => {
  try {
    const value = Number((req.body || {}).value);
    if (isNaN(value) || value < 0.5 || value > 0.95) {
      return res.status(400).json({ error: 'value must be 0.5..0.95' });
    }
    setSetting('qa_match_threshold', String(value), getHotelId(req));
    res.json({ ok: true, threshold: value });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ── Danh sách provider + intent distinct (populate filter dropdowns) ──
router.get('/meta/distinct', (req: AuthRequest, res) => {
  try {
    const hotelId = getHotelId(req);
    const providers = db.prepare(
      `SELECT DISTINCT ai_provider FROM qa_training_cache WHERE hotel_id = ? AND ai_provider IS NOT NULL ORDER BY ai_provider`
    ).all(hotelId).map((r: any) => r.ai_provider);
    const intents = db.prepare(
      `SELECT DISTINCT intent_category FROM qa_training_cache WHERE hotel_id = ? AND intent_category IS NOT NULL ORDER BY intent_category`
    ).all(hotelId).map((r: any) => r.intent_category);
    res.json({ providers, intents });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

export default router;

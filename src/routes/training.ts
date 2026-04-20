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

const router = Router();
router.use(authMiddleware);

// ── Stats ──────────────────────────────────────────────────────────
router.get('/stats', (req: AuthRequest, res) => {
  try {
    const hotelId = getHotelId(req);
    const stats = getTrainingStats(hotelId);
    // Extra: average confidence boost from cache hits
    const events = db.prepare(
      `SELECT COUNT(*) as n FROM events WHERE event = 'qa_cache_hit' AND created_at > ?`
    ).get(Date.now() - 7 * 24 * 3600_000) as any;
    res.json({ ...stats, cache_hits_7d: events?.n || 0 });
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

// ── Detail ─────────────────────────────────────────────────────────
router.get('/:id', (req: AuthRequest, res) => {
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

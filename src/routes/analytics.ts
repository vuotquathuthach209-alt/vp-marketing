import { Router } from 'express';
import { authMiddleware } from '../middleware/auth';
import { pullMetrics, getLatestMetrics, getOverview, getBestPostingTime, getDailyTrend } from '../services/analytics';
import { createExperiment, listExperiments, decidePendingWinners } from '../services/abtest';
import { analyzeRecentComments } from '../services/faqlearn';
import { syncBooking, getLatestBooking } from '../services/booking';
import { getCostOverview } from '../services/costtrack';

const router = Router();
router.use(authMiddleware);

// Dashboard overview
router.get('/overview', (req, res) => {
  const days = parseInt((req.query.days as string) || '30', 10);
  res.json(getOverview(days));
});

// Chi tiết post + metrics
router.get('/posts', (req, res) => {
  const limit = parseInt((req.query.limit as string) || '50', 10);
  res.json(getLatestMetrics(limit));
});

// Trigger pull metrics thủ công
router.post('/refresh', async (req, res) => {
  try {
    const r = await pullMetrics();
    res.json(r);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ===== A/B testing =====
router.get('/ab', (req, res) => {
  res.json(listExperiments());
});

router.post('/ab/create', async (req, res) => {
  const { topic, page_id } = req.body;
  if (!topic || !page_id) return res.status(400).json({ error: 'Thiếu topic hoặc page_id' });
  try {
    const exp = await createExperiment(topic, page_id);
    res.json(exp);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/ab/decide', (req, res) => {
  const n = decidePendingWinners();
  res.json({ decided: n });
});

// ===== FAQ auto-learn =====
router.post('/faq/analyze', async (req, res) => {
  try {
    const r = await analyzeRecentComments();
    res.json(r);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ===== Sprint 4: Advanced KPI =====
router.get('/best-time', (req, res) => {
  const days = parseInt((req.query.days as string) || '60', 10);
  res.json(getBestPostingTime(days));
});

router.get('/trend', (req, res) => {
  const days = parseInt((req.query.days as string) || '14', 10);
  res.json(getDailyTrend(days));
});

// ===== Sprint 4: Booking data sync =====
router.post('/booking/sync', async (req, res) => {
  try {
    const r = await syncBooking(req.body || {});
    res.json({ ok: true, ...r });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/booking', (req, res) => {
  res.json(getLatestBooking() || null);
});

// ===== Sprint 5: Cost tracker =====
router.get('/cost', (req, res) => {
  const days = parseInt((req.query.days as string) || '30', 10);
  res.json(getCostOverview(days));
});

// ===== Sprint 5: Smart schedule — gợi ý slot đăng tiếp theo =====
router.get('/smart-slot', (req, res) => {
  try {
    const bt = getBestPostingTime(60);
    const now = new Date();
    // Nếu chưa có đủ data → fallback: 09:00 ngày mai
    let hour: number;
    if (!bt.total_samples || !bt.best_hour) {
      hour = 9;
    } else {
      hour = bt.best_hour.hour;
    }
    // Tìm thời điểm gần nhất >= now có giờ = hour
    const slot = new Date(now);
    slot.setMinutes(0, 0, 0);
    slot.setHours(hour);
    if (slot.getTime() <= now.getTime() + 5 * 60 * 1000) {
      slot.setDate(slot.getDate() + 1);
    }
    res.json({
      slot_epoch: slot.getTime(),
      slot_local: slot.toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' }),
      hour,
      samples: bt.total_samples,
      reason: bt.total_samples
        ? `Khung ${String(hour).padStart(2, '0')}:00 có engagement avg ${(bt.best_hour!.avg_score * 100).toFixed(2)}% (dựa trên ${bt.total_samples} post)`
        : 'Chưa đủ dữ liệu, mặc định 09:00 sáng',
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// Intent analytics (v6 Intent-First Orchestrator)
// ═══════════════════════════════════════════════════════════════
import { db as _db } from '../db';

router.get('/intents', (req, res) => {
  const days = Math.max(1, Math.min(90, parseInt(String(req.query.days || '7'), 10) || 7));
  const since = Date.now() - days * 24 * 3600_000;
  try {
    const rows = _db.prepare(
      `SELECT meta, ts FROM events
       WHERE event_name = 'intent_classified' AND ts >= ?
       ORDER BY ts DESC LIMIT 5000`
    ).all(since) as any[];

    const intentCounts: Record<string, number> = {};
    const handlerCounts: Record<string, number> = {};
    const confBuckets = { high: 0, mid: 0, low: 0 }; // >=0.75 / 0.4-0.75 / <0.4
    const sourceCounts: Record<string, number> = {};
    let total = 0;
    let confSum = 0;

    for (const r of rows) {
      let m: any = {};
      try { m = JSON.parse(r.meta || '{}'); } catch {}
      if (!m.intent) continue;
      total++;
      intentCounts[m.intent] = (intentCounts[m.intent] || 0) + 1;
      if (m.handler) handlerCounts[m.handler] = (handlerCounts[m.handler] || 0) + 1;
      if (m.source) sourceCounts[m.source] = (sourceCounts[m.source] || 0) + 1;
      const c = Number(m.confidence) || 0;
      confSum += c;
      if (c >= 0.75) confBuckets.high++;
      else if (c >= 0.4) confBuckets.mid++;
      else confBuckets.low++;
    }

    res.json({
      days,
      total,
      avg_confidence: total > 0 ? +(confSum / total).toFixed(3) : 0,
      intents: Object.entries(intentCounts).sort((a, b) => b[1] - a[1]).map(([k, v]) => ({ intent: k, count: v, pct: +((v / total) * 100).toFixed(1) })),
      handlers: Object.entries(handlerCounts).sort((a, b) => b[1] - a[1]).map(([k, v]) => ({ handler: k, count: v })),
      confidence_buckets: confBuckets,
      sources: sourceCounts,
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/router-health', (_req, res) => {
  // Health check cho new router — % events là rule fallback (cao = LLM có vấn đề)
  const since = Date.now() - 24 * 3600_000;
  const rows = _db.prepare(
    `SELECT meta FROM events WHERE event_name = 'intent_classified' AND ts >= ?`
  ).all(since) as any[];
  let total = 0, ruleFallback = 0, lowConf = 0;
  for (const r of rows) {
    try {
      const m = JSON.parse(r.meta || '{}');
      if (!m.intent) continue;
      total++;
      if (m.source === 'rule') ruleFallback++;
      if ((Number(m.confidence) || 0) < 0.4) lowConf++;
    } catch {}
  }
  res.json({
    total,
    rule_fallback_pct: total > 0 ? +((ruleFallback / total) * 100).toFixed(1) : 0,
    low_confidence_pct: total > 0 ? +((lowConf / total) * 100).toFixed(1) : 0,
    status: total === 0 ? 'no-data' : ruleFallback / Math.max(1, total) > 0.3 ? 'degraded' : 'healthy',
  });
});

// ═══════════════════════════════════════════════════════════════
// Sprint 7: Revenue / conversion funnel
// ═══════════════════════════════════════════════════════════════
import { getFunnelStats } from '../services/conversion-tracker';
import { listBlocked, blockSender, unblockSender } from '../services/spam-guard';

router.get('/revenue', (req, res) => {
  const days = Math.max(1, Math.min(90, parseInt(String(req.query.days || '30'), 10) || 30));
  // TODO: per-hotel filter via auth. For now hotel_id = null (global) or from req.user.hotelId if present.
  const hotelId = (req as any).user?.hotelId || null;
  try {
    const stats = getFunnelStats(hotelId, days);
    res.json(stats);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/spam', (req, res) => {
  const hotelId = (req as any).user?.hotelId;
  res.json({ items: listBlocked(hotelId) });
});

router.post('/spam/block', (req, res) => {
  const { sender_id, reason, days } = req.body || {};
  const hotelId = (req as any).user?.hotelId || 1;
  if (!sender_id) return res.status(400).json({ error: 'sender_id required' });
  try { blockSender(String(sender_id), hotelId, String(reason || 'manual'), days ? parseInt(days, 10) : undefined); res.json({ ok: true }); }
  catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.post('/spam/unblock', (req, res) => {
  const { sender_id } = req.body || {};
  if (!sender_id) return res.status(400).json({ error: 'sender_id required' });
  try { unblockSender(String(sender_id)); res.json({ ok: true }); }
  catch (e: any) { res.status(500).json({ error: e.message }); }
});

export default router;

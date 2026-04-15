import { Router } from 'express';
import { authMiddleware } from '../middleware/auth';
import { pullMetrics, getLatestMetrics, getOverview, getBestPostingTime, getDailyTrend } from '../services/analytics';
import { createExperiment, listExperiments, decidePendingWinners } from '../services/abtest';
import { analyzeRecentComments } from '../services/faqlearn';
import { syncBooking, getLatestBooking } from '../services/booking';

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

export default router;

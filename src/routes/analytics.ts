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

export default router;

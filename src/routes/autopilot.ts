import { Router } from 'express';
import { authMiddleware, AuthRequest, getHotelId } from '../middleware/auth';
import { setSetting } from '../db';
import {
  getAutopilotStatus,
  runAutopilotCycle,
  generateMorningReport,
  generateEveningReport,
} from '../services/autopilot';

const router = Router();
router.use(authMiddleware);

// GET /api/autopilot/status — per hotel
router.get('/status', (req: AuthRequest, res) => {
  try {
    res.json(getAutopilotStatus(getHotelId(req)));
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/autopilot/enable — per hotel
router.post('/enable', (req: AuthRequest, res) => {
  setSetting('autopilot_enabled', '1', getHotelId(req));
  res.json({ ok: true, enabled: true });
});

router.post('/disable', (req: AuthRequest, res) => {
  setSetting('autopilot_enabled', '0', getHotelId(req));
  res.json({ ok: true, enabled: false });
});

// POST /api/autopilot/run-now — per hotel with rate limiting
router.post('/run-now', async (req: AuthRequest, res) => {
  try {
    const hotelId = getHotelId(req);
    const pageId = parseInt(req.body.pageId || req.query.pageId as string, 10);
    if (!pageId) return res.status(400).json({ error: 'pageId required' });
    const result = await runAutopilotCycle(pageId, hotelId);
    if (!result) return res.json({ ok: false, error: 'Dat gioi han so bai/ngay theo plan' });
    res.json({ ok: true, ...result });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/morning-report', async (req: AuthRequest, res) => {
  try {
    const report = await generateMorningReport(getHotelId(req));
    res.json({ ok: true, report });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/evening-report', async (req: AuthRequest, res) => {
  try {
    const report = await generateEveningReport(getHotelId(req));
    res.json({ ok: true, report });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

export default router;

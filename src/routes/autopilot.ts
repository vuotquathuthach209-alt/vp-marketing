import { Router } from 'express';
import { authMiddleware } from '../middleware/auth';
import { setSetting } from '../db';
import {
  getAutopilotStatus,
  runAutopilotCycle,
  generateMorningReport,
  generateEveningReport,
} from '../services/autopilot';

const router = Router();
router.use(authMiddleware);

// GET /api/autopilot/status
router.get('/status', (_req, res) => {
  try {
    res.json(getAutopilotStatus());
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/autopilot/enable
router.post('/enable', (_req, res) => {
  setSetting('autopilot_enabled', '1');
  res.json({ ok: true, enabled: true });
});

// POST /api/autopilot/disable
router.post('/disable', (_req, res) => {
  setSetting('autopilot_enabled', '0');
  res.json({ ok: true, enabled: false });
});

// POST /api/autopilot/run-now
router.post('/run-now', async (req, res) => {
  try {
    const pageId = parseInt(req.body.pageId || req.query.pageId as string, 10);
    if (!pageId) return res.status(400).json({ error: 'pageId required' });
    const result = await runAutopilotCycle(pageId);
    res.json({ ok: true, ...result });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/autopilot/morning-report
router.get('/morning-report', async (_req, res) => {
  try {
    const report = await generateMorningReport();
    res.json({ ok: true, report });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/autopilot/evening-report
router.get('/evening-report', async (_req, res) => {
  try {
    const report = await generateEveningReport();
    res.json({ ok: true, report });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

export default router;

import { Router } from 'express';
import { authMiddleware, AuthRequest, getHotelId } from '../middleware/auth';
import { setSetting, getSetting } from '../db';
import {
  getAutopilotStatus,
  runAutopilotCycle,
  generateMorningReport,
  generateEveningReport,
  getWeekCalendar,
  saveCalendarDay,
  syncGdriveImages,
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

// ── Content Calendar ──

router.get('/calendar', (req: AuthRequest, res) => {
  try {
    res.json({ calendar: getWeekCalendar(getHotelId(req)) });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/calendar', (req: AuthRequest, res) => {
  try {
    const { day_of_week, content_type, image_source, pillar_name, pillar_emoji, pillar_desc, hook_style } = req.body;
    if (day_of_week === undefined) return res.status(400).json({ error: 'day_of_week required' });
    saveCalendarDay(getHotelId(req), {
      day_of_week, content_type, image_source,
      pillar_name, pillar_emoji, pillar_desc, hook_style,
    });
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ── Google Drive ──

router.get('/gdrive', (req: AuthRequest, res) => {
  const hotelId = getHotelId(req);
  res.json({
    folderId: getSetting('gdrive_folder_id', hotelId) || '',
    apiKey: getSetting('gdrive_api_key') ? '***configured***' : '',
  });
});

router.post('/gdrive', (req: AuthRequest, res) => {
  const hotelId = getHotelId(req);
  const { folderId, apiKey } = req.body;
  if (folderId !== undefined) setSetting('gdrive_folder_id', folderId, hotelId);
  if (apiKey && !apiKey.startsWith('***')) setSetting('gdrive_api_key', apiKey);
  res.json({ ok: true });
});

router.post('/gdrive/sync', async (req: AuthRequest, res) => {
  try {
    const count = await syncGdriveImages(getHotelId(req));
    res.json({ ok: true, count });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

export default router;

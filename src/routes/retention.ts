/**
 * Retention admin routes — monitor + control data cleanup + right-to-delete.
 */

import { Router } from 'express';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { runRetentionCleanup, getDbStats, forgetSender, DEFAULT_POLICY } from '../services/retention-cleanup';

const router = Router();
router.use(authMiddleware);

/** GET /stats — DB table sizes + row counts */
router.get('/stats', (_req: AuthRequest, res) => {
  try {
    res.json({ tables: getDbStats(), policy: DEFAULT_POLICY });
  } catch (e: any) {
    res.status(500).json({ error: e?.message });
  }
});

/** POST /cleanup — trigger manual cleanup (admin/superadmin) */
router.post('/cleanup', (req: AuthRequest, res) => {
  if (req.user?.role !== 'superadmin' && req.user?.role !== 'admin') {
    return res.status(403).json({ error: 'admin only' });
  }
  try {
    const result = runRetentionCleanup(req.body?.policy || {});
    res.json({ ok: true, ...result });
  } catch (e: any) {
    res.status(500).json({ error: e?.message });
  }
});

/** POST /forget/:sender_id — right-to-delete (NĐ 13/2023) */
router.post('/forget/:sender_id', (req: AuthRequest, res) => {
  if (req.user?.role !== 'superadmin' && req.user?.role !== 'admin') {
    return res.status(403).json({ error: 'admin only' });
  }
  const sid = String(req.params.sender_id);
  try {
    const counts = forgetSender(sid);
    res.json({ ok: true, sender_id: sid, deleted: counts });
  } catch (e: any) {
    res.status(500).json({ error: e?.message });
  }
});

export default router;

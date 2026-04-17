/**
 * /api/agent/* — per-tenant view of agent tool calls + appointments.
 */
import { Router } from 'express';
import { db } from '../db';
import { authMiddleware, AuthRequest, getHotelId } from '../middleware/auth';

const router = Router();
router.use(authMiddleware);

// ── Tool call audit ─────────────────────────────────────────────────────
router.get('/tool-calls', (req: AuthRequest, res) => {
  const hotelId = getHotelId(req);
  const limit = Math.min(200, parseInt(String(req.query.limit || '50'), 10) || 50);
  const rows = db.prepare(
    `SELECT id, sender_id, tool, params, result, status, error, latency_ms, created_at
     FROM agent_tool_calls WHERE hotel_id = ? ORDER BY id DESC LIMIT ?`
  ).all(hotelId, limit) as any[];
  res.json({ items: rows });
});

router.get('/tool-calls/stats', (req: AuthRequest, res) => {
  const hotelId = getHotelId(req);
  const days = Math.max(1, Math.min(90, parseInt(String(req.query.days || '7'), 10) || 7));
  const since = Date.now() - days * 24 * 3600_000;
  const rows = db.prepare(
    `SELECT tool, status, COUNT(*) AS n FROM agent_tool_calls
     WHERE hotel_id = ? AND created_at >= ?
     GROUP BY tool, status ORDER BY n DESC`
  ).all(hotelId, since) as any[];
  res.json({ days, stats: rows });
});

// ── Appointments ────────────────────────────────────────────────────────
router.get('/appointments', (req: AuthRequest, res) => {
  const hotelId = getHotelId(req);
  const status = String(req.query.status || '');
  const limit = Math.min(200, parseInt(String(req.query.limit || '100'), 10) || 100);
  const sql = status
    ? `SELECT * FROM appointments WHERE hotel_id = ? AND status = ? ORDER BY scheduled_at DESC LIMIT ?`
    : `SELECT * FROM appointments WHERE hotel_id = ? ORDER BY scheduled_at DESC LIMIT ?`;
  const rows = status
    ? db.prepare(sql).all(hotelId, status, limit)
    : db.prepare(sql).all(hotelId, limit);
  res.json({ items: rows });
});

router.post('/appointments/:id/status', (req: AuthRequest, res) => {
  const hotelId = getHotelId(req);
  const id = parseInt(String(req.params.id), 10);
  const { status } = req.body || {};
  if (!['pending', 'confirmed', 'done', 'cancelled'].includes(status)) {
    return res.status(400).json({ error: 'invalid status' });
  }
  const r = db.prepare(
    `UPDATE appointments SET status = ? WHERE id = ? AND hotel_id = ?`
  ).run(status, id, hotelId);
  res.json({ ok: r.changes > 0 });
});

// ── Agent toggle per-hotel ──────────────────────────────────────────────
router.post('/toggle', (req: AuthRequest, res) => {
  const hotelId = getHotelId(req);
  const { enabled } = req.body || {};
  const row = db.prepare(`SELECT features FROM mkt_hotels WHERE id = ?`).get(hotelId) as any;
  let f = {};
  try { f = JSON.parse(row?.features || '{}'); } catch {}
  (f as any).agent_tools = !!enabled;
  db.prepare(`UPDATE mkt_hotels SET features = ?, updated_at = ? WHERE id = ?`)
    .run(JSON.stringify(f), Date.now(), hotelId);
  res.json({ ok: true, agent_tools: (f as any).agent_tools });
});

export default router;

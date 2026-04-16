import { Router } from 'express';
import { authMiddleware } from '../middleware/auth';
import {
  getOtaDbConfig,
  saveOtaDbConfig,
  testOtaConnection,
  getOtaHotels,
  getOtaHotel,
  getOtaRoomTypes,
  getOtaRooms,
  checkAvailability,
  getOtaBookings,
  getTodayBookings,
  getOtaHotelStats,
  getOtaPricingRules,
  getOtaCoupons,
} from '../services/ota-db';

const router = Router();
router.use(authMiddleware);

// ═══════════ CONFIG ═══════════

// GET /api/ota/config — lấy config (ẩn password)
router.get('/config', (_req, res) => {
  const cfg = getOtaDbConfig();
  if (!cfg) return res.json({ configured: false });
  res.json({
    configured: true,
    host: cfg.host,
    port: cfg.port,
    database: cfg.database,
    user: cfg.user,
    password: '********',
    ssl: cfg.ssl,
  });
});

// POST /api/ota/config — lưu config
router.post('/config', (req, res) => {
  const { host, port, database, user, password, ssl } = req.body;
  if (!host || !database || !user || !password) {
    return res.status(400).json({ error: 'Thiếu thông tin kết nối (host, database, user, password)' });
  }
  saveOtaDbConfig({
    host,
    port: parseInt(port) || 5432,
    database,
    user,
    password,
    ssl: ssl !== false,
  });
  res.json({ ok: true });
});

// POST /api/ota/test — test kết nối
router.post('/test', async (_req, res) => {
  const result = await testOtaConnection();
  res.json(result);
});

// ═══════════ HOTELS ═══════════

// GET /api/ota/hotels
router.get('/hotels', async (_req, res) => {
  try {
    const hotels = await getOtaHotels();
    res.json(hotels);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/ota/hotels/:id
router.get('/hotels/:id', async (req, res) => {
  try {
    const hotel = await getOtaHotel(parseInt(req.params.id));
    if (!hotel) return res.status(404).json({ error: 'Hotel not found' });
    res.json(hotel);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/ota/hotels/:id/stats
router.get('/hotels/:id/stats', async (req, res) => {
  try {
    const stats = await getOtaHotelStats(parseInt(req.params.id));
    res.json(stats);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ═══════════ ROOMS ═══════════

// GET /api/ota/hotels/:id/room-types
router.get('/hotels/:id/room-types', async (req, res) => {
  try {
    res.json(await getOtaRoomTypes(parseInt(req.params.id)));
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/ota/hotels/:id/rooms
router.get('/hotels/:id/rooms', async (req, res) => {
  try {
    res.json(await getOtaRooms(parseInt(req.params.id)));
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/ota/hotels/:id/availability?checkin=YYYY-MM-DD&checkout=YYYY-MM-DD&roomTypeId=X
router.get('/hotels/:id/availability', async (req, res) => {
  try {
    const { checkin, checkout, roomTypeId } = req.query;
    if (!checkin || !checkout) {
      return res.status(400).json({ error: 'Cần checkin và checkout (YYYY-MM-DD)' });
    }
    const result = await checkAvailability(
      parseInt(req.params.id),
      checkin as string,
      checkout as string,
      roomTypeId ? parseInt(roomTypeId as string) : undefined
    );
    res.json(result);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ═══════════ BOOKINGS ═══════════

// GET /api/ota/hotels/:id/bookings?limit=50
router.get('/hotels/:id/bookings', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit as string) || 50;
    res.json(await getOtaBookings(parseInt(req.params.id), limit));
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/ota/hotels/:id/today
router.get('/hotels/:id/today', async (req, res) => {
  try {
    res.json(await getTodayBookings(parseInt(req.params.id)));
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ═══════════ PRICING & PROMOS ═══════════

// GET /api/ota/hotels/:id/pricing-rules
router.get('/hotels/:id/pricing-rules', async (req, res) => {
  try {
    res.json(await getOtaPricingRules(parseInt(req.params.id)));
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/ota/hotels/:id/coupons
router.get('/hotels/:id/coupons', async (req, res) => {
  try {
    res.json(await getOtaCoupons(parseInt(req.params.id)));
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

export default router;

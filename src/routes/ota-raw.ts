/**
 * OTA Raw Pipeline — LAYER 1 of 2-layer ingestion.
 *
 * Khác với ota-push.ts (structured full schema), endpoint này nhận JSON BLOB
 * free-form từ OTA web. Qwen AI classifier (layer 2) sẽ xử lý sau mỗi 5 phút.
 *
 * Flow:
 *   OTA Web → POST /api/ota-raw/push (HMAC signed)
 *        → INSERT vào ota_raw_* tables (status='pending')
 *        → Cron Qwen classifier 5p → normalize → hotel_profile / etc
 *
 * Endpoints (mount tại /api/ota-raw):
 *   POST /push                     — nhận batch raw data
 *   GET  /status/:batch_id         — xem tình trạng classify
 *   GET  /failed                   — list records fail để review manual
 *   GET  /batches                  — list recent batches
 *   POST /reclassify/:table/:id    — trigger re-classify 1 record
 *   GET  /pending-types            — property types mới chưa map
 *
 * Auth: HMAC-SHA256 với shared_secret trong settings['ota_raw_secret']
 */
import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { db, getSetting, setSetting } from '../db';
import { authMiddleware, AuthRequest } from '../middleware/auth';

const router = Router();
const SECRET_KEY = 'ota_raw_secret';

/* ═══════════════════════════════════════════
   Schema — Layer 1 RAW tables
   ═══════════════════════════════════════════ */

db.exec(`
CREATE TABLE IF NOT EXISTS ota_raw_hotels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id TEXT,
  ota_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  source TEXT DEFAULT 'ota-web',
  status TEXT DEFAULT 'pending',
  classified_at INTEGER,
  classified_hotel_id INTEGER,
  error_message TEXT,
  received_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ota_raw_hotels_status ON ota_raw_hotels(status);
CREATE INDEX IF NOT EXISTS idx_ota_raw_hotels_batch ON ota_raw_hotels(batch_id);

CREATE TABLE IF NOT EXISTS ota_raw_rooms (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id TEXT,
  ota_id TEXT NOT NULL,
  parent_ota_hotel_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT DEFAULT 'pending',
  classified_at INTEGER,
  classified_room_id INTEGER,
  error_message TEXT,
  received_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ota_raw_rooms_status ON ota_raw_rooms(status);
CREATE INDEX IF NOT EXISTS idx_ota_raw_rooms_parent ON ota_raw_rooms(parent_ota_hotel_id);

CREATE TABLE IF NOT EXISTS ota_raw_availability (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id TEXT,
  ota_room_id TEXT NOT NULL,
  date TEXT NOT NULL,
  available_units INTEGER,
  price REAL,
  currency TEXT DEFAULT 'VND',
  payload TEXT,
  status TEXT DEFAULT 'pending',
  classified_at INTEGER,
  received_at INTEGER NOT NULL,
  UNIQUE(ota_room_id, date)
);
CREATE INDEX IF NOT EXISTS idx_ota_raw_avail_status ON ota_raw_availability(status);
CREATE INDEX IF NOT EXISTS idx_ota_raw_avail_date ON ota_raw_availability(date);

CREATE TABLE IF NOT EXISTS ota_raw_images (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id TEXT,
  entity_type TEXT NOT NULL,
  entity_ota_id TEXT NOT NULL,
  image_url TEXT NOT NULL,
  caption TEXT,
  is_primary INTEGER DEFAULT 0,
  order_idx INTEGER,
  status TEXT DEFAULT 'pending',
  classified_at INTEGER,
  received_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ota_raw_images_status ON ota_raw_images(status);

CREATE TABLE IF NOT EXISTS property_types_discovered (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  raw_type_name TEXT UNIQUE NOT NULL,
  mapped_to TEXT,
  discovered_from_ota_id TEXT,
  sample_payload TEXT,
  occurrences INTEGER DEFAULT 1,
  admin_reviewed_at INTEGER,
  added_to_greeting INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS ota_raw_batches (
  batch_id TEXT PRIMARY KEY,
  source TEXT,
  type TEXT,
  total_items INTEGER DEFAULT 0,
  pending_items INTEGER DEFAULT 0,
  classified_items INTEGER DEFAULT 0,
  failed_items INTEGER DEFAULT 0,
  received_at INTEGER NOT NULL,
  last_status_check INTEGER
);
`);

/* ═══════════════════════════════════════════
   HMAC verify (raw body)
   ═══════════════════════════════════════════ */

interface RawBodyReq extends Request {
  rawBody?: string;
}

function verifyHmac(req: RawBodyReq): { ok: boolean; reason?: string } {
  const secret = getSetting(SECRET_KEY) || process.env.OTA_RAW_SECRET;
  if (!secret) {
    console.warn('[ota-raw] WARNING: ota_raw_secret chưa cấu hình — BỎ QUA HMAC');
    return { ok: true, reason: 'no_secret_configured' };
  }

  const sig = (req.headers['x-ota-signature'] as string | undefined) || '';
  if (!sig) return { ok: false, reason: 'missing X-OTA-Signature header' };
  const match = sig.match(/^sha256=([a-f0-9]{64})$/i);
  if (!match) return { ok: false, reason: 'bad signature format (expected sha256=<hex64>)' };

  // Use raw body if captured by express.json verify hook, else fallback re-serialize
  const payload = req.rawBody || JSON.stringify(req.body || {});
  const computed = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  const expected = match[1].toLowerCase();
  if (expected !== computed) return { ok: false, reason: 'signature mismatch' };

  // Timestamp tolerance (±5 phút)
  const ts = parseInt((req.headers['x-ota-timestamp'] as string) || '0', 10);
  if (ts) {
    const skew = Math.abs(Date.now() - ts);
    if (skew > 5 * 60 * 1000) return { ok: false, reason: `timestamp out of range (skew=${skew}ms)` };
  }

  return { ok: true };
}

/* ═══════════════════════════════════════════
   POST /push — Nhận batch raw data từ OTA
   ═══════════════════════════════════════════ */

router.post('/push', (req: RawBodyReq, res: Response) => {
  const verdict = verifyHmac(req);
  if (!verdict.ok) {
    console.warn('[ota-raw] HMAC reject:', verdict.reason);
    return res.status(401).json({ ok: false, error: verdict.reason });
  }

  const body = req.body || {};
  const batchId = String(body.batch_id || `batch_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`);
  const type = String(body.type || '').toLowerCase();
  const items = Array.isArray(body.items) ? body.items : [];
  const source = String(req.headers['x-ota-source'] || body.source || 'ota-web');
  const now = Date.now();

  if (!type || !['hotels', 'rooms', 'availability', 'images'].includes(type)) {
    return res.status(400).json({ ok: false, error: 'type must be one of: hotels, rooms, availability, images' });
  }
  if (!items.length) {
    return res.status(400).json({ ok: false, error: 'items array empty' });
  }

  // Insert batch record
  db.prepare(
    `INSERT OR REPLACE INTO ota_raw_batches
     (batch_id, source, type, total_items, pending_items, received_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(batchId, source, type, items.length, items.length, now);

  let inserted = 0;
  let errors: Array<{ ota_id: string; error: string }> = [];

  const insertFns: Record<string, (item: any) => void> = {
    hotels: (it) => {
      if (!it.ota_id) throw new Error('ota_id required');
      db.prepare(
        `INSERT INTO ota_raw_hotels (batch_id, ota_id, payload, source, status, received_at)
         VALUES (?, ?, ?, ?, 'pending', ?)`
      ).run(batchId, String(it.ota_id), JSON.stringify(it.data || {}), source, now);
    },
    rooms: (it) => {
      if (!it.ota_id || !it.parent_ota_hotel_id) throw new Error('ota_id + parent_ota_hotel_id required');
      db.prepare(
        `INSERT INTO ota_raw_rooms (batch_id, ota_id, parent_ota_hotel_id, payload, status, received_at)
         VALUES (?, ?, ?, ?, 'pending', ?)`
      ).run(batchId, String(it.ota_id), String(it.parent_ota_hotel_id), JSON.stringify(it.data || {}), now);
    },
    availability: (it) => {
      if (!it.ota_room_id || !it.date) throw new Error('ota_room_id + date required');
      db.prepare(
        `INSERT OR REPLACE INTO ota_raw_availability
         (batch_id, ota_room_id, date, available_units, price, currency, payload, status, received_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`
      ).run(
        batchId, String(it.ota_room_id), String(it.date),
        it.available_units !== undefined ? Number(it.available_units) : null,
        it.price !== undefined ? Number(it.price) : null,
        it.currency || 'VND',
        it.data ? JSON.stringify(it.data) : null,
        now,
      );
    },
    images: (it) => {
      if (!it.entity_type || !it.entity_ota_id || !it.image_url) {
        throw new Error('entity_type + entity_ota_id + image_url required');
      }
      db.prepare(
        `INSERT INTO ota_raw_images (batch_id, entity_type, entity_ota_id, image_url, caption, is_primary, order_idx, status, received_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`
      ).run(
        batchId, String(it.entity_type), String(it.entity_ota_id), String(it.image_url),
        it.caption || null,
        it.is_primary ? 1 : 0,
        it.order_idx !== undefined ? Number(it.order_idx) : null,
        now,
      );
    },
  };

  const fn = insertFns[type];
  for (const it of items) {
    try {
      fn(it);
      inserted++;
    } catch (e: any) {
      errors.push({ ota_id: String(it?.ota_id || it?.ota_room_id || '?'), error: e?.message || 'unknown' });
    }
  }

  res.json({
    ok: true,
    batch_id: batchId,
    type,
    received: items.length,
    inserted,
    failed: errors.length,
    errors: errors.slice(0, 10),
    pending_classification: inserted,
    next_classify_at: 'within 5 min (cron)',
  });
});

/* ═══════════════════════════════════════════
   Status endpoints (authed admin UI)
   ═══════════════════════════════════════════ */

router.use(authMiddleware);

/** GET /batches — recent batches summary */
router.get('/batches', (_req: AuthRequest, res) => {
  const rows = db.prepare(
    `SELECT batch_id, source, type, total_items, pending_items, classified_items, failed_items, received_at
     FROM ota_raw_batches ORDER BY received_at DESC LIMIT 50`
  ).all();
  res.json({ items: rows });
});

/** GET /status/:batch_id — tình trạng 1 batch */
router.get('/status/:batch_id', (req: AuthRequest, res) => {
  const bid = String(req.params.batch_id);
  const batch = db.prepare(`SELECT * FROM ota_raw_batches WHERE batch_id = ?`).get(bid) as any;
  if (!batch) return res.status(404).json({ error: 'batch not found' });

  // Count by status from respective table
  const table = batch.type === 'hotels' ? 'ota_raw_hotels'
    : batch.type === 'rooms' ? 'ota_raw_rooms'
    : batch.type === 'availability' ? 'ota_raw_availability'
    : 'ota_raw_images';
  const counts = db.prepare(
    `SELECT status, COUNT(*) as n FROM ${table} WHERE batch_id = ? GROUP BY status`
  ).all(bid);
  const breakdown: Record<string, number> = {};
  for (const c of counts as any[]) breakdown[c.status] = c.n;

  res.json({ batch, breakdown });
});

/** GET /failed — list records fail để admin review */
router.get('/failed', (req: AuthRequest, res) => {
  const limit = Math.min(200, parseInt((req.query.limit as string) || '50', 10));
  const type = (req.query.type as string) || 'hotels';
  const tableMap: Record<string, string> = {
    hotels: 'ota_raw_hotels',
    rooms: 'ota_raw_rooms',
    availability: 'ota_raw_availability',
    images: 'ota_raw_images',
  };
  const table = tableMap[type];
  if (!table) return res.status(400).json({ error: 'invalid type' });

  const rows = db.prepare(
    `SELECT * FROM ${table} WHERE status = 'failed' ORDER BY received_at DESC LIMIT ?`
  ).all(limit);
  // Parse payload JSON cho dễ đọc
  for (const r of rows as any[]) {
    try { r.payload = r.payload ? JSON.parse(r.payload) : null; } catch {}
  }
  res.json({ items: rows });
});

/** POST /reclassify/:table/:id — force re-classify 1 record */
router.post('/reclassify/:table/:id', (req: AuthRequest, res) => {
  const table = `ota_raw_${String(req.params.table)}`;
  const id = parseInt(String(req.params.id), 10);
  const allowed = ['ota_raw_hotels', 'ota_raw_rooms', 'ota_raw_availability', 'ota_raw_images'];
  if (!allowed.includes(table)) return res.status(400).json({ error: 'invalid table' });
  const r = db.prepare(
    `UPDATE ${table} SET status = 'pending', error_message = NULL WHERE id = ?`
  ).run(id);
  res.json({ ok: true, changed: r.changes });
});

/** GET /pending-types — property types mới chưa map */
router.get('/pending-types', (_req: AuthRequest, res) => {
  const rows = db.prepare(
    `SELECT * FROM property_types_discovered WHERE mapped_to IS NULL OR admin_reviewed_at IS NULL
     ORDER BY occurrences DESC, created_at DESC LIMIT 50`
  ).all();
  res.json({ items: rows });
});

/** POST /map-type — admin map 1 property type mới vào canonical */
router.post('/map-type', (req: AuthRequest, res) => {
  const { id, mapped_to, add_to_greeting } = req.body || {};
  if (!id || !mapped_to) return res.status(400).json({ error: 'id + mapped_to required' });
  const allowedTypes = ['hotel', 'homestay', 'villa', 'apartment', 'resort', 'guesthouse', 'hostel'];
  if (!allowedTypes.includes(mapped_to)) {
    return res.status(400).json({ error: `mapped_to must be one of: ${allowedTypes.join(', ')}` });
  }
  db.prepare(
    `UPDATE property_types_discovered
     SET mapped_to = ?, admin_reviewed_at = ?, added_to_greeting = ?
     WHERE id = ?`
  ).run(mapped_to, Date.now(), add_to_greeting ? 1 : 0, id);
  res.json({ ok: true });
});

/** GET /secret-info — admin xem info secret (không expose) + rotate */
router.get('/secret-info', (_req: AuthRequest, res) => {
  const secret = getSetting(SECRET_KEY) || process.env.OTA_RAW_SECRET || '';
  res.json({
    configured: !!secret,
    preview: secret ? secret.slice(0, 6) + '...' + secret.slice(-4) : null,
    from: getSetting(SECRET_KEY) ? 'settings' : (process.env.OTA_RAW_SECRET ? 'env' : 'not set'),
    endpoint: 'POST /api/ota-raw/push',
    headers_required: ['X-OTA-Signature: sha256=<hex>', 'X-OTA-Timestamp: <ms>', 'X-OTA-Source: ota-web|pms|manual'],
  });
});

/** POST /secret-rotate — tạo secret mới (chỉ superadmin) */
router.post('/secret-rotate', (req: AuthRequest, res) => {
  if (req.user?.role !== 'superadmin') return res.status(403).json({ error: 'superadmin only' });
  const newSecret = crypto.randomBytes(32).toString('hex');
  setSetting(SECRET_KEY, newSecret);
  res.json({
    ok: true,
    secret: newSecret,
    note: 'IMPORTANT: update OTA side with this new secret. Old secret is now invalid.',
  });
});

/** GET /stats — dashboard summary */
router.get('/stats', (_req: AuthRequest, res) => {
  const stats = {
    hotels: {
      pending: (db.prepare(`SELECT COUNT(*) as n FROM ota_raw_hotels WHERE status='pending'`).get() as any).n,
      classified: (db.prepare(`SELECT COUNT(*) as n FROM ota_raw_hotels WHERE status='classified'`).get() as any).n,
      failed: (db.prepare(`SELECT COUNT(*) as n FROM ota_raw_hotels WHERE status='failed'`).get() as any).n,
    },
    rooms: {
      pending: (db.prepare(`SELECT COUNT(*) as n FROM ota_raw_rooms WHERE status='pending'`).get() as any).n,
      classified: (db.prepare(`SELECT COUNT(*) as n FROM ota_raw_rooms WHERE status='classified'`).get() as any).n,
      failed: (db.prepare(`SELECT COUNT(*) as n FROM ota_raw_rooms WHERE status='failed'`).get() as any).n,
    },
    availability: {
      pending: (db.prepare(`SELECT COUNT(*) as n FROM ota_raw_availability WHERE status='pending'`).get() as any).n,
      classified: (db.prepare(`SELECT COUNT(*) as n FROM ota_raw_availability WHERE status='classified'`).get() as any).n,
    },
    images: {
      pending: (db.prepare(`SELECT COUNT(*) as n FROM ota_raw_images WHERE status='pending'`).get() as any).n,
      classified: (db.prepare(`SELECT COUNT(*) as n FROM ota_raw_images WHERE status='classified'`).get() as any).n,
    },
    property_types_discovered: (db.prepare(`SELECT COUNT(*) as n FROM property_types_discovered WHERE admin_reviewed_at IS NULL`).get() as any).n,
    recent_batches: (db.prepare(`SELECT COUNT(*) as n FROM ota_raw_batches WHERE received_at > ?`).get(Date.now() - 24 * 3600000) as any).n,
  };
  res.json(stats);
});

export default router;

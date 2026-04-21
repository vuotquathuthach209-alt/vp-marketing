/**
 * OTA Push Receiver — OTA team code trên phía OTA để POST data vào bot.
 *
 * Kiến trúc: Push model (OTA → bot), không còn bot pull từ OTA nữa.
 * Auth: HMAC-SHA256 signature (shared secret OTA_WEBHOOK_SECRET).
 *
 * Endpoints (tất cả dưới /api/ota/push):
 *   POST /sync          — full batch sync (mảng hotels, mỗi hotel chứa rooms/amenities/policies)
 *   POST /hotel         — 1 hotel với nested data
 *   POST /hotel/:id     — partial update cho 1 hotel
 *   DELETE /hotel/:id   — soft-delete hotel (không xóa data, mark status=inactive)
 *   GET  /ping          — OTA test kết nối + verify signature
 *
 * HMAC:
 *   OTA compute: hmac_sha256(OTA_WEBHOOK_SECRET, raw_body)
 *   Gửi header: X-OTA-Signature: sha256=<hex>
 *   Bot verify → reject 401 nếu sai
 */
import { Router, Request } from 'express';
import crypto from 'crypto';
import { db, getSetting, setSetting } from '../db';
import { authMiddleware } from '../middleware/auth';

const router = Router();
const SECRET_KEY = 'ota_push_secret';   // stored in settings table

/* ═══════════════════════════════════════════
   HMAC SIGNATURE MIDDLEWARE
   ═══════════════════════════════════════════ */

// Cần raw body để verify HMAC — express.json() đã parse body. Middleware này
// re-serialize body để verify (OTA team phải sign request theo JSON.stringify).
// Alternative: OTA gửi raw body + bot parse manual.
function verifyHmac(req: Request): { ok: boolean; reason?: string } {
  const secret = getSetting(SECRET_KEY) || process.env.OTA_WEBHOOK_SECRET;
  if (!secret) {
    // First-time setup: cho phép nếu chưa config, nhưng warn
    console.warn('[ota-push] WARNING: OTA_WEBHOOK_SECRET chưa cấu hình — BỎ QUA HMAC check');
    return { ok: true, reason: 'no_secret_configured' };
  }

  const sig = req.headers['x-ota-signature'] as string | undefined;
  if (!sig) return { ok: false, reason: 'missing X-OTA-Signature header' };

  const match = sig.match(/^sha256=([a-f0-9]{64})$/i);
  if (!match) return { ok: false, reason: 'bad signature format (expected sha256=<hex64>)' };

  const expected = match[1].toLowerCase();
  // Compute over JSON-serialized body. OTA team phải dùng SAME serialization.
  const payload = JSON.stringify(req.body || {});
  const computed = crypto.createHmac('sha256', secret).update(payload).digest('hex');

  if (expected !== computed) return { ok: false, reason: 'signature mismatch' };
  return { ok: true };
}

/* ═══════════════════════════════════════════
   UPSERT HELPERS
   ═══════════════════════════════════════════ */

interface PushHotelPayload {
  ota_hotel_id: number;
  name: string;
  name_en?: string;
  slug?: string;
  city?: string;
  district?: string;
  address?: string;
  latitude?: number;
  longitude?: number;
  phone?: string;
  star_rating?: number;
  property_type?: string;           // apartment | hotel | homestay | resort | villa
  product_group?: string;           // monthly_apartment | nightly_stay
  rental_type?: string;             // per_night | per_hour | per_month
  target_segment?: string;
  brand_voice?: string;             // friendly | formal | luxury
  ai_summary_vi?: string;
  ai_summary_en?: string;
  usp_top3?: string[];
  nearby_landmarks?: Record<string, unknown>;
  // Apartment-specific
  monthly_price_from?: number;
  monthly_price_to?: number;
  min_stay_months?: number;
  deposit_months?: number;
  full_kitchen?: boolean;
  washing_machine?: boolean;
  utilities_included?: boolean;
  // Nested
  rooms?: Array<{
    room_key?: string;
    display_name_vi: string;
    display_name_en?: string;
    price_weekday?: number;
    price_weekend?: number;
    price_hourly?: number;
    max_guests?: number;
    bed_config?: string;
    size_m2?: number;
    amenities?: string[];
    photos_urls?: string[];
    description_vi?: string;
  }>;
  amenities?: Array<{
    category?: string;
    name_vi: string;
    name_en?: string;
    free?: boolean;
    hours?: string;
    note?: string;
  }>;
  policies?: {
    checkin_time?: string;
    checkout_time?: string;
    cancellation_text?: string;
    deposit_percent?: number;
    pet_allowed?: boolean;
    child_policy?: string;
    payment_methods?: string;
  };
  // Meta
  status?: 'active' | 'inactive';
  source?: string;
  pushed_at?: number;
}

/** Upsert 1 hotel payload → hotel_profile + rooms + amenities + policies.
 *  Returns {created, updated, error}. */
function upsertHotelPayload(p: PushHotelPayload): { ok: boolean; action: 'created' | 'updated' | 'skipped'; error?: string } {
  if (!p.ota_hotel_id || !p.name) return { ok: false, action: 'skipped', error: 'missing ota_hotel_id/name' };

  const now = Date.now();

  // 1. Ensure mkt_hotels row exists cho hotel này
  let mktRow = db.prepare(`SELECT id FROM mkt_hotels WHERE ota_hotel_id = ?`).get(p.ota_hotel_id) as any;
  let action: 'created' | 'updated' = 'updated';
  if (!mktRow) {
    const slug = (p.slug || p.name || 'hotel-' + p.ota_hotel_id).toLowerCase()
      .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const r = db.prepare(
      `INSERT INTO mkt_hotels (ota_hotel_id, name, slug, plan, status, config, features, max_posts_per_day, max_pages, activated_at, created_at, updated_at)
       VALUES (?, ?, ?, 'pro', 'active', '{}', '{"chatbot":true,"autopilot":true}', 5, 5, ?, ?, ?)`
    ).run(p.ota_hotel_id, p.name, slug, now, now, now);
    mktRow = { id: Number(r.lastInsertRowid) };
    action = 'created';
  } else {
    // Update name if changed
    db.prepare(`UPDATE mkt_hotels SET name = ?, updated_at = ? WHERE id = ?`).run(p.name, now, mktRow.id);
  }

  const hotelId = p.ota_hotel_id;  // hotel_profile PK = ota_hotel_id

  // 2. Upsert hotel_profile
  const existing = db.prepare(`SELECT manual_override, version FROM hotel_profile WHERE hotel_id = ?`).get(hotelId) as any;

  if (existing?.manual_override) {
    // Respect admin override — KHÔNG ghi đè
    return { ok: true, action: 'skipped', error: 'manual_override=true' };
  }

  const usp = p.usp_top3 ? JSON.stringify(p.usp_top3) : '[]';
  const landmarks = p.nearby_landmarks ? JSON.stringify(p.nearby_landmarks) : '{}';
  const scrapedData = JSON.stringify({
    source: p.source || 'ota_push',
    pushed_at: p.pushed_at || now,
    min_stay_months: p.min_stay_months,
    deposit_months: p.deposit_months,
    utilities_included: p.utilities_included,
    full_kitchen: p.full_kitchen,
    washing_machine: p.washing_machine,
  });

  if (existing) {
    db.prepare(
      `UPDATE hotel_profile SET
        ota_hotel_id=?, name_canonical=?, name_en=?, city=?, district=?, address=?,
        latitude=?, longitude=?, phone=?, star_rating=?,
        property_type=?, rental_type=?, product_group=?, target_segment=?, brand_voice=?,
        ai_summary_vi=?, ai_summary_en=?, usp_top3=?, nearby_landmarks=?,
        monthly_price_from=?, monthly_price_to=?, min_stay_months=?, deposit_months=?,
        utilities_included=?, full_kitchen=?, washing_machine=?,
        scraped_data=?, data_source='ota_push', scraped_at=?, updated_at=?,
        version=version+1
       WHERE hotel_id=?`
    ).run(
      p.ota_hotel_id, p.name, p.name_en || null, p.city || null, p.district || null, p.address || null,
      p.latitude ?? null, p.longitude ?? null, p.phone || null, p.star_rating ?? null,
      p.property_type || null, p.rental_type || null, p.product_group || null,
      p.target_segment || null, p.brand_voice || 'friendly',
      p.ai_summary_vi || null, p.ai_summary_en || null, usp, landmarks,
      p.monthly_price_from ?? null, p.monthly_price_to ?? null,
      p.min_stay_months ?? null, p.deposit_months ?? null,
      p.utilities_included ? 1 : 0, p.full_kitchen ? 1 : 0, p.washing_machine ? 1 : 0,
      scrapedData, now, now, hotelId,
    );
  } else {
    db.prepare(
      `INSERT INTO hotel_profile (
        hotel_id, ota_hotel_id, name_canonical, name_en, city, district, address,
        latitude, longitude, phone, star_rating,
        property_type, rental_type, product_group, target_segment, brand_voice,
        ai_summary_vi, ai_summary_en, usp_top3, nearby_landmarks,
        monthly_price_from, monthly_price_to, min_stay_months, deposit_months,
        utilities_included, full_kitchen, washing_machine,
        scraped_data, data_source, scraped_at, synthesized_at, synthesized_by, version, updated_at, manual_override
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ota_push', ?, ?, 'ota_push', 1, ?, 0)`
    ).run(
      hotelId, p.ota_hotel_id, p.name, p.name_en || null, p.city || null, p.district || null, p.address || null,
      p.latitude ?? null, p.longitude ?? null, p.phone || null, p.star_rating ?? null,
      p.property_type || null, p.rental_type || null, p.product_group || null,
      p.target_segment || null, p.brand_voice || 'friendly',
      p.ai_summary_vi || null, p.ai_summary_en || null, usp, landmarks,
      p.monthly_price_from ?? null, p.monthly_price_to ?? null,
      p.min_stay_months ?? null, p.deposit_months ?? null,
      p.utilities_included ? 1 : 0, p.full_kitchen ? 1 : 0, p.washing_machine ? 1 : 0,
      scrapedData, now, now, now,
    );
    action = action === 'created' ? 'created' : 'updated';
  }

  // 3. Upsert rooms (full replace)
  if (Array.isArray(p.rooms) && p.rooms.length > 0) {
    db.prepare(`DELETE FROM hotel_room_catalog WHERE hotel_id = ?`).run(hotelId);
    const stmt = db.prepare(
      `INSERT INTO hotel_room_catalog (hotel_id, room_key, display_name_vi, display_name_en,
        price_weekday, price_weekend, price_hourly, max_guests, bed_config, size_m2,
        amenities, photos_urls, description_vi, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const r of p.rooms) {
      const key = r.room_key || `${hotelId}_${r.display_name_vi.slice(0, 20).replace(/\s+/g, '_')}`;
      stmt.run(
        hotelId, key, r.display_name_vi, r.display_name_en || null,
        r.price_weekday ?? 0, r.price_weekend ?? r.price_weekday ?? 0, r.price_hourly ?? null,
        r.max_guests ?? 2, r.bed_config || null, r.size_m2 ?? null,
        r.amenities ? JSON.stringify(r.amenities) : null,
        r.photos_urls ? JSON.stringify(r.photos_urls) : null,
        r.description_vi || null, now,
      );
    }
  }

  // 4. Upsert amenities (full replace)
  if (Array.isArray(p.amenities) && p.amenities.length > 0) {
    db.prepare(`DELETE FROM hotel_amenities WHERE hotel_id = ?`).run(hotelId);
    const stmt = db.prepare(
      `INSERT INTO hotel_amenities (hotel_id, category, name_vi, name_en, free, hours, note, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const a of p.amenities) {
      stmt.run(hotelId, a.category || 'general', a.name_vi, a.name_en || null,
        a.free ? 1 : 0, a.hours || null, a.note || null, now);
    }
  }

  // 5. Upsert policies (single row per hotel)
  if (p.policies) {
    const pol = p.policies;
    db.prepare(
      `INSERT INTO hotel_policies (hotel_id, checkin_time, checkout_time, cancellation_text, deposit_percent, pet_allowed, child_policy, payment_methods, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(hotel_id) DO UPDATE SET
         checkin_time=excluded.checkin_time,
         checkout_time=excluded.checkout_time,
         cancellation_text=excluded.cancellation_text,
         deposit_percent=excluded.deposit_percent,
         pet_allowed=excluded.pet_allowed,
         child_policy=excluded.child_policy,
         payment_methods=excluded.payment_methods,
         updated_at=excluded.updated_at`
    ).run(hotelId, pol.checkin_time || null, pol.checkout_time || null,
      pol.cancellation_text || null, pol.deposit_percent ?? null,
      pol.pet_allowed ? 1 : 0, pol.child_policy || null,
      pol.payment_methods || null, now);
  }

  return { ok: true, action };
}

/* ═══════════════════════════════════════════
   ENDPOINTS
   ═══════════════════════════════════════════ */

// Health check + auth test
router.get('/ping', (_req, res) => {
  const secret = getSetting(SECRET_KEY);
  res.json({
    ok: true,
    message: 'OTA push endpoint đang hoạt động',
    auth_configured: !!secret,
    timestamp: Date.now(),
  });
});

// HMAC auth test (OTA team thử ping có ký signature)
router.post('/ping', (req, res) => {
  const auth = verifyHmac(req);
  if (!auth.ok) return res.status(401).json({ error: auth.reason });
  res.json({ ok: true, authenticated: true, body_echo: req.body });
});

// Full batch sync
router.post('/sync', (req, res) => {
  const auth = verifyHmac(req);
  if (!auth.ok) return res.status(401).json({ error: auth.reason });

  const { hotels } = req.body || {};
  if (!Array.isArray(hotels)) {
    return res.status(400).json({ error: 'body phải có field `hotels` là array' });
  }

  const startTime = Date.now();
  const result = { processed: 0, created: 0, updated: 0, skipped: 0, failed: 0, errors: [] as any[] };

  for (const h of hotels) {
    result.processed++;
    try {
      const r = upsertHotelPayload(h);
      if (r.action === 'created') result.created++;
      else if (r.action === 'updated') result.updated++;
      else result.skipped++;
      if (!r.ok) result.errors.push({ ota_hotel_id: h.ota_hotel_id, error: r.error });
    } catch (e: any) {
      result.failed++;
      result.errors.push({ ota_hotel_id: h.ota_hotel_id, error: e.message });
    }
  }

  // Log to etl_sync_log
  try {
    db.prepare(
      `INSERT INTO etl_sync_log (started_at, finished_at, status, hotels_total, hotels_ok, hotels_failed, duration_ms, trigger_source)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'ota_push')`
    ).run(startTime, Date.now(), result.failed > 0 ? 'partial' : 'completed',
      result.processed, result.created + result.updated, result.failed,
      Date.now() - startTime);
  } catch {}

  console.log(`[ota-push] sync: ${JSON.stringify({ ...result, errors: result.errors.length })}`);
  res.json({ ok: true, ...result, duration_ms: Date.now() - startTime });
});

// Single hotel push (partial ok)
router.post('/hotel', (req, res) => {
  const auth = verifyHmac(req);
  if (!auth.ok) return res.status(401).json({ error: auth.reason });

  const payload = req.body;
  if (!payload || !payload.ota_hotel_id) {
    return res.status(400).json({ error: 'ota_hotel_id required' });
  }

  try {
    const r = upsertHotelPayload(payload);
    res.json({ ...r, ota_hotel_id: payload.ota_hotel_id });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Soft-delete (mark status=inactive)
router.delete('/hotel/:id', (req, res) => {
  const auth = verifyHmac(req);
  if (!auth.ok) return res.status(401).json({ error: auth.reason });

  const otaId = parseInt(String(req.params.id), 10);
  try {
    const now = Date.now();
    const r = db.prepare(
      `UPDATE mkt_hotels SET status = 'inactive', updated_at = ? WHERE ota_hotel_id = ?`
    ).run(now, otaId);
    res.json({ ok: true, affected: r.changes });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Admin endpoints — auth-protected (khác với public /sync, /hotel gọi bằng HMAC)
router.post('/admin/secret', authMiddleware, (req, res) => {
  const { secret } = req.body || {};
  if (!secret || typeof secret !== 'string' || secret.length < 16) {
    return res.status(400).json({ error: 'secret phải là string >= 16 chars' });
  }
  setSetting(SECRET_KEY, secret);
  res.json({ ok: true, masked: '***' + secret.slice(-4) });
});

router.get('/admin/secret', authMiddleware, (_req, res) => {
  const secret = getSetting(SECRET_KEY);
  res.json({
    configured: !!secret,
    masked: secret ? '***' + secret.slice(-4) : null,
  });
});

// Admin: generate random secret (convenience button)
router.post('/admin/generate-secret', authMiddleware, (_req, res) => {
  const newSecret = crypto.randomBytes(32).toString('hex');   // 64 char hex
  setSetting(SECRET_KEY, newSecret);
  res.json({ ok: true, secret: newSecret, warning: 'Secret này chỉ hiện 1 lần. Copy + lưu ngay!' });
});

// Admin: view recent push audit log
router.get('/admin/log', authMiddleware, (_req, res) => {
  try {
    const rows = db.prepare(
      `SELECT id, started_at, finished_at, status, hotels_total, hotels_ok, hotels_failed,
              duration_ms, trigger_source, error_summary
       FROM etl_sync_log WHERE trigger_source = 'ota_push'
       ORDER BY id DESC LIMIT 50`
    ).all();
    res.json({ entries: rows });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

export default router;

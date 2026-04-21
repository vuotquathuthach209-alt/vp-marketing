/**
 * Hotel Editor — admin CRUD cho hotel_profile + rooms + amenities + policies.
 * Đợt 3.2: cho phép override thủ công data scraper tự động.
 *
 * Endpoints:
 *   GET  /api/hotels-editor/list            — danh sách hotels (từ v_hotel_bot_context)
 *   GET  /api/hotels-editor/:id             — detail: profile + rooms + amenities + policies
 *   PUT  /api/hotels-editor/:id             — update profile fields + set manual_override=1
 *   POST /api/hotels-editor/:id/room        — thêm room mới
 *   PUT  /api/hotels-editor/:id/room/:rid   — edit room
 *   DELETE /api/hotels-editor/:id/room/:rid — xoá room
 *   POST /api/hotels-editor/:id/amenity     — thêm amenity
 *   DELETE /api/hotels-editor/:id/amenity/:aid — xoá amenity
 *   PUT  /api/hotels-editor/:id/policies    — update policies
 *   POST /api/hotels-editor/:id/toggle-override — bật/tắt manual_override
 */
import { Router } from 'express';
import { db } from '../db';
import { authMiddleware, AuthRequest, getHotelId } from '../middleware/auth';

const router = Router();
router.use(authMiddleware);

function resolveProfileId(mktHotelId: number): number | null {
  try {
    const row = db.prepare(`SELECT ota_hotel_id FROM mkt_hotels WHERE id = ?`).get(mktHotelId) as any;
    if (row?.ota_hotel_id) return row.ota_hotel_id;
  } catch {}
  return null;
}

function checkOwnership(req: AuthRequest, mktHotelId: number): boolean {
  if (req.user?.role === 'superadmin') return true;
  return getHotelId(req) === mktHotelId;
}

router.get('/list', (req: AuthRequest, res) => {
  try {
    const role = req.user?.role;
    const rows = role === 'superadmin'
      ? db.prepare(`SELECT * FROM v_hotel_bot_context ORDER BY mkt_hotel_id`).all()
      : db.prepare(`SELECT * FROM v_hotel_bot_context WHERE mkt_hotel_id = ?`).all(getHotelId(req));
    for (const r of rows as any[]) {
      try { r.usp_top3 = r.usp_top3 ? JSON.parse(r.usp_top3) : []; } catch { r.usp_top3 = []; }
      try { r.nearby_landmarks = r.nearby_landmarks ? JSON.parse(r.nearby_landmarks) : {}; } catch { r.nearby_landmarks = {}; }
    }
    res.json({ hotels: rows });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.get('/:id', (req: AuthRequest, res) => {
  try {
    const id = parseInt(String(req.params.id), 10);
    if (!checkOwnership(req, id)) return res.status(403).json({ error: 'forbidden' });
    const profileId = resolveProfileId(id);
    if (!profileId) return res.status(404).json({ error: 'not linked' });

    const profile = db.prepare(`SELECT * FROM hotel_profile WHERE hotel_id = ?`).get(profileId) as any;
    if (!profile) return res.status(404).json({ error: 'not found' });
    try { profile.usp_top3 = profile.usp_top3 ? JSON.parse(profile.usp_top3) : []; } catch { profile.usp_top3 = []; }
    try { profile.nearby_landmarks = profile.nearby_landmarks ? JSON.parse(profile.nearby_landmarks) : {}; } catch { profile.nearby_landmarks = {}; }
    try { profile.scraped_data = profile.scraped_data ? JSON.parse(profile.scraped_data) : {}; } catch { profile.scraped_data = {}; }

    const rooms = db.prepare(`SELECT * FROM hotel_room_catalog WHERE hotel_id = ? ORDER BY price_weekday`).all(profileId) as any[];
    rooms.forEach(r => {
      try { r.amenities = r.amenities ? JSON.parse(r.amenities) : []; } catch { r.amenities = []; }
    });
    const amenities = db.prepare(`SELECT * FROM hotel_amenities WHERE hotel_id = ?`).all(profileId);
    const policies = db.prepare(`SELECT * FROM hotel_policies WHERE hotel_id = ?`).get(profileId);

    res.json({ mkt_hotel_id: id, profile, rooms, amenities, policies });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.put('/:id', (req: AuthRequest, res) => {
  try {
    const id = parseInt(String(req.params.id), 10);
    if (!checkOwnership(req, id)) return res.status(403).json({ error: 'forbidden' });
    const profileId = resolveProfileId(id);
    if (!profileId) return res.status(404).json({ error: 'not linked' });

    const allowed = [
      'name_canonical', 'name_en', 'city', 'district', 'address', 'phone',
      'star_rating', 'target_segment', 'brand_voice',
      'ai_summary_vi', 'ai_summary_en', 'usp_top3', 'nearby_landmarks',
      'property_type', 'rental_type', 'product_group',
      'monthly_price_from', 'monthly_price_to', 'min_stay_months', 'deposit_months',
      'full_kitchen', 'washing_machine', 'utilities_included',
    ];
    const body = req.body || {};
    const sets: string[] = [];
    const params: any[] = [];
    for (const k of allowed) {
      if (body[k] !== undefined) {
        let v = body[k];
        if (k === 'usp_top3' || k === 'nearby_landmarks') v = JSON.stringify(v);
        if (['full_kitchen', 'washing_machine', 'utilities_included'].includes(k)) v = v ? 1 : 0;
        sets.push(`${k} = ?`);
        params.push(v);
      }
    }
    if (sets.length === 0) return res.status(400).json({ error: 'nothing to update' });
    // Auto-set manual_override=1 khi admin edit — tránh ETL ghi đè
    sets.push(`manual_override = 1`);
    sets.push(`updated_at = ?`);
    params.push(Date.now());
    params.push(profileId);
    db.prepare(`UPDATE hotel_profile SET ${sets.join(', ')} WHERE hotel_id = ?`).run(...params);
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.post('/:id/toggle-override', (req: AuthRequest, res) => {
  try {
    const id = parseInt(String(req.params.id), 10);
    if (!checkOwnership(req, id)) return res.status(403).json({ error: 'forbidden' });
    const profileId = resolveProfileId(id);
    if (!profileId) return res.status(404).json({ error: 'not linked' });
    const enable = !!(req.body || {}).enable;
    db.prepare(`UPDATE hotel_profile SET manual_override = ?, updated_at = ? WHERE hotel_id = ?`)
      .run(enable ? 1 : 0, Date.now(), profileId);
    res.json({ ok: true, manual_override: enable });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ── Rooms ──────────────────────────────────────────────────────────
router.post('/:id/room', (req: AuthRequest, res) => {
  try {
    const id = parseInt(String(req.params.id), 10);
    if (!checkOwnership(req, id)) return res.status(403).json({ error: 'forbidden' });
    const profileId = resolveProfileId(id);
    if (!profileId) return res.status(404).json({ error: 'not linked' });
    const b = req.body || {};
    if (!b.display_name_vi) return res.status(400).json({ error: 'display_name_vi required' });
    const key = b.room_key || `manual_${Date.now()}`;
    const r = db.prepare(
      `INSERT INTO hotel_room_catalog (hotel_id, room_key, display_name_vi, display_name_en, price_weekday, price_weekend, price_hourly, max_guests, bed_config, size_m2, amenities, photos_urls, description_vi, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      profileId, key, b.display_name_vi, b.display_name_en || null,
      b.price_weekday || 0, b.price_weekend || b.price_weekday || 0, b.price_hourly || null,
      b.max_guests || 2, b.bed_config || null, b.size_m2 || null,
      b.amenities ? JSON.stringify(b.amenities) : null,
      b.photos_urls ? JSON.stringify(b.photos_urls) : null,
      b.description_vi || null, Date.now(),
    );
    res.json({ ok: true, id: Number(r.lastInsertRowid) });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.put('/:id/room/:rid', (req: AuthRequest, res) => {
  try {
    const id = parseInt(String(req.params.id), 10);
    if (!checkOwnership(req, id)) return res.status(403).json({ error: 'forbidden' });
    const profileId = resolveProfileId(id);
    if (!profileId) return res.status(404).json({ error: 'not linked' });
    const rid = parseInt(String(req.params.rid), 10);
    const b = req.body || {};
    const allowed = ['display_name_vi', 'display_name_en', 'price_weekday', 'price_weekend', 'price_hourly', 'max_guests', 'bed_config', 'size_m2', 'description_vi'];
    const sets: string[] = [];
    const params: any[] = [];
    for (const k of allowed) {
      if (b[k] !== undefined) { sets.push(`${k} = ?`); params.push(b[k]); }
    }
    if (b.amenities !== undefined) { sets.push(`amenities = ?`); params.push(JSON.stringify(b.amenities)); }
    if (sets.length === 0) return res.status(400).json({ error: 'nothing to update' });
    sets.push(`updated_at = ?`); params.push(Date.now());
    params.push(rid, profileId);
    db.prepare(`UPDATE hotel_room_catalog SET ${sets.join(', ')} WHERE id = ? AND hotel_id = ?`).run(...params);
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.delete('/:id/room/:rid', (req: AuthRequest, res) => {
  try {
    const id = parseInt(String(req.params.id), 10);
    if (!checkOwnership(req, id)) return res.status(403).json({ error: 'forbidden' });
    const profileId = resolveProfileId(id);
    if (!profileId) return res.status(404).json({ error: 'not linked' });
    const rid = parseInt(String(req.params.rid), 10);
    db.prepare(`DELETE FROM hotel_room_catalog WHERE id = ? AND hotel_id = ?`).run(rid, profileId);
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ── Amenities ──────────────────────────────────────────────────────
router.post('/:id/amenity', (req: AuthRequest, res) => {
  try {
    const id = parseInt(String(req.params.id), 10);
    if (!checkOwnership(req, id)) return res.status(403).json({ error: 'forbidden' });
    const profileId = resolveProfileId(id);
    if (!profileId) return res.status(404).json({ error: 'not linked' });
    const b = req.body || {};
    if (!b.name_vi) return res.status(400).json({ error: 'name_vi required' });
    const r = db.prepare(
      `INSERT INTO hotel_amenities (hotel_id, category, name_vi, name_en, free, hours, note, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(profileId, b.category || 'general', b.name_vi, b.name_en || null, b.free ? 1 : 0, b.hours || null, b.note || null, Date.now());
    res.json({ ok: true, id: Number(r.lastInsertRowid) });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.delete('/:id/amenity/:aid', (req: AuthRequest, res) => {
  try {
    const id = parseInt(String(req.params.id), 10);
    if (!checkOwnership(req, id)) return res.status(403).json({ error: 'forbidden' });
    const profileId = resolveProfileId(id);
    if (!profileId) return res.status(404).json({ error: 'not linked' });
    const aid = parseInt(String(req.params.aid), 10);
    db.prepare(`DELETE FROM hotel_amenities WHERE id = ? AND hotel_id = ?`).run(aid, profileId);
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ── Policies ──────────────────────────────────────────────────────
router.put('/:id/policies', (req: AuthRequest, res) => {
  try {
    const id = parseInt(String(req.params.id), 10);
    if (!checkOwnership(req, id)) return res.status(403).json({ error: 'forbidden' });
    const profileId = resolveProfileId(id);
    if (!profileId) return res.status(404).json({ error: 'not linked' });
    const b = req.body || {};
    const now = Date.now();
    db.prepare(
      `INSERT INTO hotel_policies (hotel_id, checkin_time, checkout_time, cancellation_text, deposit_percent, pet_allowed, child_policy, payment_methods, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(hotel_id) DO UPDATE SET
         checkin_time = excluded.checkin_time,
         checkout_time = excluded.checkout_time,
         cancellation_text = excluded.cancellation_text,
         deposit_percent = excluded.deposit_percent,
         pet_allowed = excluded.pet_allowed,
         child_policy = excluded.child_policy,
         payment_methods = excluded.payment_methods,
         updated_at = excluded.updated_at`
    ).run(profileId, b.checkin_time || null, b.checkout_time || null, b.cancellation_text || null,
      b.deposit_percent || null, b.pet_allowed ? 1 : 0, b.child_policy || null,
      b.payment_methods || null, now);
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

export default router;

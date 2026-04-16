import { Router } from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { config } from '../config';
import { db, getMktUser } from '../db';
import { getOtaDbConfig } from '../services/ota-db';
import { Pool } from 'pg';

const router = Router();

// Rate limiting: max 5 login attempts per IP per 15 minutes
const loginAttempts: Map<string, { count: number; resetAt: number }> = new Map();
const MAX_ATTEMPTS = 5;
const WINDOW_MS = 15 * 60 * 1000;

function checkLoginRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = loginAttempts.get(ip);
  if (!entry || now > entry.resetAt) {
    loginAttempts.set(ip, { count: 1, resetAt: now + WINDOW_MS });
    return true;
  }
  entry.count++;
  return entry.count <= MAX_ATTEMPTS;
}

/**
 * Sprint 9 Phase 1 — Multi-tenant Auth
 *
 * 2 modes:
 * 1. Admin password (backward compat): POST /login { password }
 * 2. OTA email login: POST /login { email, password }
 *    - Verify credentials against OTA DB (hotel_owners table) — READ ONLY
 *    - Check mkt_permissions for access
 *    - Issue JWT with { hotelId, userId, role, email }
 */

/** Verify email+password against OTA DB (read-only, no writes) */
async function verifyOtaCredentials(email: string, password: string): Promise<{
  ota_owner_id: number;
  full_name: string;
  email: string;
  hotel_ids: number[];
} | null> {
  const cfg = getOtaDbConfig();
  if (!cfg) return null;

  const pool = new Pool({
    host: cfg.host,
    port: cfg.port,
    database: cfg.database,
    user: cfg.user,
    password: cfg.password,
    ssl: cfg.ssl ? { rejectUnauthorized: false } : false,
    max: 1,
    connectionTimeoutMillis: 10000,
  });

  try {
    // Get owner by email
    const ownerResult = await pool.query(
      `SELECT id, full_name, email, password_hash FROM hotel_owners WHERE email = $1 AND status = 'active' AND deleted_at IS NULL`,
      [email]
    );

    if (ownerResult.rows.length === 0) return null;

    const owner = ownerResult.rows[0];

    // Verify password using bcrypt
    const valid = await bcrypt.compare(password, owner.password_hash);
    if (!valid) return null;

    // Get hotel IDs owned by this user
    const hotelsResult = await pool.query(
      `SELECT id FROM hotels WHERE owner_id = $1 AND status = 'active' AND deleted_at IS NULL`,
      [owner.id]
    );

    return {
      ota_owner_id: Number(owner.id),
      full_name: owner.full_name,
      email: owner.email,
      hotel_ids: hotelsResult.rows.map((r: any) => Number(r.id)),
    };
  } catch (e: any) {
    console.error('[auth] OTA verify error:', e.message);
    return null;
  } finally {
    await pool.end();
  }
}

router.post('/login', async (req, res) => {
  const ip = (req.headers['x-forwarded-for'] as string || req.socket.remoteAddress || '').split(',')[0].trim();
  if (!checkLoginRateLimit(ip)) {
    return res.status(429).json({ error: 'Qua nhieu lan dang nhap. Vui long doi 15 phut.' });
  }

  const { password, email } = req.body;

  // Mode 1: Admin password (backward compat / superadmin)
  if (password && !email) {
    if (password !== config.adminPassword) {
      return res.status(401).json({ error: 'Sai mật khẩu' });
    }
    const token = jwt.sign(
      { admin: true, hotelId: 1, role: 'superadmin' },
      config.jwtSecret,
      { expiresIn: '30d' }
    );
    res.cookie('auth', token, {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 30 * 24 * 60 * 60 * 1000,
    });
    return res.json({ ok: true, mode: 'admin' });
  }

  // Mode 2: OTA email login
  if (email && password) {
    try {
      // Step 1: Verify against OTA DB (read-only)
      const otaUser = await verifyOtaCredentials(email, password);
      if (!otaUser) {
        return res.status(401).json({ error: 'Email hoặc mật khẩu không đúng' });
      }

      // Step 2: Check if user exists in MKT DB
      let mktUser = getMktUser(email);

      if (!mktUser) {
        // Check if there's an mkt_hotel linked to any of their OTA hotels
        let hotelId: number | null = null;

        for (const otaHotelId of otaUser.hotel_ids) {
          const linked = db.prepare(
            `SELECT id FROM mkt_hotels WHERE ota_hotel_id = ? AND status = 'active'`
          ).get(otaHotelId) as { id: number } | undefined;
          if (linked) {
            hotelId = linked.id;
            break;
          }
        }

        if (!hotelId) {
          return res.status(403).json({
            error: 'Tài khoản chưa được cấp quyền sử dụng VP Marketing. Liên hệ admin.',
            ota_verified: true,
          });
        }

        // Auto-create MKT user
        const now = Date.now();
        const r = db.prepare(`
          INSERT INTO mkt_users (email, hotel_id, ota_owner_id, role, display_name, last_login, status, created_at, updated_at)
          VALUES (?, ?, ?, 'owner', ?, ?, 'active', ?, ?)
        `).run(email, hotelId, otaUser.ota_owner_id, otaUser.full_name, now, now, now);

        mktUser = {
          id: Number(r.lastInsertRowid),
          email,
          hotel_id: hotelId,
          role: 'owner',
          display_name: otaUser.full_name,
          hotel_name: '',
          plan: 'free',
          hotel_status: 'active',
        };
      } else {
        // Update last_login
        db.prepare(`UPDATE mkt_users SET last_login = ? WHERE id = ?`).run(Date.now(), mktUser.id);
      }

      // Step 3: Check hotel is active
      if (mktUser.hotel_status !== 'active') {
        return res.status(403).json({ error: 'Khách sạn đang tạm ngừng. Liên hệ admin.' });
      }

      // Step 4: Issue JWT
      const token = jwt.sign(
        {
          admin: false,
          hotelId: mktUser.hotel_id,
          userId: mktUser.id,
          role: mktUser.role || 'owner',
          email: mktUser.email,
        },
        config.jwtSecret,
        { expiresIn: '30d' }
      );

      res.cookie('auth', token, {
        httpOnly: true,
        sameSite: 'lax',
        maxAge: 30 * 24 * 60 * 60 * 1000,
      });

      return res.json({
        ok: true,
        mode: 'hotel',
        hotel_name: mktUser.hotel_name,
        plan: mktUser.plan,
        role: mktUser.role,
      });
    } catch (e: any) {
      console.error('[auth] login error:', e);
      return res.status(500).json({ error: 'Lỗi đăng nhập: ' + e.message });
    }
  }

  return res.status(400).json({ error: 'Cần password (admin) hoặc email + password (hotel owner)' });
});

router.post('/logout', (req, res) => {
  res.clearCookie('auth');
  res.json({ ok: true });
});

router.get('/me', (req, res) => {
  const token = req.cookies?.auth;
  if (!token) return res.json({ authenticated: false });
  try {
    const payload = jwt.verify(token, config.jwtSecret) as any;
    res.json({
      authenticated: true,
      hotelId: payload.hotelId || 1,
      role: payload.role || 'superadmin',
      email: payload.email,
      admin: payload.admin || false,
    });
  } catch {
    res.json({ authenticated: false });
  }
});

export default router;

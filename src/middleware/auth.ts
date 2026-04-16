import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config';

/**
 * Sprint 9 Phase 1 — Multi-tenant Auth
 *
 * JWT payload: { admin, hotelId, userId, role, email }
 * - admin: true = old-style admin login (backward compat)
 * - hotelId: mkt_hotels.id — inject vào mọi request
 * - userId: mkt_users.id
 * - role: superadmin | owner | staff
 */

export interface AuthUser {
  admin: boolean;
  hotelId: number;
  userId?: number;
  role?: string;      // superadmin | owner | staff
  email?: string;
}

export interface AuthRequest extends Request {
  user?: AuthUser;
}

export function authMiddleware(req: AuthRequest, res: Response, next: NextFunction) {
  const token = req.cookies?.auth || req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Chưa đăng nhập' });

  try {
    const payload = jwt.verify(token, config.jwtSecret) as any;

    // Backward compat: old JWT chỉ có { admin: true } → default hotelId = 1
    req.user = {
      admin: payload.admin || false,
      hotelId: payload.hotelId || 1,
      userId: payload.userId,
      role: payload.role || (payload.admin ? 'superadmin' : 'owner'),
      email: payload.email,
    };

    next();
  } catch {
    return res.status(401).json({ error: 'Token không hợp lệ' });
  }
}

/** Middleware: chỉ cho superadmin */
export function superadminOnly(req: AuthRequest, res: Response, next: NextFunction) {
  if (!req.user || req.user.role !== 'superadmin') {
    return res.status(403).json({ error: 'Chỉ super admin mới được truy cập' });
  }
  next();
}

/** Helper: lấy hotelId từ request (guaranteed after authMiddleware) */
export function getHotelId(req: AuthRequest): number {
  return req.user?.hotelId || 1;
}

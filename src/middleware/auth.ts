import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config';

export interface AuthRequest extends Request {
  user?: { admin: boolean };
}

export function authMiddleware(req: AuthRequest, res: Response, next: NextFunction) {
  const token = req.cookies?.auth || req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Chưa đăng nhập' });

  try {
    const payload = jwt.verify(token, config.jwtSecret) as { admin: boolean };
    req.user = payload;
    next();
  } catch {
    return res.status(401).json({ error: 'Token không hợp lệ' });
  }
}

import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config';

const router = Router();

router.post('/login', (req, res) => {
  const { password } = req.body;
  if (!password || password !== config.adminPassword) {
    return res.status(401).json({ error: 'Sai mật khẩu' });
  }
  const token = jwt.sign({ admin: true }, config.jwtSecret, { expiresIn: '30d' });
  res.cookie('auth', token, {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 30 * 24 * 60 * 60 * 1000,
  });
  res.json({ ok: true });
});

router.post('/logout', (req, res) => {
  res.clearCookie('auth');
  res.json({ ok: true });
});

router.get('/me', (req, res) => {
  const token = req.cookies?.auth;
  if (!token) return res.json({ authenticated: false });
  try {
    jwt.verify(token, config.jwtSecret);
    res.json({ authenticated: true });
  } catch {
    res.json({ authenticated: false });
  }
});

export default router;

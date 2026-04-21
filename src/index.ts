import express from 'express';
import cookieParser from 'cookie-parser';
import path from 'path';
import { config } from './config';
import './db'; // init DB
import { startScheduler } from './services/scheduler';
import { startBot as startTelegramBot } from './services/telegram';
import authRoutes from './routes/auth';
import settingsRoutes from './routes/settings';
import aiRoutes from './routes/ai';
import mediaRoutes from './routes/media';
import postsRoutes from './routes/posts';
import campaignsRoutes from './routes/campaigns';
import autoreplyRoutes from './routes/autoreply';
import wikiRoutes from './routes/wiki';
import analyticsRoutes from './routes/analytics';
import autopilotRouter from './routes/autopilot';
import bookingRouter from './routes/booking';
import hotelTelegramRouter from './routes/hotel-telegram';
import otaRouter from './routes/ota';
import adminRouter from './routes/admin';
import onboardingRouter from './routes/onboarding';
import monitoringRouter from './routes/monitoring';
import subscriptionRouter from './routes/subscription';
import paymentRouter from './routes/payment';
import feedbackRouter from './routes/feedback';
import referralRouter from './routes/referral';
import zaloRouter, { zaloWebhookRouter } from './routes/zalo';
import bankWebhookRouter from './routes/bank-webhook';
import agentRouter from './routes/agent';
import dataDeletionRouter from './routes/data-deletion';
import trainingRouter from './routes/training';
import newsRouter from './routes/news';
import './services/agent-tools'; // init table + register tools
import './services/ota-readonly-guard'; // self-test fires on boot (fail-fast if guard broken)
// v8: Intent matcher self-test
import { selfTest as intentMatcherSelfTest } from './services/intent-matcher';
intentMatcherSelfTest().catch(e => console.warn('[intent-matcher] boot selftest fail:', e?.message));
import rateLimit from 'express-rate-limit';

const app = express();

// ── Security headers (improve SmartScreen / SafeBrowsing reputation) ───
app.use((_req, res, next) => {
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.removeHeader('X-Powered-By');
  next();
});

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// ── Rate limiting ───────────────────────────────────────────────────────
app.set('trust proxy', 1); // respect X-Forwarded-For from nginx
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 10,
  message: { error: 'Quá nhiều lần đăng nhập. Thử lại sau 15 phút.' },
  standardHeaders: true, legacyHeaders: false,
});
const webhookLimiter = rateLimit({
  windowMs: 60 * 1000, max: 120,
  standardHeaders: true, legacyHeaders: false,
});
const proofLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, max: 5,
  message: { error: 'Quá nhiều lần gửi bill. Thử lại sau 1 giờ.' },
  standardHeaders: true, legacyHeaders: false,
});
const apiGeneralLimiter = rateLimit({
  windowMs: 60 * 1000, max: 300,
  standardHeaders: true, legacyHeaders: false,
  skip: (req) => req.path.startsWith('/api/health'),
});
app.use('/api/auth/login', loginLimiter);
app.use('/api/auth/register', loginLimiter);
app.use('/webhook', webhookLimiter);
app.use('/api/subscription/submit-proof', proofLimiter);
app.use('/api/', apiGeneralLimiter);

// Static frontend
app.use(express.static(path.join(__dirname, '..', 'src', 'public')));

// Public media (room images, uploaded photos) — no auth, FB/clients fetch directly
import { config as _cfg } from './config';
app.use('/media', express.static(_cfg.mediaDir, {
  maxAge: '30d',
  fallthrough: false,
}));

// API routes
app.use('/api/auth', authRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/ai', aiRoutes);
app.use('/api/media', mediaRoutes);
app.use('/api/posts', postsRoutes);
app.use('/api/campaigns', campaignsRoutes);
app.use('/api/auto-reply', autoreplyRoutes);
app.use('/api/wiki', wikiRoutes);
app.use('/api/analytics', analyticsRoutes);
app.use('/api/autopilot', autopilotRouter);
app.use('/api/booking', bookingRouter);
app.use('/api/hotel-telegram', hotelTelegramRouter);
app.use('/api/ota', otaRouter);
app.use('/api/admin', adminRouter);
app.use('/api/onboarding', onboardingRouter);
app.use('/api/monitoring', monitoringRouter);
app.use('/api/subscription', subscriptionRouter);
app.use('/api/payment', paymentRouter);
app.use('/api/feedback', feedbackRouter);
app.use('/api/referral', referralRouter);
app.use('/api/zalo', zaloRouter);
app.use('/api/agent', agentRouter);
app.use('/api/training', trainingRouter);
app.use('/api/news', newsRouter);
app.use('/api/data-deletion', dataDeletionRouter);
app.use('/data-deletion', dataDeletionRouter); // also accept /data-deletion/status (URL returned to FB)
app.use('/', zaloWebhookRouter); // POST /webhook/zalo
app.use('/webhook', bankWebhookRouter); // POST /webhook/bank

app.get('/api/health', (req, res) => res.json({ ok: true, time: Date.now() }));

// Public: industries list (for signup page)
app.get('/api/public/industries', (_req, res) => {
  try {
    const { listIndustries } = require('./services/industry');
    res.json({ items: listIndustries() });
  } catch { res.json({ items: [] }); }
});

// Public event tracking (no auth) — used by pricing.html
app.post('/api/public/track', (req, res) => {
  try {
    const { trackEvent } = require('./services/events');
    const { event, meta } = req.body || {};
    if (!event || typeof event !== 'string' || event.length > 60) return res.status(400).json({ error: 'bad event' });
    trackEvent({ event: String(event).slice(0, 60), meta, ip: req.ip, ua: String(req.headers['user-agent'] || '') });
    res.json({ ok: true });
  } catch { res.json({ ok: false }); }
});

// Public: bank info + pricing + admin contact (no auth) — pricing page reads this
app.get('/api/public/bank-info', (_req, res) => {
  const { db } = require('./db');
  const get = (k: string) => (db.prepare(`SELECT value FROM settings WHERE key = ?`).get(k) as any)?.value || '';
  const price = (k: string, def: number) => {
    const v = get(k);
    return v ? parseInt(v, 10) : def;
  };
  res.json({
    bank: {
      bin: get('bank_bin'),
      account: get('bank_account'),
      holder: get('bank_holder'),
      name: get('bank_name'),
    },
    contact: {
      zalo: get('admin_zalo') || '0942883133',
      hotline: get('admin_hotline') || '0942883133',
    },
    prices: {
      starter: price('price_starter', 300000),
      pro: price('price_pro', 600000),
      enterprise: price('price_enterprise', 1500000),
    },
  });
});

// Global error handler — prevent stack trace leaks
app.use((err: any, req: any, res: any, next: any) => {
  console.error(`[error] ${req.method} ${req.path}:`, err.message);
  res.status(err.status || 500).json({ error: config.nodeEnv === 'production' ? 'Internal server error' : err.message });
});

// 404 cho /api/* để tránh SPA fallback nuốt typo
app.use('/api', (_req, res) => res.status(404).json({ error: 'API endpoint not found' }));
app.use('/webhook', (_req, res) => res.status(404).json({ error: 'webhook endpoint not found' }));

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'src', 'public', 'index.html'));
});

app.listen(config.port, () => {
  console.log(`🚀 Marketing Auto chạy trên http://localhost:${config.port}`);
  console.log(`   TZ: ${config.tz}`);
  startScheduler();
  startTelegramBot();
});

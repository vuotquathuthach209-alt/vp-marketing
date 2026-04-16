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

const app = express();

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// Static frontend
app.use(express.static(path.join(__dirname, '..', 'src', 'public')));

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

app.get('/api/health', (req, res) => res.json({ ok: true, time: Date.now() }));

// Global error handler — prevent stack trace leaks
app.use((err: any, req: any, res: any, next: any) => {
  console.error(`[error] ${req.method} ${req.path}:`, err.message);
  res.status(err.status || 500).json({ error: config.nodeEnv === 'production' ? 'Internal server error' : err.message });
});

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

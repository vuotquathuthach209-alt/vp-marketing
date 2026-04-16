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

app.get('/api/health', (req, res) => res.json({ ok: true, time: Date.now() }));

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

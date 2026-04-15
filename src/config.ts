import dotenv from 'dotenv';
import path from 'path';

dotenv.config();

export const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  adminPassword: process.env.ADMIN_PASSWORD || 'change-me-now',
  jwtSecret: process.env.JWT_SECRET || 'dev-secret-change-me',
  tz: process.env.TZ || 'Asia/Ho_Chi_Minh',

  anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
  falApiKey: process.env.FAL_API_KEY || '',

  fbAppId: process.env.FB_APP_ID || '',
  fbAppSecret: process.env.FB_APP_SECRET || '',

  dataDir: path.resolve(process.cwd(), 'data'),
  mediaDir: path.resolve(process.cwd(), 'data/media'),
  uploadsDir: path.resolve(process.cwd(), 'data/uploads'),
  dbPath: path.resolve(process.cwd(), 'data/db.sqlite'),
};

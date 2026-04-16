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

  // VNPay
  vnpTmnCode: process.env.VNP_TMN_CODE || '',
  vnpHashSecret: process.env.VNP_HASH_SECRET || '',
  vnpUrl: process.env.VNP_URL || 'https://sandbox.vnpayment.vn/paymentv2/vnapigw.html',
  vnpReturnUrl: process.env.VNP_RETURN_URL || 'http://localhost:3000/api/payment/vnpay-return',

  // MoMo
  momoPartnerCode: process.env.MOMO_PARTNER_CODE || '',
  momoAccessKey: process.env.MOMO_ACCESS_KEY || '',
  momoSecretKey: process.env.MOMO_SECRET_KEY || '',
  momoEndpoint: process.env.MOMO_ENDPOINT || 'https://test-payment.momo.vn/v2/gateway/api/create',
  momoReturnUrl: process.env.MOMO_RETURN_URL || 'http://localhost:3000/api/payment/momo-return',
  momoIpnUrl: process.env.MOMO_IPN_URL || 'http://localhost:3000/api/payment/momo-ipn',

  // Email (SMTP)
  smtpHost: process.env.SMTP_HOST || 'smtp.gmail.com',
  smtpPort: parseInt(process.env.SMTP_PORT || '587'),
  smtpUser: process.env.SMTP_USER || '',
  smtpPass: process.env.SMTP_PASS || '',
  smtpFrom: process.env.SMTP_FROM || 'VP Marketing <noreply@sondervn.com>',

  dataDir: path.resolve(process.cwd(), 'data'),
  mediaDir: path.resolve(process.cwd(), 'data/media'),
  uploadsDir: path.resolve(process.cwd(), 'data/uploads'),
  dbPath: path.resolve(process.cwd(), 'data/db.sqlite'),
};

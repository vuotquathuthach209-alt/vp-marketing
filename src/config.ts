import dotenv from 'dotenv';
import path from 'path';

dotenv.config();

/**
 * Dynamic config: đọc DB settings trước, fallback env, fallback default.
 * Admin có thể thay đổi tất cả config từ UI mà không cần Railway.
 */
function dbGet(key: string): string {
  try {
    // Lazy import to avoid circular dependency (config loads before db)
    const { getSetting } = require('./db');
    return getSetting(key) || '';
  } catch { return ''; }
}

/** Read from DB first, then env, then default */
function cfg(dbKey: string, envKey: string, defaultVal: string = ''): string {
  return dbGet(dbKey) || process.env[envKey] || defaultVal;
}

export const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  adminPassword: process.env.ADMIN_PASSWORD || 'change-me-now',
  jwtSecret: process.env.JWT_SECRET || 'dev-secret-change-me',
  tz: process.env.TZ || 'Asia/Ho_Chi_Minh',

  // AI Keys — DB settings trước, env fallback
  get anthropicApiKey() { return cfg('anthropic_api_key', 'ANTHROPIC_API_KEY'); },
  get falApiKey() { return cfg('fal_api_key', 'FAL_API_KEY'); },

  // Facebook
  get fbAppId() { return cfg('fb_app_id', 'FB_APP_ID'); },
  get fbAppSecret() { return cfg('fb_app_secret', 'FB_APP_SECRET'); },

  // Public base URL (for callback URLs, email links, FB data-deletion status page)
  get publicUrl() { return cfg('public_url', 'PUBLIC_URL', 'https://mkt.sondervn.com'); },

  // VNPay
  get vnpTmnCode() { return cfg('vnp_tmn_code', 'VNP_TMN_CODE'); },
  get vnpHashSecret() { return cfg('vnp_hash_secret', 'VNP_HASH_SECRET'); },
  vnpUrl: process.env.VNP_URL || 'https://sandbox.vnpayment.vn/paymentv2/vnapigw.html',
  get vnpReturnUrl() { return cfg('vnp_return_url', 'VNP_RETURN_URL', 'http://localhost:3000/api/payment/vnpay-return'); },

  // MoMo
  get momoPartnerCode() { return cfg('momo_partner_code', 'MOMO_PARTNER_CODE'); },
  get momoAccessKey() { return cfg('momo_access_key', 'MOMO_ACCESS_KEY'); },
  get momoSecretKey() { return cfg('momo_secret_key', 'MOMO_SECRET_KEY'); },
  momoEndpoint: process.env.MOMO_ENDPOINT || 'https://test-payment.momo.vn/v2/gateway/api/create',
  get momoReturnUrl() { return cfg('momo_return_url', 'MOMO_RETURN_URL', 'http://localhost:3000/api/payment/momo-return'); },
  get momoIpnUrl() { return cfg('momo_ipn_url', 'MOMO_IPN_URL', 'http://localhost:3000/api/payment/momo-ipn'); },

  // Email (SMTP)
  get smtpHost() { return cfg('smtp_host', 'SMTP_HOST', 'smtp.gmail.com'); },
  get smtpPort() { return parseInt(cfg('smtp_port', 'SMTP_PORT', '587')); },
  get smtpUser() { return cfg('smtp_user', 'SMTP_USER'); },
  get smtpPass() { return cfg('smtp_pass', 'SMTP_PASS'); },
  get smtpFrom() { return cfg('smtp_from', 'SMTP_FROM', 'VP Marketing <noreply@sondervn.com>'); },

  dataDir: path.resolve(process.cwd(), 'data'),
  mediaDir: path.resolve(process.cwd(), 'data/media'),
  uploadsDir: path.resolve(process.cwd(), 'data/uploads'),
  dbPath: path.resolve(process.cwd(), 'data/db.sqlite'),
};

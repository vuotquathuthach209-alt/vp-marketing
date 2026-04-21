import axios from 'axios';
import fs from 'fs';
import path from 'path';
import FormData from 'form-data';
import { config } from '../config';

const GRAPH = 'https://graph.facebook.com/v21.0';

interface PublishResult {
  fbPostId: string;
}

/**
 * Đăng text thuần lên Facebook Page
 */
export async function publishText(
  pageId: string,
  accessToken: string,
  message: string
): Promise<PublishResult> {
  const resp = await axios.post(
    `${GRAPH}/${pageId}/feed`,
    null,
    {
      params: { message, access_token: accessToken },
      timeout: 30000,
    }
  );
  return { fbPostId: resp.data.id };
}

/**
 * Đăng ảnh + caption lên Facebook Page.
 * Auto-detect: URL (http/https) → dùng Graph API url= (FB tự fetch).
 * Local path → upload multipart.
 * Tránh ENOENT khi autopilot lưu URL vào media.filename.
 */
export async function publishImage(
  pageId: string,
  accessToken: string,
  message: string,
  imagePath: string
): Promise<PublishResult> {
  // URL mode — FB tự fetch (vd Google Drive direct link, CDN, ...)
  if (/^https?:\/\//i.test(imagePath)) {
    const resp = await axios.post(`${GRAPH}/${pageId}/photos`, null, {
      params: { message, url: imagePath, access_token: accessToken },
      timeout: 120000,
    });
    return { fbPostId: resp.data.post_id || resp.data.id };
  }

  // Local file mode
  if (!fs.existsSync(imagePath)) {
    throw new Error(`Image file not found: ${imagePath}`);
  }
  const form = new FormData();
  form.append('message', message);
  form.append('access_token', accessToken);
  form.append('source', fs.createReadStream(imagePath));

  const resp = await axios.post(`${GRAPH}/${pageId}/photos`, form, {
    headers: form.getHeaders(),
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
    timeout: 120000,
  });

  return { fbPostId: resp.data.post_id || resp.data.id };
}

/**
 * Đăng video + caption lên Facebook Page
 * Dùng resumable upload cho video > 1MB
 */
export async function publishVideo(
  pageId: string,
  accessToken: string,
  message: string,
  videoPath: string
): Promise<PublishResult> {
  const form = new FormData();
  form.append('description', message);
  form.append('access_token', accessToken);
  form.append('source', fs.createReadStream(videoPath));

  const resp = await axios.post(`${GRAPH}/${pageId}/videos`, form, {
    headers: form.getHeaders(),
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
    timeout: 600000, // 10 phút cho video
  });

  return { fbPostId: resp.data.post_id || resp.data.id };
}

/**
 * Kiểm tra token còn hạn không, trả về tên page
 */
export async function verifyPageToken(
  pageId: string,
  accessToken: string
): Promise<{ name: string; id: string }> {
  const resp = await axios.get(`${GRAPH}/${pageId}`, {
    params: { fields: 'id,name', access_token: accessToken },
    timeout: 15000,
  });
  return { id: resp.data.id, name: resp.data.name };
}

export function mediaFullPath(filename: string): string {
  return path.join(config.mediaDir, filename);
}

/**
 * Đổi short-lived token → long-lived token (60 ngày)
 */
export async function exchangeLongLivedToken(shortToken: string): Promise<{ access_token: string; expires_in: number }> {
  const resp = await axios.get(`${GRAPH}/oauth/access_token`, {
    params: {
      grant_type: 'fb_exchange_token',
      client_id: config.fbAppId,
      client_secret: config.fbAppSecret,
      fb_exchange_token: shortToken,
    },
    timeout: 15000,
  });
  return {
    access_token: resp.data.access_token,
    expires_in: resp.data.expires_in || 5184000, // default 60 days
  };
}

/**
 * Kiểm tra token info: còn hạn bao lâu
 */
export async function debugToken(accessToken: string): Promise<{ is_valid: boolean; expires_at: number; scopes: string[] }> {
  try {
    const resp = await axios.get(`${GRAPH}/debug_token`, {
      params: {
        input_token: accessToken,
        access_token: `${config.fbAppId}|${config.fbAppSecret}`,
      },
      timeout: 15000,
    });
    const data = resp.data?.data || {};
    return {
      is_valid: data.is_valid || false,
      expires_at: data.expires_at || 0,
      scopes: data.scopes || [],
    };
  } catch {
    return { is_valid: false, expires_at: 0, scopes: [] };
  }
}

/**
 * Tự động refresh tất cả page tokens sắp hết hạn (< 7 ngày)
 * Gọi bằng cron mỗi ngày
 */
export async function autoRefreshPageTokens(): Promise<{ refreshed: number; failed: number; errors: string[] }> {
  const { db } = require('../db');
  const pages = db.prepare(`SELECT id, name, fb_page_id, access_token FROM pages`).all() as any[];
  let refreshed = 0, failed = 0;
  const errors: string[] = [];
  const sevenDays = 7 * 86400;

  for (const page of pages) {
    try {
      const info = await debugToken(page.access_token);
      if (!info.is_valid) {
        errors.push(`${page.name}: token het han hoac khong hop le`);
        failed++;
        continue;
      }

      const now = Math.floor(Date.now() / 1000);
      const remaining = info.expires_at - now;

      // Token còn > 7 ngày → skip
      if (info.expires_at === 0 || remaining > sevenDays) continue;

      // Token sắp hết → thử refresh
      console.log(`[fb-refresh] ${page.name}: token con ${Math.round(remaining / 86400)} ngay, dang refresh...`);
      const newToken = await exchangeLongLivedToken(page.access_token);
      db.prepare(`UPDATE pages SET access_token = ? WHERE id = ?`).run(newToken.access_token, page.id);
      refreshed++;
      console.log(`[fb-refresh] ${page.name}: da refresh, moi ${Math.round(newToken.expires_in / 86400)} ngay`);
    } catch (e: any) {
      errors.push(`${page.name}: ${e.message}`);
      failed++;
    }
  }

  return { refreshed, failed, errors };
}

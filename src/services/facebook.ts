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
 * Đăng ảnh + caption lên Facebook Page
 */
export async function publishImage(
  pageId: string,
  accessToken: string,
  message: string,
  imagePath: string
): Promise<PublishResult> {
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

/**
 * FB Attachment Downloader
 *
 * Tải file đính kèm từ FB Messenger về memory để feed vào multimodal analyzer.
 * - Image URLs: public CDN, không cần auth
 * - Audio URLs: thường có query params auth tự đủ (FB sign URL)
 *
 * Limits:
 *  - Tối đa 10MB / file để tránh Gemini reject
 *  - Timeout 20s
 */
import axios from 'axios';

const MAX_BYTES = 10 * 1024 * 1024;

export interface DownloadResult {
  data: Buffer;
  mimeType: string;
  size: number;
}

export async function downloadFbAttachment(url: string): Promise<DownloadResult> {
  const resp = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: 20000,
    maxContentLength: MAX_BYTES,
    maxBodyLength: MAX_BYTES,
  });
  const mimeType = String(resp.headers['content-type'] || 'application/octet-stream').split(';')[0].trim();
  const data = Buffer.from(resp.data);
  return { data, mimeType, size: data.length };
}

/** Heuristic mime → type dùng cho multimodal.ts */
export function mimeToAttachmentType(mime: string): 'image' | 'audio' | 'video' | null {
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('video/')) return 'video';
  return null;
}

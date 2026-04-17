import axios from 'axios';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { config } from '../config';
import { db } from '../db';
import { pickKey } from './keyrotator';

function getKey(): string {
  return pickKey('fal_api_key', config.falApiKey);
}

/**
 * Gen ảnh bằng Flux schnell (rẻ, nhanh ~$0.003/ảnh)
 * Docs: https://fal.ai/models/fal-ai/flux/schnell
 */
export async function generateImage(prompt: string): Promise<number> {
  const key = getKey();
  if (!key) throw new Error('Chưa cấu hình fal.ai API key. Vào Cấu hình → ô 🟠 fal.ai Keys để nhập.');

  let resp;
  try {
    resp = await axios.post(
      'https://fal.run/fal-ai/flux/schnell',
      {
        prompt,
        image_size: 'landscape_4_3',
        num_inference_steps: 4,
        num_images: 1,
        enable_safety_checker: true,
      },
      {
        headers: {
          Authorization: `Key ${key}`,
          'Content-Type': 'application/json',
        },
        timeout: 120000,
      }
    );
  } catch (e: any) {
    // Trả message cụ thể từ fal.ai thay vì generic axios error
    const status = e?.response?.status;
    const detail = e?.response?.data?.detail || e?.response?.data?.error || e?.response?.data;
    const detailStr = typeof detail === 'string' ? detail : JSON.stringify(detail || {});
    if (status === 403 && /balance|locked|exhausted/i.test(detailStr)) {
      throw new Error('fal.ai: Tài khoản hết tiền. Nạp thêm tại https://fal.ai/dashboard/billing rồi thử lại.');
    }
    if (status === 401) {
      throw new Error('fal.ai: API key không hợp lệ (401). Kiểm tra lại key ở tab Cấu hình.');
    }
    if (status === 429) {
      throw new Error('fal.ai: Quá rate limit (429). Đợi 1-2 phút rồi thử lại.');
    }
    throw new Error(`fal.ai gen ảnh fail (HTTP ${status || '?'}): ${detailStr.slice(0, 200)}`);
  }

  const imageUrl = resp.data?.images?.[0]?.url;
  if (!imageUrl) throw new Error('fal.ai không trả về ảnh');

  // Tải ảnh về lưu local
  const imgResp = await axios.get(imageUrl, { responseType: 'arraybuffer', timeout: 60000 });
  const ext = 'jpg';
  const filename = `ai-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${ext}`;
  const filepath = path.join(config.mediaDir, filename);
  fs.writeFileSync(filepath, Buffer.from(imgResp.data));

  // Lưu vào DB
  const stat = fs.statSync(filepath);
  const result = db
    .prepare(
      `INSERT INTO media (filename, mime_type, size, source, prompt, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(filename, 'image/jpeg', stat.size, 'ai-image', prompt, Date.now());

  return Number(result.lastInsertRowid);
}

export type VideoTier = 'standard' | 'pro' | 'veo3';

const TIER_CONFIG: Record<VideoTier, { t2v: string; i2v: string; duration: string; label: string; cost: number }> = {
  standard: {
    t2v: 'fal-ai/kling-video/v1/standard/text-to-video',
    i2v: 'fal-ai/kling-video/v1/standard/image-to-video',
    duration: '5',
    label: 'Kling v1 Standard',
    cost: 0.35,
  },
  pro: {
    t2v: 'fal-ai/kling-video/v1/pro/text-to-video',
    i2v: 'fal-ai/kling-video/v1/pro/image-to-video',
    duration: '5',
    label: 'Kling v1 Pro',
    cost: 0.95,
  },
  veo3: {
    t2v: 'fal-ai/veo3',
    i2v: 'fal-ai/veo3/image-to-video',
    duration: '8',
    label: 'Google Veo 3',
    cost: 2.5,
  },
};

/**
 * Upload local file lên fal.ai storage để lấy public URL (dùng cho image-to-video).
 * Docs: https://docs.fal.ai/model-endpoints/storage
 */
async function uploadToFalStorage(filepath: string, mime: string): Promise<string> {
  const key = getKey();
  const buf = fs.readFileSync(filepath);
  const filename = path.basename(filepath);

  // Step 1: initiate
  const init = await axios.post(
    'https://rest.alpha.fal.ai/storage/upload/initiate',
    { content_type: mime, file_name: filename },
    { headers: { Authorization: `Key ${key}`, 'Content-Type': 'application/json' }, timeout: 20000 }
  );
  const uploadUrl = init.data?.upload_url;
  const fileUrl = init.data?.file_url;
  if (!uploadUrl || !fileUrl) throw new Error('fal.ai storage init failed');

  // Step 2: PUT raw bytes
  await axios.put(uploadUrl, buf, {
    headers: { 'Content-Type': mime },
    timeout: 120000,
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
  });

  return fileUrl;
}

/**
 * Gen video 5-8s bằng Kling/Veo qua fal.ai.
 * @param prompt  prompt tiếng Anh
 * @param opts.tier         'standard' | 'pro' | 'veo3' (default 'standard')
 * @param opts.imageMediaId  nếu có → image-to-video (bám cảnh thật)
 */
export async function generateVideo(
  prompt: string,
  opts: { tier?: VideoTier; imageMediaId?: number } = {}
): Promise<number> {
  const key = getKey();
  if (!key) throw new Error('Chưa cấu hình fal.ai API key. Vào Cài đặt → ô 🖼 FAL.AI để nhập.');

  const tier = opts.tier || 'standard';
  const cfg = TIER_CONFIG[tier];
  if (!cfg) throw new Error(`Tier không hợp lệ: ${tier}`);

  // Nếu có image → upload lên fal storage, dùng image-to-video endpoint
  let imageUrl: string | null = null;
  if (opts.imageMediaId) {
    const row: any = db.prepare('SELECT filename, mime_type FROM media WHERE id = ?').get(opts.imageMediaId);
    if (!row) throw new Error(`Không tìm thấy media #${opts.imageMediaId}`);
    if (!/^image\//.test(row.mime_type)) throw new Error('Media đã chọn không phải ảnh');
    const fp = path.join(config.mediaDir, row.filename);
    if (!fs.existsSync(fp)) throw new Error('File ảnh đã bị xoá trên đĩa');
    imageUrl = await uploadToFalStorage(fp, row.mime_type);
  }

  const endpoint = imageUrl ? cfg.i2v : cfg.t2v;
  const payload: any = { prompt, duration: cfg.duration, aspect_ratio: '16:9' };
  if (imageUrl) payload.image_url = imageUrl;

  const submitResp = await axios.post(
    `https://queue.fal.run/${endpoint}`,
    payload,
    { headers: { Authorization: `Key ${key}`, 'Content-Type': 'application/json' }, timeout: 30000 }
  );

  const requestId = submitResp.data?.request_id;
  // fal.ai trả về status_url + response_url mà dùng base model name (không v1/standard/...)
  const statusUrl: string = submitResp.data?.status_url;
  const responseUrl: string = submitResp.data?.response_url;
  if (!requestId || !statusUrl || !responseUrl) {
    throw new Error(`fal.ai submit thiếu request_id/status_url: ${JSON.stringify(submitResp.data).slice(0, 200)}`);
  }

  // Poll (tối đa 10 phút = 120 lần × 5s — Kling Pro / Veo có thể chậm)
  let videoUrl: string | null = null;
  let lastStatus = '';
  for (let i = 0; i < 120; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const statusResp = await axios.get(statusUrl, {
      headers: { Authorization: `Key ${key}` }, timeout: 15000, validateStatus: () => true,
    });
    lastStatus = statusResp.data?.status || `HTTP ${statusResp.status}`;
    if (statusResp.data?.status === 'COMPLETED') {
      const resultResp = await axios.get(responseUrl, {
        headers: { Authorization: `Key ${key}` }, timeout: 30000,
      });
      videoUrl = resultResp.data?.video?.url || resultResp.data?.response?.video?.url || null;
      break;
    }
    if (statusResp.data?.status === 'FAILED' || statusResp.data?.status === 'ERROR') {
      const logs = JSON.stringify(statusResp.data?.logs || statusResp.data).slice(0, 200);
      throw new Error(`fal.ai ${cfg.label} gen video thất bại: ${logs}`);
    }
  }

  if (!videoUrl) throw new Error(`Timeout chờ video ${cfg.label} (10 phút) — status cuối: ${lastStatus}`);

  const vidResp = await axios.get(videoUrl, { responseType: 'arraybuffer', timeout: 180000 });
  const filename = `ai-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.mp4`;
  const filepath = path.join(config.mediaDir, filename);
  fs.writeFileSync(filepath, Buffer.from(vidResp.data));

  const stat = fs.statSync(filepath);
  const label = `[${cfg.label}${imageUrl ? ' i2v' : ' t2v'}] ${prompt}`;
  const result = db
    .prepare(
      `INSERT INTO media (filename, mime_type, size, source, prompt, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(filename, 'video/mp4', stat.size, 'ai-video', label, Date.now());

  return Number(result.lastInsertRowid);
}

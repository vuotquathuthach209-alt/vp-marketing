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

  const resp = await axios.post(
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

/**
 * Gen video 5s bằng Kling qua fal.ai (~$0.35/video)
 * Docs: https://fal.ai/models/fal-ai/kling-video/v1/standard/text-to-video
 */
export async function generateVideo(prompt: string): Promise<number> {
  const key = getKey();

  // Video gen có thể mất 1-3 phút, dùng queue API
  const submitResp = await axios.post(
    'https://queue.fal.run/fal-ai/kling-video/v1/standard/text-to-video',
    { prompt, duration: '5', aspect_ratio: '16:9' },
    {
      headers: { Authorization: `Key ${key}`, 'Content-Type': 'application/json' },
      timeout: 30000,
    }
  );

  const requestId = submitResp.data?.request_id;
  if (!requestId) throw new Error('fal.ai không trả request_id');

  // Poll trạng thái
  let videoUrl: string | null = null;
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const statusResp = await axios.get(
      `https://queue.fal.run/fal-ai/kling-video/v1/standard/requests/${requestId}`,
      { headers: { Authorization: `Key ${key}` }, timeout: 15000 }
    );
    if (statusResp.data?.status === 'COMPLETED') {
      videoUrl = statusResp.data?.video?.url || statusResp.data?.response?.video?.url || null;
      if (!videoUrl) {
        // Fetch kết quả đầy đủ
        const resultResp = await axios.get(
          `https://queue.fal.run/fal-ai/kling-video/v1/standard/requests/${requestId}`,
          { headers: { Authorization: `Key ${key}` } }
        );
        videoUrl = resultResp.data?.video?.url;
      }
      break;
    }
    if (statusResp.data?.status === 'FAILED') {
      throw new Error('fal.ai gen video thất bại');
    }
  }

  if (!videoUrl) throw new Error('Timeout chờ video từ fal.ai');

  const vidResp = await axios.get(videoUrl, { responseType: 'arraybuffer', timeout: 180000 });
  const filename = `ai-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.mp4`;
  const filepath = path.join(config.mediaDir, filename);
  fs.writeFileSync(filepath, Buffer.from(vidResp.data));

  const stat = fs.statSync(filepath);
  const result = db
    .prepare(
      `INSERT INTO media (filename, mime_type, size, source, prompt, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(filename, 'video/mp4', stat.size, 'ai-video', prompt, Date.now());

  return Number(result.lastInsertRowid);
}

import axios from 'axios';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { config } from '../config';
import { db } from '../db';

/**
 * Pollinations.ai — gen ảnh MIỄN PHÍ 100%, không cần API key.
 * Endpoint: https://image.pollinations.ai/prompt/{encodedPrompt}?width=...&height=...&model=flux&nologo=true
 * Trả về PNG trực tiếp.
 *
 * Model hỗ trợ: flux (default, chất lượng cao), flux-realism, turbo.
 */
export async function generateImagePollinations(prompt: string): Promise<number> {
  const encoded = encodeURIComponent(prompt);
  const url = `https://image.pollinations.ai/prompt/${encoded}?width=1024&height=768&model=flux&nologo=true&enhance=true`;

  let resp;
  try {
    resp = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: 180000,
      // Pollinations đôi khi trả 500 thoáng qua, retry 1 lần bằng axios không cần thiết
    });
  } catch (e: any) {
    const status = e?.response?.status;
    throw new Error(`Pollinations fail (HTTP ${status || '?'}): ${e?.message || ''}`);
  }

  const buf = Buffer.from(resp.data);
  if (buf.length < 1000) {
    throw new Error('Pollinations: response quá nhỏ, có thể là lỗi thay vì ảnh');
  }

  // Detect format từ magic bytes (Pollinations có thể trả JPEG hoặc PNG)
  const isPng = buf[0] === 0x89 && buf[1] === 0x50;
  const isJpeg = buf[0] === 0xff && buf[1] === 0xd8;
  if (!isPng && !isJpeg) {
    throw new Error('Pollinations: response không phải PNG/JPEG');
  }
  const ext = isPng ? 'png' : 'jpg';
  const mime = isPng ? 'image/png' : 'image/jpeg';

  const filename = `ai-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${ext}`;
  const filepath = path.join(config.mediaDir, filename);
  fs.writeFileSync(filepath, buf);

  const stat = fs.statSync(filepath);
  const result = db
    .prepare(
      `INSERT INTO media (filename, mime_type, size, source, prompt, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(filename, mime, stat.size, 'ai-image-pollinations:flux', prompt, Date.now());

  return Number(result.lastInsertRowid);
}

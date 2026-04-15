import axios from 'axios';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { config } from '../config';
import { db } from '../db';
import { getAllKeys, pickKey } from './keyrotator';

/**
 * Gen ảnh bằng Google. Dùng chung `google_api_key` với Gemini text.
 *
 * Ưu tiên 2 model (thử lần lượt):
 *   1) gemini-2.0-flash-preview-image-generation (generateContent, có FREE tier)
 *   2) imagen-3.0-generate-002 (predict, PAID — fallback nếu model 1 không khả dụng trên key)
 *
 * Ảnh trả về dạng base64, lưu local vào mediaDir và insert vào bảng media.
 */

const GEMINI_IMAGE_MODEL = 'gemini-2.5-flash-image';
const IMAGEN_MODEL = 'imagen-4.0-fast-generate-001';

interface GenResult {
  mediaId: number;
  model: string;
}

export function hasGoogleImageKey(): boolean {
  try {
    pickKey('google_api_key');
    return true;
  } catch {
    return false;
  }
}

/**
 * Thử gen ảnh qua Google. Ném lỗi có message tiếng Việt rõ ràng nếu fail.
 */
export async function generateImageGoogle(prompt: string): Promise<GenResult> {
  const keys = getAllKeys('google_api_key');
  if (keys.length === 0) throw new Error('Chưa cấu hình Google API key.');

  const startIdx = keys.indexOf(pickKey('google_api_key'));
  let lastErr: any;

  // Thử model Gemini 2.0 Flash Image (free tier) trước
  for (let i = 0; i < keys.length; i++) {
    const key = keys[(startIdx + i) % keys.length];
    try {
      const base64 = await callGeminiImage(key, prompt);
      return saveImage(base64, prompt, GEMINI_IMAGE_MODEL);
    } catch (e: any) {
      lastErr = e;
      const status = e?.response?.status;
      // 404 = model không có trên key đó → nhảy sang Imagen luôn
      // 401/403 = key sai/locked → thử key khác
      // 429 = rate limit → thử key khác
      if (status === 404) break; // model không khả dụng, không cần thử key khác
      if (![401, 403, 429, 500, 503].includes(status)) throw wrapGoogleErr(e);
      console.warn(`[googleimage/gemini] key ${key.slice(-6)} lỗi ${status}, thử key kế`);
    }
  }

  // Fallback sang Imagen 3 (paid)
  for (let i = 0; i < keys.length; i++) {
    const key = keys[(startIdx + i) % keys.length];
    try {
      const base64 = await callImagen(key, prompt);
      return saveImage(base64, prompt, IMAGEN_MODEL);
    } catch (e: any) {
      lastErr = e;
      const status = e?.response?.status;
      if (![401, 403, 404, 429, 500, 503].includes(status)) throw wrapGoogleErr(e);
      console.warn(`[googleimage/imagen] key ${key.slice(-6)} lỗi ${status}, thử key kế`);
    }
  }

  throw wrapGoogleErr(lastErr);
}

async function callGeminiImage(key: string, prompt: string): Promise<string> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_IMAGE_MODEL}:generateContent?key=${key}`;
  const resp = await axios.post(
    url,
    {
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        responseModalities: ['TEXT', 'IMAGE'],
      },
    },
    { timeout: 120000, headers: { 'Content-Type': 'application/json' } }
  );
  const parts = resp.data?.candidates?.[0]?.content?.parts || [];
  for (const p of parts) {
    if (p.inlineData?.data) return p.inlineData.data as string;
    if (p.inline_data?.data) return p.inline_data.data as string;
  }
  throw new Error('Gemini Image: không có ảnh trong response');
}

async function callImagen(key: string, prompt: string): Promise<string> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${IMAGEN_MODEL}:predict?key=${key}`;
  const resp = await axios.post(
    url,
    {
      instances: [{ prompt }],
      parameters: {
        sampleCount: 1,
        aspectRatio: '4:3',
      },
    },
    { timeout: 120000, headers: { 'Content-Type': 'application/json' } }
  );
  const pred = resp.data?.predictions?.[0];
  const b64 = pred?.bytesBase64Encoded || pred?.image?.bytesBase64Encoded;
  if (!b64) throw new Error('Imagen: không có bytesBase64Encoded trong response');
  return b64 as string;
}

function saveImage(base64: string, prompt: string, model: string): GenResult {
  const buf = Buffer.from(base64, 'base64');
  const filename = `ai-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.png`;
  const filepath = path.join(config.mediaDir, filename);
  fs.writeFileSync(filepath, buf);
  const stat = fs.statSync(filepath);
  const result = db
    .prepare(
      `INSERT INTO media (filename, mime_type, size, source, prompt, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(filename, 'image/png', stat.size, `ai-image-google:${model}`, prompt, Date.now());
  return { mediaId: Number(result.lastInsertRowid), model };
}

function wrapGoogleErr(e: any): Error {
  const status = e?.response?.status;
  const msg =
    e?.response?.data?.error?.message ||
    e?.response?.data?.error ||
    e?.message ||
    String(e);
  const msgStr = typeof msg === 'string' ? msg : JSON.stringify(msg);
  if (status === 401 || status === 403) {
    if (/quota|billing|permission/i.test(msgStr)) {
      return new Error(`Google Image: quota/billing bị khoá. ${msgStr.slice(0, 200)}`);
    }
    return new Error(`Google Image: API key không hợp lệ (${status}). ${msgStr.slice(0, 200)}`);
  }
  if (status === 429) return new Error('Google Image: quá rate limit, đợi 1-2 phút.');
  if (status === 404) return new Error(`Google Image: model không khả dụng trên key này.`);
  return new Error(`Google Image fail (HTTP ${status || '?'}): ${msgStr.slice(0, 200)}`);
}

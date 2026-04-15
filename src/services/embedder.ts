import axios from 'axios';
import { pickKey, getAllKeys, countKeys } from './keyrotator';

/**
 * Embedder — dùng Google text-embedding-004 (free tier rộng rãi, 768 dims).
 * Fallback: nếu không có Google key, trả null và caller sẽ dùng keyword scoring.
 */

const EMBED_MODEL = 'text-embedding-004';
const EMBED_DIMS = 768;

export function isEmbedderReady(): boolean {
  return countKeys('google_api_key') > 0;
}

export function getEmbedderInfo() {
  return { model: EMBED_MODEL, dims: EMBED_DIMS, ready: isEmbedderReady() };
}

/**
 * Tạo embedding cho text. Trả về Float32Array (768 dims) hoặc null nếu fail.
 */
export async function embed(text: string): Promise<Float32Array | null> {
  if (!isEmbedderReady()) return null;
  const clean = text.trim().slice(0, 8000);
  if (!clean) return null;

  const keys = getAllKeys('google_api_key');
  const startKey = pickKey('google_api_key');
  const startIdx = Math.max(0, keys.indexOf(startKey));

  let lastErr: any;
  for (let i = 0; i < keys.length; i++) {
    const key = keys[(startIdx + i) % keys.length];
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${EMBED_MODEL}:embedContent?key=${key}`;
      const resp = await axios.post(
        url,
        { model: `models/${EMBED_MODEL}`, content: { parts: [{ text: clean }] } },
        { timeout: 30000, headers: { 'Content-Type': 'application/json' } }
      );
      const values: number[] | undefined = resp.data?.embedding?.values;
      if (!values || values.length === 0) throw new Error('Gemini embed: empty values');
      return new Float32Array(values);
    } catch (e: any) {
      lastErr = e;
      const status = e?.response?.status;
      if (![401, 403, 429, 500, 503].includes(status)) {
        console.warn(`[embedder] fatal ${status}: ${e?.message}`);
        return null;
      }
      console.warn(`[embedder] key ${key.slice(-6)} lỗi ${status}, thử key kế`);
    }
  }
  console.warn('[embedder] tất cả key fail:', lastErr?.message);
  return null;
}

/**
 * Cosine similarity giữa 2 Float32Array cùng size.
 */
export function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * Encode Float32Array → Buffer để lưu SQLite BLOB
 */
export function encodeEmbedding(vec: Float32Array): Buffer {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}

/**
 * Decode Buffer → Float32Array
 */
export function decodeEmbedding(buf: Buffer): Float32Array {
  // Copy để tránh alignment issue
  const copy = new ArrayBuffer(buf.byteLength);
  new Uint8Array(copy).set(buf);
  return new Float32Array(copy);
}

export { EMBED_MODEL, EMBED_DIMS };

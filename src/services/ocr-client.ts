/**
 * OCR Client — gọi Python PaddleOCR sidecar qua HTTP.
 *
 * Sidecar: http://127.0.0.1:8501 (hoặc env OCR_SERVICE_URL)
 * Auth: Bearer token (env OCR_SERVICE_TOKEN).
 *
 * Usage:
 *   const result = await extractText(imageBuffer);
 *   console.log(result.raw_text);  // "MB Bank\n500.000 VND\n..."
 */

import fs from 'fs';
import axios from 'axios';

const OCR_URL = process.env.OCR_SERVICE_URL || 'http://127.0.0.1:8501';
const OCR_TOKEN = process.env.OCR_SERVICE_TOKEN || 'dev-token-change-me';
const DEFAULT_TIMEOUT = 30_000;

export interface OcrLine {
  text: string;
  confidence: number;
  bbox: Array<[number, number]>;
}

export interface OcrResult {
  ok: boolean;
  lines: OcrLine[];
  raw_text: string;
  width: number;
  height: number;
  latency_ms: number;
  error?: string;
}

/** Extract text from image buffer (JPEG/PNG). */
export async function extractText(imageBuffer: Buffer, opts: { min_confidence?: number } = {}): Promise<OcrResult> {
  try {
    const base64 = imageBuffer.toString('base64');
    const resp = await axios.post(
      `${OCR_URL}/ocr`,
      {
        image_base64: base64,
        min_confidence: opts.min_confidence ?? 0.5,
      },
      {
        headers: {
          Authorization: `Bearer ${OCR_TOKEN}`,
          'Content-Type': 'application/json',
        },
        timeout: DEFAULT_TIMEOUT,
        maxContentLength: 20 * 1024 * 1024,
        maxBodyLength: 20 * 1024 * 1024,
      },
    );
    return resp.data as OcrResult;
  } catch (e: any) {
    return {
      ok: false,
      lines: [],
      raw_text: '',
      width: 0,
      height: 0,
      latency_ms: 0,
      error: e?.response?.data?.detail || e?.message || 'unknown',
    };
  }
}

/** Extract from URL (fetch first, then OCR).
 *  v23: SSRF protection — block private IPs + non-http schemes.  */
export async function extractFromUrl(url: string, opts: { min_confidence?: number } = {}): Promise<OcrResult> {
  // v23: SSRF guard — reuse isSafeUrl from news-ingest
  try {
    const { isSafeUrl } = require('./news-ingest');
    const check = isSafeUrl(url);
    if (!check.safe) {
      console.warn(`[ocr] extractFromUrl blocked SSRF: ${check.reason} url=${url.slice(0, 80)}`);
      return {
        ok: false,
        lines: [],
        raw_text: '',
        width: 0,
        height: 0,
        latency_ms: 0,
        error: `url blocked: ${check.reason}`,
      };
    }
  } catch (e: any) {
    console.warn('[ocr] SSRF guard load fail:', e?.message);
  }

  try {
    const resp = await axios.get<ArrayBuffer>(url, {
      responseType: 'arraybuffer',
      timeout: 20_000,
      maxContentLength: 10 * 1024 * 1024,
      // v23: also validate via redirect — axios default allows 5 redirects,
      //      but we're already on safe host; disable redirects to avoid
      //      redirect-to-private-IP bypass.
      maxRedirects: 0,
    });
    return extractText(Buffer.from(resp.data), opts);
  } catch (e: any) {
    return {
      ok: false,
      lines: [],
      raw_text: '',
      width: 0,
      height: 0,
      latency_ms: 0,
      error: `fetch url fail: ${e?.message}`,
    };
  }
}

/** Extract from local file path. */
export async function extractFromFile(filePath: string, opts: { min_confidence?: number } = {}): Promise<OcrResult> {
  try {
    const buf = fs.readFileSync(filePath);
    return extractText(buf, opts);
  } catch (e: any) {
    return {
      ok: false,
      lines: [],
      raw_text: '',
      width: 0,
      height: 0,
      latency_ms: 0,
      error: `read file fail: ${e?.message}`,
    };
  }
}

/** Health check — gọi /health endpoint. */
export async function ocrHealthCheck(): Promise<{ healthy: boolean; detail?: any; error?: string }> {
  try {
    const resp = await axios.get(`${OCR_URL}/health`, { timeout: 5_000 });
    return { healthy: true, detail: resp.data };
  } catch (e: any) {
    return { healthy: false, error: e?.message || 'unknown' };
  }
}

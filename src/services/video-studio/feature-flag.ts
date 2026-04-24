/**
 * Video Studio — feature flag.
 *
 * Gate MỌI video studio operation qua hàm isVideoStudioEnabled().
 * Default: false (tắt) — admin phải explicitly enable qua UI hoặc env.
 *
 * Module HOÀN TOÀN TÁCH BIỆT với chatbot + agentic.
 */

import { db } from '../../db';

export function isVideoStudioEnabled(): boolean {
  if (process.env.VIDEO_STUDIO_ENABLED === 'true' || process.env.VIDEO_STUDIO_ENABLED === '1') {
    return true;
  }
  try {
    const { getSetting } = require('../../db');
    const v = getSetting('video_studio_enabled');
    return v === 'true' || v === true || v === '1';
  } catch {
    return false;
  }
}

/**
 * Get a video-studio-scoped setting (prefix vs_).
 */
export function getVSSetting(key: string, def?: string): string | undefined {
  try {
    const { getSetting } = require('../../db');
    const v = getSetting(`vs_${key}`);
    return v !== undefined && v !== null && v !== '' ? v : def;
  } catch { return def; }
}

export function setVSSetting(key: string, value: string): void {
  try {
    const { setSetting } = require('../../db');
    setSetting(`vs_${key}`, value);
  } catch {}
}

/**
 * Get API key from settings OR env (in that order).
 * Supported keys: elevenlabs_api_key, pexels_api_key, pixabay_api_key, runway_api_key
 */
export function getApiKey(provider: string): string | undefined {
  try {
    const { getSetting } = require('../../db');
    const fromSetting = getSetting(`${provider}_api_key`);
    if (fromSetting) return fromSetting;
  } catch {}

  const envKey = `${provider.toUpperCase()}_API_KEY`;
  return process.env[envKey];
}

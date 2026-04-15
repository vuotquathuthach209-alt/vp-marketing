import { getSetting } from '../db';
import { config } from '../config';

// Round-robin counters, giữ trong memory process
const counters: Record<string, number> = {};

/**
 * Parse danh sách key từ 1 chuỗi: hỗ trợ newline, dấu phẩy, hoặc space.
 * Trả về mảng key đã trim, bỏ rỗng và duplicate.
 */
function parseKeys(raw: string): string[] {
  if (!raw) return [];
  const parts = raw
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return Array.from(new Set(parts));
}

/**
 * Lấy 1 key theo round-robin từ settings.
 * settingKey: tên cột trong bảng settings (vd: 'anthropic_api_key')
 * envFallback: key lấy từ .env nếu settings rỗng
 */
export function pickKey(settingKey: string, envFallback?: string): string {
  const raw = getSetting(settingKey) || envFallback || '';
  const keys = parseKeys(raw);
  if (keys.length === 0) {
    throw new Error(`Chưa cấu hình ${settingKey}. Vào Cấu hình để nhập.`);
  }
  const idx = (counters[settingKey] ?? -1) + 1;
  counters[settingKey] = idx % keys.length;
  return keys[counters[settingKey]];
}

/**
 * Đếm số key đang cấu hình (để hiện ở UI).
 */
export function countKeys(settingKey: string, envFallback?: string): number {
  const raw = getSetting(settingKey) || envFallback || '';
  return parseKeys(raw).length;
}

/**
 * Lấy tất cả keys (dùng cho fallback khi 1 key bị lỗi).
 */
export function getAllKeys(settingKey: string, envFallback?: string): string[] {
  const raw = getSetting(settingKey) || envFallback || '';
  return parseKeys(raw);
}

import { getSetting } from '../db';
import { config } from '../config';

// Round-robin counters, giữ trong memory process
const counters: Record<string, number> = {};

// Cooldown map: key bị 429/quota → tạm skip 10 phút
const cooldowns: Map<string, number> = new Map();
const COOLDOWN_MS = 10 * 60 * 1000; // 10 phút

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
 * Đánh dấu key bị lỗi tạm thời (429, quota exhausted).
 * Key sẽ bị skip trong 10 phút, sau đó tự phục hồi.
 */
export function markKeyCooldown(key: string) {
  cooldowns.set(key, Date.now() + COOLDOWN_MS);
  console.warn(`[keyrotator] key ...${key.slice(-6)} cooldown 10 phút`);
}

/** Kiểm tra key có đang bị cooldown không */
function isOnCooldown(key: string): boolean {
  const until = cooldowns.get(key);
  if (!until) return false;
  if (Date.now() >= until) {
    cooldowns.delete(key); // Hết cooldown → phục hồi
    return false;
  }
  return true;
}

/**
 * Lấy 1 key theo round-robin từ settings, tự skip key đang cooldown.
 */
export function pickKey(settingKey: string, envFallback?: string): string {
  const raw = getSetting(settingKey) || envFallback || '';
  const keys = parseKeys(raw);
  if (keys.length === 0) {
    throw new Error(`Chưa cấu hình ${settingKey}. Vào Cấu hình để nhập.`);
  }

  const startIdx = ((counters[settingKey] ?? -1) + 1) % keys.length;
  // Thử tất cả key, ưu tiên key không bị cooldown
  for (let i = 0; i < keys.length; i++) {
    const idx = (startIdx + i) % keys.length;
    if (!isOnCooldown(keys[idx])) {
      counters[settingKey] = idx;
      return keys[idx];
    }
  }
  // Tất cả đều cooldown → trả key đầu tiên (sẽ retry anyway)
  counters[settingKey] = startIdx;
  return keys[startIdx];
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

/**
 * Trả về tình trạng cooldown hiện tại (để debug/monitor).
 */
export function getCooldownStatus(): Array<{ key: string; until: string; remaining: number }> {
  const result: Array<{ key: string; until: string; remaining: number }> = [];
  const now = Date.now();
  cooldowns.forEach((until, key) => {
    if (until > now) {
      result.push({
        key: `***${key.slice(-6)}`,
        until: new Date(until).toISOString(),
        remaining: Math.round((until - now) / 1000),
      });
    }
  });
  return result;
}

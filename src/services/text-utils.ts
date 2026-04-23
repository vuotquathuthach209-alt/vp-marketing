/**
 * Text utilities — safe truncation cho UTF-8, emoji, multi-byte chars.
 *
 * `"a🎉b".slice(0, 2)` returns `"a\uD83C"` — invalid UTF-8 (incomplete surrogate pair).
 * `truncateSafe("a🎉b", 2)` returns `"a"` (drops incomplete emoji).
 */

/**
 * Truncate a string at `maxLen` characters (JavaScript chars = UTF-16 code units),
 * removing any trailing orphan surrogate pair (incomplete emoji).
 * Also trim trailing whitespace.
 */
export function truncateSafe(text: string, maxLen: number): string {
  if (!text) return '';
  if (text.length <= maxLen) return text;

  let result = text.slice(0, maxLen);
  // Check last char — if high surrogate (0xD800-0xDBFF) without low surrogate, drop it
  const lastCode = result.charCodeAt(result.length - 1);
  if (lastCode >= 0xD800 && lastCode <= 0xDBFF) {
    result = result.slice(0, -1);
  }

  // Also handle zero-width joiner (ZWJ) sequences: don't end on ZWJ
  result = result.replace(/\u200D$/, '');

  return result.trimEnd();
}

/** Count code points (Unicode chars), not code units (UTF-16). Useful for IG 2200 limit. */
export function countCodePoints(text: string): number {
  let count = 0;
  for (const _ of text) count++;
  return count;
}

/** Truncate by code points (more accurate cho IG caption limit). */
export function truncateByCodePoints(text: string, maxCodePoints: number): string {
  if (!text) return '';
  let count = 0;
  let result = '';
  for (const ch of text) {
    if (count >= maxCodePoints) break;
    result += ch;
    count++;
  }
  return result.trimEnd();
}

/** Redact access_token, api_key, secret patterns trong text (log safety). */
export function redactSecrets(text: string): string {
  if (!text) return '';
  return text
    .replace(/access_token=[^\s&"]+/gi, 'access_token=***')
    .replace(/api[_-]?key=[^\s&"]+/gi, 'api_key=***')
    .replace(/authorization:\s*bearer\s+[^\s]+/gi, 'authorization: Bearer ***')
    .replace(/"access_token"\s*:\s*"[^"]+"/gi, '"access_token":"***"')
    .replace(/"secret"\s*:\s*"[^"]+"/gi, '"secret":"***"');
}

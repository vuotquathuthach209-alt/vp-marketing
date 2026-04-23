/**
 * Message Sanitizer — strip markdown cho các channel không render.
 *
 * Vấn đề (user screenshot): Bot gửi `**550k/đêm**` qua Zalo, Zalo không
 * render markdown → khách thấy dấu sao trong text, lộ rõ là bot.
 *
 * Fix: Strip markdown formatting TRƯỚC KHI send qua channel adapter
 * (Zalo hoàn toàn không render; FB Messenger cũng không render bold/italic
 * đúng → an toàn strip toàn bộ).
 *
 * API:
 *   stripMarkdown(text)                  — bare strip, no channel logic
 *   sanitizeForChannel(text, channel)    — channel-aware (fb | zalo | web)
 */

/**
 * Strip all markdown formatting from a string.
 * Keeps emoji, line breaks, and bullet text but removes the markers.
 */
export function stripMarkdown(text: string): string {
  if (!text) return '';
  let out = String(text);

  // Code blocks ```...``` → content only
  out = out.replace(/```[a-zA-Z]*\n?([\s\S]*?)```/g, '$1');

  // Inline code `x` → x  (only if balanced, avoid eating free-standing backticks)
  out = out.replace(/`([^`\n]+)`/g, '$1');

  // Links [text](url) → "text (url)" if http, else just text
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, text, url) => {
    if (/^https?:\/\//i.test(url)) return `${text} (${url})`;
    return text;
  });

  // Bold+italic ***text*** / ___text___ → text
  out = out.replace(/\*\*\*([^\n*]+?)\*\*\*/g, '$1');
  out = out.replace(/___([^\n_]+?)___/g, '$1');

  // Bold **text** / __text__ → text
  out = out.replace(/\*\*([^\n*]+?)\*\*/g, '$1');
  out = out.replace(/__([^\n_]+?)__/g, '$1');

  // Italic *text* / _text_ → text  (careful: avoid eating unicode asterisks,
  // and single-char bullets). Require non-whitespace char inside.
  out = out.replace(/(?<![*\w])\*([^\n*]{1,120}?)\*(?!\w)/g, '$1');
  out = out.replace(/(?<![_\w])_([^\n_]{1,120}?)_(?!\w)/g, '$1');

  // Strikethrough ~~text~~ → text
  out = out.replace(/~~([^\n~]+?)~~/g, '$1');

  // Headings: `# Heading` / `## Heading` → `Heading`
  out = out.replace(/^#{1,6}\s+/gm, '');

  // Blockquote `> text` → `text`
  out = out.replace(/^\s*>\s?/gm, '');

  // Horizontal rules (---, ***, ___)
  out = out.replace(/^\s*[-*_]{3,}\s*$/gm, '');

  // Bullet list markers at line-start: `- ` / `* ` / `+ ` → remove marker
  //   BUT preserve bullets that USE unicode `•` (human-readable bullets)
  out = out.replace(/^\s*[-*+]\s+/gm, '• ');

  // Numbered list `1. ` — keep "1." as it reads fine in plain text

  // Clean consecutive blank lines
  out = out.replace(/\n{3,}/g, '\n\n');

  return out.trim();
}

export type Channel = 'fb' | 'zalo' | 'web' | 'api' | 'telegram' | string;

/**
 * Channel-aware sanitization.
 * - zalo: strip all markdown (Zalo không render gì)
 * - fb:   strip markdown (Messenger render hạn chế, strip an toàn hơn)
 * - web:  keep markdown (frontend tự render)
 * - telegram: keep (Telegram có MarkdownV2 support)
 */
export function sanitizeForChannel(text: string, channel: Channel): string {
  if (!text) return '';
  const lower = String(channel || '').toLowerCase();

  if (lower === 'zalo' || lower === 'fb' || lower === 'messenger') {
    return stripMarkdown(text);
  }
  if (lower === 'web' || lower === 'telegram' || lower === 'api') {
    return text;     // preserve formatting
  }
  // Unknown channel — default to strip for safety
  return stripMarkdown(text);
}

/**
 * Sanitize bot reply THAT HAS emoji + bullet + bold.
 * Ensures Zalo-sendable text (≤ 2000 chars post-strip).
 */
export function sanitizeForZalo(text: string): string {
  const stripped = stripMarkdown(text);
  if (stripped.length <= 2000) return stripped;
  // Truncate safely on sentence boundary
  const cut = stripped.slice(0, 1990);
  const lastDot = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('\n'));
  return (lastDot > 1500 ? cut.slice(0, lastDot + 1) : cut) + '…';
}

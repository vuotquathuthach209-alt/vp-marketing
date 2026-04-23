/**
 * v24 helper smoke tests — markdown sanitizer + VN date formatter.
 * Run: npx ts-node src/scripts/test-v24-helpers.ts
 */

import { stripMarkdown, sanitizeForZalo } from '../services/message-sanitizer';
import { formatDateVN, formatDateVNDisplay, checkinUrgency } from '../services/vn-date-formatter';

const tests: Array<{ name: string; got: any; want: any }> = [];

// ──────────── Sanitizer ────────────
tests.push({
  name: 'strip **bold**',
  got: stripMarkdown('giá **550k/đêm** rẻ'),
  want: 'giá 550k/đêm rẻ',
});
tests.push({
  name: 'strip mixed **Homestay** + emoji',
  got: stripMarkdown('🏡 **Homestay** (2 chỗ) — ấm cúng'),
  want: '🏡 Homestay (2 chỗ) — ấm cúng',
});
tests.push({
  name: 'strip # heading',
  got: stripMarkdown('# Tiêu đề\nNội dung'),
  want: 'Tiêu đề\nNội dung',
});
tests.push({
  name: 'strip [link](url)',
  got: stripMarkdown('xem [đây](https://sonder.vn) nhé'),
  want: 'xem đây (https://sonder.vn) nhé',
});
tests.push({
  name: 'strip bullet -',
  got: stripMarkdown('- Khách sạn\n- Homestay'),
  want: '• Khách sạn\n• Homestay',
});
tests.push({
  name: 'strip *italic*',
  got: stripMarkdown('phí *30%* phụ thu'),
  want: 'phí 30% phụ thu',
});
tests.push({
  name: 'strip `code`',
  got: stripMarkdown('gõ `đặt phòng` nhé'),
  want: 'gõ đặt phòng nhé',
});
tests.push({
  name: 'preserve emoji-only',
  got: stripMarkdown('🏨🏡🏢'),
  want: '🏨🏡🏢',
});
tests.push({
  name: 'strip ***bold italic***',
  got: stripMarkdown('**Sonder** là ***chuỗi*** khách sạn'),
  want: 'Sonder là chuỗi khách sạn',
});
tests.push({
  name: 'sanitize for Zalo (≤2000)',
  got: sanitizeForZalo('🏨 **Sonder** — giá `từ 550k` ☆'.repeat(100)).length <= 2000,
  want: true,
});

// ──────────── VN Date ────────────
const ref = new Date('2026-04-23T07:00:00Z'); // VN noon
tests.push({
  name: 'today → hôm nay (23/4)',
  got: formatDateVNDisplay('2026-04-23', { reference: ref }),
  want: 'hôm nay (23/4)',
});
tests.push({
  name: 'tomorrow → ngày mai (24/4)',
  got: formatDateVNDisplay('2026-04-24', { reference: ref }),
  want: 'ngày mai (24/4)',
});
tests.push({
  name: '2 days → ngày kia (25/4)',
  got: formatDateVNDisplay('2026-04-25', { reference: ref }),
  want: 'ngày kia (25/4)',
});
tests.push({
  name: '5 days → thứ 3 này (28/4)',    // 28/4/2026 là thứ 3
  got: formatDateVNDisplay('2026-04-28', { reference: ref }),
  want: 'thứ 3 này (28/4)',
});
tests.push({
  name: '10 days → thứ 7 tuần sau (2/5)',
  got: formatDateVNDisplay('2026-05-02', { reference: ref }),
  want: 'thứ 7 tuần sau (2/5)',
});
tests.push({
  name: 'is_same_day',
  got: formatDateVN('2026-04-23', { reference: ref })?.is_same_day,
  want: true,
});
tests.push({
  name: 'checkinUrgency same_day',
  got: checkinUrgency('2026-04-23'),
  want: (() => { const r = formatDateVN('2026-04-23'); return r?.is_same_day ? 'same_day' : 'future'; })(),
});

// ──────────── Report ────────────
let pass = 0, fail = 0;
for (const t of tests) {
  const ok = JSON.stringify(t.got) === JSON.stringify(t.want);
  if (ok) { pass++; console.log(`✅ ${t.name}`); }
  else { fail++; console.log(`❌ ${t.name}\n   got:  ${JSON.stringify(t.got)}\n   want: ${JSON.stringify(t.want)}`); }
}
console.log(`\n${pass}/${pass + fail} passed${fail > 0 ? ` (${fail} FAILED)` : ' 🎉'}`);
process.exit(fail > 0 ? 1 : 0);

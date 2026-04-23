/**
 * Vietnamese Bank Receipt Parser.
 *
 * Input: OCR raw_text từ ảnh biên lai chuyển khoản
 * Output: structured ReceiptData (bank, amount, account, timestamp, ref)
 *
 * Support 9 banks phổ biến VN:
 *   MB Bank, Vietcombank, Techcombank, VPBank, TPBank, BIDV, Agribank, ACB, Sacombank
 *
 * Thiết kế:
 *   1. Detect bank từ keywords
 *   2. Apply bank-specific regex OR generic fallback
 *   3. Normalize amount (2.000.000đ → 2000000)
 *   4. Parse timestamp (nhiều format)
 *   5. Return confidence score (0-1) based on how many fields extracted
 */

export interface ReceiptData {
  bank: string | null;                // 'MB Bank' | 'Vietcombank' | ... | null if unknown
  bank_code: string | null;           // 'mb', 'vcb', 'tcb', ...
  amount_vnd: number | null;
  recipient_account: string | null;
  recipient_name: string | null;
  sender_name: string | null;
  transaction_time: number | null;    // epoch ms
  transaction_time_str: string | null;
  ref_content: string | null;         // nội dung chuyển khoản
  transaction_id: string | null;
  confidence: number;                 // 0-1, how complete is the data
  raw_text: string;
  parser_notes: string[];
}

const BANKS: Array<{
  code: string;
  name: string;
  keywords: string[];        // multiple possible keywords (any match)
}> = [
  { code: 'mb',   name: 'MB Bank',      keywords: ['MB BANK', 'MBBANK', 'APP MBBANK', 'MBBank'] },
  { code: 'vcb',  name: 'Vietcombank',  keywords: ['VIETCOMBANK', 'VCB', 'Vietcom Bank', 'Ngan hang TMCP Ngoai thuong'] },
  { code: 'tcb',  name: 'Techcombank',  keywords: ['TECHCOMBANK', 'TCB', 'F@ST Mobile', 'F@ST MOBILE', 'TCBN'] },
  { code: 'vpb',  name: 'VPBank',       keywords: ['VPBANK', 'VPBANK NEO', 'VP BANK', 'VPBANKNEO'] },
  { code: 'tpb',  name: 'TPBank',       keywords: ['TPBANK', 'TP BANK', 'TPBank eBank'] },
  { code: 'bidv', name: 'BIDV',         keywords: ['BIDV', 'BIDV SmartBanking', 'BIDV Smart Banking'] },
  { code: 'agr',  name: 'Agribank',     keywords: ['AGRIBANK', 'AGRIBANK E-Mobile', 'Agri E-Mobile'] },
  { code: 'acb',  name: 'ACB',          keywords: ['ACB ONE', 'ACBONE', 'ACB Mobile'] },
  { code: 'stb',  name: 'Sacombank',    keywords: ['SACOMBANK', 'SACOMBANK PAY', 'STB'] },
];

/** Detect bank từ text (return first match hoặc null). */
function detectBank(text: string): { code: string; name: string } | null {
  const upper = text.toUpperCase();
  for (const bank of BANKS) {
    for (const kw of bank.keywords) {
      if (upper.includes(kw.toUpperCase())) {
        return { code: bank.code, name: bank.name };
      }
    }
  }
  return null;
}

/** Parse Vietnamese amount: "2.000.000đ" "2.000.000 VND" "500,000 đ" "1500000" → 2000000 */
function parseAmount(text: string): number | null {
  // Patterns ordered by specificity
  const patterns = [
    /([\d\.,]+)\s*(?:đ|VNĐ|VND|vnd)\b/i,
    /Số tiền\s*:?\s*([\d\.,]+)/i,
    /So tien\s*:?\s*([\d\.,]+)/i,
    /Amount\s*:?\s*([\d\.,]+)/i,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m) {
      const clean = m[1].replace(/[.,]/g, '');
      const n = parseInt(clean, 10);
      if (!isNaN(n) && n >= 1000 && n <= 100_000_000_000) return n;
    }
  }
  return null;
}

/** Parse timestamp từ biên lai (nhiều format). Return epoch ms.
 *  Note: EasyOCR đôi khi đọc ':' thành '.' → tolerate [:.] between time parts. */
function parseTimestamp(text: string): { ts: number | null; raw: string | null } {
  // Pattern: HH:MM:SS DD/MM/YYYY or HH:MM DD/MM/YYYY
  // EasyOCR có thể đọc ':' thành '.' hoặc ';' → regex dùng [:.;]
  const patterns = [
    /(\d{1,2})[:.;](\d{2})(?:[:.;](\d{2}))?\s*(?:ngày\s+)?(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/i,
    /(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})\s+(\d{1,2})[:.;](\d{2})(?:[:.;](\d{2}))?/i,
    /(\d{4})-(\d{2})-(\d{2})\s+(\d{1,2})[:.;](\d{2})(?:[:.;](\d{2}))?/,
  ];

  for (let i = 0; i < patterns.length; i++) {
    const m = text.match(patterns[i]);
    if (!m) continue;

    let hh: number, mm: number, ss: number, day: number, month: number, year: number;
    if (i === 0) {
      // HH:MM:SS DD/MM/YYYY
      hh = parseInt(m[1], 10); mm = parseInt(m[2], 10); ss = parseInt(m[3] || '0', 10);
      day = parseInt(m[4], 10); month = parseInt(m[5], 10); year = parseInt(m[6], 10);
    } else if (i === 1) {
      // DD/MM/YYYY HH:MM:SS
      day = parseInt(m[1], 10); month = parseInt(m[2], 10); year = parseInt(m[3], 10);
      hh = parseInt(m[4], 10); mm = parseInt(m[5], 10); ss = parseInt(m[6] || '0', 10);
    } else {
      // YYYY-MM-DD HH:MM:SS
      year = parseInt(m[1], 10); month = parseInt(m[2], 10); day = parseInt(m[3], 10);
      hh = parseInt(m[4], 10); mm = parseInt(m[5], 10); ss = parseInt(m[6] || '0', 10);
    }

    if (year < 2020 || year > 2030) continue;
    if (month < 1 || month > 12) continue;
    if (day < 1 || day > 31) continue;

    // VN timezone: UTC+7
    const isoLike = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}+07:00`;
    const ts = Date.parse(isoLike);
    if (!isNaN(ts)) {
      return { ts, raw: m[0] };
    }
  }
  return { ts: null, raw: null };
}

/** Parse account number — find 9-16 digit sequence, prefer "Tài khoản" context. */
function parseAccountNumber(text: string): string | null {
  // Patterns ordered by priority (context → pure digits)
  const contextPatterns = [
    /(?:Tài khoản|Tai khoan|Thụ hưởng|Thu huong|Đến TK|Den TK|Account|STK|To Account)[\s:]*?([\d\s]{9,20})/gi,
    /(?:Người thụ hưởng|Nguoi thu huong)[\s:]*?([\d\s]{9,20})/gi,
  ];
  for (const re of contextPatterns) {
    const m = re.exec(text);
    if (m) {
      const digits = m[1].replace(/\s+/g, '');
      if (digits.length >= 9 && digits.length <= 16) return digits;
    }
  }
  // Fallback: find longest 9-16 digit sequence (chưa ideal nhưng đủ cho 80% cases)
  const allNumbers = text.match(/\b\d{9,16}\b/g) || [];
  if (allNumbers.length) {
    // Prefer longer numbers (account numbers usually 10-12 digits)
    allNumbers.sort((a, b) => b.length - a.length);
    return allNumbers[0] || null;
  }
  return null;
}

/** Parse recipient name — uppercase Vietnamese name (usually no diacritics). */
function parseRecipientName(text: string): string | null {
  const patterns = [
    /(?:Thụ hưởng|Thu huong|Người nhận|Nguoi nhan|Tên người nhận|Ten nguoi nhan|Đến|Den)\s*:?\s*([A-Z][A-Z\s]{3,60})\b/i,
    /(?:Người thụ hưởng|To)\s*:?\s*([A-Z][A-Z\s]{3,60})\b/i,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m) {
      const name = m[1].trim().replace(/\s+/g, ' ');
      if (name.length >= 5 && name.length <= 80) return name;
    }
  }
  return null;
}

/** Parse content/memo ("Nội dung CK: XXX"). */
function parseRefContent(text: string): string | null {
  const patterns = [
    /(?:Nội dung|Noi dung|Nội dung chuyển khoản|Noi dung chuyen khoan|Message|Description|Chi tiết|Chi tiet|Mô tả|Mo ta)\s*:?\s*([^\n]{5,200})/i,
    /(?:ND|Content)\s*:?\s*([^\n]{5,200})/i,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m) {
      const content = m[1].trim();
      // Skip if it's just the label repeated
      if (content.length >= 3 && content.length <= 250) return content;
    }
  }
  return null;
}

/** Parse transaction ID — usually 6-20 digits/letters. */
function parseTransactionId(text: string): string | null {
  const patterns = [
    /(?:Mã giao dịch|Ma giao dich|Mã GD|Ma GD|Transaction ID|Ref|Reference)\s*:?\s*([A-Z0-9]{6,25})/i,
    /(?:FT|GD)\d{8,20}/i,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m) {
      const id = (m[1] || m[0]) as string | undefined;
      if (id && id.length >= 6) return id.trim();
    }
  }
  return null;
}

/** Main parser. */
export function parseReceipt(rawText: string): ReceiptData {
  const notes: string[] = [];
  const bank = detectBank(rawText);
  if (!bank) notes.push('bank_not_detected');

  const amount = parseAmount(rawText);
  if (!amount) notes.push('amount_not_found');

  const account = parseAccountNumber(rawText);
  if (!account) notes.push('account_not_found');

  const { ts, raw: tsRaw } = parseTimestamp(rawText);
  if (!ts) notes.push('timestamp_not_found');

  const recipientName = parseRecipientName(rawText);
  const refContent = parseRefContent(rawText);
  const txnId = parseTransactionId(rawText);

  // Confidence: score từ 4 fields quan trọng nhất
  let score = 0;
  if (bank) score += 0.2;
  if (amount) score += 0.3;
  if (account) score += 0.25;
  if (ts) score += 0.15;
  if (refContent) score += 0.1;

  return {
    bank: bank?.name || null,
    bank_code: bank?.code || null,
    amount_vnd: amount,
    recipient_account: account,
    recipient_name: recipientName,
    sender_name: null,   // future: detect sender
    transaction_time: ts,
    transaction_time_str: tsRaw,
    ref_content: refContent,
    transaction_id: txnId,
    confidence: +score.toFixed(2),
    raw_text: rawText,
    parser_notes: notes,
  };
}

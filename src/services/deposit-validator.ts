/**
 * Deposit Validator — verify biên lai chuyển khoản có đúng của Sonder không.
 *
 * Check 4 rules:
 *   1. amount_match      — số tiền = booking.deposit_amount (±1000đ tolerance)
 *   2. account_match     — recipient_account = Sonder STK config
 *   3. timestamp_fresh   — giao dịch < 30 phút trước (không phải ảnh cũ)
 *   4. ref_match         — nội dung chuyển khoản chứa booking_ref
 *
 * Result: matched | mismatch_* với evidence cụ thể.
 */

import { db, getSetting } from '../db';
import { parseReceipt, ReceiptData } from './receipt-parser-vn';

export interface SonderBankConfig {
  account_number: string;
  bank_name: string;
  bank_code?: string;
  account_holder: string;
}

export interface ValidationInput {
  ocr_text: string;
  expected_amount: number;
  expected_ref_code: string;              // e.g. 'SONDER-B1234' hoặc 'SD1234'
  sonder_bank?: SonderBankConfig;          // nếu không truyền → load từ settings
  tolerance_vnd?: number;                  // default 1000
  freshness_min?: number;                  // default 30
}

export type ValidationStatus =
  | 'matched'
  | 'mismatch_amount'
  | 'mismatch_account'
  | 'stale_timestamp'
  | 'missing_ref'
  | 'low_ocr_confidence'
  | 'bank_not_recognized';

export interface ValidationResult {
  status: ValidationStatus;
  passed_rules: string[];
  failed_rules: string[];
  parsed: ReceiptData;
  expected_amount: number;
  expected_ref: string;
  notes: string[];
  auto_confirm_eligible: boolean;   // true nếu status=matched
}

const DEFAULT_SONDER_BANK: SonderBankConfig = {
  account_number: '0000000000',      // placeholder, config vào settings
  bank_name: 'MB Bank',
  bank_code: 'mb',
  account_holder: 'CONG TY TNHH SONDER VIET NAM',
};

/** Load Sonder bank config từ settings table (key='sonder_bank'). */
export function getSonderBankConfig(): SonderBankConfig {
  try {
    const raw = getSetting('sonder_bank');
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed.account_number && parsed.bank_name) {
        return {
          account_number: String(parsed.account_number),
          bank_name: String(parsed.bank_name),
          bank_code: parsed.bank_code || undefined,
          account_holder: String(parsed.account_holder || 'Sonder'),
        };
      }
    }
  } catch {}
  return DEFAULT_SONDER_BANK;
}

/** Normalize account number for comparison (strip spaces, hyphens). */
function normalizeAccount(s: string | null | undefined): string {
  if (!s) return '';
  return String(s).replace(/[\s\-\.]/g, '');
}

/** Normalize ref code for contains-check (uppercase, strip separators). */
function normalizeRef(s: string | null | undefined): string {
  if (!s) return '';
  return String(s).toUpperCase().replace(/[\s\-\_\.]/g, '');
}

export function validateDeposit(input: ValidationInput): ValidationResult {
  const sonderBank = input.sonder_bank || getSonderBankConfig();
  const tolerance = input.tolerance_vnd ?? 1000;
  const freshnessMin = input.freshness_min ?? 30;
  const parsed = parseReceipt(input.ocr_text);

  const passed: string[] = [];
  const failed: string[] = [];
  const notes: string[] = [];

  // Low-level pre-check: OCR confidence
  if (parsed.confidence < 0.35) {
    return {
      status: 'low_ocr_confidence',
      passed_rules: [],
      failed_rules: ['ocr_confidence'],
      parsed,
      expected_amount: input.expected_amount,
      expected_ref: input.expected_ref_code,
      notes: [...parsed.parser_notes, `ocr_confidence=${parsed.confidence}`],
      auto_confirm_eligible: false,
    };
  }

  // Rule 1: Amount match (±tolerance)
  if (parsed.amount_vnd === null) {
    failed.push('amount_match');
    notes.push('amount_not_extracted');
  } else {
    const diff = Math.abs(parsed.amount_vnd - input.expected_amount);
    if (diff <= tolerance) {
      passed.push('amount_match');
    } else {
      failed.push('amount_match');
      notes.push(`amount_diff=${diff}đ (got ${parsed.amount_vnd}, expected ${input.expected_amount})`);
    }
  }

  // Rule 2: Account match
  const expectedAcct = normalizeAccount(sonderBank.account_number);
  const gotAcct = normalizeAccount(parsed.recipient_account);
  if (!gotAcct) {
    failed.push('account_match');
    notes.push('account_not_extracted');
  } else if (expectedAcct && gotAcct.includes(expectedAcct)) {
    // Tolerate gotAcct might have extra digits prefix/suffix from OCR
    passed.push('account_match');
  } else if (expectedAcct && expectedAcct.includes(gotAcct) && gotAcct.length >= 6) {
    // OR gotAcct is truncated version of expected
    passed.push('account_match');
    notes.push('account_partial_match');
  } else {
    failed.push('account_match');
    notes.push(`account_mismatch (got ${gotAcct}, expected ${expectedAcct})`);
  }

  // Rule 3: Timestamp fresh
  if (!parsed.transaction_time) {
    failed.push('timestamp_fresh');
    notes.push('timestamp_not_extracted');
  } else {
    const ageMinutes = (Date.now() - parsed.transaction_time) / 60_000;
    if (ageMinutes < 0) {
      // Future timestamp — probably OCR bogus
      failed.push('timestamp_fresh');
      notes.push(`timestamp_future(${Math.abs(ageMinutes).toFixed(0)}m)`);
    } else if (ageMinutes > freshnessMin) {
      failed.push('timestamp_fresh');
      notes.push(`timestamp_stale(${ageMinutes.toFixed(0)}m > ${freshnessMin}m)`);
    } else {
      passed.push('timestamp_fresh');
    }
  }

  // Rule 4: Ref code present trong nội dung
  const expectedRef = normalizeRef(input.expected_ref_code);
  const gotRef = normalizeRef(parsed.ref_content || '');
  if (!gotRef) {
    failed.push('ref_match');
    notes.push('ref_content_not_extracted');
  } else if (expectedRef && gotRef.includes(expectedRef)) {
    passed.push('ref_match');
  } else {
    failed.push('ref_match');
    notes.push(`ref_mismatch (got "${parsed.ref_content}", expected contains "${input.expected_ref_code}")`);
  }

  // Determine status — priority: account > amount > ref > timestamp
  let status: ValidationStatus;
  if (failed.length === 0) {
    status = 'matched';
  } else if (failed.includes('account_match')) {
    status = 'mismatch_account';
  } else if (failed.includes('amount_match')) {
    status = 'mismatch_amount';
  } else if (failed.includes('ref_match')) {
    status = 'missing_ref';
  } else if (failed.includes('timestamp_fresh')) {
    status = 'stale_timestamp';
  } else {
    status = 'mismatch_amount';  // shouldn't reach
  }

  return {
    status,
    passed_rules: passed,
    failed_rules: failed,
    parsed,
    expected_amount: input.expected_amount,
    expected_ref: input.expected_ref_code,
    notes,
    auto_confirm_eligible: status === 'matched',
  };
}

/** Save config via settings table. */
export function saveSonderBankConfig(config: SonderBankConfig): void {
  const { setSetting } = require('../db');
  setSetting('sonder_bank', JSON.stringify(config));
}

/** Log OCR receipt to ocr_receipts table (audit trail). */
export function logOcrReceipt(input: {
  hotel_id: number;
  sender_id?: string;
  booking_id?: number;
  image_path?: string;
  result: ValidationResult;
}): number {
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS ocr_receipts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        hotel_id INTEGER NOT NULL,
        sender_id TEXT,
        booking_id INTEGER,
        image_path TEXT,
        raw_ocr_text TEXT,
        parsed_json TEXT,
        detected_bank TEXT,
        amount_vnd INTEGER,
        recipient_account TEXT,
        ref_content TEXT,
        transaction_time INTEGER,
        verification_status TEXT,
        passed_rules TEXT,
        failed_rules TEXT,
        notes TEXT,
        auto_confirmed INTEGER DEFAULT 0,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_ocr_receipts_sender ON ocr_receipts(sender_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_ocr_receipts_status ON ocr_receipts(verification_status, created_at DESC);
    `);

    const { parsed } = input.result;
    const r = db.prepare(
      `INSERT INTO ocr_receipts
       (hotel_id, sender_id, booking_id, image_path, raw_ocr_text, parsed_json,
        detected_bank, amount_vnd, recipient_account, ref_content, transaction_time,
        verification_status, passed_rules, failed_rules, notes, auto_confirmed, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      input.hotel_id,
      input.sender_id || null,
      input.booking_id || null,
      input.image_path || null,
      parsed.raw_text.slice(0, 5000),
      JSON.stringify(parsed),
      parsed.bank || null,
      parsed.amount_vnd || null,
      parsed.recipient_account || null,
      parsed.ref_content || null,
      parsed.transaction_time || null,
      input.result.status,
      JSON.stringify(input.result.passed_rules),
      JSON.stringify(input.result.failed_rules),
      JSON.stringify(input.result.notes),
      input.result.auto_confirm_eligible ? 1 : 0,
      Date.now(),
    );
    return r.lastInsertRowid as number;
  } catch (e: any) {
    console.warn('[deposit-validator] log fail:', e?.message);
    return 0;
  }
}

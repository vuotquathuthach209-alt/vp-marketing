/**
 * Deposit Handler — orchestrate OCR → validate → update booking → Telegram notify.
 *
 * Gọi từ funnel-dispatcher hoặc webhook khi user gửi ảnh biên lai.
 *
 * Flow:
 *   1. OCR image
 *   2. Validate (4 rules)
 *   3. If matched → update sync_bookings status=confirmed + decrement availability + reply "Đã nhận cọc ✅"
 *   4. If mismatch → reply "Đang verify thủ công" + Telegram notify staff
 */

import { db } from '../db';
import { extractFromUrl, extractText } from './ocr-client';
import { validateDeposit, getSonderBankConfig, logOcrReceipt, ValidationResult } from './deposit-validator';
import { confirmBooking } from './sync-hub';

export interface DepositHandleInput {
  hotel_id: number;
  sender_id: string;
  image_url?: string;
  image_buffer?: Buffer;
  booking_id?: number;      // nếu admin biết trước; nếu không thì auto-detect từ sender_id
  expected_amount?: number; // nếu không truyền thì lookup từ booking
  expected_ref?: string;    // nếu không truyền thì auto-generate từ booking_id
}

export interface DepositHandleResult {
  ok: boolean;
  status: string;
  reply: string;
  validation?: ValidationResult;
  booking_id?: number;
  ocr_receipt_id?: number;
  error?: string;
}

/** Format VND (500000 → "500.000đ") */
function fmtVnd(n: number): string {
  return n.toLocaleString('vi-VN') + 'đ';
}

/** Find active booking cho sender_id. */
function findActiveBooking(hotelId: number, senderId: string): any {
  return db.prepare(
    `SELECT * FROM sync_bookings
     WHERE hotel_id = ? AND sender_id = ? AND status = 'hold'
       AND expires_at > ?
     ORDER BY id DESC LIMIT 1`
  ).get(hotelId, senderId, Date.now()) as any;
}

/** Build standard reference code từ booking ID. */
function buildRefCode(bookingId: number): string {
  return `SONDER-B${bookingId}`;
}

export async function handleDepositReceipt(input: DepositHandleInput): Promise<DepositHandleResult> {
  // 1. Find booking
  let booking: any = null;
  if (input.booking_id) {
    booking = db.prepare(`SELECT * FROM sync_bookings WHERE id = ?`).get(input.booking_id) as any;
  } else {
    booking = findActiveBooking(input.hotel_id, input.sender_id);
  }

  if (!booking) {
    return {
      ok: false,
      status: 'no_booking',
      reply: 'Dạ em chưa thấy booking nào đang chờ cọc cho anh/chị. Anh/chị có thể nói em biết muốn đặt chỗ nào trước nhé ạ? 🙏',
      error: 'no active hold booking',
    };
  }

  const expectedAmount = input.expected_amount ?? (booking.deposit_amount || 500_000);
  const expectedRef = input.expected_ref ?? buildRefCode(booking.id);

  // 2. OCR
  let ocrResult;
  if (input.image_buffer) {
    ocrResult = await extractText(input.image_buffer);
  } else if (input.image_url) {
    ocrResult = await extractFromUrl(input.image_url);
  } else {
    return {
      ok: false,
      status: 'no_image',
      reply: 'Dạ em chưa nhận được ảnh biên lai ạ, anh/chị gửi lại giúp em nhé 📎',
    };
  }

  if (!ocrResult.ok) {
    return {
      ok: false,
      status: 'ocr_fail',
      reply: 'Dạ ảnh bị mờ quá em đọc không rõ, anh/chị chụp lại rõ hơn giúp em nhé 📷',
      error: ocrResult.error,
    };
  }

  // 3. Validate
  const validation = validateDeposit({
    ocr_text: ocrResult.raw_text,
    expected_amount: expectedAmount,
    expected_ref_code: expectedRef,
  });

  // 4. Log receipt
  const receiptId = logOcrReceipt({
    hotel_id: input.hotel_id,
    sender_id: input.sender_id,
    booking_id: booking.id,
    image_path: input.image_url,
    result: validation,
  });

  // 5. Build reply + action theo status
  const sonderBank = getSonderBankConfig();

  if (validation.status === 'matched') {
    // Auto confirm
    confirmBooking(booking.id, { deposit_proof_url: input.image_url });
    notifyStaffSuccess(booking, validation, input.image_url);

    return {
      ok: true,
      status: 'matched',
      reply: buildMatchedReply(booking, validation),
      validation,
      booking_id: booking.id,
      ocr_receipt_id: receiptId,
    };
  }

  // Mismatch → human review
  notifyStaffMismatch(booking, validation, input.image_url);

  return {
    ok: true,
    status: validation.status,
    reply: buildMismatchReply(booking, validation, sonderBank, expectedRef),
    validation,
    booking_id: booking.id,
    ocr_receipt_id: receiptId,
  };
}

/* ═══════════════════════════════════════════
   REPLY TEMPLATES
   ═══════════════════════════════════════════ */

function buildMatchedReply(booking: any, validation: ValidationResult): string {
  const parsed = validation.parsed;
  return `✅ Đã nhận cọc thành công!\n\n` +
    `• Số tiền: ${fmtVnd(parsed.amount_vnd || 0)}\n` +
    `• Ngân hàng: ${parsed.bank || '?'}\n` +
    `• Phòng: ${booking.room_type_code}\n` +
    `• Check-in: ${booking.checkin_date}${booking.checkout_date ? ` → ${booking.checkout_date}` : ''}\n\n` +
    `🎉 Booking đã được xác nhận. Team em sẽ gọi xác nhận + gửi mã giữ phòng qua SĐT.\n\n` +
    `Cảm ơn anh/chị đã chọn Sonder! 💚`;
}

function buildMismatchReply(booking: any, validation: ValidationResult, sonderBank: any, expectedRef: string): string {
  const status = validation.status;
  const parsed = validation.parsed;
  const expectedAmount = fmtVnd(validation.expected_amount);

  switch (status) {
    case 'mismatch_amount':
      return `⚠️ Em thấy số tiền chuyển là ${parsed.amount_vnd ? fmtVnd(parsed.amount_vnd) : '?'} nhưng cần cọc **${expectedAmount}** ạ.\n\n` +
        `Anh/chị kiểm tra lại giúp em nhé. Nếu đã chuyển đúng rồi thì em nhờ staff kiểm tra thủ công trong 15 phút ạ 🙏`;

    case 'mismatch_account':
      return `⚠️ Em thấy số tài khoản nhận là **${parsed.recipient_account || '?'}** nhưng STK của Sonder là **${sonderBank.account_number}** ạ.\n\n` +
        `Anh/chị có thể nhầm bên khác rồi. Vui lòng chuyển đúng STK:\n` +
        `• ${sonderBank.account_number} — ${sonderBank.bank_name}\n` +
        `• ${sonderBank.account_holder}\n\n` +
        `Nếu đã chuyển đúng rồi thì em nhờ staff kiểm tra thủ công trong 15 phút ạ 🙏`;

    case 'stale_timestamp':
      return `⚠️ Biên lai này có vẻ là giao dịch cũ (> 30 phút trước). \n\nAnh/chị chuyển khoản lại giúp em nhé, hoặc gửi lại ảnh biên lai mới nhất ạ 🙏`;

    case 'missing_ref':
      return `⚠️ Em không thấy mã booking **${expectedRef}** trong nội dung chuyển khoản.\n\n` +
        `Anh/chị có thể chuyển lại với nội dung đúng: **${expectedRef}**\n` +
        `Hoặc em nhờ staff verify thủ công trong 15 phút ạ 🙏`;

    case 'low_ocr_confidence':
      return `📷 Ảnh biên lai hơi mờ, em đọc không được rõ. Anh/chị chụp lại rõ hơn giúp em nhé (chụp thẳng, đủ sáng) 🙏`;

    default:
      return `⏳ Em đang verify biên lai, chờ staff xác nhận trong 15 phút nhé ạ. Nếu gấp, anh/chị có thể gọi hotline 0348 644 833 🙏`;
  }
}

/* ═══════════════════════════════════════════
   TELEGRAM NOTIFY
   ═══════════════════════════════════════════ */

function notifyStaffSuccess(booking: any, validation: ValidationResult, imageUrl?: string): void {
  try {
    const { notifyAll } = require('./telegram');
    const parsed = validation.parsed;
    const msg = `✅ *CỌC NHẬN ĐƯỢC — Booking #${booking.id}*\n` +
      `━━━━━━━━━━━━━━━━━━\n` +
      `• Khách: ${booking.customer_name || '(chưa tên)'} (${booking.customer_phone || '?'})\n` +
      `• Phòng: ${booking.room_type_code}\n` +
      `• Check-in: ${booking.checkin_date}${booking.checkout_date ? ` → ${booking.checkout_date}` : ''}\n` +
      `• Số tiền: ${fmtVnd(parsed.amount_vnd || 0)} ✓\n` +
      `• Bank: ${parsed.bank || '?'} → Sonder ✓\n` +
      `• Thời gian: ${parsed.transaction_time_str || '?'}\n` +
      `• Mã ref: ${parsed.ref_content || '?'}\n\n` +
      `→ Auto-confirmed booking.\n` +
      `→ OTA team sẽ sync sang PMS trong 5 phút.`;
    notifyAll(msg).catch(() => {});
  } catch {}
}

function notifyStaffMismatch(booking: any, validation: ValidationResult, imageUrl?: string): void {
  try {
    const { notifyAll } = require('./telegram');
    const parsed = validation.parsed;
    const msg = `⚠️ *CẦN REVIEW — Booking #${booking.id}*\n` +
      `━━━━━━━━━━━━━━━━━━\n` +
      `Status: *${validation.status}*\n\n` +
      `OCR đọc được:\n` +
      `• Số tiền: ${parsed.amount_vnd ? fmtVnd(parsed.amount_vnd) : '❌ không đọc được'}\n` +
      `  (cần: ${fmtVnd(validation.expected_amount)})\n` +
      `• STK nhận: ${parsed.recipient_account || '❌'}\n` +
      `• Bank: ${parsed.bank || '❌'}\n` +
      `• Mã ref: ${parsed.ref_content || '❌'}\n` +
      `  (cần chứa: ${validation.expected_ref})\n` +
      `• Thời gian: ${parsed.transaction_time_str || '❌'}\n\n` +
      `Failed rules: ${validation.failed_rules.join(', ')}\n\n` +
      `Khách: ${booking.customer_phone || booking.sender_id}\n` +
      `Ảnh gốc: ${imageUrl || '(trong DB)'}\n\n` +
      `\`/confirm ${booking.id}\` xác nhận thủ công\n` +
      `\`/reject ${booking.id}\` từ chối`;
    notifyAll(msg).catch(() => {});
  } catch {}
}

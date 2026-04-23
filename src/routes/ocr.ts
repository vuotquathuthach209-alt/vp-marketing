/**
 * OCR Routes — admin UI cho test + config Sonder bank.
 */

import { Router } from 'express';
import { db } from '../db';
import { authMiddleware, AuthRequest, getHotelId } from '../middleware/auth';
import { ocrHealthCheck, extractText, extractFromUrl } from '../services/ocr-client';
import { parseReceipt } from '../services/receipt-parser-vn';
import { validateDeposit, getSonderBankConfig, saveSonderBankConfig, logOcrReceipt } from '../services/deposit-validator';

const router = Router();
router.use(authMiddleware);

/** Health check sidecar */
router.get('/health', async (_req: AuthRequest, res) => {
  try {
    const r = await ocrHealthCheck();
    res.json(r);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

/** Get Sonder bank config */
router.get('/bank-config', (_req: AuthRequest, res) => {
  try {
    res.json(getSonderBankConfig());
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

/** Update Sonder bank config */
router.post('/bank-config', (req: AuthRequest, res) => {
  try {
    const { account_number, bank_name, bank_code, account_holder } = req.body || {};
    if (!account_number || !bank_name || !account_holder) {
      return res.status(400).json({ error: 'account_number + bank_name + account_holder required' });
    }
    saveSonderBankConfig({
      account_number: String(account_number),
      bank_name: String(bank_name),
      bank_code: bank_code ? String(bank_code) : undefined,
      account_holder: String(account_holder),
    });
    res.json({ ok: true, saved: getSonderBankConfig() });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

/** Test OCR with image URL hoặc base64 */
router.post('/test', async (req: AuthRequest, res) => {
  try {
    const { image_url, image_base64 } = req.body || {};
    if (!image_url && !image_base64) {
      return res.status(400).json({ error: 'image_url or image_base64 required' });
    }

    const result = image_url
      ? await extractFromUrl(image_url)
      : await extractText(Buffer.from(image_base64.replace(/^data:[^,]+,/, ''), 'base64'));

    if (!result.ok) return res.status(500).json({ error: result.error, ocr_result: result });

    const parsed = parseReceipt(result.raw_text);
    res.json({ ocr_result: result, parsed });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

/** Test validate deposit — full flow */
router.post('/validate', async (req: AuthRequest, res) => {
  try {
    const hotelId = getHotelId(req);
    const { image_url, image_base64, expected_amount, expected_ref_code } = req.body || {};
    if ((!image_url && !image_base64) || !expected_amount || !expected_ref_code) {
      return res.status(400).json({ error: 'image + expected_amount + expected_ref_code required' });
    }

    const ocrResult = image_url
      ? await extractFromUrl(image_url)
      : await extractText(Buffer.from(image_base64.replace(/^data:[^,]+,/, ''), 'base64'));

    if (!ocrResult.ok) return res.status(500).json({ error: ocrResult.error, ocr_result: ocrResult });

    const validation = validateDeposit({
      ocr_text: ocrResult.raw_text,
      expected_amount: Number(expected_amount),
      expected_ref_code: String(expected_ref_code),
    });

    logOcrReceipt({
      hotel_id: hotelId,
      sender_id: String(req.body?.sender_id || 'admin_test'),
      result: validation,
    });

    res.json({
      ocr_result: ocrResult,
      validation,
    });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

/** List recent OCR receipts */
router.get('/recent', (req: AuthRequest, res) => {
  try {
    const hotelId = getHotelId(req);
    const limit = Math.min(200, Math.max(10, parseInt(String(req.query.limit || '50'), 10)));
    const status = req.query.status as string | undefined;

    const where = status ? 'AND verification_status = ?' : '';
    const params: any[] = [hotelId];
    if (status) params.push(status);
    params.push(limit);

    const rows = db.prepare(
      `SELECT id, sender_id, booking_id, detected_bank, amount_vnd, recipient_account,
              ref_content, verification_status, passed_rules, failed_rules, notes,
              auto_confirmed, transaction_time, created_at
       FROM ocr_receipts
       WHERE hotel_id = ? ${where}
       ORDER BY id DESC LIMIT ?`
    ).all(...params) as any[];

    for (const r of rows) {
      try { r.passed_rules = JSON.parse(r.passed_rules || '[]'); } catch {}
      try { r.failed_rules = JSON.parse(r.failed_rules || '[]'); } catch {}
      try { r.notes = JSON.parse(r.notes || '[]'); } catch {}
    }

    const stats = db.prepare(
      `SELECT verification_status, COUNT(*) as n FROM ocr_receipts WHERE hotel_id = ? GROUP BY verification_status`
    ).all(hotelId) as any[];

    res.json({
      items: rows,
      stats: Object.fromEntries(stats.map((s: any) => [s.verification_status, s.n])),
    });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

export default router;

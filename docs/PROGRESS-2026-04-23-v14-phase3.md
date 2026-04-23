# Progress Log — 2026-04-23 (v14 Phase 3)

## 🎯 Status summary

### ✅ COMPLETED
| Component | Status |
|-----------|--------|
| Python FastAPI sidecar (`ocr-service/main.py`) | ✅ Code done |
| install.sh + systemd unit | ✅ Done |
| Node OCR client (`src/services/ocr-client.ts`) | ✅ Done |
| Receipt parser VN (9 banks) | ✅ Done |
| Deposit validator (4 rules) | ✅ Done |
| Deposit handler (orchestrator) | ✅ Done |
| Admin routes `/api/ocr/*` | ✅ Done |
| Funnel integration (image → OCR pipeline) | ✅ Done |
| Zalo + FB webhook pass imageUrl | ✅ Done |
| TSC build pass | ✅ Done |
| Git commits | ✅ ef1bb59, edc3b6e, 25ed826, 9d9786b |
| Node deployed to VPS | ✅ Done |

### 🔄 IN PROGRESS
- Python sidecar install trên VPS (easyocr + torch ~500MB download)
- Waiting for pip install to complete

### ⏭️ NEXT
- Verify health endpoint after install completes
- Test with sample Vietnamese bank receipt image
- Document usage for admin

## 📝 Key decisions

### Switched PaddleOCR → EasyOCR
**Reason:** PaddleOCR 2.7.5 has import bug (`NameError: predict_system not defined`) on Python 3.12 Ubuntu 24.04. PaddlePaddle 2.6.2 installed fine but paddleocr package itself broken.

**Alternative chosen:** EasyOCR 1.7.2 + PyTorch 2.2.0
- Pure Python + PyTorch ecosystem (stable, well-maintained)
- Vietnamese language pack built-in (`lang=['vi', 'en']`)
- Simpler API (`reader.readtext()` returns `[(bbox, text, conf), ...]`)
- Heavier deps (~1GB) but fits 15GB VPS fine

### Bank config: placeholder default
User said "phần tài khoản mình sẽ điền vào sau". Default in `deposit-validator.ts`:
```typescript
const DEFAULT_SONDER_BANK = {
  account_number: '0000000000',
  bank_name: 'MB Bank',
  bank_code: 'mb',
  account_holder: 'CONG TY TNHH SONDER VIET NAM',
};
```

Admin điền sau qua:
```bash
curl -X POST https://mkt.sondervn.com/api/ocr/bank-config \
  -b cookie.txt \
  -H 'Content-Type: application/json' \
  -d '{"account_number":"0123456789","bank_name":"MB Bank","bank_code":"mb","account_holder":"CONG TY SONDER"}'
```

### Reference code format
Default: `SONDER-B{booking_id}` (e.g. `SONDER-B1234`). Validator dùng `includes()` check → khách có thể gõ uppercase/lowercase, có dashes hay không đều OK.

## 🏗️ Pipeline flow

```
Khách book → handleShowResults (v14 sync hub filter)
    ↓ (>=24h trước check-in + còn phòng)
Bot yêu cầu cọc + info STK + mã ref
    ↓ (create sync_bookings.status='hold', 15min timeout)
Khách CK + gửi ảnh qua Zalo/FB
    ↓ (webhook detect attachment)
smartReplyWithSender(text, senderId, ..., imageUrl)
    ↓
processFunnelMessage(... opts.imageUrl)
    ↓ (detect active hold booking for sender)
handleDepositReceipt()
    ↓
extractFromUrl() → EasyOCR → raw_text
    ↓
parseReceipt() → ReceiptData (amount, account, time, ref)
    ↓
validateDeposit() → 4 rules check
    ↓
┌── matched → confirmBooking() → decrement availability → Telegram ✅
└── mismatch → Telegram ⚠️ admin review + reply khách
```

## 🔐 Security

1. **HMAC sync hub:** OTA team phải sign request với shared secret
2. **OCR sidecar:** Bearer token auth (local 127.0.0.1:8501, không expose internet)
3. **NĐ 13 compliance:** 
   - Ảnh biên lai không chứa PII sinh trắc (khác CCCD)
   - Log `ocr_receipts` để audit
   - Recommend xoá ảnh > 30 ngày (có `retention-cleanup.ts` infra)

## 📦 Files created this phase

```
ocr-service/
├── main.py                     # FastAPI + EasyOCR
├── requirements.txt            # easyocr + torch + fastapi
├── install.sh                  # apt deps + venv + systemd
└── vp-mkt-ocr.service          # systemd unit (2GB RAM cap)

src/services/
├── ocr-client.ts               # HTTP call sidecar
├── receipt-parser-vn.ts        # Parse 9 banks (MB, VCB, TCB, VPB, TPB, BIDV, Agr, ACB, STB)
├── deposit-validator.ts        # 4 rules + logOcrReceipt
└── deposit-handler.ts          # Orchestrator

src/routes/
└── ocr.ts                      # Admin test + bank config

Schema: ocr_receipts (auto-created)
```

## 🧪 Test commands (sau khi sidecar live)

```bash
# Health
curl -b cookie.txt https://mkt.sondervn.com/api/ocr/health

# Config bank
curl -b cookie.txt -X POST https://mkt.sondervn.com/api/ocr/bank-config \
  -H 'Content-Type: application/json' \
  -d '{"account_number":"0123","bank_name":"MB Bank","account_holder":"SONDER"}'

# Test with image URL
curl -b cookie.txt -X POST https://mkt.sondervn.com/api/ocr/validate \
  -H 'Content-Type: application/json' \
  -d '{"image_url":"https://...","expected_amount":500000,"expected_ref_code":"SONDER-B1"}'
```

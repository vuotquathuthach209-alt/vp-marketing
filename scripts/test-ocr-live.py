"""End-to-end OCR test: synthetic receipt → OCR → parse → validate."""
import sys, paramiko
try: sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except: pass
HOST = "103.82.193.74"
PASSWORD = sys.argv[1] if len(sys.argv) > 1 else ""

# Generate synthetic MB Bank receipt via PIL on VPS, then OCR it
CMD = r"""
cd /opt/vp-marketing

# 1. Generate synthetic receipt image
cat > /tmp/gen-receipt.py <<'PY'
from PIL import Image, ImageDraw, ImageFont
import os

img = Image.new('RGB', (600, 900), 'white')
draw = ImageDraw.Draw(img)

# Try to use a system font, fallback to default
try:
    font_big = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', 28)
    font = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', 20)
    font_small = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', 16)
except:
    font_big = ImageFont.load_default()
    font = ImageFont.load_default()
    font_small = ImageFont.load_default()

y = 30
draw.text((200, y), "MB BANK", fill='black', font=font_big); y += 50
draw.text((170, y), "Giao dich thanh cong", fill='green', font=font_big); y += 70

draw.text((50, y), "So tien:", fill='gray', font=font_small); y += 25
draw.text((50, y), "500.000 VND", fill='black', font=font_big); y += 60

draw.text((50, y), "Thoi gian:", fill='gray', font=font_small); y += 25
from datetime import datetime, timezone, timedelta
vn = datetime.now(timezone(timedelta(hours=7)))
ts = vn.strftime('%H:%M:%S %d/%m/%Y')
draw.text((50, y), ts, fill='black', font=font); y += 50

draw.text((50, y), "Tai khoan nhan:", fill='gray', font=font_small); y += 25
draw.text((50, y), "0123456789", fill='black', font=font); y += 35
draw.text((50, y), "CONG TY TNHH SONDER VIET NAM", fill='black', font=font); y += 50

draw.text((50, y), "Noi dung:", fill='gray', font=font_small); y += 25
draw.text((50, y), "SONDER-B999 coc phong", fill='black', font=font); y += 50

draw.text((50, y), "Ma giao dich:", fill='gray', font=font_small); y += 25
draw.text((50, y), "FT20260423500001", fill='black', font=font)

img.save('/tmp/test-receipt.jpg', quality=90)
print(f'Saved: /tmp/test-receipt.jpg, timestamp={ts}')
PY
/opt/vp-marketing/ocr-service/venv/bin/python /tmp/gen-receipt.py

echo ""
echo "=== 2. Call OCR endpoint ==="
TOKEN=$(grep TOKEN /etc/vp-mkt-ocr.env | cut -d= -f2)
BASE64=$(base64 -w0 /tmp/test-receipt.jpg)
curl -s -X POST http://127.0.0.1:8501/ocr \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"image_base64\":\"$BASE64\",\"min_confidence\":0.3}" > /tmp/ocr-result.json

echo "OCR result (abbrev):"
node -e "
  const r = require('/tmp/ocr-result.json');
  console.log('ok:', r.ok, '| latency_ms:', r.latency_ms, '| lines:', r.lines.length);
  console.log('raw_text:');
  console.log(r.raw_text);
"

echo ""
echo "=== 3. Parse receipt + validate ==="
cat > /tmp/test-parse.js <<'JS'
const { parseReceipt } = require('/opt/vp-marketing/dist/services/receipt-parser-vn');
const { validateDeposit, saveSonderBankConfig } = require('/opt/vp-marketing/dist/services/deposit-validator');

// Config Sonder bank for this test
saveSonderBankConfig({
  account_number: '0123456789',
  bank_name: 'MB Bank',
  bank_code: 'mb',
  account_holder: 'CONG TY TNHH SONDER VIET NAM',
});

const result = require('/tmp/ocr-result.json');
const parsed = parseReceipt(result.raw_text);
console.log('\n=== Parsed ===');
console.log('bank:', parsed.bank);
console.log('amount:', parsed.amount_vnd);
console.log('account:', parsed.recipient_account);
console.log('timestamp_str:', parsed.transaction_time_str);
console.log('ref_content:', parsed.ref_content);
console.log('transaction_id:', parsed.transaction_id);
console.log('confidence:', parsed.confidence);
console.log('parser_notes:', parsed.parser_notes.join(', '));

console.log('\n=== Validation ===');
const v = validateDeposit({
  ocr_text: result.raw_text,
  expected_amount: 500000,
  expected_ref_code: 'SONDER-B999',
});
console.log('Status:', v.status);
console.log('Passed rules:', v.passed_rules.join(', '));
console.log('Failed rules:', v.failed_rules.join(', '));
console.log('Notes:', v.notes.join(' | '));
console.log('Auto confirm:', v.auto_confirm_eligible);
JS
node /tmp/test-parse.js
"""
client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, username="root", password=PASSWORD, timeout=15)
_, stdout, stderr = client.exec_command(CMD, timeout=120)
print(stdout.read().decode("utf-8", errors="replace"))
err = stderr.read().decode("utf-8", errors="replace")
if err.strip(): print("STDERR:\n" + err, file=sys.stderr)
client.close()

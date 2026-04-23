#!/bin/bash
# Install script cho OCR sidecar trên VPS Ubuntu 24.04.
# Usage: sudo bash install.sh
set -e

echo "=== VP MKT OCR Sidecar Install ==="

OCR_DIR="/opt/vp-marketing/ocr-service"
VENV_DIR="$OCR_DIR/venv"
SERVICE_NAME="vp-mkt-ocr"

if [ ! -d "$OCR_DIR" ]; then
  echo "ERROR: $OCR_DIR not found. Run git pull first."
  exit 1
fi

cd "$OCR_DIR"

# 1. System deps
echo "[1/5] Installing system deps..."
apt-get update -qq
apt-get install -y python3 python3-pip python3-venv libgomp1 libglib2.0-0 libsm6 libxext6 libxrender-dev libgl1 >/dev/null 2>&1

# 2. Python venv
echo "[2/5] Creating Python venv..."
if [ ! -d "$VENV_DIR" ]; then
  python3 -m venv "$VENV_DIR"
fi

# 3. Install Python packages
echo "[3/5] Installing PaddleOCR (may take 5-10 min)..."
"$VENV_DIR/bin/pip" install --upgrade pip -q
"$VENV_DIR/bin/pip" install -r requirements.txt

# 4. Warmup (download models)
echo "[4/5] Warmup — downloading PaddleOCR models (~25MB)..."
"$VENV_DIR/bin/python" -c "
from paddleocr import PaddleOCR
ocr = PaddleOCR(use_angle_cls=False, lang='en', show_log=False)
print('Models ready.')
" || echo "WARN: warmup failed, models sẽ download khi chạy service"

# 5. Generate shared token + systemd unit
echo "[5/5] Setting up systemd service..."
if [ ! -f "/etc/vp-mkt-ocr.env" ]; then
  TOKEN=$(openssl rand -hex 32)
  cat > /etc/vp-mkt-ocr.env <<EOF
OCR_SHARED_TOKEN=$TOKEN
OCR_PORT=8501
OCR_HOST=127.0.0.1
EOF
  chmod 600 /etc/vp-mkt-ocr.env
  echo "✅ Shared token saved to /etc/vp-mkt-ocr.env"
  echo "   TOKEN: $TOKEN"
  echo ""
  echo "   ACTION: Thêm vào /opt/vp-marketing/.env:"
  echo "   OCR_SERVICE_URL=http://127.0.0.1:8501"
  echo "   OCR_SERVICE_TOKEN=$TOKEN"
else
  echo "✅ /etc/vp-mkt-ocr.env exists (preserved)"
fi

# Copy systemd unit
cp "$OCR_DIR/vp-mkt-ocr.service" "/etc/systemd/system/$SERVICE_NAME.service"
systemctl daemon-reload
systemctl enable "$SERVICE_NAME"
systemctl restart "$SERVICE_NAME"

sleep 3
systemctl status "$SERVICE_NAME" --no-pager -l | head -15

echo ""
echo "=== Done ==="
echo "Test: curl -H 'Authorization: Bearer \$(grep TOKEN /etc/vp-mkt-ocr.env | cut -d= -f2)' http://127.0.0.1:8501/health"
echo "Logs: journalctl -u $SERVICE_NAME -f"

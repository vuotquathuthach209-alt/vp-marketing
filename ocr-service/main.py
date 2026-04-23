"""
VP MKT OCR Sidecar — PaddleOCR v4 FastAPI wrapper.

Cung cấp /ocr endpoint cho Node service gọi extract text từ ảnh biên lai chuyển khoản.

Models preloaded 1 lần khi start → mỗi request chỉ inference (~300-500ms).

Chạy:
    uvicorn main:app --host 127.0.0.1 --port 8501

Auth: Bearer token (shared với Node sidecar).
"""
import os
import sys
import time
import base64
import logging
from typing import Optional

from fastapi import FastAPI, HTTPException, Request
from pydantic import BaseModel
import uvicorn

# EasyOCR imports — nhẹ hơn PaddleOCR và stable hơn trên Ubuntu 24.04
try:
    import easyocr
    import numpy as np
    from PIL import Image
    import io
except ImportError as e:
    print(f"FATAL: {e}", file=sys.stderr)
    print("Run: pip install easyocr torch pillow opencv-python-headless", file=sys.stderr)
    sys.exit(1)

# Logging
logging.basicConfig(
    level=logging.INFO,
    format='[ocr-service] %(asctime)s %(levelname)s: %(message)s',
)
log = logging.getLogger("ocr")

# Config
SHARED_TOKEN = os.environ.get("OCR_SHARED_TOKEN", "dev-token-change-me")
MAX_IMAGE_SIZE_MB = 10

# ═══════════════════════════════════════════════════════════
# Preload EasyOCR models (1 time, at startup)
# ═══════════════════════════════════════════════════════════
log.info("Loading EasyOCR models (vi + en)...")
t0 = time.time()
try:
    # Vietnamese + English — handle cả dấu tiếng Việt + số + English keyword
    reader = easyocr.Reader(['vi', 'en'], gpu=False, verbose=False)
    log.info(f"Models loaded in {time.time() - t0:.1f}s")
except Exception as e:
    log.error(f"Failed to load EasyOCR: {e}")
    raise

# ═══════════════════════════════════════════════════════════
# FastAPI app
# ═══════════════════════════════════════════════════════════
app = FastAPI(title="VP MKT OCR Sidecar", version="1.0")

class OcrRequest(BaseModel):
    image_base64: str
    min_confidence: float = 0.5

class OcrLine(BaseModel):
    text: str
    confidence: float
    bbox: list  # [[x1,y1],[x2,y2],[x3,y3],[x4,y4]]

class OcrResponse(BaseModel):
    ok: bool
    lines: list
    raw_text: str
    width: int
    height: int
    latency_ms: int
    error: Optional[str] = None


@app.middleware("http")
async def auth_middleware(request: Request, call_next):
    # Skip auth for health/docs
    if request.url.path in ('/health', '/docs', '/openapi.json'):
        return await call_next(request)
    auth = request.headers.get("authorization", "")
    if not auth.startswith("Bearer "):
        return HTTPException(status_code=401, detail="missing token").__dict__ and {"error": "unauthorized"}
    token = auth[7:]
    if token != SHARED_TOKEN:
        return HTTPException(status_code=401, detail="bad token").__dict__
    return await call_next(request)


@app.get("/health")
async def health():
    return {"status": "ok", "models_loaded": True, "token_configured": bool(SHARED_TOKEN)}


@app.post("/ocr")
async def ocr_endpoint(req: OcrRequest):
    """Extract text từ image. Input: base64-encoded image. Output: lines[] + raw_text."""
    t0 = time.time()
    try:
        # Decode image
        img_data = req.image_base64
        # Strip data URL prefix if present
        if ',' in img_data and img_data.startswith('data:'):
            img_data = img_data.split(',', 1)[1]
        try:
            img_bytes = base64.b64decode(img_data)
        except Exception as e:
            raise HTTPException(status_code=400, detail=f"invalid base64: {e}")

        size_mb = len(img_bytes) / 1024 / 1024
        if size_mb > MAX_IMAGE_SIZE_MB:
            raise HTTPException(status_code=413, detail=f"image too large: {size_mb:.1f}MB > {MAX_IMAGE_SIZE_MB}MB")

        # PIL → numpy (PaddleOCR accepts both)
        try:
            img = Image.open(io.BytesIO(img_bytes))
            # Convert RGBA/palette → RGB
            if img.mode != 'RGB':
                img = img.convert('RGB')
            img_np = np.array(img)
        except Exception as e:
            raise HTTPException(status_code=400, detail=f"cannot decode image: {e}")

        width, height = img.size

        # Run OCR (EasyOCR format)
        try:
            # readtext returns: [(bbox, text, confidence), ...]
            result = reader.readtext(img_np, detail=1, paragraph=False)
        except Exception as e:
            log.error(f"OCR inference fail: {e}")
            raise HTTPException(status_code=500, detail=f"ocr inference error: {e}")

        lines = []
        raw_text_parts = []
        for item in (result or []):
            if not item or len(item) < 3:
                continue
            bbox, text, conf = item[0], item[1], float(item[2])
            if conf < req.min_confidence:
                continue
            lines.append({
                "text": text,
                "confidence": round(conf, 3),
                "bbox": [[float(p[0]), float(p[1])] for p in bbox] if bbox else [],
            })
            raw_text_parts.append(text)

        latency = int((time.time() - t0) * 1000)
        log.info(f"OCR: {len(lines)} lines, {latency}ms, image {width}x{height} {size_mb:.1f}MB")

        return {
            "ok": True,
            "lines": lines,
            "raw_text": "\n".join(raw_text_parts),
            "width": width,
            "height": height,
            "latency_ms": latency,
        }
    except HTTPException:
        raise
    except Exception as e:
        log.exception("unexpected error")
        return {
            "ok": False,
            "lines": [],
            "raw_text": "",
            "width": 0,
            "height": 0,
            "latency_ms": int((time.time() - t0) * 1000),
            "error": str(e),
        }


if __name__ == "__main__":
    port = int(os.environ.get("OCR_PORT", "8501"))
    host = os.environ.get("OCR_HOST", "127.0.0.1")
    log.info(f"Starting OCR sidecar on {host}:{port}")
    uvicorn.run(app, host=host, port=port, log_level="info")

# OTA Raw Data API — Spec cho OTA team

> **Mục đích**: OTA web (sondervn.com / PMS Sonder) đẩy dữ liệu raw vào bot marketing để bot tự động classify + tư vấn khách qua Facebook / Zalo.
>
> **Kiến trúc**: 2-layer pipeline
> - Layer 1 (endpoint này): nhận JSON free-form → lưu raw
> - Layer 2 (tự động, cron 5 phút): Qwen AI classify → map vào schema bot chuẩn

---

## 🔐 Authentication

### Shared secret
- 32-byte hex, sinh bằng `crypto.randomBytes(32).toString('hex')`
- Store: bot lưu trong `settings.ota_raw_secret` (DB); OTA lưu trong env `SONDER_BOT_SECRET`
- Rotate: mỗi 90 ngày, admin bot bấm nút "Rotate secret" → gửi secret mới qua Telegram + email

### Request signing

Mỗi request **BẮT BUỘC** có 3 headers:

```
X-OTA-Signature: sha256=<HMAC_SHA256(raw_body, secret)>
X-OTA-Timestamp: <unix_ms>
X-OTA-Source:    ota-web | pms | manual
```

**Compute**:
```javascript
import crypto from 'crypto';

const body = JSON.stringify(payload);
const sig = crypto
  .createHmac('sha256', process.env.SONDER_BOT_SECRET)
  .update(body)
  .digest('hex');

const headers = {
  'Content-Type': 'application/json',
  'X-OTA-Signature': 'sha256=' + sig,
  'X-OTA-Timestamp': Date.now().toString(),
  'X-OTA-Source': 'ota-web',
};
```

**Bot verify**:
- Timestamp skew ±5 phút (tránh replay attack)
- Signature mismatch → `401 Unauthorized`

---

## 📤 Endpoint: POST /api/ota-raw/push

### Full URL
```
https://app.sondervn.com/api/ota-raw/push
```

### Request body

```json
{
  "batch_id": "string (optional, bot auto-generate nếu không có)",
  "type": "hotels | rooms | availability | images",
  "items": [ /* array of items theo type */ ]
}
```

### Item schemas theo `type`

#### type = "hotels"
```json
{
  "ota_id": "string required, unique hotel ID trong OTA system",
  "data": { /* free-form JSON, bot sẽ classify */ }
}
```

**Gợi ý fields trong `data`** (bot + Qwen sẽ map nếu có):
```json
{
  "name": "Sonder Airport",
  "address": "123 Trường Sơn, Tân Bình, TP.HCM",
  "city": "Ho Chi Minh",
  "district": "Tân Bình",
  "latitude": 10.8171,
  "longitude": 106.6589,
  "phone": "+84 909 123 456",
  "star_rating": 4,
  "type": "apartment | hotel | homestay | villa | resort | guesthouse | hostel | (hoặc bất kỳ — Qwen sẽ classify)",
  "rental_mode": "nightly | monthly | hourly | mixed",
  "description": "mô tả dài...",
  "monthly_price_from": 3600000,
  "monthly_price_to": 3900000,
  "min_stay_months": 1,
  "deposit_months": 1,
  "utilities_included": true,
  "full_kitchen": true,
  "washing_machine": true,
  "amenities": ["wifi", "pool", "gym", "breakfast"],
  "usp": ["gần sân bay", "mới xây 2024", "view đẹp"],
  "images": [
    { "url": "https://...", "caption": "Mặt tiền", "is_primary": true, "order": 1 }
  ]
}
```

#### type = "rooms"
```json
{
  "ota_id": "string required, unique room_type ID",
  "parent_ota_hotel_id": "string required, matches hotel.ota_id",
  "data": {
    "name": "Deluxe Twin",
    "bed_type": "2 giường đôi",
    "max_guests": 2,
    "size_sqm": 28,
    "price_weekday": 700000,
    "price_weekend": 850000,
    "price_monthly": null,
    "price_hourly": null,
    "amenities": ["wifi", "tv", "mini-bar"],
    "images": [ ... ]
  }
}
```

#### type = "availability"
```json
{
  "ota_room_id": "string required, matches rooms.ota_id",
  "date": "YYYY-MM-DD",
  "available_units": 5,
  "price": 700000,
  "currency": "VND"
}
```

> **Note**: `availability` là daily snapshot. Re-push cùng `(ota_room_id, date)` sẽ **overwrite** (UPSERT).

#### type = "images"
```json
{
  "entity_type": "hotel | room",
  "entity_ota_id": "string required",
  "image_url": "https://... (HTTPS required)",
  "caption": "Mặt tiền khách sạn",
  "is_primary": true,
  "order_idx": 1
}
```

### Response (success)

```json
{
  "ok": true,
  "batch_id": "batch_1234567890_abc123",
  "type": "hotels",
  "received": 10,
  "inserted": 10,
  "failed": 0,
  "errors": [],
  "pending_classification": 10,
  "next_classify_at": "within 5 min (cron)"
}
```

### Response (error)

```json
{
  "ok": false,
  "error": "missing X-OTA-Signature header" | "signature mismatch" | "timestamp out of range (skew=...)"
}
```

HTTP codes:
- `200 OK` — ingested (dù có một số items fail, check `errors` array)
- `400 Bad Request` — invalid payload structure
- `401 Unauthorized` — HMAC fail
- `500 Internal Server Error` — bot-side issue

---

## 🔄 Polling status

### GET /api/ota-raw/status/:batch_id

Check tình trạng classify của 1 batch (admin auth required).

```json
{
  "batch": {
    "batch_id": "batch_...",
    "type": "hotels",
    "total_items": 10,
    "pending_items": 3,
    "classified_items": 6,
    "failed_items": 1,
    "received_at": 1776850995671
  },
  "breakdown": {
    "pending": 3,
    "classified": 6,
    "failed": 1
  }
}
```

---

## 💡 Best practices cho OTA team

### 1. Batch size
- Nhỏ (<100 items/batch) cho real-time updates
- Lớn (500-1000 items) cho initial import — bot xử lý chậm hơn nhưng vẫn OK

### 2. Rate limit
- Tối đa **10 req/phút** cho bot, để Qwen classify theo kịp
- Initial import: nên split thành batches nhỏ + delay 6 giây giữa các batches

### 3. Error handling
- Response `failed > 0` → retry **chỉ items failed** trong batch sau
- Don't retry same batch_id — bot deduplicate theo `(ota_id, received_at)`

### 4. Delta updates vs full sync
- Delta (khuyến nghị): chỉ push items CÓ THAY ĐỔI
- Full sync: toàn bộ catalog mỗi đêm (cron OTA) → bot refresh data toàn cục

### 5. Images
- URL phải HTTPS public accessible (không auth)
- Bot caches locally nên OTA có thể xóa URL sau khi bot classify xong

### 6. Type = "hotels" nên push TRƯỚC rooms + availability
- Bot classify rooms cần biết parent hotel
- Nếu push parallel: Qwen sẽ delay classify rooms đến khi hotel xong

---

## 🛠 Sample client code (Node.js)

```javascript
const crypto = require('crypto');
const axios = require('axios');

const BOT_URL = 'https://app.sondervn.com/api/ota-raw/push';
const SECRET = process.env.SONDER_BOT_SECRET;

async function pushToBot(type, items) {
  const body = JSON.stringify({
    batch_id: `${type}-${Date.now()}`,
    type,
    items,
  });
  const sig = crypto.createHmac('sha256', SECRET).update(body).digest('hex');

  try {
    const resp = await axios.post(BOT_URL, body, {
      headers: {
        'Content-Type': 'application/json',
        'X-OTA-Signature': 'sha256=' + sig,
        'X-OTA-Timestamp': Date.now().toString(),
        'X-OTA-Source': 'ota-web',
      },
      timeout: 30000,
    });
    console.log('✓ Pushed', resp.data.inserted, 'of', items.length, 'items');
    return resp.data;
  } catch (err) {
    console.error('✗ Push failed:', err.response?.data || err.message);
    throw err;
  }
}

// Example usage
pushToBot('hotels', [
  {
    ota_id: 'sonder-airport',
    data: {
      name: 'Sonder Airport',
      address: '123 Trường Sơn, Tân Bình',
      type: 'serviced_apartment',
      rental_mode: 'monthly',
      monthly_price_from: 3600000,
      // ...
    },
  },
]);
```

---

## 🐍 Sample client code (Python)

```python
import hmac
import hashlib
import json
import time
import requests
import os

BOT_URL = 'https://app.sondervn.com/api/ota-raw/push'
SECRET = os.environ['SONDER_BOT_SECRET']

def push_to_bot(item_type, items):
    batch = {
        'batch_id': f'{item_type}-{int(time.time() * 1000)}',
        'type': item_type,
        'items': items,
    }
    body = json.dumps(batch, ensure_ascii=False)
    sig = hmac.new(SECRET.encode(), body.encode(), hashlib.sha256).hexdigest()

    resp = requests.post(BOT_URL, data=body, headers={
        'Content-Type': 'application/json',
        'X-OTA-Signature': f'sha256={sig}',
        'X-OTA-Timestamp': str(int(time.time() * 1000)),
        'X-OTA-Source': 'ota-web',
    }, timeout=30)
    resp.raise_for_status()
    return resp.json()
```

---

## 📊 Flow từ OTA push → bot tư vấn khách

```
 1. OTA POST /api/ota-raw/push { type: "hotels", items: [...] }
    ↓
 2. Bot INSERT vào ota_raw_hotels (status='pending')
    ↓ (cron 5 phút)
 3. Qwen AI classify payload → map vào hotel_profile schema
    ↓
 4. Success: status='classified' + link classified_hotel_id
    Failed:  status='failed' + error_message → admin review
    ↓
 5. Bot marketing dùng hotel_profile để tư vấn khách:
    - FB/Zalo chat: "tôi cần homestay gần sân bay"
    - Bot query → list properties match → close booking
```

---

## ❓ FAQ

**Q: OTA push cùng `ota_id` nhiều lần?**
A: Mỗi lần là 1 row raw MỚI (append-only). Qwen classify row mới nhất → UPDATE hotel_profile. Raw data giữ 90 ngày.

**Q: Nếu OTA schema thay đổi?**
A: Không ảnh hưởng. OTA cứ push JSON mới, Qwen prompt sẽ adapt. Nếu Qwen fail classify → admin review qua UI `/ota-pipeline` → map manual.

**Q: Làm sao biết bot đã classify xong chưa?**
A: GET `/api/ota-raw/status/:batch_id` hoặc xem admin UI "OTA Pipeline" tab.

**Q: Có endpoint DELETE hotel không?**
A: Chưa. Nếu muốn deprecate hotel, push `hotels` với `{ "data": { "status": "inactive" } }` — Qwen sẽ set `mkt_hotels.status='inactive'`.

**Q: Rate limit nghiêm ngặt cỡ nào?**
A: 10 req/phút mềm. Bot không block, nhưng Qwen classify queue sẽ chậm.

---

## 🚀 Onboarding checklist

- [ ] Nhận shared secret qua Telegram + email
- [ ] Lưu secret vào env OTA side: `SONDER_BOT_SECRET=<hex>`
- [ ] Test endpoint `GET /api/ota-raw/secret-info` (admin) để confirm bot side đã có secret
- [ ] Push sample batch hotels → check admin UI "OTA Pipeline" thấy batch
- [ ] Đợi 5-10 phút → check status → 'classified'
- [ ] Verify bot trả lời đúng data mới (chat Zalo test)
- [ ] Scale up: push rooms + availability + images

---

## 📞 Support

- Admin bot: `https://app.sondervn.com` tab "🔌 OTA Pipeline"
- Logs: `pm2 logs vp-mkt | grep ota-raw` trên VPS
- Issues: thông báo qua Telegram bot vp-marketing (admin nhận)

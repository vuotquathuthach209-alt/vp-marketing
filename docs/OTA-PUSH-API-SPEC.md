# OTA → Bot Push API Specification
_Version 1.0 — 2026-04-21_

> **Dành cho**: OTA dev team  
> **Dành cho**: VP Marketing Bot team  
> **Liên hệ**: bot@sondervn.com

## 📋 Tóm tắt

Marketing bot của Sonder cần dữ liệu khách sạn **realtime** để tư vấn khách trên Facebook Messenger. Thay vì bot kéo data từ OTA (cần credentials, firewall, v.v.), OTA **tự push** khi có thay đổi.

**Push model**:
```
OTA DB changes → trigger/cron → POST /api/ota/push/sync → bot update
```

## 🌐 Base URL

```
Production : https://app.sondervn.com/api/ota/push
```

## 🔐 Authentication — HMAC SHA-256

### Setup

1. **OTA dev** sinh random secret 32 bytes (64 hex chars):
   ```bash
   # Linux/Mac
   openssl rand -hex 32
   # → ví dụ: 7a3f8b2c1d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a
   ```
   HOẶC lấy secret từ bot admin (đã generate sẵn trên dashboard).

2. **Lưu secret** ở 2 nơi:
   - **OTA side**: trong env `OTA_BOT_PUSH_SECRET`
   - **Bot side**: đã được admin set trong dashboard

### Cách ký request

Với **mỗi POST** request:

```javascript
const crypto = require('crypto');

const secret = process.env.OTA_BOT_PUSH_SECRET;
const body = { hotels: [...] };
const payload = JSON.stringify(body);   // ⚠️ SAME serialization với bot expect

const signature = crypto
  .createHmac('sha256', secret)
  .update(payload)
  .digest('hex');

// Gửi request
fetch('https://app.sondervn.com/api/ota/push/sync', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-OTA-Signature': `sha256=${signature}`,
  },
  body: payload,  // ← chính là chuỗi đã dùng để ký
});
```

### Test auth (Ping)

```bash
# Không cần auth
curl https://app.sondervn.com/api/ota/push/ping
# → {"ok":true,"message":"...","auth_configured":true,...}

# Có auth (verify signature)
SECRET="your_secret_here"
BODY='{"hello":"world"}'
SIG=$(echo -n "$BODY" | openssl dgst -sha256 -hmac "$SECRET" | cut -d' ' -f2)
curl -X POST https://app.sondervn.com/api/ota/push/ping \
  -H "Content-Type: application/json" \
  -H "X-OTA-Signature: sha256=$SIG" \
  -d "$BODY"
# → {"ok":true,"authenticated":true,"body_echo":{"hello":"world"}}
```

---

## 📤 Endpoints

### 1. Batch sync tất cả hotels

```
POST /api/ota/push/sync
Content-Type: application/json
X-OTA-Signature: sha256=<hex>

{
  "hotels": [
    { ...hotel 1... },
    { ...hotel 2... }
  ]
}
```

**Response**:
```json
{
  "ok": true,
  "processed": 5,
  "created": 1,
  "updated": 4,
  "skipped": 0,
  "failed": 0,
  "errors": [],
  "duration_ms": 250
}
```

**Dùng khi**: full sync mỗi giờ, hoặc sau khi OTA có batch update.

### 2. Push 1 hotel (partial update OK)

```
POST /api/ota/push/hotel
X-OTA-Signature: sha256=<hex>

{
  "ota_hotel_id": 6,
  "name": "Sonder Airport",
  "ai_summary_vi": "Updated description..."
}
```

**Response**:
```json
{"ok":true,"action":"updated","ota_hotel_id":6}
```

**Dùng khi**: 1 hotel vừa được edit → realtime push (trigger on UPDATE).

### 3. Soft-delete hotel

```
DELETE /api/ota/push/hotel/6
X-OTA-Signature: sha256=<hex>
```

**Response**:
```json
{"ok":true,"affected":1}
```

Bot set `mkt_hotels.status='inactive'`, không xóa data thực.

---

## 📦 Payload schema

### Hotel object (full spec)

```typescript
interface PushHotelPayload {
  // ═══ REQUIRED ═══
  ota_hotel_id: number;          // PK — must match OTA's hotels.id
  name: string;                  // canonical name

  // ═══ BASIC INFO ═══
  name_en?: string;
  slug?: string;                 // URL-safe name (auto-gen nếu trống)
  city?: string;                 // "Ho Chi Minh" | "Ha Noi" | ...
  district?: string;             // "Tan Binh" | ...
  address?: string;              // "123 ABC, phường X, quận Y"
  latitude?: number;             // GPS
  longitude?: number;
  phone?: string;                // "0901234567"
  star_rating?: number;          // 1-5

  // ═══ CLASSIFICATION ═══
  property_type?: 'apartment' | 'hotel' | 'homestay' | 'resort' | 'villa';
  product_group?: 'monthly_apartment' | 'nightly_stay';
  rental_type?: 'per_night' | 'per_hour' | 'per_month';
  target_segment?: 'business' | 'family' | 'couple' | 'backpacker' | 'long_stay' | 'mixed';

  // ═══ BRAND VOICE (bot sẽ dùng tone này khi reply khách) ═══
  brand_voice?: 'friendly' | 'formal' | 'luxury';   // default 'friendly'

  // ═══ AI CONTENT ═══
  ai_summary_vi?: string;        // "Sonder Airport là căn hộ dịch vụ cho khách công tác dài hạn..."
  ai_summary_en?: string;
  usp_top3?: string[];           // ["Giá rẻ", "Bếp đầy đủ", "Gần sân bay"]
  nearby_landmarks?: {           // { landmark: distance_km }
    "Sân bay Tân Sơn Nhất": 2.5,
    "Lotte Mart Phú Mỹ Hưng": 8.0
  };

  // ═══ APARTMENT PRICING (nếu product_group='monthly_apartment') ═══
  monthly_price_from?: number;   // 3600000 (VND)
  monthly_price_to?: number;     // 3900000
  min_stay_months?: number;      // 3
  deposit_months?: number;       // 1
  full_kitchen?: boolean;
  washing_machine?: boolean;
  utilities_included?: boolean;

  // ═══ NESTED ═══
  rooms?: RoomPayload[];
  amenities?: AmenityPayload[];
  policies?: PoliciesPayload;

  // ═══ META ═══
  status?: 'active' | 'inactive';
  source?: string;               // "ota_push" (default)
  pushed_at?: number;            // epoch ms (bot sẽ dùng làm scraped_at)
}

interface RoomPayload {
  room_key?: string;             // unique trong hotel (auto-gen nếu trống)
  display_name_vi: string;       // "Phòng Deluxe 2 giường"
  display_name_en?: string;
  price_weekday?: number;        // VND/đêm
  price_weekend?: number;
  price_hourly?: number;         // VND/giờ (nếu có)
  max_guests?: number;           // default 2
  bed_config?: string;           // "1 King" | "2 Single" | ...
  size_m2?: number;
  amenities?: string[];          // ["wifi", "balcony", "bathtub"]
  photos_urls?: string[];        // URL ảnh phòng
  description_vi?: string;
}

interface AmenityPayload {
  category?: string;             // "general" | "pool" | "gym" | "spa" | "food"
  name_vi: string;               // "Hồ bơi ngoài trời"
  name_en?: string;
  free?: boolean;
  hours?: string;                // "6:00 - 22:00"
  note?: string;
}

interface PoliciesPayload {
  checkin_time?: string;         // "14:00"
  checkout_time?: string;        // "12:00"
  cancellation_text?: string;    // "Miễn phí huỷ trước 24h, sau đó charge 50%"
  deposit_percent?: number;      // 30
  pet_allowed?: boolean;
  child_policy?: string;         // "Trẻ em dưới 6 tuổi miễn phí"
  payment_methods?: string;      // "Tiền mặt, chuyển khoản, Momo"
}
```

---

## 💼 Ví dụ payload đầy đủ (1 hotel)

### Apartment (Sonder Airport)
```json
{
  "ota_hotel_id": 6,
  "name": "Sonder Airport",
  "city": "Ho Chi Minh",
  "district": "Tan Binh",
  "address": "B12 D. Bach Dang, Phuong 2, Tan Son Hoa",
  "latitude": 10.7995218,
  "longitude": 106.6412817,
  "phone": "0942883133",
  "star_rating": 3,
  "property_type": "apartment",
  "product_group": "monthly_apartment",
  "rental_type": "per_month",
  "brand_voice": "friendly",
  "ai_summary_vi": "Sonder Airport là căn hộ dịch vụ cho thuê tháng, phù hợp khách công tác dài hạn tại Tân Bình. Giá 3.6-3.9 triệu/tháng, bao trọn điện nước, có bếp + máy giặt riêng.",
  "usp_top3": [
    "Giá thuê tháng tiết kiệm, bao trọn điện nước",
    "Căn hộ đầy đủ tiện nghi: bếp + máy giặt riêng",
    "Gần sân bay Tân Sơn Nhất (2.5km)"
  ],
  "monthly_price_from": 3600000,
  "monthly_price_to": 3900000,
  "min_stay_months": 3,
  "deposit_months": 1,
  "full_kitchen": true,
  "washing_machine": true,
  "utilities_included": true,
  "rooms": [
    {
      "room_key": "sonder_airport_monthly",
      "display_name_vi": "Căn hộ thuê tháng Sonder Airport",
      "price_weekday": 3600000,
      "price_weekend": 3900000,
      "max_guests": 2,
      "bed_config": "1 Queen",
      "size_m2": 28,
      "amenities": ["wifi", "kitchen", "washer", "balcony"],
      "description_vi": "Căn hộ dịch vụ đầy đủ tiện nghi, phù hợp ở dài ngày"
    }
  ],
  "amenities": [
    { "category": "general", "name_vi": "Wifi miễn phí", "free": true },
    { "category": "general", "name_vi": "Bãi đỗ xe", "free": true },
    { "category": "general", "name_vi": "Lễ tân 24/7", "free": true, "hours": "24/7" }
  ],
  "policies": {
    "checkin_time": "14:00",
    "checkout_time": "12:00",
    "cancellation_text": "Miễn phí huỷ trước 7 ngày. Sau đó charge 1 tháng tiền cọc.",
    "deposit_percent": 0,
    "pet_allowed": false,
    "payment_methods": "Chuyển khoản, tiền mặt"
  },
  "source": "ota_production_db",
  "pushed_at": 1776678879176
}
```

### Hotel (Seehome Airport)
```json
{
  "ota_hotel_id": 7,
  "name": "Seehome Airport",
  "city": "Ho Chi Minh",
  "district": "Tan Binh",
  "star_rating": 4,
  "property_type": "homestay",
  "product_group": "nightly_stay",
  "rental_type": "per_night",
  "brand_voice": "friendly",
  "ai_summary_vi": "Seehome Airport là homestay 4 sao, giá 550k/đêm, có hồ bơi + gym + spa. Phù hợp các cặp đôi.",
  "rooms": [
    {
      "display_name_vi": "Phòng Standard",
      "price_weekday": 550000,
      "price_weekend": 650000,
      "max_guests": 2,
      "bed_config": "1 Queen"
    },
    {
      "display_name_vi": "Phòng Deluxe City View",
      "price_weekday": 750000,
      "price_weekend": 850000,
      "max_guests": 2,
      "bed_config": "1 King"
    }
  ],
  "amenities": [
    { "category": "pool", "name_vi": "Hồ bơi ngoài trời", "free": true, "hours": "6:00-22:00" },
    { "category": "gym", "name_vi": "Phòng gym", "free": true },
    { "category": "spa", "name_vi": "Spa", "free": false }
  ],
  "policies": {
    "checkin_time": "14:00",
    "checkout_time": "12:00",
    "cancellation_text": "Miễn phí huỷ trước 24h",
    "deposit_percent": 30
  }
}
```

---

## 🔄 Suggested push triggers (OTA side)

### 1. Cron job (safe default)
```javascript
// Cron mỗi 30 phút push delta (hotels updated kể từ lần trước)
cron.schedule('*/30 * * * *', async () => {
  const since = await redis.get('last_push_ts') || 0;
  const hotels = await db.query(`
    SELECT * FROM hotels
    WHERE updated_at > $1 AND status = 'active'
  `, [since]);
  if (hotels.length === 0) return;

  const payload = { hotels: hotels.map(toPushFormat) };
  const sig = signPayload(payload);

  const r = await fetch('https://app.sondervn.com/api/ota/push/sync', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-OTA-Signature': `sha256=${sig}` },
    body: JSON.stringify(payload),
  });
  const result = await r.json();
  console.log('[push] synced', result.processed);
  await redis.set('last_push_ts', Date.now());
});
```

### 2. Realtime trigger (khi admin edit 1 hotel)
```javascript
// Sau khi UPDATE hotels → push ngay
async function onHotelUpdated(hotelId) {
  const hotel = await db.query('SELECT * FROM hotels WHERE id = $1', [hotelId]);
  const payload = toPushFormat(hotel);
  const sig = signPayload(payload);

  await fetch('https://app.sondervn.com/api/ota/push/hotel', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-OTA-Signature': `sha256=${sig}` },
    body: JSON.stringify(payload),
  });
}
```

### 3. Database trigger (nếu dùng PostgreSQL)
```sql
CREATE OR REPLACE FUNCTION notify_hotel_change() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('hotel_updated', NEW.id::text);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER hotel_updated_trigger AFTER UPDATE ON hotels
FOR EACH ROW EXECUTE FUNCTION notify_hotel_change();
```
Kết hợp với Node.js listener `client.on('notification', ...)` → call push endpoint.

---

## ⚠️ Lưu ý quan trọng

### Manual override
Nếu admin bot đã edit hotel trực tiếp trong dashboard (bật `manual_override=1`), bot sẽ **SKIP update** từ OTA push → log response `"action": "skipped"`. Admin có thể tắt override qua UI khi muốn sync lại từ OTA.

### Idempotency
Dùng `ota_hotel_id` làm key. OTA có thể push cùng hotel nhiều lần mà không tạo duplicate.

### Full replace vs merge
- `rooms` array: **full replace** (xóa hết rooms cũ, insert list mới)
- `amenities` array: **full replace**
- `policies` object: **upsert** (merge fields)
- Hotel profile fields: **merge** (null/undefined không ghi đè, trừ khi explicit)

### Rate limit
- 300 req/phút trên `/api/*` (đã có rate limit global)
- Khuyến nghị: OTA batch 50-100 hotels/request thay vì 1 hotel/request

### Error handling
OTA nên retry khi:
- HTTP 5xx → retry 3 lần với exponential backoff
- HTTP 401 → check signature, KHÔNG retry (invalid auth)
- HTTP 400 → check payload format, KHÔNG retry (bad data)

### Monitoring
Admin có thể xem audit log tại:
```
GET /api/ota/push/admin/log  (auth required)
```
Trả về 50 push gần nhất với status + duration + errors.

---

## 🧪 Test checklist

- [ ] Ping không auth (public): `curl https://app.sondervn.com/api/ota/push/ping`
- [ ] Ping có auth: sign với secret, POST `/api/ota/push/ping`
- [ ] Sync 1 hotel test → verify bot dashboard thấy hotel mới
- [ ] Sync 1 hotel với `rooms` đầy đủ → verify UI "Khách sạn" thấy rooms
- [ ] Push partial update (chỉ `name` mới) → verify rooms cũ giữ nguyên
- [ ] DELETE hotel → verify `status=inactive`
- [ ] Sai signature → verify 401 response
- [ ] Thiếu `ota_hotel_id` → verify 400 response

---

## 📞 Support

Nếu OTA team gặp vấn đề:
- Check logs bot: `pm2 logs vp-mkt | grep ota-push`
- Admin view push audit: dashboard `app.sondervn.com` → (sắp có tab riêng)
- Liên hệ: admin bot

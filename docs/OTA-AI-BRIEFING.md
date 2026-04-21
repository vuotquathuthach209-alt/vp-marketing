# Kế Hoạch Cho OTA AI — Push Data Vào Marketing Bot
_Version 1.0 — 2026-04-21_

> **CONTEXT**: Đây là brief để bạn (AI đang làm việc trên codebase OTA) đọc và
> hiểu nhiệm vụ. User sẽ nạp file này vào session của bạn để bạn phân tích
> codebase OTA + lên kế hoạch implementation.
>
> **KHÔNG** cần SSH sang bot server — tất cả implement trên OTA side.
> Bot side đã sẵn sàng nhận push.

---

## 🎯 Mục tiêu

Sonder có 2 hệ thống:
1. **OTA** (đang có sẵn) — quản lý hotels, rooms, bookings tại `sondervn.com`
2. **Marketing Bot** (đã build) — chatbot Facebook Messenger tại `app.sondervn.com`

**Vấn đề**: Bot cần dữ liệu hotel chi tiết (giá, phòng, tiện nghi, policies) để tư vấn khách trên Messenger. Hiện bot đang **scrape HTML** sondervn.com — không bền vững khi scale.

**Giải pháp**: OTA **tự push** data sang bot khi có thay đổi. Bot đã expose endpoint nhận sẵn.

**Nhiệm vụ của bạn**: Code phía OTA để gọi endpoint bot đã sẵn sàng.

---

## 🏗️ Kiến trúc

```
┌─────────────────────────┐         ┌─────────────────────────┐
│  OTA (codebase của bạn) │         │  Marketing Bot          │
│  sondervn.com           │         │  app.sondervn.com       │
│                         │         │                         │
│  PostgreSQL             │         │  SQLite (bot DB riêng)  │
│   hotels                │         │   hotel_profile         │
│   rooms                 │────────→│   hotel_room_catalog    │
│   room_types            │  POST   │   hotel_amenities       │
│   amenities             │  JSON   │   hotel_policies        │
│   policies              │  HMAC   │                         │
│                         │         │  View: v_hotel_bot_ctx  │
│  NEW CODE YOU WRITE:    │         │  (đã tự gộp data)       │
│  - cron 30p delta push  │         │                         │
│  - trigger on-update    │         │  Bot query view →       │
│  - HMAC signing         │         │  trả lời khách FB       │
└─────────────────────────┘         └─────────────────────────┘
```

**Push direction**: OTA → Bot (1 chiều). Bot KHÔNG gọi ngược OTA. Bot KHÔNG cần DB credentials OTA.

**Trigger**:
- Cron delta sync (mỗi 30 phút) — cho safe default
- Event-driven (khi admin edit hotel) — cho realtime
- DB trigger (pg_notify) — cho production scale

---

## 🌐 Endpoint bot đã expose (read-only cho OTA)

```
Base URL: https://app.sondervn.com/api/ota/push
```

| Method | Path | Mục đích |
|--------|------|----------|
| GET | `/ping` | Health check (không auth) |
| POST | `/ping` | Test HMAC signature |
| **POST** | **`/sync`** | **Batch push nhiều hotels** |
| POST | `/hotel` | Single hotel (partial update OK) |
| DELETE | `/hotel/:id` | Soft-delete |

Full spec ở `docs/OTA-PUSH-API-SPEC.md` (bot repo). Tóm tắt bên dưới.

---

## 🔐 Authentication — HMAC SHA-256

### Setup 1 lần

1. User (admin bot) **vào dashboard**: https://app.sondervn.com → tab **"OTA DB"** → section **"📥 OTA Push API"** → click **"🎲 Generate"**
2. Bot trả secret 64 hex chars (chỉ hiện 1 lần), ví dụ:
   ```
   7a3f8b2c1d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a
   ```
3. User gửi secret cho OTA dev → **bạn lưu vào env** `OTA_BOT_PUSH_SECRET`

### Ký request (mỗi POST)

```typescript
// Node.js / TypeScript
import crypto from 'crypto';

function signPayload(body: object): string {
  const secret = process.env.OTA_BOT_PUSH_SECRET!;
  const payload = JSON.stringify(body);   // ⚠️ CÙNG serialization với body gửi
  const signature = crypto
    .createHmac('sha256', secret)
    .update(payload)
    .digest('hex');
  return `sha256=${signature}`;
}

// Ví dụ gọi
const body = { hotels: [{ ota_hotel_id: 6, name: "..." }] };
await fetch('https://app.sondervn.com/api/ota/push/sync', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-OTA-Signature': signPayload(body),
  },
  body: JSON.stringify(body),   // SAME string!
});
```

```python
# Python / FastAPI / Django
import hmac
import hashlib
import json
import requests
import os

def sign_payload(body: dict) -> str:
    secret = os.environ['OTA_BOT_PUSH_SECRET'].encode()
    payload = json.dumps(body, separators=(',', ':'), ensure_ascii=False).encode()
    sig = hmac.new(secret, payload, hashlib.sha256).hexdigest()
    return f'sha256={sig}', payload

body = {"hotels": [...]}
sig, payload = sign_payload(body)
requests.post(
    'https://app.sondervn.com/api/ota/push/sync',
    headers={'Content-Type': 'application/json', 'X-OTA-Signature': sig},
    data=payload,   # ⚠️ raw bytes, KHÔNG `json=` vì sẽ re-serialize khác
)
```

```go
// Go
import (
    "crypto/hmac"
    "crypto/sha256"
    "encoding/hex"
)

func sign(secret string, payload []byte) string {
    h := hmac.New(sha256.New, []byte(secret))
    h.Write(payload)
    return "sha256=" + hex.EncodeToString(h.Sum(nil))
}
```

**Lưu ý SERIALIZATION**:
- Bot verify bằng `JSON.stringify(body)` (Node default — no space, key order theo JS object).
- OTA nên dùng cùng kiểu serialize. Nếu dùng Python/Go, thống nhất 1 format (compact JSON, separators=',:').
- Test với `/ping` endpoint để đảm bảo chữ ký match trước khi push real data.

---

## 📦 Payload schema — Hotel object

### Required fields (bắt buộc)

```typescript
{
  ota_hotel_id: number,   // PK trong DB OTA (bot dùng làm idempotent key)
  name: string,           // "Sonder Airport"
}
```

### Recommended fields

```typescript
{
  // Basic
  name_en?: string,
  slug?: string,                    // "sonder-airport"
  city?: string,                    // "Ho Chi Minh" | "Ha Noi" | ...
  district?: string,                // "Tan Binh"
  address?: string,                 // "123 Bach Dang, ..."
  latitude?: number,
  longitude?: number,
  phone?: string,                   // "0901234567"
  star_rating?: number,             // 1-5

  // Classification (quan trọng cho bot tư vấn đúng product)
  property_type?: 'apartment' | 'hotel' | 'homestay' | 'resort' | 'villa',
  product_group?: 'monthly_apartment' | 'nightly_stay',
  rental_type?: 'per_night' | 'per_hour' | 'per_month',
  target_segment?: 'business' | 'family' | 'couple' | 'backpacker' | 'long_stay' | 'mixed',

  // Brand voice — bot dùng khi reply khách (default 'friendly')
  brand_voice?: 'friendly' | 'formal' | 'luxury',

  // AI content (nếu OTA có synthesized content sẵn thì push; nếu không bot tự gen)
  ai_summary_vi?: string,           // "Sonder Airport là căn hộ dịch vụ..."
  ai_summary_en?: string,
  usp_top3?: string[],              // ["Giá rẻ", "Gần sân bay", "Bếp đầy đủ"]
  nearby_landmarks?: Record<string, number>,  // { "Sân bay": 2.5 } (km)

  // Apartment-specific (nếu product_group='monthly_apartment')
  monthly_price_from?: number,      // VND 3600000
  monthly_price_to?: number,        // VND 3900000
  min_stay_months?: number,         // 3
  deposit_months?: number,          // 1
  full_kitchen?: boolean,
  washing_machine?: boolean,
  utilities_included?: boolean,     // điện nước bao trọn

  // Rooms (FULL REPLACE mỗi lần push — OTA là source of truth)
  rooms?: Array<{
    room_key?: string,              // unique trong hotel, auto-gen nếu trống
    display_name_vi: string,        // "Phòng Deluxe 2 giường"
    display_name_en?: string,
    price_weekday?: number,         // VND/đêm
    price_weekend?: number,
    price_hourly?: number,          // VND/giờ (nếu có)
    max_guests?: number,            // default 2
    bed_config?: string,            // "1 King" | "2 Single"
    size_m2?: number,
    amenities?: string[],           // ["wifi", "balcony", "bathtub"]
    photos_urls?: string[],
    description_vi?: string,
  }>,

  // Amenities (FULL REPLACE)
  amenities?: Array<{
    category?: string,              // "general" | "pool" | "gym" | "spa" | "food"
    name_vi: string,                // "Hồ bơi ngoài trời"
    name_en?: string,
    free?: boolean,
    hours?: string,                 // "6:00-22:00"
    note?: string,
  }>,

  // Policies (upsert merge)
  policies?: {
    checkin_time?: string,          // "14:00"
    checkout_time?: string,         // "12:00"
    cancellation_text?: string,
    deposit_percent?: number,       // 30
    pet_allowed?: boolean,
    child_policy?: string,
    payment_methods?: string,       // "Chuyển khoản, tiền mặt, Momo"
  },

  // Meta
  status?: 'active' | 'inactive',
  source?: string,                  // "ota_push" | "ota_manual_edit"
  pushed_at?: number,               // epoch ms
}
```

### Ví dụ đầy đủ — apartment (Sonder Airport)

```json
{
  "hotels": [
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
          "description_vi": "Căn hộ dịch vụ đầy đủ tiện nghi"
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
  ]
}
```

### Ví dụ — hotel nightly stay (Seehome)

```json
{
  "hotels": [
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
      "ai_summary_vi": "Seehome Airport là homestay 4 sao, giá 550k/đêm, có hồ bơi + gym + spa.",
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
  ]
}
```

---

## 🛠️ Task list cho bạn (OTA AI)

### PHASE 1 — Phân tích codebase OTA (1 giờ)

Chạy:
```bash
# Xác định stack
cat package.json 2>/dev/null | head -30 || cat pyproject.toml 2>/dev/null || cat go.mod
# Xác định DB
grep -r "POSTGRES\|DATABASE_URL\|DB_HOST" --include="*.env*" --include="*.ts" --include="*.js" | head -5
# Tìm hotel schema
grep -rn "hotel_id\|CREATE TABLE hotels" --include="*.sql" --include="*.ts" | head -20
```

Trả lời:
- [ ] Language/framework OTA (Next.js? NestJS? Express? Django?)
- [ ] ORM/query builder (Prisma? TypeORM? raw SQL?)
- [ ] DB driver (pg? sequelize?)
- [ ] Entry point cron / worker hiện tại (PM2? Kubernetes CronJob? node-cron?)
- [ ] Cấu trúc `hotels` table exactly (columns, FK)
- [ ] Tables liên quan: `rooms`, `room_types`, `amenities`, `policies`, `hotel_images`
- [ ] Có trigger/audit cơ chế update_at hay không?

### PHASE 2 — Thiết kế delta detection (2 giờ)

Bạn cần **biết hotel nào vừa thay đổi** để push. 3 cách:

**Option A — Cột updated_at (đơn giản nhất)**
```sql
-- Mỗi lần write, update cột updated_at
UPDATE hotels SET name = ..., updated_at = NOW() WHERE id = 6;
```
Query delta:
```sql
SELECT * FROM hotels WHERE updated_at > $1 AND status = 'active';
```

**Option B — Trigger + outbox table**
```sql
CREATE TABLE hotel_sync_outbox (
  id SERIAL PRIMARY KEY,
  hotel_id INT NOT NULL,
  action VARCHAR(16) NOT NULL,    -- 'upsert' | 'delete'
  synced_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE OR REPLACE FUNCTION enqueue_sync() RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO hotel_sync_outbox (hotel_id, action)
  VALUES (NEW.id, CASE WHEN TG_OP = 'DELETE' THEN 'delete' ELSE 'upsert' END);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER hotel_sync AFTER INSERT OR UPDATE OR DELETE ON hotels
FOR EACH ROW EXECUTE FUNCTION enqueue_sync();

-- Cũng làm cho rooms, amenities nếu cần
```

**Option C — pg_notify realtime**
```sql
CREATE OR REPLACE FUNCTION notify_hotel_change() RETURNS TRIGGER AS $$
BEGIN
  PERFORM pg_notify('hotel_updated', NEW.id::text);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER hotel_notify AFTER INSERT OR UPDATE ON hotels
FOR EACH ROW EXECUTE FUNCTION notify_hotel_change();
```
Kết hợp Node.js listener:
```typescript
const client = await pool.connect();
await client.query('LISTEN hotel_updated');
client.on('notification', async (msg) => {
  if (msg.channel === 'hotel_updated') {
    await pushHotel(parseInt(msg.payload));
  }
});
```

**Khuyến nghị**: Bắt đầu bằng **Option A** (đơn giản), upgrade sang **Option C** khi ổn định.

### PHASE 3 — Implement push service (3 giờ)

Tạo file `src/services/bot-push.ts` (hoặc tương đương cho stack của bạn):

```typescript
// src/services/bot-push.ts
import crypto from 'crypto';
import { db } from '../db';

const BOT_PUSH_URL = process.env.BOT_PUSH_URL || 'https://app.sondervn.com/api/ota/push';
const SECRET = process.env.OTA_BOT_PUSH_SECRET!;

if (!SECRET) {
  console.warn('[bot-push] OTA_BOT_PUSH_SECRET không set — push sẽ được bot chấp nhận nhưng không có auth.');
}

function sign(payload: string): string {
  return 'sha256=' + crypto.createHmac('sha256', SECRET || '').update(payload).digest('hex');
}

/** Build payload từ DB row — map OTA schema → bot schema */
async function buildHotelPayload(hotelId: number): Promise<any | null> {
  // ⚠️ Query này PHẢI điều chỉnh theo schema OTA thực tế
  const hotel = await db.query(`SELECT * FROM hotels WHERE id = $1`, [hotelId]);
  if (!hotel.rows[0]) return null;
  const h = hotel.rows[0];

  const rooms = await db.query(`
    SELECT r.*, rt.name as type_name
    FROM rooms r LEFT JOIN room_types rt ON rt.id = r.room_type_id
    WHERE r.hotel_id = $1 AND r.deleted_at IS NULL
  `, [hotelId]);

  const amenities = await db.query(`
    SELECT * FROM hotel_amenities WHERE hotel_id = $1
  `, [hotelId]);

  const policies = await db.query(`
    SELECT * FROM hotel_policies WHERE hotel_id = $1 LIMIT 1
  `, [hotelId]);

  return {
    ota_hotel_id: h.id,
    name: h.name,
    name_en: h.name_en,
    slug: h.slug,
    city: h.city,
    district: h.district,
    address: h.address,
    latitude: h.latitude,
    longitude: h.longitude,
    phone: h.phone,
    star_rating: h.star_rating,
    property_type: h.property_type,   // apartment / hotel / homestay ...
    product_group: h.monthly_rental ? 'monthly_apartment' : 'nightly_stay',
    rental_type: h.rental_type,
    brand_voice: h.brand_voice || 'friendly',
    ai_summary_vi: h.summary_vi,
    ai_summary_en: h.summary_en,
    usp_top3: h.usp ? h.usp.split('|') : undefined,
    // Apartment
    monthly_price_from: h.monthly_price_min,
    monthly_price_to: h.monthly_price_max,
    min_stay_months: h.min_stay_months,
    deposit_months: h.deposit_months,
    full_kitchen: h.has_kitchen,
    washing_machine: h.has_washer,
    utilities_included: h.utilities_included,
    // Nested
    rooms: rooms.rows.map(r => ({
      room_key: r.code,
      display_name_vi: r.type_name || r.name,
      price_weekday: r.price,
      price_weekend: r.price_weekend || r.price,
      price_hourly: r.price_hourly,
      max_guests: r.max_guests,
      bed_config: r.bed_config,
      size_m2: r.size,
      amenities: r.amenities ? JSON.parse(r.amenities) : [],
      photos_urls: r.photos ? JSON.parse(r.photos) : [],
      description_vi: r.description,
    })),
    amenities: amenities.rows.map(a => ({
      category: a.category,
      name_vi: a.name,
      name_en: a.name_en,
      free: a.is_free,
      hours: a.hours,
    })),
    policies: policies.rows[0] ? {
      checkin_time: policies.rows[0].checkin_time,
      checkout_time: policies.rows[0].checkout_time,
      cancellation_text: policies.rows[0].cancellation_text,
      deposit_percent: policies.rows[0].deposit_percent,
      pet_allowed: policies.rows[0].pet_allowed,
      child_policy: policies.rows[0].child_policy,
      payment_methods: policies.rows[0].payment_methods,
    } : undefined,
    status: h.status,
    source: 'ota_push',
    pushed_at: Date.now(),
  };
}

/** Push 1 hotel */
export async function pushHotel(hotelId: number): Promise<{ ok: boolean; error?: string }> {
  try {
    const payload = await buildHotelPayload(hotelId);
    if (!payload) return { ok: false, error: 'hotel not found' };

    const body = JSON.stringify(payload);
    const sig = sign(body);

    const resp = await fetch(`${BOT_PUSH_URL}/hotel`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-OTA-Signature': sig,
      },
      body,
    });

    const result = await resp.json();
    if (!resp.ok) {
      console.error(`[bot-push] hotel ${hotelId} failed:`, result);
      return { ok: false, error: result.error };
    }
    console.log(`[bot-push] hotel ${hotelId} → ${result.action}`);
    return { ok: true };
  } catch (e: any) {
    console.error(`[bot-push] exception hotel ${hotelId}:`, e.message);
    return { ok: false, error: e.message };
  }
}

/** Batch sync tất cả hotels active (hoặc delta since) */
export async function syncAllHotels(sinceTs?: Date): Promise<{ total: number; ok: number; failed: number }> {
  const whereSince = sinceTs ? `AND updated_at > $1` : '';
  const hotels = await db.query(`
    SELECT id FROM hotels
    WHERE status = 'active' ${whereSince}
    ORDER BY id
  `, sinceTs ? [sinceTs] : []);

  if (hotels.rows.length === 0) return { total: 0, ok: 0, failed: 0 };

  // Build all payloads
  const payloads = [];
  for (const row of hotels.rows) {
    const p = await buildHotelPayload(row.id);
    if (p) payloads.push(p);
  }

  const body = JSON.stringify({ hotels: payloads });
  const sig = sign(body);

  const resp = await fetch(`${BOT_PUSH_URL}/sync`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-OTA-Signature': sig },
    body,
  });

  const result = await resp.json();
  console.log(`[bot-push] batch sync: ${JSON.stringify(result)}`);
  return {
    total: hotels.rows.length,
    ok: (result.created || 0) + (result.updated || 0),
    failed: result.failed || 0,
  };
}

/** Soft-delete hotel trên bot */
export async function deleteHotel(hotelId: number): Promise<{ ok: boolean }> {
  const sig = sign('');   // DELETE không có body
  const resp = await fetch(`${BOT_PUSH_URL}/hotel/${hotelId}`, {
    method: 'DELETE',
    headers: { 'X-OTA-Signature': sig },
  });
  return { ok: resp.ok };
}
```

### PHASE 4 — Wire lên OTA production (1 giờ)

**4.1 — Cron delta sync (mỗi 30 phút)**

```typescript
// src/cron/bot-sync.ts
import cron from 'node-cron';
import { syncAllHotels } from '../services/bot-push';
import { db } from '../db';

let lastSyncAt = new Date(0);   // Khởi tạo 0 → full sync lần đầu

async function loadLastSync() {
  const r = await db.query(`SELECT last_sync FROM bot_push_state WHERE id = 1`);
  if (r.rows[0]?.last_sync) lastSyncAt = r.rows[0].last_sync;
}

async function saveLastSync(ts: Date) {
  await db.query(`
    INSERT INTO bot_push_state (id, last_sync) VALUES (1, $1)
    ON CONFLICT (id) DO UPDATE SET last_sync = $1
  `, [ts]);
  lastSyncAt = ts;
}

export async function startBotSyncCron() {
  await loadLastSync();

  // Full sync 1 lần khi app start (nếu lastSync quá cũ)
  if (Date.now() - lastSyncAt.getTime() > 24 * 3600 * 1000) {
    console.log('[bot-sync] initial full sync...');
    await syncAllHotels();
    await saveLastSync(new Date());
  }

  // Delta mỗi 30 phút
  cron.schedule('*/30 * * * *', async () => {
    const now = new Date();
    try {
      const r = await syncAllHotels(lastSyncAt);
      if (r.total > 0) console.log(`[bot-sync] delta: ${JSON.stringify(r)}`);
      await saveLastSync(now);
    } catch (e: any) {
      console.error('[bot-sync] failed:', e.message);
    }
  });
}
```

Đăng ký trong main entry:
```typescript
// src/index.ts
import { startBotSyncCron } from './cron/bot-sync';

app.listen(PORT, async () => {
  await startBotSyncCron();
});
```

Và tạo state table:
```sql
CREATE TABLE IF NOT EXISTS bot_push_state (
  id INT PRIMARY KEY,
  last_sync TIMESTAMP NOT NULL
);
INSERT INTO bot_push_state (id, last_sync) VALUES (1, '1970-01-01')
ON CONFLICT (id) DO NOTHING;
```

**4.2 — Realtime trigger (khi admin edit)**

Nếu OTA có admin panel edit hotel → hook vào event:

```typescript
// Ví dụ NestJS
import { pushHotel } from '../services/bot-push';

@Put('hotels/:id')
async updateHotel(@Param('id') id: number, @Body() dto: UpdateHotelDto) {
  const hotel = await this.hotelService.update(id, dto);
  // Fire-and-forget (không block response)
  pushHotel(id).catch(e => console.warn('[bot-push] fail:', e));
  return hotel;
}
```

**4.3 — DB trigger (khi có pg_notify — optional)**

```typescript
// src/workers/bot-push-listener.ts
import { Client } from 'pg';
import { pushHotel } from '../services/bot-push';

export async function startListener() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  await client.query('LISTEN hotel_updated');

  client.on('notification', async (msg) => {
    if (msg.channel === 'hotel_updated' && msg.payload) {
      const hotelId = parseInt(msg.payload, 10);
      if (!isNaN(hotelId)) {
        console.log(`[listener] hotel ${hotelId} changed → push`);
        await pushHotel(hotelId);
      }
    }
  });

  console.log('[bot-push-listener] started');
}
```

### PHASE 5 — Test + monitoring (1 giờ)

**5.1 — Test local với ping**

```bash
# Không cần auth
curl https://app.sondervn.com/api/ota/push/ping
# → {"ok":true,"message":"OTA push endpoint đang hoạt động","auth_configured":true/false}

# Ping có auth (dùng secret đã set)
SECRET="your_secret_here"
BODY='{"test":"hello"}'
SIG=$(echo -n "$BODY" | openssl dgst -sha256 -hmac "$SECRET" | cut -d' ' -f2)
curl -X POST https://app.sondervn.com/api/ota/push/ping \
  -H "Content-Type: application/json" \
  -H "X-OTA-Signature: sha256=$SIG" \
  -d "$BODY"
# → {"ok":true,"authenticated":true,"body_echo":{"test":"hello"}}
```

**5.2 — Test push 1 hotel**

Trong OTA code:
```typescript
// scripts/test-bot-push.ts
import { pushHotel } from '../src/services/bot-push';

async function main() {
  const testHotelId = 6;   // Hotel có sẵn trong OTA
  const r = await pushHotel(testHotelId);
  console.log('Result:', r);
}
main();
```

Chạy:
```bash
npx ts-node scripts/test-bot-push.ts
```

Verify trên bot:
1. Vào https://app.sondervn.com → tab **"Khách sạn"** → thấy hotel cập nhật
2. Tab **"OTA DB"** → section **"📥 OTA Push API"** → button **"📜 View push log"** → thấy entry mới
3. Tab **"Thử bot"** → chọn hotel đã push → test câu hỏi → bot trả data mới

**5.3 — Test batch sync**

```typescript
// scripts/test-batch-sync.ts
import { syncAllHotels } from '../src/services/bot-push';

async function main() {
  const r = await syncAllHotels();
  console.log('Batch result:', r);
}
main();
```

### PHASE 6 — Monitoring (ongoing)

Trên bot side (admin):
- **Tab "OTA DB"** → **"📜 View push log"** → thấy audit đầy đủ:
  - Thời gian push
  - Status: completed / partial / failed
  - Số hotels total / OK / failed
  - Duration ms

Trên OTA side, add logging:
```typescript
import { pushHotel } from './services/bot-push';

async function pushWithLog(hotelId: number) {
  const start = Date.now();
  const r = await pushHotel(hotelId);
  const elapsed = Date.now() - start;

  await db.query(`
    INSERT INTO bot_push_audit (hotel_id, ok, error, duration_ms, created_at)
    VALUES ($1, $2, $3, $4, NOW())
  `, [hotelId, r.ok, r.error || null, elapsed]);

  if (!r.ok) {
    // Gửi alert: Telegram, Slack, email...
    await notifyAdmin(`[bot-push] hotel ${hotelId} failed: ${r.error}`);
  }
}
```

---

## ⚠️ Lưu ý quan trọng

### 1. Idempotency
Cùng `ota_hotel_id` push nhiều lần KHÔNG tạo duplicate. Bot dùng UPSERT (INSERT ... ON CONFLICT).

### 2. Manual override
Nếu admin bot đã edit hotel qua dashboard (bật `manual_override=1`), bot sẽ SKIP update từ OTA push → response `"action": "skipped"`. Đây là tính năng, không phải bug.

### 3. Full replace vs merge
- `rooms` array: FULL REPLACE — gửi full list mỗi lần push (OTA là source of truth).
- `amenities` array: FULL REPLACE.
- `policies` object: upsert merge (fields undefined → giữ nguyên).
- Hotel profile fields: merge (null/undefined không ghi đè).

### 4. Rate limits
- Bot đã có rate limit 300 req/phút/IP
- Khuyến nghị OTA batch 50-100 hotels/request (KHÔNG 1 hotel/request loop)

### 5. Error handling

| HTTP | Nguyên nhân | OTA nên làm |
|------|-------------|-------------|
| 200 | OK | Lưu lastSync |
| 400 | Payload sai format | Fix code, KHÔNG retry |
| 401 | Signature sai | Check SECRET env, KHÔNG retry |
| 429 | Rate limit | Retry sau 60s |
| 500, 502, 503 | Bot server lỗi | Retry 3 lần với exponential backoff (1s, 5s, 30s) |

### 6. Payload size
- Bot accept body tới 10MB (giới hạn từ express.json)
- 100 hotels đầy đủ ~~500KB — OK
- Nếu > 1000 hotels, batch thành nhiều request 100/batch

### 7. Network
- Bot endpoint public tại `https://app.sondervn.com` (Cloudflare) — có SSL
- OTA có thể push từ bất kỳ IP nào (không có IP whitelist, dựa vào HMAC)

---

## ✅ Checklist trước khi deploy production

- [ ] `OTA_BOT_PUSH_SECRET` đã lưu trong env OTA (secret manager / vault)
- [ ] `buildHotelPayload` mapping đúng schema OTA thực (KHÔNG copy paste code mẫu)
- [ ] Test local: push 1 hotel → verify trên bot dashboard
- [ ] Test batch: `syncAllHotels()` với 5-10 hotels
- [ ] Cron đã add vào production deploy (PM2 / K8s / Docker)
- [ ] Realtime trigger (nếu có) đã wire vào admin edit endpoint
- [ ] Logging: audit `bot_push_audit` table để trace errors
- [ ] Alert: Telegram/Slack khi push fail liên tục
- [ ] Document cho team OTA: "khi edit hotel, data tự push sang bot"

---

## 🚀 Rollout plan (đề xuất)

### Tuần 1 — Setup + test
- Ngày 1-2: PHASE 1 + 2 (phân tích + thiết kế delta)
- Ngày 3-4: PHASE 3 (code push service)
- Ngày 5: PHASE 5 (test local + staging)

### Tuần 2 — Production rollout
- Ngày 1: Deploy code production, cron tạm tắt
- Ngày 2: Bật cron với interval 60 phút (an toàn)
- Ngày 3-5: Monitor logs, tune nếu có issue
- Ngày 6-7: Giảm interval xuống 30 phút

### Tuần 3 — Optimize
- Thêm realtime trigger (Option B/C) cho hotels hay thay đổi
- Add alerting
- Document cho team OTA

---

## 📞 Support

Khi gặp vấn đề:

1. **Ping endpoint trả 404/500**: liên hệ bot team, check `pm2 logs vp-mkt | grep ota-push`
2. **401 signature mismatch**: check `OTA_BOT_PUSH_SECRET` trùng secret bot → vào dashboard bot tab "OTA DB" → "🔑 Shared Secret" kiểm tra masked có trùng 4 chars cuối của OTA secret không
3. **400 bad payload**: paste payload + error vào ticket → bot team xem lại validation
4. **Bot không thấy data sau push**: check `"action": "skipped"` trong response — nghĩa là `manual_override=1` → admin bot đã edit → cần tắt override qua UI
5. **manual_override muốn tắt**: admin vào dashboard bot → tab "Khách sạn" → click hotel → uncheck **"Manual override (ETL không ghi đè)"**

---

## 📚 Tài liệu tham khảo

- Bot side: `docs/OTA-PUSH-API-SPEC.md` (chi tiết endpoint spec)
- Bot source code: https://github.com/vuotquathuthach209-alt/vp-marketing (repo marketing bot)
- Dashboard admin: https://app.sondervn.com
- Endpoint base: `https://app.sondervn.com/api/ota/push`

---

## 🎓 Summary cho bạn (OTA AI)

**Nhiệm vụ tóm tắt**:
1. Phân tích codebase OTA (language, DB, schema)
2. Viết `src/services/bot-push.ts` với 3 functions: `pushHotel`, `syncAllHotels`, `deleteHotel`
3. Map schema OTA → payload bot format (xem phần "Payload schema" + 2 ví dụ apartment/hotel)
4. Wire cron 30p + realtime trigger vào code hiện có
5. Test với `/ping` endpoint trước → push 1 hotel → batch sync
6. Deploy production, monitor logs

**Output mong đợi**:
- 1 PR / commit vào OTA codebase
- Env var `OTA_BOT_PUSH_SECRET` set trên production
- Cron đang chạy, mỗi 30 phút push delta
- Khi admin edit hotel trong OTA admin panel → bot tự nhận update trong vài giây

**Thời gian ước tính**: 6-8 giờ công của 1 senior backend developer (hoặc 4-6h với AI pair programming).

**Ngân sách**: $0 — hoàn toàn dùng infra sẵn có 2 bên.

---

_Document này do AI bên bot (session trước) soạn gửi cho AI bên OTA (session của bạn). Nếu có thắc mắc về spec → xem `docs/OTA-PUSH-API-SPEC.md` trong bot repo. Nếu có thắc mắc về business logic → hỏi user trực tiếp._

_Chúc bạn code thuận lợi! 🚀_

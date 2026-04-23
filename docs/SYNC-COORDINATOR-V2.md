# Sync Coordinator v2 — OTA ↔ Bot MKT Integration Guide

> **Audience:** OTA team (103.153.73.97) + Bot MKT team (103.82.193.74)
> **Goal:** Đồng bộ 2 chiều data giữa OTA PMS và Bot MKT để bot có thông tin chính xác khi tư vấn khách.

---

## 🎯 Tại sao cần sync 2 chiều?

**Ngày thường:**
- Bot chốt booking với khách qua Zalo → OTA PMS PHẢI biết (để kênh khác không over-sell)
- OTA có booking từ Booking.com → Bot PHẢI biết (để trả lời khách "còn phòng không" chính xác)

**Kết quả khi sync tốt:**
- Bot không bao giờ nói "còn phòng" khi OTA đã bán hết
- Staff không cần copy-paste manual giữa 2 hệ thống
- Customer support có full 360° view: inquiry qua chat + booking từ OTA

---

## 🏛️ Kiến trúc tổng quan

```
┌──────────────────────┐                          ┌──────────────────────┐
│   OTA System         │                          │   Bot MKT System     │
│   103.153.73.97      │                          │   103.82.193.74      │
│                      │                          │                      │
│  • MySQL PMS DB      │                          │  • SQLite            │
│  • HTTP API          │                          │  • Node.js + Express │
│  • Ownership: OTA    │                          │  • Ownership: MKT    │
└──────────┬───────────┘                          └──────────┬───────────┘
           │                                                 │
           │                                                 │
  ┌────────▼──────────────────────────────────────────────────▼────────┐
  │                    SYNC COORDINATOR v2                             │
  │                                                                    │
  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌───────────┐  │
  │  │ Pull Layer  │  │ Push Layer  │  │ Webhook In  │  │ Conflict  │  │
  │  │ (OTA → MKT) │  │ (MKT → OTA) │  │ (OTA → MKT) │  │ Resolver  │  │
  │  │             │  │             │  │             │  │           │  │
  │  │ cron every  │  │ outbox      │  │ real-time   │  │ rule-based│  │
  │  │ 1-6h        │  │ worker 30s  │  │ HMAC POST   │  │ merge     │  │
  │  └─────────────┘  └─────────────┘  └─────────────┘  └───────────┘  │
  └──────────────────────────────────────────────────────────────────┘
                              │
                              ▼
  ┌──────────────────────────────────────────────────────────────────┐
  │                 CANONICAL SCHEMA (Bot-friendly)                  │
  │                                                                  │
  │  sync_bookings    ← all bookings, no matter source               │
  │  sync_availability ← inventory per date × room_type              │
  │  sync_outbox      ← pending ops MKT→OTA with retry/DLQ           │
  │  sync_events_log  ← audit log all inbound/outbound               │
  │  sync_conflicts   ← manual review when auto-merge fails          │
  │  sync_webhook_inbound ← dedup + audit incoming events            │
  └──────────────────────────────────────────────────────────────────┘
```

---

## 📋 Canonical Schema — tại sao MKT dùng riêng

MKT KHÔNG phụ thuộc trực tiếp vào schema OTA. Lý do:

1. **OTA là production, không được ghi** — MKT chỉ SELECT
2. **Bot cần fields không có trong OTA**: `sender_id`, `bot_intent`, `chat_summary`, `persona_tier`
3. **Hot path query tốc độ** — SQLite local + indexes tối ưu cho bot search

### Mapping key fields

| Canonical (Bot MKT)         | OTA source                | Notes |
|-----------------------------|---------------------------|-------|
| `ota_hotel_id` (INT, PK)    | `hotels.id`               | Stable identifier across sync |
| `name_canonical` (TEXT)     | `hotels.name`             | Cleaned / normalized |
| `name_variants[]` (JSON)    | computed                  | Aliases cho fuzzy search |
| `location.city_norm`        | `hotels.city` → normalize | "Ho Chi Minh" (no diacritics lowercase) |
| `location.district_norm`    | `hotels.district` → normalize | "tan binh" |
| `location.landmarks_nearby[]` | extracted from address   | ["sân bay TSN", "chợ Bến Thành"] |
| `location.location_keywords[]` | computed aliases       | ["q1", "quận 1", "quan 1", "district 1"] |
| `room_type_code` (TEXT)     | slugify(`room_type_name`) | "standard", "deluxe", "family" |
| `property_type` (enum)      | `hotels.property_type`    | hotel/homestay/apartment/villa/... |
| `ai_summary_vi`             | generated                 | Bot-ready 2-3 sentence overview |
| `usp_top3[]`                | generated                 | Top 3 selling points |
| `pms_booking_id`            | OTA PMS id                | Link to PMS record |

### Location hierarchy (user-requested emphasis)

MKT giữ **multi-level location** để bot tư vấn chi tiết hơn:

```json
{
  "location": {
    "city": "Ho Chi Minh",
    "city_norm": "ho chi minh",
    "district": "Tân Bình",
    "district_norm": "tan binh",
    "ward": "Phường 2",
    "ward_norm": "phuong 2",
    "address": "123 Hoàng Hoa Thám, P.2, Q.Tân Bình",
    "latitude": 10.8015,
    "longitude": 106.6507,
    "landmarks_nearby": [
      "sân bay Tân Sơn Nhất",
      "bến xe Miền Đông"
    ],
    "location_keywords": [
      "tan binh", "q.tb", "qtb", "quận tân bình",
      "san bay tan son nhat", "tsn", "airport"
    ]
  }
}
```

**Khi khách hỏi** `"có chỗ gần sân bay không"` → bot search:
1. Parse "sân bay" → match vào `location_keywords` của hotels có landmark "sân bay Tân Sơn Nhất"
2. Sort theo distance (lat/lng nếu có)
3. Trả về: *"Dạ Sonder có 2 chỗ gần sân bay TSN — Sonder Airport (3 phút taxi) và Sonder Trường Sơn (5 phút taxi). Anh/chị muốn em tư vấn chỗ nào ạ?"*

Bot KHÔNG thể làm được điều này nếu chỉ có `hotels.city = "Ho Chi Minh"` flat.

---

## 🔄 Flow 1: Bot bán phòng → OTA biết

### Từ phía Bot MKT (đã implement)

```javascript
// src/services/sync-hub.ts
confirmBooking(bookingId) {
  // 1. Update status + decrement availability
  db.update('sync_bookings SET status = confirmed, deposit_paid = 1 ...')

  // 2. Auto-enqueue outbox push
  enqueueOutbox({
    op_type: 'push_booking',
    hotel_id: booking.hotel_id,
    aggregate_id: bookingId,
    payload: canonicalBookingToOtaPayload(booking),
    idempotency_key: `mkt_booking_${bookingId}_v1`,  // deterministic
  });
}
```

### Từ phía OTA (OTA team cần implement)

**Endpoint:** `POST /api/pms/bookings`

**Headers từ Bot MKT:**
```
Content-Type: application/json
X-Idempotency-Key: mkt_booking_123_v1       # Nếu key trùng → trả về booking cũ, KHÔNG tạo mới
X-Signature: sha256=<hmac_sha256(body, shared_secret)>
User-Agent: vp-marketing-outbox/1.0
```

**Body (từ `mapCanonicalBookingToOtaPayload`):**
```json
{
  "hotel_id": 42,
  "room_type_code": "deluxe",
  "checkin_date": "2026-05-25",
  "checkout_date": "2026-05-27",
  "nights": 2,
  "guests": 2,
  "guests_adults": 2,
  "guests_children": 0,
  "total_price": 1500000,
  "deposit_amount": 500000,
  "deposit_paid": true,
  "guest_name": "Nguyễn Văn A",
  "guest_phone": "0901234567",
  "source": "bot",
  "channel_ref": "zalo:3000123456",
  "mkt_booking_id": 123,
  "status": "confirmed",
  "notes": "Khách yêu cầu check-in sớm 12h"
}
```

**OTA cần:**
1. Verify `X-Signature` bằng shared secret
2. Check `X-Idempotency-Key` — nếu đã xử lý → trả response cũ
3. INSERT vào OTA bookings table (source='bot')
4. Trả response:

```json
{
  "ok": true,
  "ota_booking_id": "PMS-2026-0042-A1B2C3",
  "booking_code": "SON20260525XXX",
  "status": "confirmed"
}
```

5. Nếu fail (VD phòng đã bán hết từ channel khác) → HTTP 409 Conflict + body:
```json
{
  "ok": false,
  "error": "overbooking",
  "message": "Room deluxe đã bán hết cho 25/5",
  "retry_after_seconds": null
}
```
Bot sẽ DLQ sau 5 lần retry → staff alert Telegram.

### Retry schedule (exponential backoff)

| Attempt | Delay | Cumulative |
|---------|-------|-----------|
| 1 | 10s | 10s |
| 2 | 30s | 40s |
| 3 | 2 min | 2m 40s |
| 4 | 10 min | 12m 40s |
| 5 | 1h | 1h 13m |
| Fail → DLQ | — | Telegram alert |

---

## 🔄 Flow 2: OTA có booking từ Booking.com/Agoda → Bot biết

### Từ phía OTA (OTA team cần implement)

Khi OTA có sự kiện mới (booking created/cancelled, payment confirmed, stop-sell), gọi webhook:

**Endpoint:** `POST https://mkt.sondervn.com/api/sync/webhook/:event`

`:event` ∈ `booking`, `availability`, `payment`, `stop-sell`

**Headers:**
```
Content-Type: application/json
X-Signature: sha256=<hmac_sha256(body, webhook_secret)>
```

**Body schema:**
```json
{
  "event_id": "evt_550e8400-e29b-41d4-a716-446655440000",
  "event_type": "booking_created",
  "source": "booking.com",
  "hotel_id": 42,
  "timestamp": 1713985200000,
  "data": {
    "ota_booking_id": "BDC-XYZ789",
    "room_type_code": "deluxe",
    "checkin_date": "2026-05-25",
    "checkout_date": "2026-05-27",
    "nights": 2,
    "guests": 2,
    "total_price": 1650000,
    "guest_name": "John Doe",
    "guest_phone": "+84912345678",
    "channel": "booking.com"
  }
}
```

### Supported `event_type`

| Event | Bot side action |
|-------|-----------------|
| `booking_created` | INSERT sync_bookings + decrement availability |
| `booking_cancelled` | UPDATE status=cancelled + restore availability |
| `booking_updated` | Merge with conflict resolver (ota wins for inventory) |
| `payment_confirmed` | Set deposit_paid=1, status hold→confirmed |
| `availability_changed` | UPSERT sync_availability |
| `stop_sell` | Set stop_sell=1 cho date range |

### Response from bot

**Success (200):**
```json
{ "ok": true, "inbound_id": 789, "applied": { "result": "created", "booking_id": 456 } }
```

**Duplicate (200, deduped):**
```json
{ "ok": true, "deduped": true, "inbound_id": 789 }
```

**Bad signature (401):**
```json
{ "ok": false, "error": "invalid_signature" }
```

**Processing error (500):**
```json
{ "ok": false, "inbound_id": 789, "error": "upsert availability fail: ..." }
```

OTA team CAN retry nếu gặp 5xx. Nếu 401/400 thì PHẢI fix rồi mới retry.

---

## 🛡️ Conflict Resolution Rules

Khi cùng 1 booking được update từ cả 2 phía:

| Field | Rule | Lý do |
|-------|------|-------|
| `available_rooms` / `total_rooms` / `stop_sell` | **OTA wins** | OTA thấy all channels, có full picture |
| `base_price` / `monthly_price_from` | **OTA wins** | OTA là source of truth pricing |
| `sender_id` / `chat_summary` / `bot_intent` | **MKT wins** | Chỉ bot có chat context |
| `guest_phone` / `guest_name` | **Richer wins** | Field dài hơn/đầy đủ hơn wins |
| `cancelled_at` | **First-cancel wins** | Cancel là terminal, không undo |
| Other fields | **Last-write-wins** (by timestamp) | Generic rule |
| Timestamp tie | **Manual resolution** | Log vào `sync_conflicts`, admin review |

Tất cả conflicts log vào `sync_conflicts` table. Admin review tại:
```
GET /api/sync/conflicts
POST /api/sync/conflicts/:id/resolve  { winner: 'mkt' | 'ota' }
```

---

## 🔐 Authentication setup (1 lần duy nhất)

### Step 1: Provision shared secret cho webhook

Bot MKT admin chạy:

```bash
# SSH vào VPS bot
ssh root@103.82.193.74
cd /opt/vp-marketing

# Generate + lưu secret cho webhook (OTA → bot)
node -e "
const crypto = require('crypto');
const secret = crypto.randomBytes(32).toString('hex');
const { setSetting } = require('./dist/db');
setSetting('ota_webhook_secret', secret);
console.log('SAVED webhook secret:', secret);
"
```

Lưu secret này, **gửi kín** cho OTA team.

### Step 2: Provision secret cho outbox push (bot → OTA)

OTA team tạo HMAC secret bên OTA, rồi bot lưu:

```bash
# Bot admin chạy
node -e "
const { setSetting } = require('./dist/db');
setSetting('ota_pms_api_base', 'https://103.153.73.97');
setSetting('ota_pms_api_secret', 'SECRET_FROM_OTA_TEAM');
console.log('SAVED OTA PMS API config');
"
```

### Step 3: Verify connectivity

```bash
curl -X POST https://mkt.sondervn.com/api/sync/outbox/process \
  -H 'Cookie: auth=<admin-jwt>'

# Response: { "processed": 0, "succeeded": 0, "failed": 0, "moved_to_dlq": 0 }
```

---

## 📊 Monitoring

### Admin dashboard endpoint

**`GET /api/sync/status`** (auth required)

```json
{
  "outbox": {
    "pending": 2,
    "in_flight": 0,
    "pushed_24h": 47,
    "failed": 1,
    "dlq": 0,
    "oldest_pending_age_sec": 8,
    "push_success_rate_24h": 0.979
  },
  "last_pulls": [
    { "event_type": "ota_sync_hotels", "last_at": 1713999999000 },
    { "event_type": "ota_sync_bookings", "last_at": 1714003599000 }
  ],
  "webhooks_24h": [
    { "event_type": "booking_created", "total": 12, "processed": 12, "errors": 0 },
    { "event_type": "availability_changed", "total": 340, "processed": 340, "errors": 0 }
  ],
  "pending_conflicts": 0,
  "bot_bookings_awaiting_push": 0
}
```

### Telegram alerts (auto)

- DLQ item xuất hiện → 🚨 notification
- Pending bookings awaiting push > 10 → ⚠️ notification
- Push success rate < 90% trong 1h → ⚠️ notification
- Webhook xử lý error > 5% trong 1h → ⚠️ notification

### Admin actions

```bash
# Force outbox process (không chờ cron)
POST /api/sync/outbox/process

# View DLQ
GET /api/sync/dlq

# Retry DLQ item
POST /api/sync/dlq/:id/retry

# Resolve manual conflict
POST /api/sync/conflicts/:id/resolve  { "winner": "mkt" | "ota" }
```

---

## 🧪 Testing checklist

OTA team + MKT team cùng verify:

- [ ] MKT gọi POST /api/pms/bookings với valid HMAC → OTA trả 200 + ota_booking_id
- [ ] MKT gọi lại với cùng idempotency_key → OTA trả same response, KHÔNG tạo duplicate
- [ ] MKT gọi với bad HMAC → OTA trả 401
- [ ] OTA gọi POST /api/sync/webhook/booking với valid → MKT trả 200 + applied
- [ ] OTA gọi lại với cùng event_id → MKT trả deduped:true
- [ ] OTA gọi với bad HMAC → MKT trả 401
- [ ] Simulate OTA down → MKT outbox retry 5 lần → DLQ + Telegram alert
- [ ] Simulate MKT down → OTA lưu webhook, retry khi MKT up lại
- [ ] Conflict scenario: cả 2 bên cùng update booking → log vào sync_conflicts

---

## 🚀 Rollout plan

**Phase 1 (hôm nay — v24):** Infrastructure ready
- ✅ sync_outbox table + worker (30s cron)
- ✅ Webhook receiver endpoints
- ✅ Conflict resolver
- ✅ Canonical mapper với hotel_id + location hierarchy
- ✅ Dashboard API
- ⏳ Chưa có: OTA HTTP endpoints (cần OTA team build)

**Phase 2 (sprint 2 — cần OTA team):**
- [ ] OTA implement POST /api/pms/bookings (idempotent)
- [ ] OTA implement webhook call-out khi booking từ Booking.com
- [ ] Shared secret exchange giữa 2 teams
- [ ] End-to-end test với real booking

**Phase 3 (sprint 3 — polish):**
- [ ] Admin UI widget trong sidebar "Sync Status" (Nâng cao group)
- [ ] Auto-reconciliation: daily cron compare OTA bookings vs MKT sync_bookings, alert diff
- [ ] Bulk historical import OTA → MKT
- [ ] Webhook signature rotation mechanism

---

## 🆘 Troubleshooting

| Symptom | Check | Fix |
|---------|-------|-----|
| Outbox full of "pending" | `ota_pms_api_base` setting empty | `setSetting('ota_pms_api_base', ...)` |
| All pushes fail 401 | Wrong secret | Re-exchange với OTA team |
| Webhooks all 401 | `ota_webhook_secret` missing | Provision + share with OTA |
| Duplicate bookings in OTA | OTA không honor X-Idempotency-Key | OTA team fix upsert logic |
| Bot says "còn phòng" khi OTA đã full | `availability_changed` webhook không đến | OTA team check outbound webhook |
| Conflict manual_pending | Timestamp tie | Admin click resolve với judgment |

---

## 📞 Support

- **MKT side issues:** `mkt@sondervn.com`
- **OTA side issues:** OTA team lead
- **Emergency (sync stuck):** Telegram @sonder_staff

---

**Bản cập nhật:** v24 / 2026-04-23
**Author:** VP Marketing Team

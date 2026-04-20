# Đề xuất: Endpoint đồng bộ dữ liệu cho Bot Marketing

> **Người gửi**: Team VP Marketing Bot
> **Người nhận**: Team OTA (Sonder Platform)
> **Ngày**: 20/04/2026
> **Loại**: Technical Proposal — Yêu cầu build 1 API endpoint mới
> **Mức độ ưu tiên**: Trung bình (không blocker, hiện scraper HTML đang work — nhưng không bền vững khi scale)

---

## 1. Tóm tắt (Executive Summary)

Chúng tôi đang vận hành **chatbot marketing** trên fanpage Facebook của các khách sạn trong hệ thống Sonder. Bot cần **dữ liệu chính xác, cập nhật** từ DB OTA để tư vấn khách hàng đúng sản phẩm (căn hộ dịch vụ thuê tháng vs khách sạn/homestay thuê đêm).

Hiện tại bot đang phải **scrape HTML** từ `sondervn.com/homestay` và `/khach-san` để lấy full data (monthly pricing, includedServices, minStay, deposit...). **Giải pháp này KHÔNG bền vững** khi hệ thống đạt vài trăm khách sạn.

**Đề xuất**: OTA team bổ sung **1 endpoint API dedicated** cho bot đồng bộ dữ liệu: `GET /api/hotels/sync`.

**Effort ước tính**: 2-4 giờ công của 1 backend engineer.
**Giá trị**: Bot scale đến 10,000 hotels, data chuẩn, không lệ thuộc HTML structure.

---

## 2. Bối cảnh & vấn đề hiện tại

### 2.1 Endpoint `/api/hotels` hiện có — không đủ cho bot

Hiện API public chỉ trả fields cơ bản:

```json
{
  "id": "6",
  "name": "Sonder Airport",
  "propertyType": "apartment",
  "minPrice": "450000",        // ← ONLY 1 price, không rõ unit
  "city": "Ho Chi Minh",
  "address": "...",
  "amenities": ["wifi", "parking", ...]
}
```

**Missing fields bot cần:**
- `monthlyPriceFrom` / `monthlyPriceTo` (cho apartment thuê tháng)
- `minStayMonths`, `depositMonths`
- `fullKitchen`, `washingMachine`, `utilitiesIncluded`, `acceptsSonderEscrow`
- `productGroup` (phân biệt thuê tháng vs thuê đêm)
- `updatedAt` (cho incremental sync)

### 2.2 Workaround hiện tại — scrape Next.js SSR

Bot hiện đang parse HTML `/homestay` và `/khach-san`, extract JSON từ Next.js RSC payload:

```typescript
// Fetch /homestay → parse "initialApartments":[{...}]
// Fetch /khach-san → parse "initialHotels":[{...}]
```

Dữ liệu này **đầy đủ** (web SSR query trực tiếp DB với full fields) nhưng:

| Rủi ro | Chi tiết |
|--------|----------|
| 🔴 **Fragile** | Web đổi UI/Next.js version → regex parsing break |
| 🟡 **Slow at scale** | 1000 hotels = 50 pages scrape × 3 runs/tuần = 150 req/tuần |
| 🟡 **No incremental** | Mỗi lần sync phải fetch lại tất cả — không biết hotel nào đã đổi |
| 🟢 **Không đụng OTA DB** | HTTP GET read-only |

### 2.3 Roadmap scale

| # hotels | Scraper HTML | Cần endpoint? |
|----------|--------------|---------------|
| **2-100** (now) | ✅ OK | Không |
| **100-500** | ✅ Pagination added | Không (chưa cấp bách) |
| **500-1000** | ⚠️ 50 pages/sync | Nên có |
| **1000-5000** | ❌ Quá chậm, có thể bị Cloudflare block | **Bắt buộc** |
| **5000+** | ❌ Không khả thi | **Bắt buộc + DB replica** |

---

## 3. Đề xuất — Endpoint `/api/hotels/sync`

### 3.1 URL & Authentication

```
GET /api/hotels/sync
Authorization: Bearer {BOT_API_SECRET}
```

**Auth**: Shared secret header (environment variable trên cả 2 phía). Đơn giản, đủ cho server-to-server.

**Alternative**: IP whitelist (allow từ VPS bot `103.82.193.74`).

### 3.2 Query parameters

| Param | Type | Default | Mô tả |
|-------|------|---------|-------|
| `since` | Unix timestamp | null | Chỉ trả hotels updated từ timestamp này trở đi |
| `page` | integer | 1 | Trang hiện tại (1-indexed) |
| `limit` | integer | 100 | Hotels per page (max 500) |
| `productGroup` | string | all | `long_term_apartment` \| `short_stay` \| null |
| `city` | string | null | Filter theo city |
| `includeDeleted` | boolean | false | Trả về hotels đã soft-delete (để bot biết mà xóa khỏi cache) |

### 3.3 Response schema

```json
{
  "success": true,
  "hotels": [
    {
      "id": "6",
      "name": "Sonder Airport",
      "slug": "sonder-airport",

      // ⭐ Phân loại sản phẩm (quan trọng nhất cho bot)
      "productGroup": "long_term_apartment",
      "propertyType": "apartment",

      // Địa lý
      "city": "Ho Chi Minh",
      "district": "Tan Binh",
      "address": "B12 D. Bach Dang, Phuong 2",
      "latitude": 10.819,
      "longitude": 106.657,
      "phone": "+84 xxx xxx xxx",

      // Thông số hotel
      "starRating": 3,

      // ⭐ Pricing — structured, cover cả monthly + daily + hourly
      "pricing": {
        "monthly": {
          "min": 3600000,
          "max": 3900000,
          "currency": "VND",
          "unit": "/tháng"
        },
        "daily": {
          "min": 450000,
          "max": 550000,
          "currency": "VND",
          "unit": "/đêm",
          "weekdayPrice": 450000,
          "weekendPrice": 550000
        },
        "hourly": null
      },

      // ⭐ Chính sách thuê
      "rentalRules": {
        "minStayMonths": 3,
        "depositMonths": 1,
        "depositText": "1 tháng",
        "checkInTime": "14:00",
        "checkOutTime": "12:00",
        "cancellationPolicy": "Hủy miễn phí trước 7 ngày",
        "selfCheckinEnabled": false
      },

      // ⭐ Dịch vụ bao gồm (quan trọng cho apartment)
      "includedServices": [
        "fullKitchen",
        "washingMachine",
        "utilities",
        "wifi",
        "cleaning"
      ],
      "amenities": [
        "wifi", "parking", "air conditioning",
        "reception 24 hours"
      ],

      // Hình ảnh
      "coverImage": "/uploads/hotels_6_xxx.jpg",
      "images": [
        "/uploads/hotels_6_xxx1.jpg",
        "/uploads/hotels_6_xxx2.jpg"
      ],

      // Business flags
      "isVerified": false,
      "isFeatured": true,
      "acceptsSonderEscrow": true,

      // Reviews
      "reviewAvg": 4.5,
      "reviewCount": 12,

      // ⭐ Timestamps (cho incremental sync)
      "createdAt": "2026-01-15T08:30:00Z",
      "updatedAt": "2026-04-19T14:22:00Z",
      "deletedAt": null,

      // ⭐ Rooms detail (optional, nếu có multiple room types)
      "rooms": [
        {
          "id": "101",
          "name": "Studio 1 PN",
          "maxGuests": 2,
          "bedType": "Queen",
          "sizeM2": 28,
          "monthlyPrice": 3600000,
          "dailyPrice": null,
          "amenities": ["balcony", "kitchen"]
        }
      ]
    }
  ],

  // Metadata
  "pagination": {
    "page": 1,
    "limit": 100,
    "total": 2,
    "totalPages": 1,
    "hasMore": false
  },

  "meta": {
    "serverTime": 1745127600,
    "lastUpdate": 1745100000,
    "cacheVersion": "v1.2.3"
  }
}
```

### 3.4 Error handling

```json
{
  "success": false,
  "error": {
    "code": "UNAUTHORIZED",
    "message": "Invalid or missing bot token"
  }
}
```

**Status codes**:
- `200` — OK
- `401` — Auth fail
- `429` — Rate limit
- `500` — Server error

### 3.5 Rate limit

**Suggest**: 60 requests/phút/token (thừa cho bot sync 3 lần/tuần).

---

## 4. Use cases chính

### Use case 1: Full sync (lần đầu hoặc rebuild)

```
GET /api/hotels/sync?page=1&limit=500
→ Trả full 500 hotels page 1
→ Bot fetch tiếp page 2, 3...
```

### Use case 2: Incremental sync (hàng ngày)

```
# Bot lưu lastSyncAt = 1745000000 trong DB
GET /api/hotels/sync?since=1745000000
→ Chỉ trả hotels có updatedAt > since
→ Bot update cache → lastSyncAt = response.meta.serverTime
```

### Use case 3: Filter theo nhóm sản phẩm

```
GET /api/hotels/sync?productGroup=long_term_apartment&city=Ho-Chi-Minh
→ Trả apartments thuê tháng tại HCM
```

### Use case 4: Detect hotel deleted

```
GET /api/hotels/sync?since=X&includeDeleted=true
→ Bot biết hotel nào đã xóa để remove khỏi bot knowledge
```

---

## 5. So sánh trước/sau

| Tiêu chí | Scraper HTML (hiện tại) | Endpoint `/sync` (đề xuất) |
|----------|--------------------------|------------------------------|
| **Requests/sync (1000 hotels)** | 100 HTTP GET pages | 2-3 API calls (paginated) |
| **Runtime** | ~100 giây | ~5 giây |
| **Fragility** | HTML cấu trúc đổi → break | JSON schema stable |
| **Incremental** | ❌ Không | ✅ `?since=X` |
| **Auth** | Không (public HTML) | Bearer token |
| **Rate limit** | Phụ thuộc web server | API layer control |
| **Full data** | ⚠️ Fields ẩn trong HTML | ✅ Structured JSON |

---

## 6. Implementation guide cho OTA team

### 6.1 Backend (Next.js / Node.js)

File mới: `pages/api/hotels/sync.ts`

```typescript
import { NextApiRequest, NextApiResponse } from 'next';
import { prisma } from '@/lib/prisma'; // hoặc ORM hiện tại

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  // 1. Auth check
  const auth = req.headers.authorization;
  if (auth !== `Bearer ${process.env.BOT_API_SECRET}`) {
    return res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED' } });
  }

  // 2. Parse query
  const since = req.query.since ? parseInt(req.query.since as string, 10) : null;
  const page = parseInt(req.query.page as string || '1', 10);
  const limit = Math.min(parseInt(req.query.limit as string || '100', 10), 500);
  const productGroup = req.query.productGroup as string | undefined;
  const city = req.query.city as string | undefined;

  // 3. Build WHERE
  const where: any = {};
  if (since) where.updatedAt = { gte: new Date(since * 1000) };
  if (productGroup) where.productGroup = productGroup;
  if (city) where.city = city;

  // 4. Query DB với JOIN đủ fields
  const [hotels, total] = await Promise.all([
    prisma.hotel.findMany({
      where,
      include: {
        rooms: true,
        pricing: true,
        amenities: true,
        rules: true,
      },
      skip: (page - 1) * limit,
      take: limit,
      orderBy: { updatedAt: 'desc' },
    }),
    prisma.hotel.count({ where }),
  ]);

  // 5. Transform to response schema
  const transformed = hotels.map(h => ({
    id: String(h.id),
    name: h.name,
    slug: h.slug,
    productGroup: h.productGroup,
    propertyType: h.propertyType,
    city: h.city,
    district: h.district,
    address: h.address,
    latitude: h.lat,
    longitude: h.lng,
    phone: h.phone,
    starRating: h.starRating,
    pricing: {
      monthly: h.pricing?.monthlyMin ? {
        min: h.pricing.monthlyMin,
        max: h.pricing.monthlyMax,
        currency: 'VND',
        unit: '/tháng',
      } : null,
      daily: h.pricing?.dailyMin ? {
        min: h.pricing.dailyMin,
        max: h.pricing.dailyMax,
        weekdayPrice: h.pricing.weekdayPrice,
        weekendPrice: h.pricing.weekendPrice,
        currency: 'VND',
        unit: '/đêm',
      } : null,
      hourly: null,
    },
    rentalRules: {
      minStayMonths: h.rules?.minStayMonths,
      depositMonths: h.rules?.depositMonths,
      checkInTime: h.rules?.checkInTime,
      checkOutTime: h.rules?.checkOutTime,
      selfCheckinEnabled: h.rules?.selfCheckinEnabled,
    },
    includedServices: h.rules?.includedServices || [],
    amenities: h.amenities?.map(a => a.code) || [],
    coverImage: h.coverImage,
    images: h.images,
    isVerified: h.isVerified,
    isFeatured: h.isFeatured,
    acceptsSonderEscrow: h.acceptsSonderEscrow,
    reviewAvg: h.reviewAvg,
    reviewCount: h.reviewCount,
    createdAt: h.createdAt.toISOString(),
    updatedAt: h.updatedAt.toISOString(),
    deletedAt: h.deletedAt?.toISOString() || null,
    rooms: h.rooms.map(r => ({ ... })),
  }));

  return res.json({
    success: true,
    hotels: transformed,
    pagination: {
      page, limit, total,
      totalPages: Math.ceil(total / limit),
      hasMore: page * limit < total,
    },
    meta: {
      serverTime: Math.floor(Date.now() / 1000),
      lastUpdate: Math.floor((hotels[0]?.updatedAt?.getTime() || Date.now()) / 1000),
    },
  });
}
```

### 6.2 Database schema gợi ý (nếu cần thêm table)

```sql
-- Nếu pricing chưa có bảng riêng
CREATE TABLE hotel_pricing (
  hotel_id INT PRIMARY KEY REFERENCES hotels(id),
  monthly_min INT NULL,
  monthly_max INT NULL,
  daily_min INT NULL,
  daily_max INT NULL,
  weekday_price INT NULL,
  weekend_price INT NULL,
  hourly_price INT NULL,
  currency VARCHAR(3) DEFAULT 'VND',
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE hotel_rules (
  hotel_id INT PRIMARY KEY REFERENCES hotels(id),
  min_stay_months INT NULL,
  deposit_months INT NULL,
  check_in_time VARCHAR(10) DEFAULT '14:00',
  check_out_time VARCHAR(10) DEFAULT '12:00',
  self_checkin_enabled BOOLEAN DEFAULT false,
  included_services JSON NULL,
  cancellation_policy TEXT NULL
);

-- Thêm vào bảng hotels nếu chưa có:
ALTER TABLE hotels
  ADD COLUMN product_group VARCHAR(30) NULL, -- 'long_term_apartment' | 'short_stay'
  ADD COLUMN updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  ADD COLUMN deleted_at TIMESTAMP NULL,
  ADD INDEX idx_updated (updated_at),
  ADD INDEX idx_product_group (product_group),
  ADD INDEX idx_city (city);
```

---

## 7. Test cases (Acceptance criteria)

Team QA của OTA check những case sau:

### 7.1 Functional
- [ ] `GET /api/hotels/sync` với Bearer token đúng → trả 200 + data
- [ ] Token sai → 401
- [ ] `?page=2` → trả đúng trang 2
- [ ] `?since=TIMESTAMP` → chỉ trả hotels có `updatedAt > timestamp`
- [ ] `?productGroup=long_term_apartment` → chỉ trả apartment
- [ ] `?city=Ho Chi Minh` → chỉ trả hotels ở HCM
- [ ] `?limit=500` → max 500 records
- [ ] `?includeDeleted=true` → trả cả soft-deleted với `deletedAt != null`

### 7.2 Data integrity
- [ ] Mỗi hotel có đủ fields theo schema
- [ ] `pricing.monthly` và `pricing.daily` chính xác theo DB
- [ ] `rentalRules.minStayMonths` khớp với data thật (3 cho Sonder Airport)
- [ ] `productGroup` tự derive từ `propertyType` (nếu NULL)
- [ ] `updatedAt` thay đổi khi admin edit hotel

### 7.3 Performance
- [ ] Response time < 2s với 100 hotels
- [ ] Response time < 5s với 500 hotels
- [ ] Index trên `updated_at` + `product_group` + `city`

### 7.4 Security
- [ ] Endpoint KHÔNG accessible without token
- [ ] Token được load từ env var, KHÔNG hardcode
- [ ] Log mọi request (IP, token last 6 chars, params) cho audit

---

## 8. Timeline ước tính

| Task | Effort | Responsible |
|------|--------|-------------|
| DB migration (thêm cols nếu thiếu) | 30 phút | Backend |
| API handler `/api/hotels/sync` | 1.5 giờ | Backend |
| Transform layer (DB → response schema) | 1 giờ | Backend |
| Unit tests + acceptance tests | 1 giờ | QA |
| Deploy staging | 30 phút | DevOps |
| UAT với bot team | 1 giờ | Bot team |
| **TOTAL** | **~5.5 giờ** | |

**Timeline gợi ý**: 1 tuần (nửa ngày work actual + time buffer cho review/QA).

---

## 9. Trách nhiệm đôi bên

### OTA team làm:
- [ ] Build endpoint `/api/hotels/sync` theo spec section 3
- [ ] Generate `BOT_API_SECRET` random string, share qua kênh bảo mật
- [ ] Deploy endpoint lên `sondervn.com` (cùng domain với web)
- [ ] Cung cấp Postman collection để bot team test

### Bot team (VP Marketing) làm:
- [ ] Update `ota-reader.ts` gọi `/api/hotels/sync` thay vì scrape HTML
- [ ] Lưu `BOT_API_SECRET` vào `.env` trên VPS
- [ ] Implement incremental sync với `lastSyncAt`
- [ ] Verify data accuracy với Sonder Airport + Seehome Airport

---

## 10. Backward compatibility

**Endpoint hiện tại `/api/hotels` GIỮ NGUYÊN** — phục vụ web public.
Endpoint mới `/api/hotels/sync` là **internal** chỉ cho bot/PMS.

Bot sẽ switch sang endpoint mới khi OTA team deploy. **Không ảnh hưởng** user end-users hoặc web hiện tại.

---

## 11. Q&A dự kiến

**Q: Có phải build hoàn toàn mới không?**
A: Nếu DB đã có fields (monthlyPrice, minStay...), chỉ cần endpoint transform. Nếu chưa có, cần migration nhỏ (section 6.2).

**Q: Có cần thay đổi frontend web không?**
A: Không. Web vẫn dùng `/api/hotels` như hiện tại.

**Q: Auth như thế nào?**
A: Simple Bearer token (shared secret). Bot team giữ token trong env var. Rotate định kỳ.

**Q: Khi nào deploy?**
A: Không cấp bách. Khi Sonder đạt ~500 hotels. Hiện tại scraper vẫn work.

**Q: Có thể dùng endpoint này cho PMS (property management system) không?**
A: Có! Schema thiết kế để reuse cho cả bot + PMS + mobile app.

---

## 12. Liên hệ

**Bot team — VP Marketing**:
- Tech lead: [bạn]
- Email: admin@sondervn.com
- Dashboard: https://app.sondervn.com

**Sau khi OTA team review**:
- Báo lại nếu có question về schema hoặc use case
- Confirm timeline
- Setup kickoff meeting nếu cần

---

## Phụ lục A — Sample request/response cURL

```bash
# Test với token (sau khi có BOT_API_SECRET)
curl -H "Authorization: Bearer your_secret_here" \
  "https://sondervn.com/api/hotels/sync?page=1&limit=10"

# Incremental sync
curl -H "Authorization: Bearer your_secret_here" \
  "https://sondervn.com/api/hotels/sync?since=1745000000&productGroup=long_term_apartment"
```

## Phụ lục B — Links tham khảo

- [Next.js API Routes docs](https://nextjs.org/docs/api-routes/introduction)
- [Prisma pagination](https://www.prisma.io/docs/concepts/components/prisma-client/pagination)
- [JWT vs Bearer token best practices](https://oauth.net/2/bearer-tokens/)

---

**End of proposal** — Cảm ơn OTA team đã xem! Nếu có câu hỏi, reply thread này.

# Cross-Post FB → IG + Zalo OA — Setup Guide

> v24 • Auto fan-out mỗi bài FB published → IG (@sonder_haven) + Zalo OA broadcast

## ✅ Đã implement (code-side)

- `src/services/cross-post-sync.ts` — service chính, fan-out + log
- Hooks vào 4 FB publish points: `scheduler`, `campaigns`, `posts`, `news-publisher`
- Admin endpoints: `/api/posts/:id/cross-post`, `/api/posts/cross-post/stats`
- Idempotency via `cross_post_log` table
- Image URL auto-resolve từ FB CDN (globally reachable)

## ⚠️ Chặn hiện tại (external dependencies)

### 1. Instagram — Meta App Review required

**Error hiện tại**:
```
(#10) Requires instagram_content_publish permission to manage the object
```

**Why**: FB Developer App chưa được Meta duyệt permission `instagram_content_publish`.

**2 cách fix** (chọn 1):

**A. App Review (cho production)** — takes 3-7 business days:
1. Vào https://developers.facebook.com/apps → chọn app của Sonder
2. **App Review** → **Permissions and Features**
3. Request:
   - ✅ `instagram_basic`
   - ✅ `instagram_content_publish` ← quan trọng nhất
   - ✅ `pages_read_engagement`
   - ✅ `pages_show_list`
4. Cho mỗi permission: điền use case description (mẫu ở `docs/IG-SETUP-GUIDE.md` Part C.1) + record screen video + sample data
5. Submit & wait 3-7 ngày

**B. Development Mode (cho test ngay)** — chỉ limited users:
1. Vào app settings → **Roles**
2. Thêm user owning IG @sonder_haven vào Administrators hoặc Developers
3. User đó đã có quyền publish IG qua API (không cần review)
4. Limitation: chỉ các admin/dev của app publish được, không phải public

### 2. Zalo OA — broader scope needed for broadcast

**Error hiện tại**:
```
Zalo upload -216: Access token is invalid
```

**Why**: Token hiện tại có scope `oa.provide_service` (chat 1-1 với customer) nhưng THIẾU scope cho broadcast/article API.

**Note**: Bot chat đang hoạt động bình thường (242 messages logged, 61 senders) — token cho chat OK. Vấn đề CHỈ là broadcast API.

**Cách fix**:
1. OA cần là **Verified Business** (có đăng ký giấy phép kinh doanh với Zalo)
   - Vào https://oa.zalo.me → Quản lý OA → **Xác minh doanh nghiệp**
   - Upload giấy phép kinh doanh
   - Đợi Zalo duyệt (~1-3 ngày)
2. Sau khi verified, re-authorize OA với scope broader:
   - https://developers.zalo.me → Your App → Permission
   - Request scope `oa.broadcast` hoặc `oa.article`
3. Re-run OAuth flow → nhận token mới với broader scope

**Alternative workaround**: Thay vì broadcast, dùng `zaloSendText` send cho TỪNG follower trong inbox của họ. Nhược: tốn quota + khách có thể đánh dấu spam.

---

## Cách test khi đã có permissions

### Trigger cross-post cho 1 post đã publish

```bash
# Từ VPS
curl -b cookie.txt -X POST https://mkt.sondervn.com/api/posts/9/cross-post

# Response expected:
{
  "fb_post_id": "892083053979896_122126476131105277",
  "ig": { "attempted": 1, "success": 1, "errors": [] },
  "zalo": { "attempted": 1, "success": 1, "errors": [] }
}
```

### Xem log cross-post

```bash
curl -b cookie.txt https://mkt.sondervn.com/api/posts/9/cross-post-log

# Response:
{
  "items": [
    {
      "platform": "instagram",
      "result": "success",
      "external_id": "18012345678901234",
      "created_at": 1713985200000
    }
  ]
}
```

### Stats dashboard

```bash
curl -b cookie.txt 'https://mkt.sondervn.com/api/posts/cross-post/stats?days=7'

# Response:
{
  "days": 7,
  "stats": {
    "instagram": { "success": 3, "failed": 1, "skipped": 0 },
    "zalo_oa": { "success": 2, "failed": 2, "skipped": 0 }
  }
}
```

---

## Auto-post flow khi đã unblock

Khi cả IG App Review + Zalo Verified Business xong, mỗi FB publish → 10s sau:

```
1. FB post đăng thành công           (posts.status='published')
2. scheduler/campaigns/posts route hook → crossPostFromPostId(id)
3. Fetch image URL từ FB CDN         (graph.facebook.com/:id?fields=full_picture)
4. Parallel:
   a. Publish IG (@sonder_haven)     → ig_media_id saved
   b. Publish Zalo OA broadcast      → zalo_article_id saved
5. Log vào cross_post_log            (idempotency + audit)
6. Nếu fail → logged, KHÔNG retry tự động (user trigger manual via admin)
```

Cross-post NON-BLOCKING: nếu IG fail, Zalo vẫn chạy. Nếu cả 2 fail, FB post vẫn thành công.

---

## Monitoring

### Telegram alerts (sẽ add sau)
- DLQ > 0: khi liên tiếp 3 cross-post fail → alert
- Quota warning: khi IG daily rate limit gần đạt 20/25

### Admin UI (roadmap)
- Sidebar "Posts" → detail post → tab "Cross-post history"
- Table view: FB post × platform × status × external_id

---

## FAQ

**Q: Bài text-only không có ảnh thì cross-post thế nào?**
A: IG require image → skip (logged as `no_image_skipped`). Zalo cover cũng cần image → skip tương tự. Chỉ bài có ảnh mới được cross-post đầy đủ.

**Q: Cross-post có delay không?**
A: Non-blocking fire-and-forget. FB publish xong → kick off cross-post ngay (parallel với response tới user). Khoảng 5-15s để IG + Zalo xử lý.

**Q: Nếu cross-post fail, bài FB có bị rollback không?**
A: KHÔNG. FB publish đã thành công là xong. Cross-post fail chỉ log lại, admin có thể retry manual.

**Q: Có quota limit không?**
A:
- IG: 25 posts/24h per business account (Meta limit)
- Zalo OA broadcast: tuỳ Verified Business tier

**Q: Sao không dùng công cụ 3rd-party (Buffer, Hootsuite)?**
A: Tự build để:
- Tiết kiệm $20-50/month subscription
- Control logic (VD: chỉ post IG cho bài có score originality > 0.5)
- Tích hợp sâu với AI remix + share package Telegram

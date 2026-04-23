# 📸 Instagram Setup Guide cho VP MKT Bot

> Bot tự động post bài lên IG cùng với FB mỗi thứ 2 9h VN time.
> Setup 1 lần, dùng mãi.

## 🎯 Tổng quan flow

```
[Sonder content] → [CI weekly]
                    ↓
                   FB Page (existing)
                    ↓ (v21)
                   Instagram Feed ← chúng ta đang setup
                    ↓ (v21)
                   FB Crosspost (page A → page B)
                    ↓
                   Share Package → Telegram (manual groups)
```

---

## ✅ Prerequisites (check trước)

| Requirement | Status check |
|-------------|--------------|
| IG account là **Business** hoặc **Creator** (không phải Personal) | Vào app IG → Settings → Account → Switch to Professional |
| IG account **đã link với FB Page** | Vào Meta Business Suite → Settings → Instagram accounts |
| FB Page có admin access của bạn | Đã có (Sonder đang dùng 2 page) |
| FB Developer App đã có permission `instagram_content_publish`, `pages_read_engagement` | Cần check, xem Part C |

---

## Part A: Kiểm tra nhanh (auto-discovery)

**Method easy nhất** — dùng helper em vừa build:

### Bước 1: Login vào VP MKT admin

```bash
# Browser: https://mkt.sondervn.com → login với admin password
# Cookie `auth` sẽ được set
```

### Bước 2: Gọi `/api/mp/ig/discover`

```bash
curl -b cookie.txt https://mkt.sondervn.com/api/mp/ig/discover
```

**Response sẽ có dạng:**

```json
{
  "discovered": 2,
  "linked_count": 1,
  "already_configured": 0,
  "items": [
    {
      "fb_page_id": 1,
      "fb_page_name": "Sonder Apartment Hotel",
      "linked": true,
      "ig_business_id": "17841400000000000",
      "ig_username": "sondervn",
      "ig_account_type": "BUSINESS",
      "ig_followers": 1234,
      "already_configured": false
    },
    {
      "fb_page_id": 2,
      "fb_page_name": "Nhà Tốt 247",
      "linked": false,
      "error": "No IG Business account linked. Link tại: Meta Business Suite → Settings → Instagram accounts → Add"
    }
  ]
}
```

### Bước 3: Nếu `linked: true` → Connect ngay

```bash
curl -b cookie.txt -X POST https://mkt.sondervn.com/api/mp/ig/connect \
  -H 'Content-Type: application/json' \
  -d '{
    "ig_business_id": "17841400000000000",
    "linked_fb_page_id": 1
  }'
```

**Xong!** Bot sẽ tự động post IG khi CI weekly chạy tiếp theo.

---

## Part B: Nếu chưa có IG Business (bước setup từ đầu)

### B.1. Đổi IG sang Business/Creator account

1. Mở app Instagram trên phone
2. **Profile** → ☰ menu → **Settings and privacy**
3. **Account** → **Account type and tools**
4. Chọn **Switch to professional account**
5. Chọn category: **"Hotel & Lodging"** hoặc "Travel Company"
6. Chọn type: **Business** (recommended — full features) hoặc Creator

### B.2. Link IG với FB Page

#### Cách 1: Qua Meta Business Suite (recommended)

1. https://business.facebook.com → chọn Business Portfolio của bạn
2. **Settings** (⚙) → **Accounts** → **Instagram accounts**
3. **Add** → login IG → chọn FB Page để link
4. Confirm permission

#### Cách 2: Qua app IG

1. App IG → Profile → Edit Profile
2. **Page** field → **Connect or Create Page**
3. Chọn existing FB Page của Sonder

### B.3. Verify link thành công

Sau khi link, gọi lại `/api/mp/ig/discover` — sẽ thấy IG hiện ra.

---

## Part C: Fix permissions nếu `/discover` trả lỗi

### Lỗi thường gặp:

| Error | Nguyên nhân | Fix |
|-------|-------------|-----|
| `(#10) This endpoint requires 'instagram_content_publish' permission` | FB App chưa có permission | App Review (xem C.1) |
| `(#200) If posting to a group, requires ...` | Nhầm endpoint | Không ảnh hưởng — bỏ qua |
| `Invalid OAuth access token` | Token expired/sai | Refresh page token |
| `Page token doesn't have access to Instagram` | IG chưa link hoặc token scope sai | Re-link IG → FB Page (B.2) |

### C.1. App Review cho `instagram_content_publish`

Nếu FB App đang dùng chưa có permission này:

1. https://developers.facebook.com/apps → chọn app của Sonder
2. **App Review** → **Permissions and Features**
3. Request các permissions:
   - ✅ `instagram_basic`
   - ✅ `instagram_content_publish` ← quan trọng nhất
   - ✅ `pages_read_engagement`
   - ✅ `pages_show_list`

**Mỗi permission cần submit:**
- Use case description (em viết sẵn below)
- Screen recording (show bot publish)
- Sample data

**Duyệt thường 3-7 ngày làm việc.**

#### Use case description mẫu (copy dùng):

> **Use case — instagram_content_publish:**
> Chúng tôi là chuỗi khách sạn Sonder Việt Nam. App này (VP Marketing Bot) tự động đăng bài marketing hàng tuần lên Instagram Feed của các khách sạn. Mỗi tuần bot sẽ:
> 1. Đọc bài báo du lịch từ nguồn uy tín (RSS VnExpress, etc.)
> 2. AI tạo nội dung marketing độc đáo (không copy — remix > 50%)
> 3. Gắn ảnh phòng + hashtag Sonder
> 4. Publish cùng thời điểm lên FB Page + IG Feed
> 
> Mục đích: giảm thời gian marketing team, tăng visibility khách sạn.
> Chỉ đăng lên IG accounts mà admin của Sonder sở hữu + đã link với FB Pages.

### C.2. Test mode (không cần App Review)

Nếu app đang ở **Development mode** và IG account là **admin của app**:
- Có thể publish ngay không cần review
- Nhưng chỉ limited tới admins của app
- Dùng để test trước khi production

---

## Part D: Test publish một bài

### D.1. Manual publish test

```bash
# Upload 1 ảnh test lên mkt.sondervn.com trước (hoặc dùng URL công khai)
# Sau đó:
curl -b cookie.txt -X POST https://mkt.sondervn.com/api/mp/ig/publish \
  -H 'Content-Type: application/json' \
  -d '{
    "image_url": "https://mkt.sondervn.com/media/your-image.jpg",
    "caption": "🌿 Sonder Airport — căn hộ dịch vụ gần sân bay Tân Sơn Nhất, view phi trường, giá từ 3.6tr/tháng.\n\nInbox để đặt phòng! #SonderVN #LongStayVN #HomestayVN"
  }'
```

**Response expected:**
```json
{
  "results": [
    {
      "ig_account_id": 1,
      "ig_business_id": "17841400000000000",
      "ok": true,
      "ig_media_id": "18012345678901234"
    }
  ]
}
```

### D.2. Check ảnh đã đăng

1. Vào profile IG của Sonder
2. Ảnh mới nhất phải hiện ra ngay (< 10 giây)

### D.3. Nếu fail

Xem error message trong response. Common fixes:
- **"Image URL must be public"** → đảm bảo URL ảnh accessible (không private)
- **"Invalid image format"** → JPG/PNG/WebP only, không phải SVG/GIF
- **"Image too large"** → < 8MB (v22 đã check pre-upload)
- **"Aspect ratio"** → 4:5 tới 1.91:1 (portrait tới landscape)

---

## Part E: Auto-post flow đã active

Sau khi connect xong, lịch sau:

### Mỗi **thứ 2 lúc 9h sáng VN**:

```
1. CI weekly chọn 1 bài inspiration mới (từ blog RSS)
2. AI remix → Sonder voice content
3. Publish lên FB Page primary (Sonder Apartment Hotel)
4. Publish IG Feed NGAY (với same caption + image)
5. Schedule FB crosspost sang Page 2 (Nhà Tốt 247) — delayed 20 min
6. Tạo Share Package → push Telegram staff để copy-paste vào groups
```

### Telegram sẽ thông báo summary:

```
🤖 CI Auto Weekly Post — Multi-platform
• Hotel: Sonder Apartment
• Inspiration: VnExpress Du lịch
• Originality: 1.0

📊 Published:
  ✅ FB: 892083053979896_XXX
  ✅ IG: 1/1 accounts
  ⏱ FB crosspost: 1 pages (delayed 20min)
  📦 Share package → Telegram (manual groups)

Preview: Anh/chị biết không...
```

---

## Part F: Monitoring sau khi live

### Check status:

```bash
# IG accounts configured
curl -b cookie.txt https://mkt.sondervn.com/api/mp/ig/accounts

# Metrics per post (sau 1 giờ có dữ liệu)
curl -b cookie.txt https://mkt.sondervn.com/api/ops/metrics/post/<post_id>

# Dead letter queue (nếu fail)
curl -b cookie.txt https://mkt.sondervn.com/api/ops/dlq
```

### Dashboard:
- https://mkt.sondervn.com/admin-dashboard.html → xem revenue + audience + metrics

---

## ⚠️ Common issues

### 1. "Invalid OAuth access token"
- Page access_token expired. Re-auth FB Page trong app.
- Hoặc generate long-lived token (60 days): https://developers.facebook.com/tools/explorer

### 2. "account_type=PERSONAL không hỗ trợ publish"
- IG vẫn là Personal account → Part B.1

### 3. Bot không tự post vào thứ 2
- Check pm2 log: `pm2 logs vp-mkt --lines 100 | grep ci-weekly`
- Cron scheduler phải chạy. Check: `systemctl status pm2-root` trên VPS

### 4. Ảnh upload fail
- Image must be public HTTPS URL (không phải localhost)
- Size < 8MB
- Format: JPG/PNG/WebP (không SVG/GIF)

### 5. Caption bị cắt
- Em đã làm UTF-8 safe truncate. Nhưng IG limit 2200 chars. Nếu vượt sẽ bị trunc an toàn (không corrupt emoji).

---

## 🔐 Bảo mật

- **Page access_token** lưu trong DB, chỉ server đọc được.
- Long-lived token auto-refresh (đã có scheduler `autoRefreshPageTokens`)
- v22 đã apply `redactSecrets()` trong tất cả error logs.

---

## 📞 Support

Nếu gặp vấn đề không có trong guide:
1. Check pm2 log: `pm2 logs vp-mkt | grep ig-publisher`
2. Check DLQ: `GET /api/ops/dlq`
3. Test với `POST /api/mp/ig/publish` manual → xem error message cụ thể.

Happy publishing! 📸

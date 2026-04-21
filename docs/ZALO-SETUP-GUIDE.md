# Zalo OA Setup Guide — Kết nối bot vào Zalo Official Account

> **Kết quả**: sau khi setup, khách nhắn Zalo OA của Sonder → bot tự động trả lời (giống bot Facebook).
>
> **Thời gian**: ~20-30 phút lần đầu, 5 phút các lần sau cho hotel mới.
>
> **Chi phí**: Free nếu OA có <300 fans. Ngoài ra 99k/tháng (Zalo charge).

---

## 📋 Chuẩn bị trước

Bạn cần:
- [ ] Zalo account (cá nhân) — dùng để login dev console
- [ ] Chủ sở hữu Zalo OA (nếu bạn là nhân viên, xin owner access)
- [ ] Truy cập admin panel Sonder: https://app.sondervn.com
- [ ] Password admin: (xem env OTA server / trong file `.claude/memory.md`)

---

## 🛠 5 bước setup (~20-30 phút)

### Bước 1 — Register Zalo Official Account

> Bỏ qua nếu Sonder đã có Zalo OA rồi.

1. Vào **https://oa.zalo.me**
2. Login với Zalo cá nhân
3. Click **"Đăng ký OA"** → chọn loại:
   - **Doanh nghiệp** (khuyến nghị): cần giấy phép kinh doanh + CCCD
   - **Cá nhân**: cần CCCD + số điện thoại
4. Fill info:
   - Tên OA: `Sonder Airport` (hoặc tên hotel)
   - Avatar: logo Sonder (512×512 px)
   - Cover: ảnh khách sạn (1024×576 px)
   - Địa chỉ, category: "Khách sạn", description
5. Nộp hồ sơ → chờ duyệt (1-3 ngày)

**Kết quả**: OA đã active tại `oa.zalo.me/dashboard/<oa_id>`. **Copy OA ID** (thường dạng 12-digit number) — sẽ dùng sau.

### Bước 2 — Create Zalo App

1. Vào **https://developers.zalo.me**
2. Login → tab **"My Apps"** → click **"Create New App"**
3. Fill info:
   - App name: `Sonder Marketing Bot`
   - Category: `Utility` hoặc `Customer Service`
   - Description: `Bot tự động trả lời khách sạn Sonder`
4. Create → vào **Settings** của app vừa tạo
5. Copy 2 thứ này:
   - **App ID** (dạng `1234567890123`)
   - **App Secret** (click Show → copy chuỗi random)

### Bước 3 — Link App với OA

Trong app settings:
1. Tab **"Official Account"** → click **"Liên kết OA"**
2. Chọn OA Sonder đã tạo ở Bước 1 → Liên kết
3. OA sẽ hiện trong app → lưu lại **OA ID** (nếu chưa có)

### Bước 4 — Get Access Token + Refresh Token

Zalo dev console có tool generate token. Có 2 cách:

#### Cách A: Tool "Get Access Token" trong Zalo Console (đơn giản)

1. Trong app → tab **"Official Account API"** → section **"Access Token"**
2. Click **"Get New Token"**
3. Zalo redirect tới OAuth page → confirm permissions → redirect back
4. Copy 2 tokens:
   - **Access Token** (sống 25 giờ — bot sẽ tự refresh)
   - **Refresh Token** (dài hạn — để bot lấy access_token mới)

#### Cách B: Manual OAuth (nếu cách A fail)

```
1. Redirect user tới:
   https://oauth.zaloapp.com/v4/oa/permission?app_id=YOUR_APP_ID&redirect_uri=URL_ENCODED_CALLBACK

2. User đồng ý → Zalo redirect kèm ?code=XYZ

3. Server exchange code → token:
   POST https://oauth.zaloapp.com/v4/oa/access_token
   Headers: secret_key: YOUR_APP_SECRET
   Body (x-www-form-urlencoded):
     code=XYZ
     app_id=YOUR_APP_ID
     grant_type=authorization_code

4. Response: { access_token, refresh_token, expires_in: 90000 }
```

### Bước 5 — Set Webhook URL trong Zalo

**CỰC KỲ QUAN TRỌNG** — thiếu bước này bot sẽ không nhận tin.

1. Trong Zalo dev app → tab **"Webhook"** hoặc **"Callback URL"**
2. Set:
   - **Webhook URL**: `https://app.sondervn.com/webhook/zalo`
   - **Subscribe events**:
     - ✅ `user_send_text` (khách gửi text)
     - ✅ `user_send_message` (khách gửi bất kỳ)
     - ✅ `user_send_image` (khách gửi ảnh — optional)
     - ✅ `user_send_sticker` (sticker — optional)
3. Click **"Xác minh URL"** — Zalo sẽ gửi test request tới bot
4. Nếu xác minh OK → **Save webhook**

> ⚠️ **Lưu ý**: Zalo yêu cầu HTTPS + response <5s. Domain app.sondervn.com đã có SSL từ Cloudflare + bot respond ngay 200 OK → đã đáp ứng.

---

## 🎛️ 6. Config trong admin dashboard

1. Vào **https://app.sondervn.com** → login
2. Tab **"📡 Kênh liên lạc"** (icon radio-tower)
3. Section **"💬 Zalo Official Account"** → điền form:
   - **OA ID**: (từ Bước 1)
   - **OA Name**: `Sonder Airport` (hoặc tên hotel)
   - **Access Token**: (từ Bước 4)
   - **Refresh Token**: (từ Bước 4)
   - **App Secret**: (từ Bước 2)
4. Click **"💾 Lưu"**
5. Section list dưới → click **"🔌 Test"** → nếu OK sẽ show info OA (tên, category, description)

## 🧪 7. Test end-to-end

### Test 1: Gửi tin từ bot → khách

1. Trong admin dashboard, section **"🧪 Gửi test"**:
   - User ID: Zalo user ID của bạn (lấy bằng cách chat vào OA → xem log webhook)
   - Text: "Hello từ bot Sonder"
   - Click **"Gửi"**
2. Mở Zalo chat OA → xem có tin nhắn không

### Test 2: Khách → bot auto-reply

1. Mở Zalo trên điện thoại (hoặc browser zalo.me)
2. Tìm OA Sonder → follow/chat
3. Gửi tin: "Bên mình có còn phòng trống không?"
4. **Bot sẽ trả lời tự động trong 2-5 giây** (giống FB Messenger)

### Test 3: Verify log

Trong admin dashboard:
- Tab **"💬 Hội thoại"** → thấy sender `zalo:xxxxxxxx` — Hùng Nguyễn (tên từ Zalo profile)
- Tab **"📊 Bot Monitor"** → section "Zalo conversations" — count tăng

---

## ⚙️ Auto-refresh token

Bot tự refresh access_token mỗi **20 giờ** (cron job). Bạn KHÔNG cần manual.

- Token live 25h
- Cron chạy 20h → refresh → token mới 25h
- Nếu refresh fail (ví dụ refresh_token expire/revoke) → bot vẫn reply tin cũ nhưng tin mới sẽ 401
- Admin check log: tab **Bot Monitor** → xem có warning `zalo-refresh failed`

**Manual refresh nếu cần**:
- Quay lại Zalo dev console → Bước 4 → generate token mới
- Trong admin → **"📡 Kênh liên lạc"** → Save lại với token mới

---

## 🐛 Troubleshooting

### Webhook không nhận tin

1. Check Zalo dev console → **Webhook Settings** — URL đúng không?
2. Check Zalo side có subscribe events chưa?
3. Check `pm2 logs vp-mkt | grep zalo` trên VPS — có log gì không?
4. Dùng tool `ngrok` / `curl` test webhook:
   ```bash
   curl -X POST https://app.sondervn.com/webhook/zalo \
     -H "Content-Type: application/json" \
     -d '{"oa_id":"YOUR_OA_ID","event_name":"user_send_text","sender":{"id":"test"},"message":{"text":"hello"}}'
   ```
   Expected: `{"ok":true}` (bot respond nhanh rồi process async)

### Bot reply 401/403

→ Token expired. Check:
```bash
pm2 logs vp-mkt | grep -i "zalo.*refresh"
```
Nếu thấy `refresh fail: authorization_error` → manual regenerate token (Bước 4).

### Signature verify fail

→ App Secret sai. Kiểm tra:
- Zalo dev console → App Settings → Reveal Secret → copy lại
- Admin dashboard → lưu lại App Secret

### Bot reply sai context (giống bug FB trước đây)

→ Bot dùng CHUNG logic với FB. Nếu FB work thì Zalo cũng work. Nếu có vấn đề, check tab Bot Monitor → Intent Confidence Heatmap.

---

## 📊 KPIs theo dõi sau launch

Sau 1 tuần, check tab **"📡 Kênh liên lạc"** → section "Zalo conversations last 7d":
- **Total msgs**: bao nhiêu tin đã process
- **Unique users**: bao nhiêu khách nhắn
- **Bot replies**: bao nhiêu lần bot reply
- **Avg latency**: thời gian phản hồi trung bình (target < 3000ms)

So sánh với Facebook (tab Bot Monitor) xem tỷ trọng khách dùng channel nào nhiều hơn.

**Kỳ vọng**: Zalo sẽ chiếm **60-70% tin nhắn** sau 1 tháng (khách VN ưu tiên Zalo).

---

## 🎯 Next steps sau khi Zalo work

- **Nhân rộng**: thêm OA cho từng hotel Sonder (mỗi hotel 1 OA riêng)
- **Link OA vào landing page**: button "Chat Zalo" trên mỗi mini-site hotel
- **Link OA vào FB**: CTA Facebook post có thể link sang Zalo OA khi cần privacy
- **Zalo Mini App**: Phase 2 — xây mini-app booking trong Zalo (giống mini-program WeChat)

---

## 📞 Support

- **Zalo OA issues**: vào **https://oa.zalo.me/help** hoặc hotline Zalo Business
- **Bot issues**: check `pm2 logs vp-mkt`, admin dashboard → Bot Monitor
- **Docs dev**: https://developers.zalo.me/docs/official-account-api

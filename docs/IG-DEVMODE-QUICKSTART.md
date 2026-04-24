# IG Dev Mode Quick Start — Refresh Page Token với đúng scope

> Mục tiêu: thêm scope `instagram_content_publish` vào Page token hiện tại để cross-post IG chạy ngay.

## Vì sao vẫn fail dù IG là admin app?

Meta phân biệt 2 thứ:

| Concept | Meaning | Hiện tại |
|---------|---------|----------|
| **App Role** (admin/developer/tester) | Quyền của user trên FB App | ✅ IG @sonder_haven đã là admin |
| **Token Scope** (permissions trên access_token) | Quyền token dùng API | ❌ Thiếu `instagram_content_publish` |

Dev Mode cho phép admin/developer DÙNG permissions mà không cần App Review — nhưng user vẫn phải **grant permission đó vào token** (qua OAuth flow).

## Fix — 3 bước, 5 phút

### Bước 1: Check app permission availability

Đầu tiên đảm bảo FB App đã **add** permission `instagram_content_publish` vào "App Review" list (kể cả Dev Mode cũng cần):

1. Vào https://developers.facebook.com/apps/784946227787902/app-review/permissions
   (Thay `784946227787902` = App ID của Sonder — em check ra rồi)

2. Trong tab **Permissions and Features**, search `instagram_content_publish`

3. Nếu thấy status **"Available in Development Mode"** → OK, next step

4. Nếu thấy **"Click to request advanced access"** → click, không cần submit review (dev mode users dùng được ngay)

5. Tương tự cho `instagram_basic` (đã OK sẵn)

### Bước 2: Generate new User Access Token (qua Graph API Explorer)

1. Vào https://developers.facebook.com/tools/explorer

2. **Meta App** dropdown (góc phải) → chọn Sonder's app (id=784946227787902)

3. **User or Page** dropdown → **User Token**

4. Click **"Permissions"** button → **TICK** tất cả các ô sau:
   - ✅ `pages_show_list`
   - ✅ `pages_read_engagement`
   - ✅ `pages_manage_posts`
   - ✅ `pages_manage_metadata`
   - ✅ `instagram_basic`
   - ✅ **`instagram_content_publish`** ← QUAN TRỌNG NHẤT
   - ✅ `business_management`

5. Click **"Generate Access Token"** → popup Facebook login

6. **Login bằng account có quyền admin FB Page "Sonder Apartment Hotel"** (cùng account đang là admin app)

7. Popup hỏi "authorize permissions" → **Continue** → **Next** → tick tất cả → **Save**

8. Back về Graph Explorer → thấy token mới (chuỗi dài ~200 ký tự bắt đầu bằng `EAAL...`) ở ô "Access Token"

9. **COPY** token đó.

### Bước 3: Lấy Page token mới + lưu vào bot

Chạy trên máy anh/chị (hoặc em chạy hộ nếu gửi user token):

```bash
# Thay TOKEN_FROM_STEP_2 = user token vừa copy
python scripts/upgrade-ig-token.py cCxEvKZ0J3Ee6NJG TOKEN_FROM_STEP_2
```

Script sẽ:
1. Exchange short-lived user token → long-lived (60 ngày)
2. Call `/me/accounts` để lấy Page access_token cho "Sonder Apartment Hotel"
3. Verify new token có scope `instagram_content_publish`
4. UPDATE pages SET access_token = ... WHERE name = 'Sonder Apartment Hotel'
5. Trigger lại cross-post cho post #9 để verify

Nếu thành công → em sẽ thấy:
```
✅ New scopes: instagram_basic, instagram_content_publish, pages_read_engagement, ...
✅ Page token updated in DB
✅ IG cross-post #9 SUCCESS: ig_media_id=17...
```

## Troubleshooting

### Error "App not in Development Mode"
→ Vào App settings → Basic → chuyển sang Development (nếu app đang Live).

### Error "Only developers and testers can use this permission"
→ User hiện tại chưa được add làm developer/tester/admin của app. Vào Roles → Add user.

### Error "Missing pages_manage_posts permission"
→ Thiếu scope khi tick ở bước 2.4. Quay lại Graph Explorer, tick đủ → regenerate token.

### Token hết hạn sau vài giờ
→ Dùng short-lived (2h). Script tự exchange sang long-lived (60 ngày). Sau 60 ngày cron `autoRefreshPageTokens` sẽ tự renew (nếu app secret đúng).

### IG publish vẫn 403
→ Check IG account loại (Business/Creator không phải Personal). Vào app IG → Settings → Switch to Professional Account.

## Flow sau khi fix

Một lần fix token → mỗi bài FB publish sẽ tự động:
```
1. FB post đăng OK
2. Hook scheduler → crossPostFromPostId
3. Fetch image từ FB CDN ✅
4. Post IG @sonder_haven       ✅
5. Post Zalo OA broadcast      ⚠️ (vẫn cần Verified Business)
6. Log vào cross_post_log
```

Zalo vẫn cần Verified Business (guide riêng ở `docs/CROSS-POST-SETUP.md`) nhưng IG có thể hoạt động ngay sau khi refresh token.

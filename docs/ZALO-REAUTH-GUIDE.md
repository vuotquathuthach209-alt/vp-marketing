# Zalo OA Re-Authorization Guide

> Cần làm khi: OA vừa verified, hoặc token bị -216 / -14014 invalid.

## Tại sao cần re-auth?

Khi OA được nâng cấp từ unverified → **Tài khoản xác thực**, Zalo:
1. Revoke TẤT CẢ token cũ (cả access + refresh)
2. Yêu cầu re-authorize để generate token mới
3. Token mới sẽ có **scope mở rộng**:
   - `send_message` (chat — OA cũ đã có)
   - `upload_image` ✅ NEW
   - `broadcast` ✅ NEW
   - `create_article` ✅ NEW
   - `oa.manage_follower` ✅ NEW
   - `zns` (ZNS notification service) ✅ NEW

## Bước 1: Lấy authorization code

1. Mở URL này trong browser (đã đăng nhập Zalo admin):

```
https://oauth.zaloapp.com/v4/oa/permission?app_id=1125683119493780855&redirect_uri=https://mkt.sondervn.com/api/zalo/oauth/callback&state=reauth_verified_2026
```

2. Zalo show trang authorize:
   - OA name: **Sonder**
   - App name: **(tên app developer của anh/chị)**
   - List permissions Zalo sẽ grant (kiểm tra đủ: message + upload + broadcast + article)
3. Click **"Cho phép"** (Allow)
4. Zalo redirect về `https://mkt.sondervn.com/api/zalo/oauth/callback?code=XXXXX&oa_id=328738126716568694&state=reauth_verified_2026`
5. Server tự exchange code → token mới và lưu vào DB

## Bước 2: Verify token mới

Sau khi redirect xong, check:
```bash
python scripts/diag-zalo-upload.py cCxEvKZ0J3Ee6NJG
```

Expect:
```
Test 1: /getoa → ✅ error: 0 (token valid)
Test 2: /upload/image → ✅ error: 0 (scope đủ cho upload)
```

## Bước 3: Test cross-post

```bash
python scripts/trigger-cross-post.py cCxEvKZ0J3Ee6NJG 9
```

Expect:
```
IG: 1/1 success
Zalo: 1/1 success
```

## Troubleshooting

### "code đã hết hạn" sau khi redirect
→ Authorization code chỉ valid trong 60 giây. Phải chạy ngay, không được để tab idle.

### OAuth redirect không về đúng URL
→ Check `redirect_uri` trong Zalo dev console khớp với URL callback. Settings: https://developers.zalo.me/app/1125683119493780855/settings → tab "Official Account" → "Callback URL"

### Token mới cũng -216
→ App trên developers.zalo.me có thể bị tạm ngưng. Check status app. Hoặc app chưa được "Duyệt" (approved) sau khi OA verified — cần submit app cho Zalo review lại.

### Redirect về endpoint nhưng token không lưu DB
→ Check log PM2: `pm2 logs vp-mkt | grep zalo`
→ Có thể endpoint `/api/zalo/oauth/callback` chưa handle đúng format. Em verify code sau.

## Alternative (nếu OAuth callback có vấn đề)

Dùng trực tiếp URL này để test:

```
https://oauth.zaloapp.com/v4/oa/permission?app_id=1125683119493780855&redirect_uri=https://oauth.zaloapp.com/v4/oa/test-callback&state=test
```

Sau khi click "Cho phép", URL sẽ là:
```
https://oauth.zaloapp.com/v4/oa/test-callback?code=<CODE_HERE>&oa_id=328738126716568694&state=test
```

Copy `code` ra, gửi em → em dùng script exchange token manually.

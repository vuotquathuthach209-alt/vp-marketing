# 🏨 Marketing Auto - Hướng dẫn sử dụng

App tự động đăng bài Facebook cho ngành **Lưu trú & Du lịch**, kèm tạo caption bằng Claude và tạo ảnh/video bằng fal.ai.

---

## 📋 MỤC LỤC
1. [Tính năng](#tính-năng)
2. [Chuẩn bị API Keys](#chuẩn-bị-api-keys)
3. [Deploy lên VPS](#deploy-lên-vps)
4. [Lấy Facebook Page Access Token](#lấy-facebook-page-access-token)
5. [Sử dụng hàng ngày](#sử-dụng-hàng-ngày)
6. [Chi phí vận hành](#chi-phí-vận-hành)
7. [Troubleshooting](#troubleshooting)

---

## Tính năng

- ✅ Đăng bài lên nhiều Fanpage (text, ảnh, video)
- ✅ Lên lịch đăng tự động (scheduler chạy mỗi phút)
- ✅ AI viết caption tiếng Việt (Claude Sonnet 4.6)
- ✅ AI tạo ảnh (Flux qua fal.ai, ~$0.003/ảnh)
- ✅ AI tạo video 5s (Kling qua fal.ai, ~$0.35/video)
- ✅ Upload ảnh/video từ máy tính
- ✅ Thư viện media, lịch sử bài đăng
- ✅ Dashboard web tiếng Việt

---

## Chuẩn bị API Keys

Trước khi deploy, bạn cần đăng ký 2 dịch vụ sau (mỗi cái ~3 phút):

### 1. Anthropic API Key (để viết caption bằng Claude)
1. Vào https://console.anthropic.com/ → đăng ký/đăng nhập
2. Settings → API Keys → **Create Key**
3. Copy key dạng `sk-ant-api03-...` và lưu tạm ra Notepad
4. Nạp tối thiểu $5 credit vào tài khoản (Billing)

### 2. fal.ai API Key (để tạo ảnh/video)
1. Vào https://fal.ai/ → Sign up (có thể dùng Google)
2. Dashboard → **API Keys** → Create new key
3. Copy key và lưu tạm
4. Nạp credit: khuyến nghị nạp $20 đầu tiên

### 3. (Chưa cần ngay) Facebook Developer Account
- Sẽ làm ở bước [Lấy Page Access Token](#lấy-facebook-page-access-token) sau khi deploy xong

---

## Deploy lên VPS

### Yêu cầu VPS
- Ubuntu 22.04 hoặc 24.04
- RAM tối thiểu 2GB (khuyên 4GB)
- Đã có SSH root access

### Bước 1: Cài Docker trên VPS

SSH vào VPS từ máy bạn:
```bash
ssh root@IP_VPS_CỦA_BẠN
```

Chạy các lệnh sau (copy-paste từng khối):

```bash
# Cập nhật hệ thống
apt update && apt upgrade -y

# Cài Docker
curl -fsSL https://get.docker.com | sh

# Kiểm tra Docker đã cài xong
docker --version
docker compose version
```

### Bước 2: Upload code lên VPS

**Cách 1 — Dùng Git (khuyến nghị nếu bạn đã push lên GitHub):**
```bash
cd /opt
git clone <repo-url> marketing-auto
cd marketing-auto
```

**Cách 2 — Upload trực tiếp bằng SCP từ máy Windows:**

Trên máy bạn (PowerShell), ở thư mục chứa code:
```bash
scp -r "C:\Users\USER\tự động đăng facebook" root@IP_VPS:/opt/marketing-auto
```

Sau đó SSH vào VPS:
```bash
cd /opt/marketing-auto
```

### Bước 3: Cấu hình biến môi trường

```bash
cp .env.example .env
nano .env
```

**Sửa các dòng sau:**
```env
ADMIN_PASSWORD=MatKhauManhCuaBan123!@#
JWT_SECRET=mot-chuoi-random-dai-it-nhat-32-ky-tu-xyz-abc-123-def
```

> 💡 Tip: Tạo JWT_SECRET bằng lệnh `openssl rand -hex 32`

Bấm `Ctrl+O` → `Enter` → `Ctrl+X` để lưu và thoát nano.

### Bước 4: Chạy deploy

```bash
chmod +x deploy.sh
./deploy.sh
```

Lần đầu sẽ build ~3-5 phút. Khi xong bạn sẽ thấy:
```
✅ Đã deploy xong!
   Mở: http://IP_VPS_CUA_BAN:3000
```

### Bước 5: Mở dashboard

Trên trình duyệt máy bạn, vào: `http://IP_VPS:3000`

Đăng nhập bằng `ADMIN_PASSWORD` bạn vừa set.

### Bước 6: Nhập API Keys

1. Vào tab **Cấu hình**
2. Dán **Anthropic API Key** và **fal.ai API Key**
3. Bấm **Lưu API Keys**

---

## Lấy Facebook Page Access Token

Đây là bước quan trọng nhất — **bạn phải tự làm**, không thể tự động hóa được.

### A. Tạo Facebook App

1. Vào https://developers.facebook.com/apps → **Create App**
2. Use case: chọn **"Other"** → **Business**
3. Điền tên App: `Marketing Auto Travel` (hoặc tùy ý)
4. Business Portfolio: chọn Business Manager của bạn (nếu chưa có, tạo mới)
5. Create App

### B. Lấy User Access Token có quyền Page

1. Vào https://developers.facebook.com/tools/explorer/
2. Góc phải: chọn App vừa tạo
3. User or Page → chọn **Get User Access Token**
4. Tick các quyền sau:
   - `pages_show_list`
   - `pages_read_engagement`
   - `pages_manage_posts`
   - `pages_manage_metadata`
5. Bấm **Generate Access Token** → đăng nhập Facebook → cấp quyền
6. Copy token vừa tạo (dài loằng ngoằng, bắt đầu `EAA...`)

### C. Lấy Page Access Token của từng Fanpage

Trong Graph Explorer, ô query nhập:
```
me/accounts
```
Bấm **Submit**. Kết quả JSON sẽ liệt kê các page bạn admin, mỗi page có:
```json
{
  "access_token": "EAAxxx...",   ← đây là Page Access Token
  "name": "Tên fanpage",
  "id": "123456789"              ← đây là Page ID
}
```

### D. Đổi sang Long-Lived Token (60 ngày)

Token mặc định chỉ sống 1-2 giờ. Đổi sang long-lived:

1. Lấy **User Access Token** vừa tạo ở bước B (không phải Page Token)
2. Mở URL sau (thay `APP_ID`, `APP_SECRET`, `USER_TOKEN`):
```
https://graph.facebook.com/v21.0/oauth/access_token?grant_type=fb_exchange_token&client_id=APP_ID&client_secret=APP_SECRET&fb_exchange_token=USER_TOKEN
```
3. Lấy `access_token` trả về → đây là **User Long-Lived Token** (60 ngày)
4. Gọi lại `me/accounts` với token này → Page Access Token trả về sẽ là **vĩnh viễn** (không hết hạn, miễn là bạn không đổi pass FB)

### E. Nhập Token vào App

1. Vào Dashboard app của bạn → tab **Cấu hình** → mục **Facebook Fanpages**
2. Điền:
   - **Page ID**: `123456789`
   - **Page Access Token**: `EAAxxx...` (long-lived)
   - **Tên ghi chú**: tùy ý
3. Bấm **Thêm Fanpage**
4. Nếu thành công, fanpage xuất hiện trong danh sách
5. Làm tương tự với fanpage thứ 2

---

## Sử dụng hàng ngày

### Tạo bài đăng tự động

1. Vào tab **Tạo bài đăng**
2. Chọn Fanpage muốn đăng
3. Nhập **chủ đề** (VD: *"Combo 2N1Đ Đà Lạt view đồi thông"*)
4. Bấm **✨ AI viết caption** → Claude tạo caption tiếng Việt
5. Chỉnh sửa caption nếu cần
6. Thêm media (chọn 1 trong 3):
   - **🎨 AI tạo ảnh** (~15 giây, ~$0.003)
   - **🎬 AI tạo video** (~2 phút, ~$0.35)
   - **📁 Upload từ máy**
7. Chọn:
   - **🚀 Đăng ngay** → publish liền
   - **📅 Lên lịch** → chọn thời gian, scheduler tự đăng đúng giờ
   - **💾 Lưu nháp**

### Xem lịch sử bài đăng

Tab **Danh sách bài** hiển thị tất cả bài với trạng thái:
- 🟨 Nháp
- 🟦 Đã lên lịch
- 🟡 Đang đăng
- 🟢 Đã đăng
- 🔴 Thất bại (xem lý do ở dòng lỗi)

### Thư viện media

Tab **Thư viện media** lưu tất cả ảnh/video đã tạo hoặc upload, để tái sử dụng.

---

## Chi phí vận hành

Ước tính **2 bài/ngày × 2 fanpage = 120 bài/tháng**, trong đó 30% có video:

| Khoản | Tháng |
|---|---|
| VPS 4GB | $10 |
| Claude API (caption) | $2-3 |
| fal.ai Flux (84 ảnh) | ~$0.30 |
| fal.ai Kling (36 video 5s) | ~$13 |
| **Tổng** | **~$26/tháng** |

Nằm trong budget $100 bạn đưa — còn dư để gen thêm nhiều content.

---

## Troubleshooting

### App không mở được trên trình duyệt
```bash
docker compose ps              # kiểm tra container có chạy không
docker compose logs -f app     # xem log lỗi
```

### Không đăng được bài, lỗi "Invalid OAuth access token"
- Token Facebook đã hết hạn → lấy lại long-lived token theo bước D ở trên

### Video upload lên FB bị lỗi timeout
- Video quá lớn, thử nén xuống dưới 100MB

### Scheduler không đăng đúng giờ
- Kiểm tra timezone: `docker compose exec app date` → phải ra giờ VN
- Nếu sai, sửa `.env`: `TZ=Asia/Ho_Chi_Minh` và `docker compose restart`

### Cập nhật code mới
```bash
cd /opt/marketing-auto
git pull            # nếu dùng git
docker compose up -d --build
```

### Backup database
```bash
# Backup
cp data/db.sqlite /root/backup-$(date +%Y%m%d).sqlite

# Backup toàn bộ (kèm media)
tar czf /root/backup-$(date +%Y%m%d).tar.gz data/
```

### Dừng/khởi động app
```bash
docker compose stop        # dừng
docker compose start       # chạy lại
docker compose restart     # restart
docker compose down        # dừng + xóa container (data vẫn giữ)
```

### Xem log realtime
```bash
docker compose logs -f app
```

---

## 🔒 Bảo mật sau khi deploy

**Quan trọng - hãy làm những việc sau:**

1. **Đổi password VPS ngay**:
   ```bash
   passwd
   ```

2. **Tắt SSH password, chỉ cho phép SSH key** (tùy chọn, an toàn hơn):
   - Tạo SSH key trên máy bạn: `ssh-keygen -t ed25519`
   - Copy lên VPS: `ssh-copy-id root@IP_VPS`
   - Sửa `/etc/ssh/sshd_config`: `PasswordAuthentication no`
   - Restart: `systemctl restart sshd`

3. **Bật firewall**:
   ```bash
   ufw allow 22/tcp
   ufw allow 3000/tcp
   ufw enable
   ```

4. **Đặt domain + HTTPS** (khuyên dùng, tránh truy cập bằng IP):
   - Trỏ domain về IP VPS
   - Cài Nginx + Certbot:
     ```bash
     apt install -y nginx certbot python3-certbot-nginx
     ```
   - Tạo Nginx config cho domain proxy về `localhost:3000`
   - Chạy: `certbot --nginx -d your-domain.com`

Nếu cần hướng dẫn chi tiết các bước bảo mật, mở lại Claude và hỏi tiếp.

---

## Cấu trúc thư mục

```
tự động đăng facebook/
├── src/
│   ├── index.ts              # Entry point
│   ├── config.ts             # Load env
│   ├── db.ts                 # SQLite schema
│   ├── middleware/auth.ts    # JWT auth
│   ├── routes/
│   │   ├── auth.ts           # Login/logout
│   │   ├── settings.ts       # API keys, fanpages
│   │   ├── ai.ts             # Gen caption/ảnh/video
│   │   ├── media.ts          # Upload, list media
│   │   └── posts.ts          # CRUD bài đăng
│   ├── services/
│   │   ├── claude.ts         # Anthropic SDK
│   │   ├── falai.ts          # fal.ai API
│   │   ├── facebook.ts       # Graph API
│   │   └── scheduler.ts      # node-cron
│   └── public/               # Frontend (HTML/JS)
├── data/                     # SQLite + media (volume)
├── Dockerfile
├── docker-compose.yml
├── deploy.sh
├── .env.example
└── HUONG-DAN.md (file này)
```

---

## Hỗ trợ

Có lỗi? Mở log:
```bash
docker compose logs --tail=100 app
```
Copy log và hỏi Claude để được debug.

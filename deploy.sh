#!/bin/bash
# Script deploy nhanh trên VPS Ubuntu
set -e

echo "🚀 Deploy Marketing Auto..."

# Kiểm tra Docker
if ! command -v docker &> /dev/null; then
  echo "❌ Chưa cài Docker. Cài bằng lệnh:"
  echo "   curl -fsSL https://get.docker.com | sh"
  exit 1
fi

# Tạo .env nếu chưa có
if [ ! -f .env ]; then
  echo "⚠️  Chưa có file .env, copy từ .env.example..."
  cp .env.example .env
  echo "❗ HÃY MỞ FILE .env VÀ SỬA:"
  echo "   - ADMIN_PASSWORD (mật khẩu đăng nhập dashboard)"
  echo "   - JWT_SECRET (chuỗi random ít nhất 32 ký tự)"
  echo ""
  read -p "Bấm Enter sau khi đã sửa xong..."
fi

# Build & chạy
docker compose down 2>/dev/null || true
docker compose up -d --build

echo ""
echo "✅ Đã deploy xong!"
echo "   Mở: http://$(hostname -I | awk '{print $1}'):3000"
echo ""
echo "Xem log: docker compose logs -f"
echo "Dừng:    docker compose down"

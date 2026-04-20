# Sprint 9 — Backlog (lưu lại làm sau)

> Ngày lưu: 2026-04-20. Sau khi hoàn tất Sprint 1-8 + cleanup data cũ.

## 🎯 Options cho Sprint 9

### Option A — Business Intelligence
- 🏆 **Multi-hotel leaderboard** — ranking hotel nào bot conversion tốt nhất (cross-tenant insight)
- 📊 **Cohort analysis** — theo dõi khách quay lại theo tuần/tháng
- 📈 **Seasonality detection** — bot tự nhận biết mùa cao/thấp điểm để điều chỉnh offer

### Option B — Revenue Automation
- 🧾 **Invoice automation** — sau deposit → tự sinh PDF invoice → gửi email
- 💳 **Direct pay inline** — tích hợp VNPay QR động trong tin nhắn (khách chạm là thanh toán)
- 📧 **Email follow-up** — post-stay review request (NPS score)
- 🎟️ **Auto-discount codes** — sinh mã giảm giá cá nhân khi khách lưỡng lự

### Option C — Enterprise Features
- 🎨 **White-label UI** — logo + màu tuỳ biến per hotel (cho B2B2C)
- 🤝 **Co-pilot mode** — hotel cao cấp duyệt mỗi reply trước khi gửi
- 🔐 **eKYC tự động** — OCR CCCD + verify (dùng multimodal Sprint 6)
- 👥 **Multi-user hotel account** — nhiều staff cùng login, phân quyền

### Option D — AI Enhancement
- 🧠 **Self-improving prompts** — bot tự đề xuất tinh chỉnh system prompt dựa trên feedback
- 🎭 **Dynamic persona** — tự detect brand personality từ wiki → viết lại tone
- 🔮 **Predictive pricing** — bot gợi ý giá tối ưu theo lịch sử conversion
- 🗣️ **Voice output** — TTS reply cho khách gửi voice (Gemini TTS hoặc Elevenlabs)

## 🏅 Recommend priority khi quay lại

Theo impact/cost:
1. **Direct pay VNPay QR inline** — giảm friction thanh toán = tăng conversion ngay
2. **Invoice automation** — chuyên nghiệp hóa, khách doanh nghiệp thích
3. **White-label UI** — mở rộng B2B2C, multi-hotel với brand riêng

## 📊 State snapshot khi lưu backlog

- Deployed commit: `b3c035d`
- Domain: https://mkt.sondervn.com
- Hotels active: Sonder Apartment Hotel + Nhà Tốt 247 (FB), flag `new_router=true`
- Sprint 1-8 tất cả đã deploy + verify
- DB cleanup 20/04/2026:
  - Xóa 2 template cũ từ conversation_memory
  - Backfill embedding: 17 → 42 messages (40% coverage)
  - learned_qa_cache sạch (7 entries)
  - Zero stalled bookings >7 ngày

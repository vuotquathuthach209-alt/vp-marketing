# Bot Sales Funnel — Operations & Deployment Guide

> Hoàn tất Day 1-8 (2026-04-22). Bot marketplace Sonder với 2-layer OTA data pipeline + FSM conversation funnel + analytics + handoff.

---

## 🏗 Kiến trúc tổng quan

```
┌─────────────────────────────────────────────────────────────┐
│  OTA Web / PMS                                              │
└──────────────────────┬──────────────────────────────────────┘
                       │ HMAC-signed POST /api/ota-raw/push
                       ▼
╔══════════════════════════════════════════════════════════════╗
║  LAYER 1 — Raw ingestion                                     ║
║  Tables: ota_raw_hotels, ota_raw_rooms, ota_raw_availability,║
║          ota_raw_images, property_types_discovered,          ║
║          ota_raw_batches                                     ║
╚══════════════════════┬═══════════════════════════════════════╝
                       │ cron 5 phút
                       ▼
╔══════════════════════════════════════════════════════════════╗
║  LAYER 2 — Qwen AI Classifier                                ║
║  Qwen 2.5-7B local với fallback rule-based                   ║
║  Output: hotel_profile, hotel_room_catalog, mkt_rooms_cache, ║
║          mkt_availability_cache, room_images                 ║
╚══════════════════════┬═══════════════════════════════════════╝
                       │
                       ▼
╔══════════════════════════════════════════════════════════════╗
║  LAYER 3 — Bot consumption (FSM Funnel)                      ║
║  15 states: INIT → PROPERTY_TYPE → [DATES|MONTHS] →          ║
║    GUESTS → BUDGET → AREA → [CHDV_EXTRAS] → SHOW_RESULTS →   ║
║    PROPERTY_PICKED → SHOW_ROOMS → CONFIRMATION_BEFORE_CLOSE →║
║    CLOSING_CONTACT → BOOKING_DRAFT_CREATED                   ║
║  Fallback: UNCLEAR_FALLBACK → HANDED_OFF                     ║
╚══════════════════════┬═══════════════════════════════════════╝
                       │
                       ▼
┌───────────────────────────────────────────────────────────────┐
│ Booking Draft + Notify:                                       │
│  • bot_booking_drafts (DB)                                    │
│  • Telegram hotel group (hotel_telegram_config) + fallback    │
│  • Email SMTP (optional)                                      │
└───────────────────────────────────────────────────────────────┘
```

---

## 📋 Config checklist (production)

### Required (.env)
```
USE_NEW_FUNNEL=true          # Enable FSM flow
OLLAMA_HOST=http://127.0.0.1:11434
OLLAMA_MODEL=qwen2.5:7b-instruct-q4_K_M
GOOGLE_API_KEY=...           # Gemini multi-slot extractor
GROQ_API_KEY=...             # Cascade fallback
TELEGRAM_BOT_TOKEN=...       # Global notify fallback
```

### Optional (email)
```
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=sender@example.com
SMTP_PASS=app-password
SMTP_FROM="Sonder Bot <noreply@sondervn.com>"
NOTIFY_EMAIL_TO=admin1@sondervn.com,admin2@sondervn.com
```

### DB settings (via admin UI)
- `ota_raw_secret` — HMAC shared secret cho OTA push (rotate 90 ngày)
- `funnel_enabled_override` — runtime toggle FSM (overrides .env)
- Per-hotel Telegram: `hotel_telegram_config` table (setup qua admin panel)

---

## 🔐 OTA Push API

**Endpoint**: `POST https://app.sondervn.com/api/ota-raw/push`

**Headers**:
```
Content-Type: application/json
X-OTA-Signature: sha256=<HMAC_SHA256(raw_body, secret)>
X-OTA-Timestamp: <unix_ms>
X-OTA-Source: ota-web | pms | manual
```

**Body**:
```json
{
  "batch_id": "unique_id",
  "type": "hotels | rooms | availability | images",
  "items": [ { "ota_id": "...", "data": { ... } } ]
}
```

Full spec: `docs/OTA-RAW-API-SPEC.md`.

**Current shared secret** (lưu trong `.claude/memory.md`, rotate via admin UI):
```
25c1e4f8bf7a1999c3f4be72e5c1357e878ae5814214999deb698bd3bfe5d321
```

---

## 🎛 Admin Operations

Login: `https://app.sondervn.com`
Password: `fpwecCB6qVdI3Wpax3PNLY0P`

### Tab structure (relevant ones)
1. **🔌 OTA Pipeline** — monitor raw ingestion, Qwen classifier, failed records
2. **🎯 Sales Funnel** — KPIs, funnel chart, bookings, handoffs, kill switch
3. **💬 Hội thoại** — view all conversations (channel filter FB/Zalo/Sim)
4. **📡 Kênh liên lạc** — Zalo OA + simulator + ZNS + broadcast

### Sales Funnel tab features
- **4 KPI cards**: conversations / bookings / handoffs / feature flag
- **Funnel bar chart**: 17 stages with conversion rate %
- **Kill switch buttons**: Enable / Kill (runtime, không cần restart)
- **Recent bookings**: inline status dropdown (new/contacted/confirmed/paid/cancelled/no_response)
- **Stuck bookings**: list `new` > 1h cần follow-up
- **Handoffs**: conversations cần can thiệp, click row để xem chi tiết
- **Daily breakdown**: 30 ngày (started/bookings/handoffs/conv rate)

### Conversation viewer modal
Click vào handoff row → modal hiện:
- **FSM State**: current stage + turns + handoff flag
- **Slots**: JSON dump của tất cả slots collected
- **Full messages**: user + bot history
- **Booking draft** nếu có
- **Actions**: Takeover (pause bot) / Resume bot / Reset conversation

---

## 🔄 Daily Ops Checklist

### Morning (9am)
- [ ] Check Sales Funnel tab:
  - Conversion rate ≥ 15%?
  - Stuck bookings (overnight) — team call ngay
  - Handoffs cần can thiệp?
- [ ] Check OTA Pipeline:
  - Pending classifications > 0?
  - Failed records cần map manual
  - Property types mới discovered → review

### Evening (6pm)
- [ ] Mark bookings đã gọi → update status
- [ ] Review conversation failures → tune prompts nếu cần

### Weekly
- [ ] Review Daily table: conversion trends, peak days
- [ ] Rotate OTA secret nếu > 90 ngày
- [ ] Clean old raw data (> 90 ngày): manual SQL

---

## 🛠 Troubleshooting

### Bot không reply khách Zalo
1. Check feature flag: `/funnel/feature-flag` endpoint hoặc admin Sales Funnel tab
2. Check handed_off: admin conversation viewer
3. PM2 logs: `pm2 logs vp-mkt | grep funnel`
4. Kill switch OFF → restart PM2 → thử lại

### Qwen classifier không chạy
1. Check Ollama: `systemctl status ollama`
2. Check model loaded: `curl http://127.0.0.1:11434/api/tags`
3. Timeout 60s — complex payload có thể fail → rule-based fallback sẽ kick in
4. Manual trigger: admin OTA Pipeline tab → "⚡ Chạy Qwen ngay"

### Booking draft không tạo
1. Check state progression: admin conversation viewer
2. Check phone extracted: `slots.phone` field
3. Check Telegram bot token configured
4. Logs: `pm2 logs vp-mkt | grep createBookingDraft`

### Conversion rate thấp
1. Check funnel chart: stage nào rớt nhiều nhất?
2. Ví dụ rớt ở BUDGET_ASK → có thể bot không nhận ra budget
3. Ví dụ rớt ở SHOW_RESULTS → không có property match
4. Tune slot extractor regex nếu cần

---

## 🧪 Testing

### Manual test qua Zalo simulator (admin)
- Tab 📡 Kênh liên lạc → Zalo Simulator
- Gõ: `"homestay gần sân bay 2 người tuần sau dưới 1 triệu"`
- Verify: bot skip qua 5 questions, show Seehome Airport

### Test multi-slot Gemini
- Gõ câu dài có nhiều info trong 1 message
- Expected: log `[funnel] multi-slot Gemini: N → M slots`
- Verify: bot tiến thẳng qua SHOW_RESULTS

### Test urgency + returning customer
- Seed past booking với phone X
- Chat với phone X → bot welcome "Chào mừng trở lại!"
- Seed 3+ recent bookings → show_results có urgency 🔥

---

## 📊 Key Metrics (benchmark)

| Metric | Target | Measure |
|--------|--------|---------|
| Conversion rate (chat → booking) | ≥ 20% | Admin Sales Funnel KPI |
| Handoff rate | ≤ 15% | Admin handoffs tab |
| Avg turns to close | ≤ 8 | Conversation viewer |
| Multi-slot extract rate | ≥ 50% | Log `multi-slot Gemini` |
| Time to first booking | ≤ 3 min | From INIT to BOOKING_DRAFT_CREATED |

---

## 🚦 Safety & Rollback

### Kill switch options
1. **Runtime (fast)**: admin Sales Funnel → "Kill" button → save to settings
2. **Env (permanent)**: `.env` set `USE_NEW_FUNNEL=false` → PM2 restart
3. **Full disable**: `pm2 stop vp-mkt` (bot down entirely)

### Partial rollback
- Keep OTA Pipeline (Layer 1+2) running
- Disable FSM only: kill switch
- Bot reverts to legacy `dispatchV6` flow

### Deploy validation
```bash
# After git push main + deploy
curl -s -o /dev/null -w "%{http_code}" https://app.sondervn.com/health  # should be 200
curl -s https://app.sondervn.com/api/funnel/feature-flag  # check flag status
```

---

## 📦 Files index (Day 1-8 deliverables)

```
Backend:
  src/routes/ota-raw.ts          - Layer 1 HMAC push receiver
  src/routes/funnel-analytics.ts - Analytics + admin control
  src/services/qwen-classifier.ts - Layer 2 AI classifier
  src/services/conversation-fsm.ts - FSM state management
  src/services/slot-extractor.ts   - Deterministic VN parsers
  src/services/multi-slot-gemini.ts - Gemini fill gaps
  src/services/funnel-handlers.ts  - 15 state handlers
  src/services/funnel-dispatcher.ts - Main orchestrator
  src/services/email-notify.ts     - SMTP optional

Frontend:
  src/public/index.html - Admin UI (OTA Pipeline, Sales Funnel tabs)
  src/public/app.js     - JS handlers

Docs:
  docs/OTA-RAW-API-SPEC.md      - OTA team integration spec
  docs/BOT-SALES-FUNNEL-OPS.md  - This file (ops guide)

Scripts:
  scripts/deploy-ssh-full.py           - Deploy to VPS
  scripts/test-fsm-full-funnel.py      - E2E flow test
  scripts/test-multi-slot.py           - Multi-slot extractor
  scripts/test-day7-enhancements.py    - Day 7 features
  scripts/gen-ota-secret-and-test.py   - Secret rotation + self-test
```

---

## 📞 Support

- Admin panel: https://app.sondervn.com
- Logs: `pm2 logs vp-mkt` trên VPS 103.82.193.74
- Git: https://github.com/vuotquathuthach209-alt/vp-marketing
- OTA handover spec: `docs/OTA-RAW-API-SPEC.md`

---

_Last updated: 2026-04-22 (Day 1-8 complete)_

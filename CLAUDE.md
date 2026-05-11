# VP Marketing — Rules & Direction

> **BẮT BUỘC đọc & tuân thủ ở MỌI phiên làm việc với repo này.**

## 🎯 Strategic Direction (updated 2026-05-11)

**Sondervn = nền tảng trung gian bán phòng cho khách sạn đối tác** (OTA marketplace).

VP Marketing là **back-office tool** cho Sondervn — KHÔNG bán phòng trực tiếp, KHÔNG chat bot, KHÔNG auto-reply Facebook.

### Tool có 3 mảng chính:

1. **🎨 Content & Posts** — V5T pipeline (real photos từ Drive → caption → carousel → đăng FB)
2. **🔍 SEO** — Multi-platform:
   - Google Web SEO (sondervn.com page crawl + audit + schema + scorecard + keyword tracking) ✅ ĐÃ XÂY
   - Facebook Page SEO (audit About, post performance, hashtag strategy)
   - Instagram SEO (bio, hashtags, alt-text)
   - TikTok / YouTube / Threads SEO
3. **💬 Customer Care** — KHÔNG bot tự reply:
   - Aggregated inbox (FB comments + messages — read-only view cho admin)
   - Reviews monitor (Google Maps + FB reviews → centralized + sentiment analysis)
   - Response template library (admin curates, copy-paste manual)
   - Telegram alert khi có review/comment urgent

### Quy tắc bất biến:

- ❌ **KHÔNG xây bot AI bán phòng** — khách sạn đối tác xử lý booking trực tiếp.
- ❌ **KHÔNG auto-reply Facebook** — Meta AI tự handle, admin tự duyệt khi cần.
- ❌ **KHÔNG đụng OTA DB ghi/sửa** — chỉ read-only (legal mandate).
- ✅ **Customer care = aggregation + alerting + templates** — admin vẫn là người trả lời.

## 🚀 Deployment Architecture

```
┌──────────────────┐  git push  ┌──────────┐  ssh+pull+restart  ┌────────────────┐
│ Local (Windows)  │ ─────────▶ │  GitHub  │ ─────────────────▶ │  VP MKT VPS    │
│ C:\Users\USER\   │            │   main   │                    │ 103.82.193.74  │
│ tự động đăng FB  │            │          │                    │   (8c/15GB)    │
└──────────────────┘            └──────────┘                    └────────────────┘
```

- **Production VPS:** `103.82.193.74` (root / cCxEvKZ0J3Ee6NJG, port 22)
- **Stack:** Ubuntu 24.04, Node 20+, PM2, Nginx, Ollama (local AI)
- **App path:** `/opt/vp-marketing`
- **Deploy flow:**
  1. `git push origin main`
  2. SSH vào VPS → `cd /opt/vp-marketing && git pull && npm install && pm2 restart vp-mkt`

## 🚫 CẤM TUYỆT ĐỐI

1. **KHÔNG SSH / deploy vào VPS `103.82.192.197`** — đó là hệ iSonder hoàn toàn khác.
2. **KHÔNG commit secrets** (API key, password) vào Git — dùng `.env` trên VPS.
3. **KHÔNG edit DB production trực tiếp** — phải qua migration trong `src/db.ts`.
4. **KHÔNG xây lại** chat bot / auto-reply / booking flow — đã loại bỏ theo strategic pivot 2026-05-11.
5. **KHÔNG ghi/sửa/xóa OTA database** (`103.153.73.97` / `OTA-WEB`):
   - OTA là PRODUCTION — chứa data của nhiều khách sạn đối tác.
   - Project này CHỈ ĐƯỢC ĐỌC: SELECT / SHOW / DESCRIBE / EXPLAIN.
   - Mọi query phải đi qua `otaQueryReadOnly()` (`src/services/ota-readonly-guard.ts`).
   - Guard throw `OtaReadOnlyViolation` ngay nếu phát hiện INSERT/UPDATE/DELETE/DROP/TRUNCATE/ALTER/CREATE/GRANT/REPLACE/MERGE/CALL/LOAD/FLUSH/etc.

## ✅ Nguyên tắc làm việc

- Mọi thay đổi code → commit → push lên GitHub main.
- Trên VPS `103.82.193.74`: kéo code mới → restart PM2.
- Secrets → chỉ nằm trong `/opt/vp-marketing/.env` trên VPS.
- Migration mới → `safeAddColumn()` hoặc `CREATE TABLE IF NOT EXISTS` trong `src/db.ts`.

## 🤖 AI Stack

| Task | Provider | Model | Why |
|------|----------|-------|-----|
| Image vision (alt-text, V5T tag) | Google Gemini | `gemini-2.5-flash` | Free tier rộng, image input |
| Caption generation (V5T, post-writer) | Anthropic Claude | `claude-sonnet-4-6` | Quality |
| Fallback / cheap tasks | Ollama local / Groq | `qwen2.5:7b-instruct-q4` / `llama-3.3-70b` | Free, local |
| Embeddings (V5T similarity, ranking) | Local ONNX | MiniLM | Free |
| Keyword ranking | Google Custom Search / SerpAPI | — | Pay per query |

## 🔐 Secrets (trong `/opt/vp-marketing/.env` trên VPS)

```
GOOGLE_API_KEY=...        # Gemini Vision + CSE
GROQ_API_KEY=...          # Fallback LLM
ANTHROPIC_API_KEY=...     # Claude (V5T captions)
FB_APP_ID=...
FB_APP_SECRET=...
TELEGRAM_BOT_TOKEN=...    # Admin alerts (not chat)
OLLAMA_HOST=http://127.0.0.1:11434
PORT=3000
NODE_ENV=production
```

Settings tự cấu hình qua DB (SQLite `settings` table):
- `gdrive_folder_id` — Drive divider cho V5T
- `google_cse_id` — Custom Search engine ID (for keyword ranking)
- `serpapi_key` (optional, alternative to CSE)
- `seo_daily_cron_enabled` (default true)

## 📦 Sanity check trước khi push

```bash
npx tsc --noEmit      # TypeScript sạch
git status            # không file rác
```

## 📁 Structure

```
src/
├── routes/
│   ├── seo.ts              — SEO Google Web (crawl/audit/scorecard/keywords/schema)
│   ├── care.ts             — Customer Care (inbox/reviews/templates) — TO BUILD
│   ├── posts.ts            — V5T posts
│   ├── ota.ts              — OTA read-only DB
│   ├── product-auto-post   — Auto-post hotel images (existing)
│   ├── analytics.ts        — Post performance metrics
│   ├── settings.ts, admin.ts, auth.ts, etc.
├── services/
│   ├── seo/                — Web SEO foundation
│   │   ├── crawler.ts, auditor (inline), schema-gen, alt-text,
│   │   │ keyword-tracker, scorecard, daily-cron
│   │   └── channels/       — Per-platform SEO (TO BUILD: facebook.ts, instagram.ts)
│   ├── care/               — Customer Care (TO BUILD)
│   │   ├── reviews.ts      — Reviews monitor
│   │   ├── inbox.ts        — Unified comment/message view
│   │   ├── sentiment.ts    — Gemini-powered sentiment
│   │   ├── templates.ts    — Response template library
│   │   └── notifier.ts     — Telegram alert
│   ├── v5t/                — Text/image post pipeline (ACTIVE)
│   ├── v5/                 — Used by V5T composer fallback (keep)
│   ├── product-auto-post/  — Daily auto-post hotel images
│   ├── ota-db.ts, ota-readonly-guard.ts, ota-sync.ts, ota-reader.ts
│   ├── analytics.ts, fb-metrics-puller.ts
│   ├── router.ts, claude.ts, ai-cache.ts
│   ├── facebook.ts, cross-post-sync.ts
│   ├── telegram.ts, email.ts (admin alerts)
│   └── scheduler.ts
├── public/                 — Static frontend (index.html + app.js)
└── db.ts                   — SQLite schema (KEEP all CREATE TABLE IF NOT EXISTS)

data/db.sqlite              — Production DB (persisted trên VPS)
```

## 🆘 Quick ops

```bash
# SSH vào VPS
ssh root@103.82.193.74

# Xem log
pm2 logs vp-mkt --lines 100

# Restart
pm2 restart vp-mkt

# Deploy mới
cd /opt/vp-marketing && git pull && npm install && pm2 restart vp-mkt
```

# VP Marketing — Rules & Deployment Skill

> **BẮT BUỘC đọc & tuân thủ ở MỌI phiên làm việc với repo này.**

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
  3. (Hoặc tự động qua GitHub Actions webhook nếu setup)

## 🚫 CẤM TUYỆT ĐỐI

1. **KHÔNG SSH / deploy vào VPS `103.82.192.197`** — đó là hệ iSonder hoàn toàn khác, không liên quan VP MKT.
2. **KHÔNG commit secrets** (API key, password) vào Git — dùng `.env` trên VPS.
3. **KHÔNG edit DB production trực tiếp** — phải qua migration trong `src/db.ts`.
4. **KHÔNG đụng vào hệ thống nào khác** trên internet khi làm VP MKT (kể cả Railway cũ, Vercel, v.v.)
5. **KHÔNG ghi/sửa/xóa OTA database** (`103.153.73.97` / `OTA-WEB`):
   - OTA là PRODUCTION — chứa data của nhiều khách sạn.
   - Project này CHỈ ĐƯỢC ĐỌC: SELECT / SHOW / DESCRIBE / EXPLAIN.
   - Mọi query phải đi qua `otaQueryReadOnly()` (`src/services/ota-readonly-guard.ts`).
   - Guard throw `OtaReadOnlyViolation` ngay nếu phát hiện INSERT/UPDATE/DELETE/DROP/TRUNCATE/ALTER/CREATE/GRANT/REPLACE/MERGE/CALL/LOAD/FLUSH/etc.
   - Self-test chạy khi app boot — fail-fast nếu guard hỏng.
   - DB user phía OTA PHẢI chỉ có `GRANT SELECT` (defense in depth).

## ✅ Nguyên tắc làm việc

- Mọi thay đổi code → commit → push lên GitHub main.
- Trên VPS `103.82.193.74`: kéo code mới → restart PM2.
- Secrets → chỉ nằm trong `/opt/vp-marketing/.env` trên VPS.
- Migration mới → `safeAddColumn()` hoặc `CREATE TABLE IF NOT EXISTS` trong `src/db.ts`.

## 🤖 AI Stack

| Task | Provider | Model | Why |
|------|----------|-------|-----|
| Intent gateway (L1) | Google Gemini | `gemini-2.0-flash-exp` | Smart router, $0.075/1M |
| Generation (L3 main) | **Ollama local** | `qwen2.5:7b-instruct-q4_K_M` | Chạy trên VPS 15GB RAM, free |
| Fallback generation | Groq cloud | `llama-3.3-70b-versatile` | Free tier 14,400/ngày |
| Embeddings | Local ONNX | MiniLM | Free, bundled |

Vì VPS có 15GB RAM + 8 cores → chạy Qwen 2.5-7B thoải mái (4.7GB model + inference).
Expected latency on CPU: 300-800ms/response — đủ cho chatbot realtime.

## 🔐 Secrets (trong `/opt/vp-marketing/.env` trên VPS)

```
GOOGLE_API_KEY=...
GROQ_API_KEY=...
CLAUDE_API_KEY=...
FB_APP_ID=...
FB_APP_SECRET=...
TELEGRAM_BOT_TOKEN=...
OLLAMA_HOST=http://127.0.0.1:11434
PORT=3000
NODE_ENV=production
```

OTA DB config lưu trong SQLite `settings` table (per-install), không dùng env.

## 📦 Sanity check trước khi push

```bash
npx tsc --noEmit      # TypeScript sạch
git status             # không file rác
```

## 📁 Structure

- `src/routes/` — Express routes
- `src/services/` — Business logic (smartreply, ota-db, router, ollama, etc.)
- `src/scripts/` — One-off maintenance scripts
- `src/public/` — Static frontend
- `data/db.sqlite` — Production DB (persisted trên VPS)

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

# Ollama status
systemctl status ollama
ollama list
```

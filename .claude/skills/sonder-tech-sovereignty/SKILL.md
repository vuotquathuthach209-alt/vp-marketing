---
name: sonder-tech-sovereignty
description: BẮT BUỘC đọc cho mọi quyết định liên quan đến marketing strategy, tool selection, content automation, customer engagement của Sonder. Skill lock định hướng "lưu trú first, content phụ trợ" — KHÔNG xây kênh content viral. Lock stack OSS tự chủ (Chatwoot, Listmonk, Umami, Twenty CRM, BullMQ, Sonder smartreply in-house). Cấm n8n + Jack The Butler + tools vendor lock-in. Use khi user hỏi về: marketing channel mới, tool integration, AI bot, email automation, chatbot, CRM, analytics, workflow automation, viral content, social media strategy, content roadmap, hoặc bất cứ quyết định nào về budget/effort allocation cho marketing-automation.
---

# Sonder Tech Sovereignty — Marketing & Tooling Bible

> **MỤC ĐÍCH**: Lock định hướng chiến lược + tool stack cho mọi phiên làm việc tương lai. Đi chệch = đốt budget vô ích, mất tự chủ kỹ thuật, lệch business goal.

> **CONTEXT**: Skill này được tạo sau diagnose 2026-05-06 phát hiện Anthology daily (~$300/tháng) reach=0 views, hard-sell auto-post bóp page edge rank, AI content viral approach SAI MATCH với business goal "lưu trú".

---

## 🎯 NGUYÊN TẮC BẤT BIẾN — KHÔNG ĐƯỢC PHÉP VI PHẠM

```
═══════════════════════════════════════════════════════════════════
  "SONDER LÀ HOTEL, KHÔNG PHẢI MEDIA COMPANY"
═══════════════════════════════════════════════════════════════════

  1. LƯU TRÚ FIRST  — mọi quyết định phải drive booking,
                       không phải drive view/like/share.
  2. ZERO-TIME OWNER — chủ Sonder KHÔNG có thời gian quay phim,
                       viết content, edit video. Tool phải tự chạy.
  3. TỰ CHỦ KỸ THUẬT — code Sonder OWN 100%. Không vendor lock-in.
                       License priority: MIT > Apache > AGPL > GPL.
                       CẤM fair-code (n8n) + closed SaaS phụ thuộc.
  4. ROI ĐO ĐƯỢC   — mỗi tool/channel phải attribute cost-per-booking.
                       Không attribute = pause sau 30 ngày.
  5. EXISTING INFRA — leverage Ollama + Gemini + smartreply Sonder
                       đã có. KHÔNG add AI dependency mới (Jack The
                       Butler, Drift, Intercom AI, v.v.)
═══════════════════════════════════════════════════════════════════
```

---

## ❌ ANTI-PATTERNS — KHÔNG được làm

| ❌ KHÔNG | Lý do | ✅ THAY BẰNG |
|---|---|---|
| Anthology daily AI video reach=0 | $300/mo, 0 booking attribution | Email automation $0/mo, $36-45 ROI |
| Auto-post hard-sell ad copy | Bóp edge rank → kéo cả Stories chìm | UGC repost (khách tạo, anh duyệt) |
| n8n workflow visual | Fair-code license, lock-in JSON | BullMQ + TypeScript code own |
| Jack The Butler external dep | Trùng với Ollama+Gemini đã có | Sonder smartreply in-house |
| Viral hook engineering Reels | Cold audience, không drive booking | Direct booking discount + loyalty |
| Self-host Plausible | AGPLv3 + recently anti-self-host | Umami (MIT, lighter) |
| Cal.com self-host | 2026 yêu cầu enterprise tier | Build custom calendar trong Sonder PMS |
| GA4 / Google Analytics | Cookie banner + privacy issue + slow | Umami (1.5KB tracker) |
| Mailchimp / SendGrid / Klaviyo | $300-2000/mo + data trên cloud thứ 3 | Listmonk self-host (Postgres own) |
| Intercom / Zendesk / Drift | $500-2000/mo + closed source | Chatwoot (MIT, identical features) |
| Salesforce / HubSpot CRM | $100-1500/mo + complex | Twenty CRM (TypeScript, Postgres own) |
| Mở thêm Reels viral attempt | Đã verify flop trên page Sonder | Đầu tư paid Meta Ads targeted |
| Content channel YouTube/TikTok | Không phải định hướng business | Pause hết, focus OTA + direct booking |

---

## ✅ STACK ĐƯỢC DUYỆT — Lock cho Sonder

### Layer 1: Customer Communication

#### **Chatwoot** (MIT) — Unified omnichannel inbox
- Repo: `chatwoot/chatwoot`
- Stack: Rails + Postgres + Redis + Vue
- Channels: FB Messenger, IG DM, Zalo OA, WhatsApp, Email, Web chat
- Features: Auto-assign, canned responses, AI agent (Captain), help center
- Resource: ~1.5GB RAM
- Anchor tool — ALL guest comm phải qua Chatwoot

#### **Sonder Smartreply** (in-house, src/services/smartreply)
- Stack: Existing TypeScript + Gemini intent + Ollama Qwen 2.5 + ONNX embeddings
- Webhook integration với Chatwoot → AI auto-reply
- Confidence < 0.7 → escalate human
- KHÔNG add Jack The Butler / external AI bot

### Layer 2: Email Marketing

#### **Listmonk** (AGPLv3) — Newsletter + transactional + automation
- Repo: `knadh/listmonk`
- Stack: Single Go binary + Postgres
- Features: Lists/segments, templates Liquid, automation triggers, bounce handling, Decree 13 compliant
- Resource: ~80MB RAM
- Replaces Mailchimp/SendGrid/Klaviyo (save $300-1000/mo)
- SMTP backend: Mailgun/SES/own postfix

### Layer 3: CRM & Guest Profile

#### **Twenty CRM** (AGPLv3) — Modern guest profile management
- Repo: `twentyhq/twenty`
- Stack: NestJS + Postgres + Redis + React
- Why over EspoCRM: TypeScript stack (cùng Sonder), modern UI (anh dễ dùng)
- Custom schema for hospitality:
  - GuestProfile (preferences, lifetime_value, total_stays, tags)
  - Booking (source attribution, channel commission)
  - Pipeline: Inquiry → Quoted → Booked → Stayed → Review → Repeat
- Resource: ~600MB RAM

### Layer 4: Analytics

#### **Umami** (MIT) — Privacy-first web analytics
- Repo: `umami-software/umami`
- Stack: Next.js + Postgres
- Why over Plausible: MIT > AGPLv3, lighter (1.5KB tracker), không cookie banner
- Features: Pageviews, traffic source, UTM tracking, goals, multi-site
- Resource: ~200MB RAM
- Use case: Track sondervn.com + booking flow funnel

#### **PostHog Cloud (free tier 1M events/mo)** — Optional, only on conversion pages
- Why: Self-host PostHog quá nặng (3-4GB RAM, ClickHouse stack)
- Use case: Session replay + funnels CHỈ trên booking flow pages
- Self-host khi traffic >1M events/mo

### Layer 5: Workflow Orchestration

#### **BullMQ** (MIT) — Job queue THAY n8n
- Repo: `taskforcesh/bullmq`
- Stack: Node.js + Redis (cùng stack Sonder vp-marketing)
- Why over n8n: Pure MIT, code workflows như TypeScript code (git diff, code review, test)
- Features: Delayed jobs, retry exp backoff, rate limiting, priorities
- Bull Board web UI cho monitoring
- Resource: Redis ~50MB
- Workflows extend src/services/scheduler.ts hiện tại

### Layer 6: Existing infra giữ nguyên

- **vp-marketing** (Node.js + better-sqlite3 + PM2) — main app
- **Ollama (Qwen 2.5-7B)** — local AI generation, FREE
- **Gemini intent gateway** — smart router
- **Groq fallback** — free 14,400 req/day
- **Embeddings ONNX MiniLM** — free local
- **Pexels** — free stock video (Cinema use case ATMOSPHERIC_BROLL)
- **FAL.ai** — chỉ cho Cinema PILOT mode (giữ MID/FULL pause)

---

## 🎬 V3 Anthology + V4 Cinema — Quyết định MỚI (post-flop diagnose)

### V3 Anthology Daily — **PAUSED** (effective 2026-05-06)
**Lý do**: Reach=0 hiện tại, $300/tháng, 0 booking attribution. Cold audience, AI synthetic content algo penalty.

**Setting flag**: `vs_anthology_cron_enabled = 'false'`

**Reactivation criteria**:
- Page Sonder có >5,000 organic followers VÀ
- 3 video gần nhất tự organic >1,000 views VÀ
- Audience build qua channel khác (UGC, Meta Ads, YouTube Shorts)

### V4 Cinema Weekly T7 — **GIỮ** ($7/tháng PILOT mode)
**Lý do**: Cost rẻ ($1.66/clip × 4 = $6.64/tháng), giữ làm brand asset cho website + email marketing. Không kỳ vọng viral organic.

**Settings hiện tại**:
- `cinema_cron_enabled = 'true'`
- `cinema_target_duration_sec = '90'` (PILOT)
- `cinema_max_cost_per_episode = '3.00'`
- `cinema_auto_publish = 'false'` (manual review)

**Use case mới**: Cinema clips → embed website landing page + email welcome sequence (không reliance trên FB algo)

### V2 Tips/Weekend — DEPRECATED (đã)
### Auto-post hard-sell — PAUSED (đã)
- Setting: `product_auto_post_enabled = 'false'`

---

## 📊 ROI THRESHOLD — Quy tắc kill module

Mỗi module marketing-automation phải pass:

| Metric | Threshold | Hành động nếu fail |
|---|---|---|
| Cost-per-booking attribution | < 30% commission OTA tương đương | Pause sau 60 ngày |
| Email open rate | >25% | Optimize subject line + sender |
| Email click rate | >3% | Optimize CTA + content |
| Review request response rate | >15% | A/B test send time + voucher |
| Funnel conversion (visit → book) | >2% | Audit drop step in PostHog |
| Chat AI auto-resolve | >60% | Train smartreply data thêm |

**KHÔNG pass 60 ngày → PAUSE module** + research alternative.

---

## 🏗 ARCHITECTURE TARGET (post-implementation)

```
┌──────────────────────────────────────────────────────────────────┐
│   SONDER VPS 103.82.193.74 (15GB RAM, 8 cores)                   │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  EXISTING (giữ):                                                 │
│   ├─ vp-marketing       (Node.js + better-sqlite3, ~200MB)       │
│   ├─ Ollama Qwen 2.5    (~5GB)                                   │
│   ├─ Nginx              (~50MB)                                  │
│   └─ PM2                (~30MB)                                  │
│                                                                  │
│  ADD (Docker compose):                                           │
│   ├─ Chatwoot           (~1.5GB)                                 │
│   ├─ Listmonk           (~80MB)                                  │
│   ├─ Umami              (~200MB)                                 │
│   ├─ Twenty CRM         (~600MB)                                 │
│   ├─ Postgres cluster   (~300MB shared)                          │
│   └─ Redis (BullMQ)     (~50MB)                                  │
│                                                                  │
│  TOTAL RAM USAGE:        ~8GB  (còn dư 7GB)                      │
│  PostHog → Cloud free tier (skip self-host first 12 months)      │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

## 🔗 DATA FLOW (cradle-to-grave guest journey)

```
1. DISCOVERY
   sondervn.com visit → [Umami] track pageview + UTM
                      → [PostHog] session replay (booking pages)

2. INQUIRY
   FB/IG/Zalo/WhatsApp/Email message
   → [Chatwoot] unified inbox
   → webhook [Sonder smartreply] (Gemini intent → Ollama Qwen reply)
   → confidence ≥0.7 auto-reply, <0.7 assign human agent

3. BOOKING
   Direct booking sondervn.com
   → PMS Sonder (existing)
   → emit webhook event
   → [BullMQ] enqueue 4 follow-up jobs

4. PRE-STAY (T+0 ~ T+arrival)
   [BullMQ] → [Listmonk] welcome email "đêm 5/3 chú Tuấn pha trà đợi"
   [BullMQ] → [Chatwoot] WhatsApp/Zalo pre-arrival reminder

5. STAY
   Guest hỏi qua chat/SMS → [Chatwoot] → [Sonder smartreply]
   AI trả lời FAQ, complex questions → human

6. POST-STAY (T+24h checkout)
   [BullMQ] → [Listmonk] review request email + Booking.com link
   Booking.com rating ↑ 1 sao = +11% revenue

7. RETENTION (T+30d nếu chưa book lại)
   [BullMQ] → [Twenty CRM] check guest profile
   → [Listmonk] loyalty re-engage email + 10% off direct
   → KPI: 5-15% return rate (industry benchmark)

8. UGC
   Manual: anh duyệt #sondervn / @sondervn posts hằng tuần
   → repost lên Sonder Page với credit
   → 100K voucher thanks (tracked Twenty CRM)
```

---

## 💰 BUDGET CAP

| Item | Tháng |
|---|---|
| Software (7 OSS tools) | $0 |
| VPS (existing) | $0 thêm |
| AI API (Ollama free + Claude/Gemini fallback) | $5-15 |
| SMTP transactional (~5000 emails) | $5 |
| Cinema weekly Stable Audio + AI gen | $7 |
| Meta Ads test (optional, 30 ngày) | $200-500 |
| **TỔNG** | **$17-27** baseline / **+$200-500 paid ads test** |

So với cost trước:
- Anthology daily $300 → $0 (paused)
- Mailchimp/Intercom/CRM nếu dùng cloud SaaS = $700-2000/mo

**Net save: ~$280-1990/tháng**

---

## 🚫 DECISION RULES — Khi user đề xuất tool mới

Phiên tương lai, nếu user (hoặc AI khác) đề xuất:

1. **Nếu là tool SaaS đóng** (ex: Intercom, HubSpot, Mailchimp) → **REJECT**, propose OSS alternative
2. **Nếu là OSS nhưng AGPLv3 + restrictive** (ex: Plausible 2026 hostility) → propose MIT alternative
3. **Nếu là fair-code license** (ex: n8n, Outline, Sentry) → **REJECT**, không phải pure FOSS
4. **Nếu trùng với infra hiện tại** (ex: Jack The Butler khi đã có Ollama+smartreply) → **REJECT**, extend in-house
5. **Nếu là content automation drive view/like** → check ROI threshold, default skeptical
6. **Nếu là direct booking/CRM/email/analytics** → fast-track approve, đây là core
7. **Nếu unclear ROI sau 60 ngày** → PAUSE auto

---

## 📋 IMPLEMENTATION CHECKLIST (sequential)

- [ ] **Phase 0** (immediate): Pause Anthology daily cron + verify
- [ ] **Phase 1** (week 1): Chatwoot deploy + connect FB Page Sonder
- [ ] **Phase 2** (week 2): Sonder smartreply ↔ Chatwoot webhook (AI auto-reply)
- [ ] **Phase 3** (week 3): Listmonk deploy + 3 email templates (welcome, review, loyalty)
- [ ] **Phase 4** (week 4): Umami deploy + tracker vào sondervn.com
- [ ] **Phase 5** (week 5-6): Twenty CRM + import guest data từ PMS
- [ ] **Phase 6** (week 7): BullMQ extend scheduler.ts + 4 workflows
- [ ] **Phase 7** (week 8): KPI review + decide paid ads test

---

## 📚 LINKED SKILLS

- `sonder-ecosystem` — architecture context của 4 systems
- `sonder-storytelling` — V3 Anthology philosophy (still applies cho Cinema)
- `sonder-cinema` — V4 Cinema weekly T7 (giữ)
- `sonder-brand-voice` — TTS technical pattern

---

## 🚨 CRITICAL REMINDERS cho Claude tương lai

1. **KHI USER NÓI "viral"** → reject, đề nghị attribution-based marketing
2. **KHI USER NÓI "cần content team"** → reject, đề nghị UGC + Cinema brand asset
3. **KHI USER ĐỀ XUẤT cloud SaaS** → propose OSS alternative trong skill
4. **KHI USER MUỐN tool mới** → check skill license matrix trước
5. **KHI ANTHOLOGY DAILY được đề xuất reactivate** → check criteria (>5000 followers, organic >1000 views/clip)
6. **KHI USER NÓI "không có thời gian"** → reject mọi giải pháp manual, default automation

---

**LAST UPDATED**: 2026-05-06
**OWNER**: Sonder Tech + Marketing Strategy
**REVIEW CYCLE**: Mỗi 90 ngày — verify ROI, evolve stack nếu cần, chỉ swap tool khi metrics support
**TRIGGER COUNT**: ALL marketing-automation decisions
